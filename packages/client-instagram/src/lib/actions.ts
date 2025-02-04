// src/lib/actions.ts
import { elizaLogger } from "@elizaos/core";
import type { Comment } from "../types";
import { getIgClient } from "./state";

/**
 * Fetches comments for a specific media post
 */
export async function fetchComments(
  mediaId: string,
  count = 20
): Promise<Comment[]> {
  const ig = getIgClient();
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    elizaLogger.debug("[Instagram] Fetching comments for media:", mediaId);
    const feed = ig.feed.mediaComments(mediaId);
    const comments = await feed.items();

    const processedComments = comments.slice(0, count).map(comment => ({
      id: comment.pk.toString(),
      text: comment.text,
      timestamp: new Date(comment.created_at * 1000).toISOString(),
      username: comment.user.username,
      replies: [] // Instagram API doesn't provide replies in the same call
    }));

    elizaLogger.debug("[Instagram] Processed comments:", {
      mediaId,
      count: processedComments.length
    });

    return processedComments;
  } catch (error) {
    elizaLogger.error('[Instagram] Error fetching comments:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Posts a comment on a media post
 */
export async function postComment(
  mediaId: string,
  text: string
): Promise<Comment> {
  const ig = getIgClient();
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    elizaLogger.debug("[Instagram] Posting comment:", {
      mediaId,
      text: text.slice(0, 100) + (text.length > 100 ? '...' : '')
    });

    const result = await ig.media.comment({
      mediaId,
      text: text.slice(0, 2200) // Instagram comment length limit
    });

    const processedComment = {
      id: result.pk.toString(),
      text: result.text,
      timestamp: new Date(result.created_at * 1000).toISOString(),
      username: result.user.username,
      replies: []
    };

    elizaLogger.debug("[Instagram] Comment posted successfully:", {
      mediaId,
      commentId: processedComment.id
    });

    return processedComment;
  } catch (error) {
    elizaLogger.error('[Instagram] Error posting comment:', {
      mediaId,
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
  if (!ig) throw new Error("Instagram client not initialized");

  try {
    elizaLogger.debug("[Instagram] Attempting to like media:", mediaId);
    await ig.media.like({
      mediaId,
      moduleInfo: {
        module_name: 'feed_timeline'
      },
      d: 1
    });
    elizaLogger.debug("[Instagram] Successfully liked media:", mediaId);
  } catch (error) {
    elizaLogger.error('[Instagram] Error liking media:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error)
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