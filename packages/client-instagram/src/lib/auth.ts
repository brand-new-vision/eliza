// src/lib/auth.ts
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { IgLoginTwoFactorRequiredError, IgApiClient } from "instagram-private-api";
import type { InstagramConfig } from "../environment";
import type { InstagramState } from "../types";
import { fetchProfile } from "./profile";
import { createInitialState, getIgClient, setIgClient } from "./state";

/**
 * Authenticates with Instagram
 */
async function authenticate(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramState> {
    const ig = new IgApiClient();
    const state = createInitialState();

    try {
        // Generate device ID first - this is required before any operation
        ig.state.generateDevice(config.INSTAGRAM_USERNAME);
        setIgClient(ig);

        // Execute pre-login simulation as recommended by library
        await ig.simulate.preLoginFlow();

        // Perform login
        const loggedInUser = await ig.account.login(
            config.INSTAGRAM_USERNAME,
            config.INSTAGRAM_PASSWORD
        );

        // Execute post-login simulation and wait for it to complete
        try {
            // First do the essential session setup steps that must succeed
            await ig.zr.tokenResult();
            await ig.launcher.postLoginSync();
            await ig.attribution.logAttribution();

            // Then do the full post-login flow as intended by the library
            try {
                await ig.simulate.postLoginFlow();
            } catch (error) {
                // Log but don't fail - these are enhancement steps
                elizaLogger.warn("[Instagram] Full post-login flow had some failures (non-critical):", {
                    error: error instanceof Error ? error.message : String(error),
                    username: config.INSTAGRAM_USERNAME
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Critical post-login steps failed:", {
                error: error instanceof Error ? error.message : String(error),
                username: config.INSTAGRAM_USERNAME
            });
            // We should throw here as these are essential steps
            throw error;
        }

        // Fetch profile after successful login
        const profile = await fetchProfile(runtime, config);

        return {
            ...state,
            isInitialized: true,
            profile,
        };
    } catch (error) {
        if (error instanceof IgLoginTwoFactorRequiredError) {
            throw new Error("2FA authentication not yet implemented");
        }
        elizaLogger.error("[Instagram] Authentication failed:", {
            error: error instanceof Error ? error.message : String(error),
            username: config.INSTAGRAM_USERNAME
        });
        throw error;
    }
}

/**
 * Sets up webhooks for real-time updates if needed
 */
async function setupWebhooks() {
    // Implement webhook setup
    // This is a placeholder for future implementation
}

/**
 * Initializes the Instagram client
 */
export async function initializeClient(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramState> {
    try {
        return await authenticate(runtime, config);
    } catch (error) {
        elizaLogger.error("[Instagram] Failed to initialize Instagram client:", error);
        throw error;
    }
}

export async function refreshSession(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<boolean> {
    try {
        const ig = new IgApiClient();
        ig.state.generateDevice(config.INSTAGRAM_USERNAME);

        // Execute pre-login simulation
        await ig.simulate.preLoginFlow();

        // Perform login
        await ig.account.login(config.INSTAGRAM_USERNAME, config.INSTAGRAM_PASSWORD);

        // Set client and execute post-login simulation
        setIgClient(ig);
        try {
            // First do the essential session setup steps that must succeed
            await ig.zr.tokenResult();
            await ig.launcher.postLoginSync();
            await ig.attribution.logAttribution();

            // Then do the full post-login flow as intended by the library
            try {
                await ig.simulate.postLoginFlow();
            } catch (error) {
                // Log but don't fail - these are enhancement steps
                elizaLogger.warn("[Instagram] Full post-login flow had some failures (non-critical):", {
                    error: error instanceof Error ? error.message : String(error),
                    username: config.INSTAGRAM_USERNAME
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Critical post-login steps failed:", {
                error: error instanceof Error ? error.message : String(error),
                username: config.INSTAGRAM_USERNAME
            });
            // We should throw here as these are essential steps
            throw error;
        }

        return true;
    } catch (error) {
        elizaLogger.error("[Instagram] Failed to refresh session:", {
            error: error instanceof Error ? error.message : String(error),
            username: config.INSTAGRAM_USERNAME
        });
        return false;
    }
}

// Export other authentication related functions if needed
export { setupWebhooks };
