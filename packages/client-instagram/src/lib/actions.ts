// src/lib/actions.ts
import { elizaLogger } from "@elizaos/core";
import type { Comment, MediaItem } from "../types";
import { getIgClient } from "./state";

/**
 * Publishes a photo to Instagram
 */
export async function publishPhoto(file: Buffer, caption?: string): Promise<MediaItem> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const result = await ig.publish.photo({
            file,
            caption,
        });

        elizaLogger.debug("[Instagram API] Published photo", {
            mediaId: result.media.pk
        });

        return {
            id: result.media.pk.toString(),
            mediaType: 'IMAGE',
            mediaUrl: result.media.image_versions2?.candidates?.[0]?.url || '',
            permalink: `https://instagram.com/p/${result.media.code}/`,
            timestamp: new Date(result.media.taken_at * 1000).toISOString()
        };
    } catch (error) {
        elizaLogger.error("[Instagram API] Error publishing photo:", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Publishes a video to Instagram
 */
export async function publishVideo(video: Buffer, coverImage: Buffer, caption?: string): Promise<MediaItem> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const result = await ig.publish.video({
            video,
            coverImage,
            caption,
        });

        elizaLogger.debug("[Instagram API] Published video", {
            mediaId: result.media.pk
        });

        return {
            id: result.media.pk.toString(),
            mediaType: 'VIDEO',
            mediaUrl: (result.media as any).video_versions?.[0]?.url || '',
            permalink: `https://instagram.com/p/${result.media.code}/`,
            timestamp: new Date(result.media.taken_at * 1000).toISOString()
        };
    } catch (error) {
        elizaLogger.error("[Instagram API] Error publishing video:", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Publishes a carousel/album to Instagram
 */
export async function publishAlbum(items: Array<{ file: Buffer }>, caption?: string): Promise<MediaItem> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const result = await ig.publish.album({
            items,
            caption,
        });

        elizaLogger.debug("[Instagram API] Published album", {
            mediaId: result.id,
            itemCount: items.length
        });

        return result;
    } catch (error) {
        elizaLogger.error("[Instagram API] Error publishing album:", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Fetches user's timeline/feed posts
 */
export async function fetchTimelinePosts(count: number = 20): Promise<MediaItem[]> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const feed = ig.feed.timeline();
        const items = await feed.items();

        elizaLogger.debug("[Instagram API] Fetched timeline posts", {
            count: items.length
        });

        return items.slice(0, count).map(item => ({
            id: item.pk.toString(),
            mediaType: item.media_type === 1 ? 'IMAGE' :
                     item.media_type === 2 ? 'VIDEO' : 'CAROUSEL_ALBUM',
            mediaUrl: item.image_versions2?.candidates?.[0]?.url || '',
            permalink: `https://instagram.com/p/${item.code}/`,
            timestamp: new Date(item.taken_at * 1000).toISOString()
        }));
    } catch (error) {
        elizaLogger.error("[Instagram API] Error fetching timeline:", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Likes a media post
 */
export async function likeMedia(mediaId: string): Promise<void> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        // Ensure mediaId is in the correct format
        const formattedMediaId = mediaId.includes('_') ? mediaId.split('_')[0] : mediaId;

        elizaLogger.debug("[Instagram API] Attempting to like media:", {
            originalId: mediaId,
            formattedId: formattedMediaId
        });

        await ig.media.like({
            mediaId: formattedMediaId,
            moduleInfo: {
                module_name: "feed_timeline"
            },
            d: 1
        });

        elizaLogger.debug("[Instagram API] Successfully liked media", {
            mediaId: formattedMediaId
        });
    } catch (error) {
        elizaLogger.error("[Instagram API] Error liking media:", {
            error: error instanceof Error ? error.message : String(error),
            mediaId,
            details: error instanceof Error ? error.stack : undefined
        });
        throw error;
    }
}

/**
 * Posts a comment on a media
 */
export async function postComment(mediaId: string, text: string): Promise<Comment> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const result = await ig.media.comment({
            mediaId,
            text: text.slice(0, 2200) // Instagram comment length limit
        });

        elizaLogger.debug("[Instagram API] Posted comment", {
            mediaId,
            commentId: result.pk
        });

        return {
            id: result.pk.toString(),
            text: result.text,
            timestamp: new Date(result.created_at * 1000).toISOString(),
            username: result.user.username,
            replies: []
        };
    } catch (error) {
        elizaLogger.error("[Instagram API] Error posting comment:", {
            error: error instanceof Error ? error.message : String(error),
            mediaId
        });
        throw error;
    }
}

/**
 * Sends a direct message
 */
export async function sendDirectMessage(threadId: string, text: string): Promise<void> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        await ig.directThread.broadcast({
            threadIds: [threadId],
            item: 'text',
            form: { text }
        });

        elizaLogger.debug("[Instagram API] Sent direct message", {
            threadId
        });
    } catch (error) {
        elizaLogger.error("[Instagram API] Error sending direct message:", {
            error: error instanceof Error ? error.message : String(error),
            threadId
        });
        throw error;
    }
}

/**
 * Fetches direct message inbox
 */
export async function fetchDirectInbox(count: number = 20): Promise<any[]> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const inbox = await ig.feed.directInbox().items();

        elizaLogger.debug("[Instagram API] Fetched direct inbox", {
            count: inbox.length
        });

        return inbox.slice(0, count);
    } catch (error) {
        elizaLogger.error("[Instagram API] Error fetching direct inbox:", {
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

/**
 * Fetches comments on a media post
 */
export async function fetchComments(mediaId: string, count: number = 20): Promise<Comment[]> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error("Instagram client not initialized");
    }

    try {
        const feed = ig.feed.mediaComments(mediaId);
        const comments = (await feed.items()).map(comment => ({
            id: comment.pk.toString(),
            text: comment.text,
            timestamp: new Date(comment.created_at * 1000).toISOString(),
            username: comment.user.username,
            replies: []
        }));

        elizaLogger.debug("[Instagram API] Fetched comments", {
            mediaId,
            count: comments.length
        });

        return comments.slice(0, count);
    } catch (error) {
        elizaLogger.error("[Instagram API] Error fetching comments:", {
            error: error instanceof Error ? error.message : String(error),
            mediaId
        });
        throw error;
    }
}

/**
 * Unlikes a media post
 */
export async function unlikeMedia(mediaId: string): Promise<void> {
  const ig = getIgClient();
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    await ig.media.unlike({
      mediaId,
      moduleInfo: {
        module_name: 'feed_timeline'
      },
      d: 0
    });
    elizaLogger.debug("[Instagram] Unliked media:", mediaId);
  } catch (error) {
    elizaLogger.error('[Instagram] Error unliking media:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Replies to a comment
 */
export async function replyToComment(
  mediaId: string,
  commentId: string,
  text: string
): Promise<Comment> {
  const ig = getIgClient();
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    const result = await ig.media.comment({
      mediaId,
      text: text.slice(0, 2200),
      replyToCommentId: commentId
    });

    return {
      id: result.pk.toString(),
      text: result.text,
      timestamp: new Date(result.created_at * 1000).toISOString(),
      username: result.user.username,
      replies: []
    };
  } catch (error) {
    elizaLogger.error('[Instagram] Error replying to comment:', {
      mediaId,
      commentId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Checks if current user has liked a media post
 */
export async function hasLikedMedia(mediaId: string): Promise<boolean> {
  const ig = getIgClient();
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    const info = await ig.media.info(mediaId);
    return info.items[0].has_liked ?? false;
  } catch (error) {
    elizaLogger.error('[Instagram] Error checking if media is liked:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Fetches recent activities (alternative to news feed)
 */
export async function fetchActivities(username: string): Promise<any[]> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error('Instagram client not initialized');
    }

    try {
        elizaLogger.debug("[Instagram] Starting activity fetch");
        const activities = [];

        // Get user info using searchExact
        const user = await ig.user.searchExact(username);
        elizaLogger.debug("[Instagram] User details:", {
            userId: user.pk,
            username: user.username,
            timestamp: new Date().toISOString()
        });

        // Get direct inbox items
        elizaLogger.debug("[Instagram] Fetching direct messages...");
        const inbox = await ig.feed.directInbox().items();
        elizaLogger.debug("[Instagram] Direct messages fetched:", {
            count: inbox.length
        });
        activities.push(...inbox.map(item => ({
            type: 'direct',
            ...item
        })));

        // Get user's own media feed
        elizaLogger.debug("[Instagram] Fetching user's recent posts...");
        const userFeed = await ig.feed.user(user.pk).items();
        elizaLogger.debug("[Instagram] User feed fetched:", {
            count: userFeed.length
        });
        activities.push(...userFeed.map(item => ({
            type: 'media',
            ...item
        })));

        return activities;
    } catch (error) {
        elizaLogger.error('[Instagram] Error fetching activities:', {
            username,
            error: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}