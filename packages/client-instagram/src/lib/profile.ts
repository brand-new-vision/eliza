import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import type { InstagramConfig, InstagramProfile } from "../types";
import { getIgClient } from "./state";

const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

export async function fetchProfile(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramProfile> {
    const ig = getIgClient();
    if (!ig) throw new Error("Instagram client not initialized");

    let lastError: Error;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Get current user first
            const currentUser = await ig.account.currentUser();

            // Then fetch detailed profile info
            const userInfo = await ig.user.info(currentUser.pk);

            const profile: InstagramProfile = {
                id: userInfo.pk.toString(),
                username: userInfo.username,
                name: userInfo.full_name,
                biography: userInfo.biography,
                mediaCount: userInfo.media_count,
                followerCount: userInfo.follower_count,
                followingCount: userInfo.following_count
            };

            // Cache profile info
            await runtime.cacheManager.set(
                `instagram/profile/${config.INSTAGRAM_USERNAME}`,
                profile
            );

            elizaLogger.log("[Instagram] Fetched and cached profile:", {
                username: profile.username,
                id: profile.id
            });

            return profile;
        } catch (error) {
            lastError = error;
            elizaLogger.warn(`[Instagram] Profile fetch attempt ${attempt}/${MAX_RETRIES} failed:`, {
                error: error.message,
                code: error.code,
                attempt,
                nextRetry: attempt < MAX_RETRIES ? `${RETRY_DELAY}ms` : 'giving up'
            });

            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                continue;
            }
        }
    }

    elizaLogger.error("[Instagram] All profile fetch attempts failed");
    throw lastError;
}
