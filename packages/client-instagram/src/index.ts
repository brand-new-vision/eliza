// src/index.ts
import { type Client, type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { validateInstagramConfig } from "./environment";
import { initializeClient } from "./lib/auth";
import { InstagramInteractionService } from "./services/interaction";
import { InstagramPostService } from "./services/post";
import type { InstagramState } from './types';

export const InstagramClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        try {
            // Validate configuration
            const config = await validateInstagramConfig(runtime);
            elizaLogger.error("[Instagram] Client configuration validated:", {
                actionProcessing: config.INSTAGRAM_ENABLE_ACTION_PROCESSING,
                actionInterval: config.INSTAGRAM_ACTION_INTERVAL,
                maxActions: config.INSTAGRAM_MAX_ACTIONS
            });

            // Initialize client and get initial state
            const state = await initializeClient(runtime, config);
            elizaLogger.error("[Instagram] Client initialized successfully");

            // Add a longer delay to ensure session is properly established
            elizaLogger.error("[Instagram] Waiting for session to stabilize...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            elizaLogger.error("[Instagram] Session stabilization complete");

            // Create services
            const postService = new InstagramPostService(runtime, state);
            const interactionService = new InstagramInteractionService(
                runtime,
                state
            );
            elizaLogger.error("[Instagram] Services created");

            // Start services
            if (!config.INSTAGRAM_DRY_RUN) {
                await postService.start();
                elizaLogger.error("[Instagram] Post service started");

                if (config.INSTAGRAM_ENABLE_ACTION_PROCESSING) {
                    elizaLogger.error("[Instagram] Starting interaction service...");
                    await interactionService.start();
                    elizaLogger.error("[Instagram] Interaction service started successfully");
                } else {
                    elizaLogger.error("[Instagram] Action processing is disabled");
                }
            } else {
                elizaLogger.error("[Instagram] Client running in dry-run mode");
            }

            // Return manager instance
            return {
                post: postService,
                interaction: interactionService,
                state,
            };
        } catch (error) {
            elizaLogger.error("Failed to start Instagram client:", error);
            throw error;
        }
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.log("Stopping Instagram client services...");
        // Cleanup will be handled by the services themselves
    },
};

export default InstagramClientInterface;
export type { InstagramState };
