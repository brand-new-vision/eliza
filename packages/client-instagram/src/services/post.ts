// src/services/post.ts
import {
    type IAgentRuntime,
    ModelClass,
    composeContext,
    elizaLogger,
    generateImage,
    generateText,
    stringToUuid,
    getEmbeddingZeroVector,
} from "@elizaos/core";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";

// Template for generating Instagram posts
const instagramPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{instagramUsername}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}.
Your response should be 1-3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only.
Add up to 3 relevant hashtags at the end.`;

interface PostOptions {
    media: Array<{
        type: "IMAGE" | "VIDEO" | "CAROUSEL";
        url: string;
    }>;
    caption?: string;
}

export class InstagramPostService {
    private isRunning = false;
    private intervalId?: NodeJS.Timeout;
    private minInterval: number;
    private maxInterval: number;
    private imageModel: string;

    constructor(
        private runtime: IAgentRuntime,
        private state: InstagramState
    ) {
        this.imageModel = this.runtime.character?.imageGeneration?.modelId || "stable-diffusion-3.5";
        // Get intervals from settings or use defaults
        this.minInterval = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_POST_INTERVAL_MIN") || "90",
            10
        );
        this.maxInterval = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_POST_INTERVAL_MAX") || "180",
            10
        );
    }

    async start() {
        if (this.isRunning) {
            elizaLogger.warn("[Instagram] Post service already running");
            return;
        }

        this.isRunning = true;
        elizaLogger.log("[Instagram] Starting post service", {
            minInterval: this.minInterval,
            maxInterval: this.maxInterval
        });

        // Initial post generation
        await this.generateNewPost();

        // Set up interval for periodic posts
        const scheduleNextPost = async () => {
            // Get last post time from cache
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("instagram/lastPost");

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const randomMinutes =
                Math.floor(Math.random() * (this.maxInterval - this.minInterval + 1)) +
                this.minInterval;
            const delay = randomMinutes * 60 * 1000;

            // Only post if enough time has passed
            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewPost();
            }

            if (this.isRunning) {
                setTimeout(() => scheduleNextPost(), delay);
            }

            elizaLogger.log(
                `Next Instagram post scheduled in ${randomMinutes} minutes`
            );
        };

        // Start the scheduling cycle
        scheduleNextPost();
    }

    async stop() {
        elizaLogger.log("[Instagram] Stopping post service");
        this.isRunning = false;
        if (this.intervalId) {
            clearTimeout(this.intervalId);
        }
    }

    private async generateNewPost() {
        try {
            elizaLogger.log("[Instagram] Generating new post");

            // Create a unique room for this post
            const roomId = stringToUuid(
                `instagram_post_${Date.now()}_${this.runtime.agentId}`
            );

            // Ensure user exists
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.state.profile?.username || "",
                this.runtime.character.name,
                "instagram"
            );

            // Ensure room exists
            await this.runtime.ensureRoomExists(roomId);

            // Generate post content
            const content = await this.generatePostContent();
            if (!content) {
                elizaLogger.error("[Instagram] Failed to generate post content");
                return;
            }

            // Generate image
            const mediaUrl = await this.generateImage(content);
            if (!mediaUrl) {
                elizaLogger.error("[Instagram] Failed to generate image");
                return;
            }

            // Create the post
            await this.createPost({
                media: [
                    {
                        type: "IMAGE",
                        url: mediaUrl,
                    },
                ],
                caption: content,
            });

            // Create memory of the post
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`instagram-post-${Date.now()}`),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: content,
                    source: "instagram",
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now(),
            });

            // Update last post time in cache
            await this.runtime.cacheManager.set("instagram/lastPost", {
                timestamp: Date.now(),
            });

            elizaLogger.log("[Instagram] Successfully created new post");
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating post:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "generateNewPost"
            });
        }
    }

    private async generatePostContent(): Promise<string | null> {
        try {
            const topics = this.runtime.character.topics.join(", ");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid(`instagram_generate_${Date.now()}`),
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "POST",
                    },
                },
                {
                    instagramUsername: this.state.profile?.username,
                }
            );

            const context = composeContext({
                state,
                template: this.runtime.character.templates?.instagramPostTemplate || instagramPostTemplate,
            });

            elizaLogger.debug("[Instagram] Generate post prompt:", {
                context: context
            });

            const content = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!content) {
                throw new Error("No content generated");
            }

            // Clean the generated content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(content);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch {
                // If not JSON, clean the raw content
                cleanedContent = content
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n\n") // Convert escaped newlines to actual newlines
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error("[Instagram] Failed to extract valid content:", {
                    rawResponse: content,
                    attempted: "JSON parsing and text cleaning"
                });
                return null;
            }

            // Ensure content meets Instagram requirements
            cleanedContent = cleanedContent
                .slice(0, 2200) // Instagram caption length limit
                .trim();

            return cleanedContent;
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating post content:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "generatePostContent"
            });
            return null;
        }
    }

    private async generateImage(content: string): Promise<string | null> {
        try {
            elizaLogger.debug("[Instagram] Starting image generation", {
                content: content
            });

            // Get image settings from character config
            const imageSettings = this.runtime.character?.imageGeneration || {};

            // Parse size from settings
            const size = imageSettings.size || "1024x1024";
            const [width, height] = size.split("x").map(Number);

            const result = await generateImage({
                prompt: content,
                width: width || 1024,
                height: height || 1024,
                modelId: this.imageModel,
                count: imageSettings.count || 1,
                negativePrompt: imageSettings.negativePrompt,
                numIterations: imageSettings.numIterations || 50,
                guidanceScale: imageSettings.guidanceScale || 7.5,
                seed: imageSettings.seed,
                stylePreset: imageSettings.stylePreset,
                hideWatermark: imageSettings.hideWatermark ?? true,
                safeMode: imageSettings.safeMode ?? false,
                cfgScale: imageSettings.cfgScale,
            }, this.runtime);

            if (!result.success || !result.data || result.data.length === 0) {
                throw new Error(
                    "Failed to generate image: " +
                    (result.error || "No image data returned")
                );
            }

            // Save the base64 image to a temporary file
            const imageData = result.data[0].replace(/^data:image\/\w+;base64,/, "");
            const tempDir = path.join(process.cwd(), "temp");
            await fs.mkdir(tempDir, { recursive: true });

            const filename = `instagram_${Date.now()}.png`;
            const tempFile = path.join(tempDir, filename);

            await fs.writeFile(tempFile, Buffer.from(imageData, "base64"));

            elizaLogger.debug("[Instagram] Image generated successfully", {
                path: tempFile
            });

            return tempFile;
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating image:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "generateImage",
                content: content
            });
            return null;
        }
    }

    private async createPost(options: PostOptions) {
        const ig = getIgClient();
        if (!ig) {
            throw new Error("Instagram client not initialized");
        }

        try {
            elizaLogger.debug("[Instagram] Creating post", {
                mediaCount: options.media.length,
                hasCaption: !!options.caption
            });

            // Process media files
            const processedMedia = await Promise.all(
                options.media.map(async (media) => {
                    const buffer = await this.processMedia(media);
                    return {
                        file: buffer,
                        type: media.type,
                    };
                })
            );

            // Handle different post types
            if (processedMedia.length > 1) {
                // Create carousel post
                await ig.publish.album({
                    items: processedMedia.map((media) => ({
                        file: media.file,
                    })),
                    caption: options.caption,
                });

                elizaLogger.debug("[Instagram] Created carousel post", {
                    itemCount: processedMedia.length
                });
            } else {
                // Single image/video post
                const media = processedMedia[0];
                if (media.type === "VIDEO") {
                    await ig.publish.video({
                        video: media.file,
                        coverImage: media.file,
                        caption: options.caption,
                    });

                    elizaLogger.debug("[Instagram] Created video post");
                } else {
                    await ig.publish.photo({
                        file: media.file,
                        caption: options.caption,
                    });

                    elizaLogger.debug("[Instagram] Created photo post");
                }
            }

            // Update last post time in cache
            await this.runtime.cacheManager.set("instagram/lastPost", {
                timestamp: Date.now(),
            });

            elizaLogger.log("[Instagram] Post created successfully");
        } catch (error) {
            elizaLogger.error("[Instagram] Error creating post:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "createPost",
                mediaCount: options.media.length,
                hasCaption: !!options.caption
            });
            throw error;
        }
    }

    private async processMedia(media: {
        type: string;
        url: string;
    }): Promise<Buffer> {
        try {
            elizaLogger.debug("[Instagram] Processing media", {
                type: media.type,
                url: media.url
            });

            // Read file
            const buffer = await fs.readFile(media.url);

            if (media.type === "IMAGE") {
                // Process image with sharp
                const processed = await sharp(buffer)
                    .resize(1080, 1080, {
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .jpeg({
                        quality: 85,
                        progressive: true,
                    })
                    .toBuffer();

                elizaLogger.debug("[Instagram] Processed image", {
                    originalSize: buffer.length,
                    processedSize: processed.length
                });

                return processed;
            }

            // For other types, return original buffer
            elizaLogger.debug("[Instagram] Using original media buffer", {
                size: buffer.length
            });

            return buffer;
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing media:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "processMedia",
                mediaType: media.type,
                url: media.url
            });
            throw error;
        }
    }
}
