// src/lib/auth.ts
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { IgLoginTwoFactorRequiredError, IgApiClient } from "instagram-private-api";
import type { InstagramConfig } from "../environment";
import type { InstagramState } from "../types";
import { fetchProfile } from "./profile";
import { createInitialState, getIgClient, setIgClient, clearIgClient } from "./state";

/**
 * Authenticates with Instagram
 */
export async function authenticate(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramState> {
    if (!config.INSTAGRAM_USERNAME || !config.INSTAGRAM_PASSWORD) {
        throw new Error('Instagram username and password are required');
    }

    const ig = new IgApiClient();
    const state = createInitialState();
    const MAX_RETRIES = 3;

    try {
        // Generate device ID first
        ig.state.generateDevice(config.INSTAGRAM_USERNAME);

        // Configure request defaults with longer timeout
        ig.request.defaults.timeout = 60000; // 60 second timeout

        // Try to load cached session first
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

        // Perform fresh login
        try {
            // Try prelogin simulation but don't fail if it times out
            try {
                await Promise.race([
                    ig.simulate.preLoginFlow(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Prelogin timeout')), 10000)
                    )
                ]);
            } catch (error) {
                elizaLogger.warn("[Instagram] PreLogin simulation skipped:", error.message);
                // Continue with login anyway
            }

            // Perform login with retry
            let retryCount = 0;
            while (retryCount < MAX_RETRIES) {
                try {
                    const loggedInUser = await ig.account.login(
                        config.INSTAGRAM_USERNAME,
                        config.INSTAGRAM_PASSWORD
                    );

                    // Cache the session after successful login
                    const serialized = await ig.state.serialize();
                    await runtime.cacheManager.set("instagram/session", serialized);

                    // Set up state persistence for future requests
                    ig.request.end$.subscribe(async () => {
                        const serialized = await ig.state.serialize();
                        await runtime.cacheManager.set("instagram/session", serialized);
                    });

                    // Set client after successful login
                    setIgClient(ig);

                    // Skip post-login flow if pre-login failed
                    try {
                        await Promise.race([
                            ig.simulate.postLoginFlow(),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Postlogin timeout')), 10000)
                            )
                        ]);
                    } catch (error) {
                        elizaLogger.warn("[Instagram] PostLogin simulation skipped:", error.message);
                    }

                    const profile = await fetchProfile(runtime, config);

                    return {
                        ...state,
                        isInitialized: true,
                        profile,
                    };
                } catch (error) {
                    retryCount++;
                    if (error.code === 'ETIMEDOUT' && retryCount < MAX_RETRIES) {
                        elizaLogger.warn(`[Instagram] Login attempt ${retryCount} failed, retrying in 5s...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }
                    throw error;
                }
            }
        } catch (error) {
            if (error.code === 'ETIMEDOUT') {
                throw new Error(`Instagram API timeout after ${MAX_RETRIES} attempts. Please check your network connection or try again later.`);
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
export { setupWebhooks };
