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

    try {
        elizaLogger.log("[Instagram] Fetching activities using multiple feeds");
        const activities = [];

        // Get direct inbox items
        const inbox = await ig.feed.directInbox().items();
        activities.push(...inbox.map(item => ({
            type: 'direct',
            ...item
        })));

        // Get user's own media feed
        const userFeed = await ig.feed.user(ig.state.cookieUserId).items();

        // Get comments on recent posts
        for (const post of userFeed.slice(0, 5)) { // Only check last 5 posts
            const comments = await ig.feed.mediaComments(post.id).items();
            activities.push(...comments.map(comment => ({
                type: 'comment',
                mediaId: post.id,
                ...comment
            })));
        }

        // Get timeline feed for mentions
        const timeline = await ig.feed.timeline().items();
        const mentions = timeline.filter(item =>
            item.caption?.text?.includes(`@${ig.state.cookieUsername}`)
        );
        activities.push(...mentions.map(item => ({
            type: 'mention',
            ...item
        })));

        elizaLogger.log("[Instagram] Fetched activities:", {
            total: activities.length,
            types: activities.reduce((acc, curr) => {
                acc[curr.type] = (acc[curr.type] || 0) + 1;
                return acc;
            }, {})
        });

        return activities;
    } catch (error) {
        elizaLogger.error('[Instagram] Error fetching activities:', error);
        throw error;
    }
}