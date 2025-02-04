// src/services/post.ts
import {
    type IAgentRuntime,
    ModelClass,
    composeContext,
    elizaLogger,
    generateImage,
    generateText,
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

    constructor(
        private runtime: IAgentRuntime,
        private state: InstagramState
    ) {
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
        const scheduleNextPost = () => {
            const randomMinutes =
                Math.floor(Math.random() * (this.maxInterval - this.minInterval + 1)) +
                this.minInterval;
            const delay = randomMinutes * 60 * 1000;

            this.intervalId = setTimeout(async () => {
                try {
                    await this.generateNewPost();
                } catch (error) {
                    elizaLogger.error("[Instagram] Error generating post:", {
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                // Schedule next post after this one completes
                if (this.isRunning) {
                    scheduleNextPost();
                }
            }, delay);

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
        if (!this.isRunning) return;

        const ig = getIgClient();
        if (!ig) {
            elizaLogger.error("[Instagram] Client not initialized");
            return;
        }

        try {
            elizaLogger.log("[Instagram] Generating new post");

            // Generate post content
            const content = await this.generatePostContent();
            if (!content) {
                elizaLogger.error("[Instagram] Failed to generate post content");
                return;
            }

            // Generate or get image
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

            elizaLogger.log("[Instagram] Successfully created new post");
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating post:", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async generatePostContent(): Promise<string | null> {
        try {
            // First compose the state with character info
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: "Generate a new Instagram post",
                        action: "POST",
                    },
                },
                {
                    instagramUsername: this.state.profile?.username,
                }
            );

            // Use the template to generate the post
            const context = composeContext({
                state,
                template: this.runtime.character.templates?.instagramPostTemplate || instagramPostTemplate,
            });

            // Generate the actual post content
            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!response) {
                throw new Error("No content generated");
            }

            return this.cleanContent(response);
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating post content:", {
                error: error instanceof Error ? error.message : String(error)
            });
            return null;
        }
    }

    private async generateImage(content: string): Promise<string | null> {
        try {
            elizaLogger.log("[Instagram] Generating image for post");

            // Get image settings from character config
            const imageSettings = this.runtime.character.settings.imageSettings || {};

            const result = await generateImage({
                prompt: content,
                width: imageSettings?.width || 1024,
                height: imageSettings?.height || 1024,
                count: imageSettings?.count || 1,
                negativePrompt: imageSettings?.negativePrompt || null,
                numIterations: imageSettings?.numIterations || 50,
                guidanceScale: imageSettings?.guidanceScale || 7.5,
                seed: imageSettings?.seed || null,
                modelId: imageSettings?.modelId || null,
                jobId: imageSettings?.jobId || null,
                stylePreset: imageSettings?.stylePreset || "",
                hideWatermark: imageSettings?.hideWatermark ?? true,
                safeMode: imageSettings?.safeMode ?? false,
                cfgScale: imageSettings?.cfgScale || null,
            }, this.runtime);

            if (!result.success || !result.data || result.data.length === 0) {
                throw new Error(
                    "Failed to generate image: " +
                        (result.error || "No image data returned")
                );
            }

            // Save the base64 image to a temporary file
            const imageData = result.data[0].replace(
                /^data:image\/\w+;base64,/,
                ""
            );
            const tempDir = path.resolve(process.cwd(), "temp");
            await fs.mkdir(tempDir, { recursive: true });
            const tempFile = path.join(
                tempDir,
                `instagram-post-${Date.now()}.png`
            );
            await fs.writeFile(tempFile, Buffer.from(imageData, "base64"));

            return tempFile;
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating image:", {
                error: error instanceof Error ? error.message : String(error),
                content: content.substring(0, 100), // Log first 100 chars of content for debugging
                imageSettings: this.runtime.character.settings.imageSettings // Log image settings for debugging
            });
            return null;
        }
    }

    private async createPost(options: PostOptions) {
        const ig = getIgClient();
        if (!ig) {
            elizaLogger.error("[Instagram] Client not initialized");
            return;
        }

        try {
            elizaLogger.log("[Instagram] Creating post", {
                mediaCount: options.media.length,
                hasCaption: !!options.caption,
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
            } else {
                // Single image/video post
                const media = processedMedia[0];
                if (media.type === "VIDEO") {
                    await ig.publish.video({
                        video: media.file,
                        coverImage: media.file,
                        caption: options.caption,
                    });
                } else {
                    await ig.publish.photo({
                        file: media.file,
                        caption: options.caption,
                    });
                }
            }

            elizaLogger.log("[Instagram] Post created successfully");
        } catch (error) {
            elizaLogger.error("[Instagram] Error creating post:", {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error; // Propagate error to caller
        }
    }

    private async processMedia(media: {
        type: string;
        url: string;
    }): Promise<Buffer> {
        try {
            elizaLogger.log("[Instagram] Processing media", {
                type: media.type,
                url: media.url,
            });

            // Read file
            const buffer = await fs.readFile(media.url);

            if (media.type === "IMAGE") {
                // Process image with sharp
                return await sharp(buffer)
                    .resize(1080, 1080, {
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .jpeg({
                        quality: 85,
                        progressive: true,
                    })
                    .toBuffer();
            }

            // For other types, return original buffer
            return buffer;
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing media:", {
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    private cleanContent(content: string): string {
        return content
            .trim()
            .replace(/^['"](.*)['"]$/, "$1")
            .replace(/\\n/g, "\n")
            .slice(0, 2200); // Instagram caption length limit
    }
}
