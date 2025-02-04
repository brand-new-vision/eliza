import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import type { InstagramConfig, InstagramProfile } from "../types";
import { getIgClient } from "./state";

export async function fetchProfile(
    runtime: IAgentRuntime,
    config: InstagramConfig
): Promise<InstagramProfile> {
    const ig = getIgClient();
    if (!ig) throw new Error("Instagram client not initialized");

    try {
        // Get user info directly - no need for currentUser() first
        const user = await ig.user.searchExact(config.INSTAGRAM_USERNAME);
        const userInfo = await ig.user.info(user.pk);

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

        elizaLogger.debug("[Instagram] Profile fetched:", {
            username: profile.username,
            id: profile.id
        });

        return profile;
    } catch (error) {
        elizaLogger.error("[Instagram] Failed to fetch profile:", {
            username: config.INSTAGRAM_USERNAME,
            error: error.message
        });
        throw error;
    }
}
