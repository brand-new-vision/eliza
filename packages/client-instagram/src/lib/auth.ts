// src/lib/auth.ts
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { IgLoginTwoFactorRequiredError, IgApiClient } from "instagram-private-api";
import type { InstagramConfig } from "../types";
import type { InstagramState } from "../types";
import { fetchProfile } from "./profile";
import { createInitialState, getIgClient, setIgClient, clearIgClient } from "./state";

/**
 * Authenticates with Instagram
 */
async function authenticate(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramState> {
    if (!config.INSTAGRAM_USERNAME || !config.INSTAGRAM_PASSWORD) {
        throw new Error('Instagram username and password are required');
    }

    const ig = new IgApiClient();
    const state = createInitialState();

    try {
        // Generate device ID first
        ig.state.generateDevice(config.INSTAGRAM_USERNAME);

        // Configure request defaults
        ig.request.defaults.timeout = 30000; // 30 second timeout

        // Try to load cached session first to avoid unnecessary API calls
        const cachedSession = await runtime.cacheManager.get("instagram/session");
        if (cachedSession) {
            try {
                await ig.state.deserialize(cachedSession);
                await ig.account.currentUser();
                setIgClient(ig);
                const profile = await fetchProfile(runtime, config);
                return {
                    ...state,
                    isInitialized: true,
                    profile,
                };
            } catch (error) {
                elizaLogger.warn("[Instagram] Cached session invalid, proceeding with fresh login");
            }
        }

        // Perform fresh login with proper error handling
        try {
            await ig.simulate.preLoginFlow().catch(error => {
                elizaLogger.warn("[Instagram] PreLogin simulation failed:", error);
                // Continue anyway as this is not critical
            });

            const loggedInUser = await ig.account.login(
                config.INSTAGRAM_USERNAME,
                config.INSTAGRAM_PASSWORD
            );

            await ig.simulate.postLoginFlow().catch(error => {
                elizaLogger.warn("[Instagram] PostLogin simulation failed:", error);
                // Continue anyway as this is not critical
            });

            // Now we can safely set the client
            setIgClient(ig);

            // Cache the session after successful login
            const serialized = await ig.state.serialize();
            await runtime.cacheManager.set("instagram/session", serialized);

            // Set up state persistence for future requests
            ig.request.end$.subscribe(async () => {
                const serialized = await ig.state.serialize();
                await runtime.cacheManager.set("instagram/session", serialized);
            });

            const profile = await fetchProfile(runtime, config);

            return {
                ...state,
                isInitialized: true,
                profile,
            };
        } catch (error) {
            if (error.code === 'ETIMEDOUT') {
                throw new Error(`Instagram API timeout. Please check your network connection or try again later. Details: ${error.message}`);
            }
            throw error;
        }
    } catch (error) {
        if (error instanceof IgLoginTwoFactorRequiredError) {
            throw new Error("2FA authentication not yet implemented");
        }
        elizaLogger.error("[Instagram] Authentication failed:", error);
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
        clearIgClient();
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
        const ig = getIgClient();
        if (!ig) return false;

        // Try to verify current session
        try {
            await ig.account.currentUser();
            return true;
        } catch (error) {
            elizaLogger.warn("[Instagram] Session expired, attempting refresh");

            async function loadSession(ig: IgApiClient): Promise<boolean> {
                try {
                    const cachedSession = await runtime.cacheManager.get("instagram/session");
                    if (cachedSession) {
                        await ig.state.deserialize(cachedSession);
                        return true;
                    }
                } catch (error) {
                    elizaLogger.warn("[Instagram] Failed to load cached session");
                }
                return false;
            }

            // Try to reuse saved session first
            if (await loadSession(ig)) {
                try {
                    await ig.account.currentUser();
                    elizaLogger.log("[Instagram] Session refreshed from saved state");
                    return true;
                } catch (e) {
                    elizaLogger.warn("[Instagram] Saved session also expired");
                }
            }

            // Fall back to fresh login
            await ig.account.login(
                config.INSTAGRAM_USERNAME,
                config.INSTAGRAM_PASSWORD
            );

            const serialized = await ig.state.serialize();
            await runtime.cacheManager.set("instagram/session", serialized);
            elizaLogger.log("[Instagram] Session refreshed with new login");
            return true;
        }
    } catch (error) {
        elizaLogger.error("[Instagram] Failed to refresh session:", error);
        return false;
    }
}

// Export other authentication related functions if needed
export { authenticate, setupWebhooks };
