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
    elizaLogger.debug("[Instagram] Fetching comments for media:", mediaId);
    const feed = ig.feed.mediaComments(mediaId);
    const comments = await feed.items();

    elizaLogger.debug("[Instagram] Raw comments fetched:", {
      mediaId,
      count: comments.length,
      usernames: comments.map(c => c.user.username)
    });

    const processedComments = comments.slice(0, count).map(comment => ({
      id: comment.pk.toString(),
      text: comment.text,
      timestamp: new Date(comment.created_at * 1000).toISOString(),
      username: comment.user.username,
      replies: [] // Instagram API doesn't provide replies in the same call
    }));

    elizaLogger.debug("[Instagram] Processed comments:", {
      mediaId,
      count: processedComments.length,
      comments: processedComments.map(c => ({
        username: c.username,
        timestamp: c.timestamp,
        text: c.text
      }))
    });

    return processedComments;
  } catch (error) {
    elizaLogger.error('[Instagram] Error fetching comments:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
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

  try {
    elizaLogger.debug("[Instagram] Posting comment:", {
      mediaId,
      text: text.slice(0, 100) + (text.length > 100 ? '...' : '') // Log truncated text for readability
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
      commentId: processedComment.id,
      timestamp: processedComment.timestamp
    });

    return processedComment;
  } catch (error) {
    elizaLogger.error('[Instagram] Error posting comment:', {
      mediaId,
      text: text.slice(0, 100) + (text.length > 100 ? '...' : ''),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

/**
 * Likes a media post
 */
export async function likeMedia(mediaId: string): Promise<void> {
  const ig = getIgClient();

  try {
    elizaLogger.debug("[Instagram] Attempting to like media:", mediaId);

    await ig.media.like({
      mediaId,
      moduleInfo: {
        module_name: 'profile',
        user_id: ig.state.cookieUserId,
        username: ig.state.cookieUsername
      },
      d: 1  // 1 for like, 0 for unlike
    });

    elizaLogger.log("[Instagram] Successfully liked media:", {
      mediaId,
      username: ig.state.cookieUsername,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    elizaLogger.error('[Instagram] Error liking media:', {
      mediaId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
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
            elizaLogger.debug("[Instagram] Current user details:", {
                userId,
                username,
                timestamp: new Date().toISOString()
            });

            // Get direct inbox items with retry
            elizaLogger.debug("[Instagram] Fetching direct messages...");
            const inbox = await ig.feed.directInbox().items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch inbox:", {
                    error: error.message,
                    attempt
                });
                return [];
            });
            elizaLogger.debug("[Instagram] Direct messages fetched:", {
                count: inbox.length,
                timestamps: inbox.map(item => new Date(item.timestamp * 1000).toISOString())
            });
            activities.push(...inbox.map(item => ({
                type: 'direct',
                ...item
            })));

            // Get user's own media feed with retry
            elizaLogger.debug("[Instagram] Fetching user's recent posts...");
            const userFeed = await ig.feed.user(userId).items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch user feed:", {
                    error: error.message,
                    attempt
                });
                return [];
            });
            elizaLogger.debug("[Instagram] User feed fetched:", {
                count: userFeed.length,
                timestamps: userFeed.map(post => new Date(post.taken_at * 1000).toISOString())
            });

            // Get comments on recent posts
            elizaLogger.debug("[Instagram] Fetching comments on recent posts...");
            let totalComments = 0;
            for (const post of userFeed.slice(0, 5)) {
                try {
                    const comments = await ig.feed.mediaComments(post.id).items();
                    totalComments += comments.length;
                    elizaLogger.debug("[Instagram] Comments fetched for post:", {
                        postId: post.id,
                        commentCount: comments.length,
                        timestamps: comments.map(c => new Date(c.created_at * 1000).toISOString())
                    });
                    activities.push(...comments.map(comment => ({
                        type: 'comment',
                        mediaId: post.id,
                        ...comment
                    })));
                } catch (error) {
                    elizaLogger.warn("[Instagram] Failed to fetch comments for post:", {
                        postId: post.id,
                        error: error.message,
                        attempt
                    });
                }
            }
            elizaLogger.debug("[Instagram] Total comments processed:", totalComments);

            // Get timeline feed with retry
            elizaLogger.debug("[Instagram] Fetching timeline for mentions...");
            const timeline = await ig.feed.timeline().items().catch(error => {
                elizaLogger.warn("[Instagram] Failed to fetch timeline:", {
                    error: error.message,
                    attempt
                });
                return [];
            });
            const mentions = timeline.filter(item =>
                item.caption?.text?.includes(`@${username}`)
            );
            elizaLogger.debug("[Instagram] Mentions found in timeline:", {
                total: mentions.length,
                usernames: mentions.map(m => m.user.username),
                timestamps: mentions.map(m => new Date(m.taken_at * 1000).toISOString())
            });
            activities.push(...mentions.map(item => ({
                type: 'mention',
                ...item
            })));

            // Log activity summary
            const activitySummary = activities.reduce((acc, curr) => {
                acc[curr.type] = (acc[curr.type] || 0) + 1;
                return acc;
            }, {});

            elizaLogger.log("[Instagram] Activity fetch cycle completed:", {
                attempt,
                summary: activitySummary,
                totalActivities: activities.length
            });

            return activities;
        } catch (error) {
            lastError = error;
            elizaLogger.error("[Instagram] Error in activity fetch cycle:", {
                attempt,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });

            if (attempt < MAX_RETRIES) {
                elizaLogger.log(`[Instagram] Retrying in ${RETRY_DELAY}ms...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
    }

    throw lastError;
}