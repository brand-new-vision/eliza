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

  try {
    const feed = ig.feed.mediaComments(mediaId);
    const comments = await feed.items();

    return comments.slice(0, count).map(comment => ({
      id: comment.pk.toString(),
      text: comment.text,
      timestamp: new Date(comment.created_at * 1000).toISOString(),
      username: comment.user.username,
      replies: [] // Instagram API doesn't provide replies in the same call
    }));
  } catch (error) {
    elizaLogger.error('Error fetching comments:', error);
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

  try {
    const result = await ig.media.comment({
      mediaId,
      text: text.slice(0, 2200) // Instagram comment length limit
    });

    return {
      id: result.pk.toString(),
      text: result.text,
      timestamp: new Date(result.created_at * 1000).toISOString(),
      username: result.user.username,
      replies: []
    };
  } catch (error) {
    elizaLogger.error('Error posting comment:', error);
    throw error;
  }
}

/**
 * Likes a media post
 */
export async function likeMedia(mediaId: string): Promise<void> {
  const ig = getIgClient();

  try {
    await ig.media.like({
      mediaId,
      moduleInfo: {
        module_name: 'profile',
        user_id: ig.state.cookieUserId,
        username: ig.state.cookieUsername
      },
      d: 1  // 1 for like, 0 for unlike
    });
    elizaLogger.log(`Liked media: ${mediaId}`);
  } catch (error) {
    elizaLogger.error('Error liking media:', error);
    throw error;
  }
}

/**
 * Unlikes a media post
 */
export async function unlikeMedia(mediaId: string): Promise<void> {
  const ig = getIgClient();

  try {
    await ig.media.unlike({
      mediaId,
      moduleInfo: {
        module_name: 'profile',
        user_id: ig.state.cookieUserId,
        username: ig.state.cookieUsername
      }
    });
    elizaLogger.log(`Unliked media: ${mediaId}`);
  } catch (error) {
    elizaLogger.error('Error unliking media:', error);
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

  try {
    const result = await ig.media.comment({
      mediaId,
      text: text.slice(0, 2200), // Instagram comment length limit
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
    elizaLogger.error('Error replying to comment:', error);
    throw error;
  }
}

/**
 * Deletes a comment
 */
export async function deleteComment(
  mediaId: string,
  commentId: string
): Promise<void> {
  const ig = getIgClient();
  try {
    await ig.media.comment.delete(mediaId, commentId);
    elizaLogger.log(`Deleted comment: ${commentId} from media: ${mediaId}`);
  } catch (error) {
    elizaLogger.error('Error deleting comment:', error);
    throw error;
  }
}

/**
 * Checks if current user has liked a media post
 */
export async function hasLikedMedia(mediaId: string): Promise<boolean> {
  const ig = getIgClient();

  try {
    const info = await ig.media.info(mediaId);
    return info.items[0].has_liked ?? false;
  } catch (error) {
    elizaLogger.error('Error checking if media is liked:', error);
    throw error;
  }
}

/**
 * Fetches recent activities (alternative to news feed)
 */
export async function fetchActivities(): Promise<any[]> {
    const ig = getIgClient();
    if (!ig) {
        throw new Error('Instagram client not initialized');
    }

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000;
    let lastError: Error;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            elizaLogger.log("[Instagram] Starting activity fetch cycle (attempt " + attempt + "/" + MAX_RETRIES + ")");
            const activities = [];

            // First get current user info
            const currentUser = await ig.account.currentUser();
            const userId = currentUser.pk;
            const username = currentUser.username;
            elizaLogger.log("[Instagram] Logged in as:", username);

            // Get direct inbox items with retry
            elizaLogger.log("[Instagram] Fetching direct messages...");
            const inbox = await ig.feed.directInbox().items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch inbox:", error.message);
                return [];
            });
            elizaLogger.log(`[Instagram] Found ${inbox.length} direct messages`);
            activities.push(...inbox.map(item => ({
                type: 'direct',
                ...item
            })));

            // Get user's own media feed with retry
            elizaLogger.log("[Instagram] Fetching user's recent posts...");
            const userFeed = await ig.feed.user(userId).items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch user feed:", error.message);
                return [];
            });
            elizaLogger.log(`[Instagram] Found ${userFeed.length} recent posts`);

            // Get comments on recent posts
            elizaLogger.log("[Instagram] Fetching comments on recent posts...");
            let totalComments = 0;
            for (const post of userFeed.slice(0, 5)) {
                try {
                    const comments = await ig.feed.mediaComments(post.id).items();
                    totalComments += comments.length;
                    elizaLogger.log(`[Instagram] Found ${comments.length} comments on post ${post.id}`);
                    activities.push(...comments.map(comment => ({
                        type: 'comment',
                        mediaId: post.id,
                        ...comment
                    })));
                } catch (error) {
                    elizaLogger.warn(`[Instagram] Failed to fetch comments for post ${post.id}:`, error.message);
                }
            }
            elizaLogger.log(`[Instagram] Total comments found: ${totalComments}`);

            // Get timeline feed with retry
            elizaLogger.log("[Instagram] Fetching timeline for mentions...");
            const timeline = await ig.feed.timeline().items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch timeline:", error.message);
                return [];
            });
            const mentions = timeline.filter(item =>
                item.caption?.text?.includes(`@${username}`)
            );
            elizaLogger.log(`[Instagram] Found ${mentions.length} mentions in timeline`);
            activities.push(...mentions.map(item => ({
                type: 'mention',
                ...item
            })));

            // Log activity summary
            const activitySummary = activities.reduce((acc, curr) => {
                acc[curr.type] = (acc[curr.type] || 0) + 1;
                return acc;
            }, {});

            elizaLogger.log("[Instagram] Activity fetch summary:", {
                total: activities.length,
                breakdown: Object.entries(activitySummary).map(([type, count]) =>
                    `${type}: ${count}`
                ).join(', ')
            });

            return activities;
        } catch (error) {
            lastError = error;
            elizaLogger.warn(`[Instagram] Activities fetch attempt ${attempt}/${MAX_RETRIES} failed:`, {
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

    elizaLogger.error("[Instagram] All activity fetch attempts failed");
    throw lastError;
}