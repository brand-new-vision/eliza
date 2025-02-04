import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import type { InstagramConfig } from "../environment";
import type { MediaItem } from "../types";
import { getIgClient } from "./state";

export async function fetchRecentMedia(
    runtime: IAgentRuntime,
    config: InstagramConfig,
    count = 10
): Promise<MediaItem[]> {
    const ig = getIgClient();
    if (!ig) throw new Error("Instagram client not initialized");

    try {
        // First get the user ID properly
        const user = await ig.user.searchExact(config.INSTAGRAM_USERNAME);

        // Then get their feed using the proper ID
        const feed = ig.feed.user(user.pk);
        const items = await feed.items();

        elizaLogger.debug("[Instagram] Fetched media items:", {
            username: config.INSTAGRAM_USERNAME,
            count: items.length
        });

        return items.slice(0, count).map((item: any) => ({
            id: item.id,
            mediaType: item.media_type,
            mediaUrl: item.media_url,
            thumbnailUrl: item.thumbnail_url || null,
            permalink: item.permalink,
            caption: item.caption?.text || null,
            timestamp: item.timestamp,
            children: item.children?.map((child: any) => ({
                id: child.id,
                mediaType: child.media_type,
                mediaUrl: child.media_url,
                thumbnailUrl: child.thumbnail_url || null,
                permalink: child.permalink,
                timestamp: child.timestamp
            })) || null
        }));
    } catch (error) {
        elizaLogger.error('[Instagram] Error fetching recent media:', {
            username: config.INSTAGRAM_USERNAME,
            error: error.message
        });
        throw error;
    }
}