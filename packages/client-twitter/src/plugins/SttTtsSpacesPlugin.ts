// src/plugins/SttTtsPlugin.ts

import { spawn } from "child_process";
import {
    type ITranscriptionService,
    elizaLogger,
    stringToUuid,
    composeContext,
    getEmbeddingZeroVector,
    generateMessageResponse,
    ModelClass,
    Content,
    IAgentRuntime,
    Memory,
    Plugin,
    UUID,
    State,
    composeRandomUser,
    generateShouldRespond,
} from "@elizaos/core";
import type {
    Space,
    JanusClient,
    AudioDataWithUser,
} from "agent-twitter-client";
import { ClientBase } from "../base";
import {
    twitterVoiceHandlerTemplate,
    twitterShouldRespondTemplate,
} from "./templates";

interface PluginConfig {
    runtime: IAgentRuntime;
    client: ClientBase;
    spaceId: string;
    elevenLabsApiKey?: string; // for TTS
    sttLanguage?: string; // e.g. "en" for Whisper
    silenceThreshold?: number; // amplitude threshold for ignoring silence
    voiceId?: string; // specify which ElevenLabs voice to use
    elevenLabsModel?: string; // e.g. "eleven_monolingual_v1"
    chatContext?: Array<{
        role: "system" | "user" | "assistant";
        content: string;
    }>;
    transcriptionService: ITranscriptionService;
}

const VOLUME_WINDOW_SIZE = 100;
const SPEAKING_THRESHOLD = 0.05;
const SILENCE_DETECTION_THRESHOLD_MS = 1000; // 1-second silence threshold

/**
 * MVP plugin for speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)
 * Approach:
 *   - Collect each speaker's unmuted PCM in a memory buffer (only if above silence threshold)
 *   - On speaker mute -> flush STT -> GPT -> TTS -> push to Janus
 */
export class SttTtsPlugin implements Plugin {
    name = "SttTtsPlugin";
    description = "Speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)";
    private runtime: IAgentRuntime;
    private client: ClientBase;
    private spaceId: string;

    private space?: Space;
    private janus?: JanusClient;

    private elevenLabsApiKey?: string;

    private voiceId = "21m00Tcm4TlvDq8ikWAM";
    private elevenLabsModel = "eleven_monolingual_v1";
    private chatContext: Array<{
        role: "system" | "user" | "assistant";
        content: string;
    }> = [];

    private transcriptionService: ITranscriptionService;

    /**
     * userId => arrayOfChunks (PCM Int16)
     */
    private pcmBuffers = new Map<string, Int16Array[]>();

    /**
     * For ignoring near-silence frames (if amplitude < threshold)
     */
    private silenceThreshold = 50;

    // TTS queue for sequentially speaking
    private ttsQueue: string[] = [];
    private isSpeaking = false;
    private isProcessingAudio = false;

    private userSpeakingTimer: NodeJS.Timeout | null = null;
    private volumeBuffers: Map<string, number[]>;
    private ttsAbortController: AbortController | null = null;

    onAttach(_space: Space) {
        elizaLogger.log("[SttTtsPlugin] onAttach => space was attached");
    }

    init(params: { space: Space; pluginConfig?: Record<string, any> }): void {
        elizaLogger.log(
            "[SttTtsPlugin] init => Space fully ready. Subscribing to events."
        );

        this.space = params.space;
        this.janus = (this.space as any)?.janusClient as
            | JanusClient
            | undefined;

        const config = params.pluginConfig as PluginConfig;
        this.runtime = config?.runtime;
        this.client = config?.client;
        this.spaceId = config?.spaceId;
        this.elevenLabsApiKey = config?.elevenLabsApiKey;
        this.transcriptionService = config.transcriptionService;
        if (typeof config?.silenceThreshold === "number") {
            this.silenceThreshold = config.silenceThreshold;
        }
        if (config?.voiceId) {
            this.voiceId = config.voiceId;
        }
        if (config?.elevenLabsModel) {
            this.elevenLabsModel = config.elevenLabsModel;
        }
        if (config?.chatContext) {
            this.chatContext = config.chatContext;
        }
        elizaLogger.log("[SttTtsPlugin] Plugin config =>", config);

        this.volumeBuffers = new Map<string, number[]>();
    }

    /**
     * Called whenever we receive PCM from a speaker
     */
    onAudioData(data: AudioDataWithUser): void {
        elizaLogger.debug("[SttTtsPlugin] Received audio data:", {
            userId: data.userId,
            samplesLength: data.samples.length,
            maxAmplitude: Math.max(...data.samples.map(Math.abs)),
            timestamp: new Date().toISOString()
        });

        if (this.isProcessingAudio) {
            return;
        }
        let maxVal = 0;
        for (let i = 0; i < data.samples.length; i++) {
            const val = Math.abs(data.samples[i]);
            if (val > maxVal) maxVal = val;
        }
        if (maxVal < this.silenceThreshold) {
            elizaLogger.debug("[SttTtsPlugin] Audio below silence threshold:", {
                maxVal,
                threshold: this.silenceThreshold,
                userId: data.userId
            });
            return;
        }

        if (this.userSpeakingTimer) {
            clearTimeout(this.userSpeakingTimer);
        }

        let arr = this.pcmBuffers.get(data.userId);
        if (!arr) {
            arr = [];
            this.pcmBuffers.set(data.userId, arr);
            elizaLogger.info("[SttTtsPlugin] Created new buffer for user:", {
                userId: data.userId,
                timestamp: new Date().toISOString()
            });
        }
        arr.push(data.samples);

        elizaLogger.debug("[SttTtsPlugin] Updated buffer stats:", {
            userId: data.userId,
            totalChunks: arr.length,
            totalSamples: arr.reduce((sum, chunk) => sum + chunk.length, 0),
            bufferDurationMs: (arr.reduce((sum, chunk) => sum + chunk.length, 0) / 48000) * 1000
        });

        if (!this.isSpeaking) {
            this.userSpeakingTimer = setTimeout(() => {
                elizaLogger.log(
                    "[SttTtsPlugin] start processing audio for user =>",
                    data.userId
                );
                this.userSpeakingTimer = null;
                this.processAudio(data.userId).catch((err) =>
                    elizaLogger.error(
                        "[SttTtsPlugin] handleSilence error =>",
                        err
                    )
                );
            }, SILENCE_DETECTION_THRESHOLD_MS);
        } else {
            // check interruption
            let volumeBuffer = this.volumeBuffers.get(data.userId);
            if (!volumeBuffer) {
                volumeBuffer = [];
                this.volumeBuffers.set(data.userId, volumeBuffer);
            }
            const samples = new Int16Array(
                data.samples.buffer,
                data.samples.byteOffset,
                data.samples.length / 2
            );
            const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
            volumeBuffer.push(maxAmplitude);

            if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
                volumeBuffer.shift();
            }
            const avgVolume =
                volumeBuffer.reduce((sum, v) => sum + v, 0) /
                VOLUME_WINDOW_SIZE;

            if (avgVolume > SPEAKING_THRESHOLD) {
                volumeBuffer.length = 0;
                if (this.ttsAbortController) {
                    this.ttsAbortController.abort();
                    this.isSpeaking = false;
                    elizaLogger.log("[SttTtsPlugin] TTS playback interrupted");
                }
            }
        }
    }

    // /src/sttTtsPlugin.ts
    private async convertPcmToWavInMemory(
        pcmData: Int16Array,
        sampleRate: number
    ): Promise<ArrayBuffer> {
        // number of channels
        const numChannels = 1;
        // byte rate = (sampleRate * numChannels * bitsPerSample/8)
        const byteRate = sampleRate * numChannels * 2;
        const blockAlign = numChannels * 2;
        // data chunk size = pcmData.length * (bitsPerSample/8)
        const dataSize = pcmData.length * 2;

        // WAV header is 44 bytes
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        // RIFF chunk descriptor
        this.writeString(view, 0, "RIFF");
        view.setUint32(4, 36 + dataSize, true); // file size - 8
        this.writeString(view, 8, "WAVE");

        // fmt sub-chunk
        this.writeString(view, 12, "fmt ");
        view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
        view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
        view.setUint16(22, numChannels, true); // NumChannels
        view.setUint32(24, sampleRate, true); // SampleRate
        view.setUint32(28, byteRate, true); // ByteRate
        view.setUint16(32, blockAlign, true); // BlockAlign
        view.setUint16(34, 16, true); // BitsPerSample (16)

        // data sub-chunk
        this.writeString(view, 36, "data");
        view.setUint32(40, dataSize, true);

        // Write PCM samples
        let offset = 44;
        for (let i = 0; i < pcmData.length; i++, offset += 2) {
            view.setInt16(offset, pcmData[i], true);
        }

        return buffer;
    }

    private writeString(view: DataView, offset: number, text: string) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    /**
     * On speaker silence => flush STT => GPT => TTS => push to Janus
     */
    private async processAudio(userId: UUID): Promise<void> {
        elizaLogger.info("[SttTtsPlugin] Starting audio processing:", {
            userId,
            timestamp: new Date().toISOString()
        });

        if (this.isProcessingAudio) {
            return;
        }
        this.isProcessingAudio = true;
        try {
            elizaLogger.log(
                "[SttTtsPlugin] Starting audio processing for user:",
                userId
            );
            const chunks = this.pcmBuffers.get(userId) || [];
            this.pcmBuffers.clear();

            if (!chunks.length) {
                elizaLogger.warn(
                    "[SttTtsPlugin] No audio chunks for user =>",
                    userId
                );
                return;
            }
            elizaLogger.log(
                `[SttTtsPlugin] Flushing STT buffer for user=${userId}, chunks=${chunks.length}`
            );

            const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Int16Array(totalLen);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.length;
            }

            // Log before WAV conversion
            elizaLogger.info("[SttTtsPlugin] Converting audio to WAV:", {
                userId,
                totalChunks: chunks.length,
                totalSamples: totalLen,
                estimatedDurationMs: (totalLen / 48000) * 1000
            });

            // Convert PCM to WAV for STT
            const wavBuffer = await this.convertPcmToWavInMemory(merged, 48000);

            elizaLogger.info("[SttTtsPlugin] Audio conversion complete:", {
                userId,
                wavBufferSize: wavBuffer.byteLength,
                timestamp: new Date().toISOString()
            });

            // Before STT
            elizaLogger.info("[SttTtsPlugin] Sending to transcription service:", {
                userId,
                bufferSize: wavBuffer.byteLength,
                timestamp: new Date().toISOString()
            });

            // Whisper STT
            const sttText = await this.transcriptionService.transcribe(
                Buffer.from(wavBuffer)
            );

            elizaLogger.info("[SttTtsPlugin] Transcription result:", {
                userId,
                hasText: !!sttText,
                textLength: sttText?.length,
                timestamp: new Date().toISOString()
            });

            if (!sttText || !sttText.trim()) {
                elizaLogger.warn(
                    "[SttTtsPlugin] No speech recognized for user =>",
                    userId
                );
                return;
            }
            elizaLogger.log(
                `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`
            );

            // Process response timing
            const startTime = Date.now();
            const response = await this.handleUserMessage(sttText, userId);
            const endTime = Date.now();

            elizaLogger.info("[SttTtsPlugin] Response generation complete:", {
                userId,
                processingTimeMs: endTime - startTime,
                responseLength: response?.length,
                timestamp: new Date().toISOString()
            });

            if (!response || !response.length || !response.trim()) {
                elizaLogger.warn(
                    "[SttTtsPlugin] No replyText for user =>",
                    userId
                );
                return;
            }
            elizaLogger.log(
                `[SttTtsPlugin] user=${userId}, reply="${response}"`
            );
            this.isProcessingAudio = false;
            this.volumeBuffers.clear();
            // Use the standard speak method with queue
            await this.speakText(response);
        } catch (error) {
            elizaLogger.error("[SttTtsPlugin] Error in audio processing pipeline:", {
                userId,
                error: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                },
                timestamp: new Date().toISOString()
            });
        } finally {
            this.isProcessingAudio = false;
        }
    }

    /**
     * Public method to queue a TTS request
     */
    public async speakText(text: string): Promise<void> {
        this.ttsQueue.push(text);
        if (!this.isSpeaking) {
            this.isSpeaking = true;
            this.processTtsQueue().catch((err) => {
                elizaLogger.error(
                    "[SttTtsPlugin] processTtsQueue error =>",
                    err
                );
            });
        }
    }

    /**
     * Process TTS requests one by one
     */
    private async processTtsQueue(): Promise<void> {
        while (this.ttsQueue.length > 0) {
            const text = this.ttsQueue.shift();
            if (!text) continue;

            this.ttsAbortController = new AbortController();
            const { signal } = this.ttsAbortController;

            try {
                const ttsAudio = await this.elevenLabsTts(text);
                const pcm = await this.convertMp3ToPcm(ttsAudio, 48000);
                if (signal.aborted) {
                    elizaLogger.log(
                        "[SttTtsPlugin] TTS interrupted before streaming"
                    );
                    return;
                }
                await this.streamToJanus(pcm, 48000);
                if (signal.aborted) {
                    elizaLogger.log(
                        "[SttTtsPlugin] TTS interrupted after streaming"
                    );
                    return;
                }
            } catch (err) {
                elizaLogger.error("[SttTtsPlugin] TTS streaming error =>", err);
            } finally {
                // Clean up the AbortController
                this.ttsAbortController = null;
            }
        }
        this.isSpeaking = false;
    }

    /**
     * Handle User Message
     */
    private async handleUserMessage(
        userText: string,
        userId: UUID
    ): Promise<string> {
        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.client.profile.username,
            this.runtime.character.name,
            "twitter"
        );

        const roomId = stringToUuid("twitter_generate_room-" + this.spaceId);
        let state = await this.runtime.composeState(
            {
                agentId: this.runtime.agentId,
                content: { text: userText, source: "twitter" },
                userId,
                roomId,
            },
            {
                twitterUserName: this.client.profile.username,
                agentName: this.runtime.character.name,
            }
        );

        const memory = {
            id: stringToUuid(roomId + "-voice-message-" + Date.now()),
            agentId: this.runtime.agentId,
            content: {
                text: userText,
                source: "twitter",
            },
            userId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: Date.now(),
        };

        await this.runtime.messageManager.createMemory(memory);

        state = await this.runtime.updateRecentMessageState(state);

        const shouldIgnore = await this._shouldIgnore(memory);

        if (shouldIgnore) {
            return "";
        }

        const shouldRespond = await this._shouldRespond(userText, state);

        if (!shouldRespond) {
            return "";
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.twitterVoiceHandlerTemplate ||
                this.runtime.character.templates?.messageHandlerTemplate ||
                twitterVoiceHandlerTemplate,
        });

        const responseContent = await this._generateResponse(memory, context);

        const responseMemory: Memory = {
            id: stringToUuid(memory.id + "-voice-response-" + Date.now()),
            agentId: this.runtime.agentId,
            userId: this.runtime.agentId,
            content: {
                ...responseContent,
                user: this.runtime.character.name,
                inReplyTo: memory.id,
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
        };

        const reply = responseMemory.content.text?.trim();
        if (reply) {
            await this.runtime.messageManager.createMemory(responseMemory);
        }

        return reply;
    }

    private async _generateResponse(
        message: Memory,
        context: string
    ): Promise<Content> {
        const { userId, roomId } = message;

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        response.source = "discord";

        if (!response) {
            elizaLogger.error(
                "[SttTtsPlugin] No response from generateMessageResponse"
            );
            return;
        }

        await this.runtime.databaseAdapter.log({
            body: { message, context, response },
            userId: userId,
            roomId,
            type: "response",
        });

        return response;
    }

    private async _shouldIgnore(message: Memory): Promise<boolean> {
        elizaLogger.debug("message.content: ", message.content);
        // if the message is 3 characters or less, ignore it
        if ((message.content as Content).text.length < 3) {
            return true;
        }

        const loseInterestWords = [
            // telling the bot to stop talking
            "shut up",
            "stop",
            "dont talk",
            "silence",
            "stop talking",
            "be quiet",
            "hush",
            "stfu",
            "stupid bot",
            "dumb bot",

            // offensive words
            "fuck",
            "shit",
            "damn",
            "suck",
            "dick",
            "cock",
            "sex",
            "sexy",
        ];
        if (
            (message.content as Content).text.length < 50 &&
            loseInterestWords.some((word) =>
                (message.content as Content).text?.toLowerCase().includes(word)
            )
        ) {
            return true;
        }

        const ignoreWords = ["k", "ok", "bye", "lol", "nm", "uh"];
        if (
            (message.content as Content).text?.length < 8 &&
            ignoreWords.some((word) =>
                (message.content as Content).text?.toLowerCase().includes(word)
            )
        ) {
            return true;
        }

        return false;
    }

    private async _shouldRespond(
        message: string,
        state: State
    ): Promise<boolean> {
        const lowerMessage = message.toLowerCase();
        const characterName = this.runtime.character.name.toLowerCase();

        if (lowerMessage.includes(characterName)) {
            return true;
        }

        // If none of the above conditions are met, use the generateText to decide
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character.templates?.shouldRespondTemplate ||
                composeRandomUser(twitterShouldRespondTemplate, 2),
        });

        const response = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (response === "RESPOND") {
            return true;
        } else if (response === "IGNORE") {
            return false;
        } else if (response === "STOP") {
            return false;
        } else {
            elizaLogger.error(
                "Invalid response from response generateText:",
                response
            );
            return false;
        }
    }

    /**
     * ElevenLabs TTS => returns MP3 Buffer
     */
    private async elevenLabsTts(text: string): Promise<Buffer> {
        if (!this.elevenLabsApiKey) {
            throw new Error("[SttTtsPlugin] No ElevenLabs API key");
        }
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`;
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": this.elevenLabsApiKey,
            },
            body: JSON.stringify({
                text,
                model_id: this.elevenLabsModel,
                voice_settings: { stability: 0.4, similarity_boost: 0.8 },
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(
                `[SttTtsPlugin] ElevenLabs TTS error => ${resp.status} ${errText}`
            );
        }
        const arrayBuf = await resp.arrayBuffer();
        return Buffer.from(arrayBuf);
    }

    /**
     * Convert MP3 => PCM via ffmpeg
     */
    private convertMp3ToPcm(
        mp3Buf: Buffer,
        outRate: number
    ): Promise<Int16Array> {
        return new Promise((resolve, reject) => {
            const ff = spawn("ffmpeg", [
                "-i",
                "pipe:0",
                "-f",
                "s16le",
                "-ar",
                outRate.toString(),
                "-ac",
                "1",
                "pipe:1",
            ]);
            let raw = Buffer.alloc(0);

            ff.stdout.on("data", (chunk: Buffer) => {
                raw = Buffer.concat([raw, chunk]);
            });
            ff.stderr.on("data", () => {
                // ignoring ffmpeg logs
            });
            ff.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`ffmpeg error code=${code}`));
                    return;
                }
                const samples = new Int16Array(
                    raw.buffer,
                    raw.byteOffset,
                    raw.byteLength / 2
                );
                resolve(samples);
            });

            ff.stdin.write(mp3Buf);
            ff.stdin.end();
        });
    }

    /**
     * Push PCM back to Janus in small frames
     * We'll do 10ms @48k => 960 samples per frame
     */
    private async streamToJanus(
        samples: Int16Array,
        sampleRate: number
    ): Promise<void> {
        // TODO: Check if better than 480 fixed
        const FRAME_SIZE = Math.floor(sampleRate * 0.01); // 10ms frames => 480 @48kHz

        for (
            let offset = 0;
            offset + FRAME_SIZE <= samples.length;
            offset += FRAME_SIZE
        ) {
            if (this.ttsAbortController?.signal.aborted) {
                elizaLogger.log("[SttTtsPlugin] streamToJanus interrupted");
                return;
            }
            const frame = new Int16Array(FRAME_SIZE);
            frame.set(samples.subarray(offset, offset + FRAME_SIZE));
            this.janus?.pushLocalAudio(frame, sampleRate, 1);

            // Short pause so we don't overload
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    /**
     * Add a message (system, user or assistant) to the chat context.
     * E.g. to store conversation history or inject a persona.
     */
    public addMessage(role: "system" | "user" | "assistant", content: string) {
        this.chatContext.push({ role, content });
        elizaLogger.log(
            `[SttTtsPlugin] addMessage => role=${role}, content=${content}`
        );
    }

    /**
     * Clear the chat context if needed.
     */
    public clearChatContext() {
        this.chatContext = [];
        elizaLogger.log("[SttTtsPlugin] clearChatContext => done");
    }

    cleanup(): void {
        elizaLogger.log("[SttTtsPlugin] cleanup => releasing resources");
        this.pcmBuffers.clear();
        this.userSpeakingTimer = null;
        this.ttsQueue = [];
        this.isSpeaking = false;
        this.volumeBuffers.clear();
    }
}
