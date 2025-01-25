import {
    composeContext,
    elizaLogger,
    generateText,
    getEmbeddingZeroVector,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    type UUID
} from "@elizaos/core";
import { fetchComments, likeMedia, postComment, fetchActivities } from "../lib/actions";
import { getIgClient } from "../lib/state";
import { refreshSession } from "../lib/auth";
import type { InstagramState, InstagramConfig } from "../types";
import { IgApiClient } from 'instagram-private-api';

  // Templates
  const instagramCommentTemplate = `
  # Areas of Expertise
  {{knowledge}}

  # About {{agentName}} (@{{instagramUsername}}):
  {{bio}}
  {{lore}}
  {{topics}}

  {{providers}}

  {{characterPostExamples}}

  {{postDirections}}

  # Task: Generate a response to the following Instagram comment in the voice and style of {{agentName}}.
  Original Comment (@{{commentUsername}}): {{commentText}}

  Your response should be friendly, engaging, and natural. Keep it brief (1-2 sentences).
  Do not use hashtags in comment responses. Be conversational and authentic.`;

  const shouldInteractTemplate = `
  # About {{agentName}} (@{{instagramUsername}}):
  {{bio}}
  {{lore}}
  {{topics}}

  {{postDirections}}

  # Task: Determine if {{agentName}} should interact with this content:
  Interaction Type: {{interactionType}}
  User: @{{username}}
  Content: {{content}}

  Consider:
  1. Is this user's content relevant to {{agentName}}'s interests?
  2. Would interaction be authentic and meaningful?
  3. Is there potential for valuable engagement?

  Respond with one of:
  [INTERACT] - Content is highly relevant and engagement would be valuable
  [SKIP] - Content is not relevant enough or engagement wouldn't be authentic

  Choose [INTERACT] only if very confident about relevance and value.`;

  export class InstagramInteractionService {
    private isProcessing = false;
    private stopProcessing = false;
    private checkInterval = 60000; // 1 minute

    constructor(
        private runtime: IAgentRuntime,
        private state: InstagramState
    ) {
        elizaLogger.log("[Instagram] Interaction service initialized");
    }

    async start() {
      elizaLogger.log("[Instagram] Starting interaction service");
      this.stopProcessing = false;
      this.processInteractions();
    }

    async stop() {
      elizaLogger.log("[Instagram] Stopping interaction service");
      this.stopProcessing = true;
    }

    private async processInteractions() {
      if (this.isProcessing) return;

      try {
        this.isProcessing = true;
        elizaLogger.log("[Instagram] Starting interaction check");

        // Single session check at the start
        if (!await this.ensureLogin()) {
          elizaLogger.error("[Instagram] No valid session, skipping interactions");
          return;
        }

        try {
          // Fetch activities first
          const activities = await fetchActivities();
          elizaLogger.log("[Instagram] Fetched activities:", {
            count: activities.length,
            types: activities.map(a => a.type),
            timestamps: activities.map(a => {
              const timestamp = a.timestamp || a.taken_at;
              return timestamp ? new Date(timestamp * 1000).toISOString() : 'unknown';
            })
          });

          // Process activities
          for (const activity of activities) {
            const timestamp = activity.timestamp || activity.taken_at;
            elizaLogger.debug("[Instagram] Processing activity:", {
              type: activity.type,
              timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : 'unknown',
              from: activity.user?.username,
              content: activity.type === 'direct' ? activity.text : activity.caption?.text
            });

            if (activity.type === 'direct') {
              await this.handleDirectMessage(activity);
            } else if (activity.type === 'post') {
              await this.handlePostActivity(activity);
            }
          }

          // Wait before fetching timeline to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 5000));

          // Then fetch timeline
          const timelinePosts = await this.fetchTimelinePosts();
          elizaLogger.log("[Instagram] Fetched timeline:", {
            count: timelinePosts.length,
            usernames: timelinePosts.map(p => p.user.username),
            timestamps: timelinePosts.map(p => new Date(p.taken_at * 1000).toISOString())
          });

          // Process timeline
          for (const post of timelinePosts) {
            elizaLogger.debug("[Instagram] Processing timeline post:", {
              username: post.user.username,
              timestamp: new Date(post.taken_at * 1000).toISOString(),
              caption: post.caption?.text,
              hasMedia: post.media_type === 1 || post.media_type === 2, // 1 = IMAGE, 2 = VIDEO
              mediaType: post.media_type
            });

            const shouldInteract = await this.evaluateInteraction(post);
            elizaLogger.debug("[Instagram] Interaction decision:", {
              postId: post.id,
              username: post.user.username,
              shouldInteract,
              reason: shouldInteract ? 'Content relevant to agent interests' : 'Content not relevant enough'
            });

            if (shouldInteract) {
              await this.processTimelinePost(post);
            }
          }
        } catch (error) {
          // Extract detailed error information
          const errorDetails = {
            message: error instanceof Error ? error.message : String(error),
            name: error?.constructor?.name,
            code: error.code,
            statusCode: error.statusCode,
            request: error.request ? {
              method: error.request.method,
              uri: error.request.uri?.path || error.request.url,
              headers: error.request.headers
            } : undefined,
            response: error.response ? {
              statusCode: error.response.statusCode,
              statusMessage: error.response.statusMessage,
              body: error.response.body
            } : undefined
          };

          // Handle AggregateError specifically
          if (error && error.constructor.name === 'AggregateError') {
            const aggregateDetails = {
              ...errorDetails,
              errors: Array.isArray(error.errors) ? error.errors.map(e => ({
                message: e instanceof Error ? e.message : String(e),
                name: e?.constructor?.name,
                code: e.code,
                statusCode: e.statusCode,
                apiError: e.apiError || e.error,
                endpoint: e.request?.uri?.path || e.request?.url,
                response: e.response ? {
                  statusCode: e.response.statusCode,
                  statusMessage: e.response.statusMessage,
                  body: e.response.body
                } : undefined
              })) : []
            };

            elizaLogger.error("[Instagram] Multiple errors while fetching activities:", aggregateDetails);
          } else {
            elizaLogger.error("[Instagram] Error fetching activities:", errorDetails);
            throw error; // Re-throw non-aggregate errors
          }
        }

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling interactions:", {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name,
          code: error.code,
          statusCode: error.statusCode,
          request: error.request ? {
            method: error.request.method,
            uri: error.request.uri?.path || error.request.url,
            headers: error.request.headers
          } : undefined,
          response: error.response ? {
            statusCode: error.response.statusCode,
            statusMessage: error.response.statusMessage,
            body: error.response.body
          } : undefined
        });
      } finally {
        this.isProcessing = false;
      }
    }

    private async retryOperation<T>(
      operation: () => Promise<T>,
      operationName: string,
      maxRetries = 3,
      retryDelay = 5000
    ): Promise<T> {
      let lastError: Error;
      let currentDelay = retryDelay;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Add delay between attempts even on first try to avoid rate limits
          if (attempt > 1 || operationName.includes('fetch')) {
            await new Promise(resolve => setTimeout(resolve, currentDelay));
          }

          elizaLogger.log(`[Instagram] Attempting ${operationName} (attempt ${attempt}/${maxRetries})`);
          const result = await operation();
          if (attempt > 1) {
            elizaLogger.log(`[Instagram] ${operationName} succeeded after ${attempt} attempts`);
          }
          return result;
        } catch (error) {
          lastError = error;

          // Enhanced error logging for AggregateError
          if (error && error.constructor.name === 'AggregateError') {
            const errorDetails = {
              name: error.constructor.name,
              message: error.message,
              errors: error.errors?.map(e => ({
                name: e?.constructor?.name,
                message: e?.message,
                code: e?.code,
                apiError: e?.apiError,
                response: e?.response ? {
                  statusCode: e?.response?.statusCode,
                  body: e?.response?.body,
                  headers: e?.response?.headers
                } : undefined,
                request: e?.request ? {
                  method: e?.request?.method,
                  url: e?.request?.uri?.path || e?.request?.url,
                  headers: e?.request?.headers
                } : undefined
              }))
            };

            elizaLogger.error(`[Instagram] ${operationName} failed with AggregateError:`,
              JSON.stringify(errorDetails, null, 2)
            );
          }

          const isTimeout = error.code === 'ETIMEDOUT' ||
                          (error.apiError && error.apiError.code === 'ETIMEDOUT');
          const isRateLimit = error.response?.statusCode === 429 ||
                            error.apiError?.error_type === 'rate_limit_error';

          // Adjust delay based on error type
          if (isTimeout || isRateLimit) {
            currentDelay = retryDelay * Math.pow(2, attempt - 1);
            if (isRateLimit) {
              currentDelay += 30000; // Add 30 seconds for rate limits
            }
          }

          elizaLogger.warn(`[Instagram] ${operationName} failed (attempt ${attempt}/${maxRetries}):`, {
            errorType: error?.constructor?.name,
            message: error?.message,
            apiError: error?.apiError,
            code: error?.code,
            isTimeout,
            isRateLimit,
            response: error?.response ? {
              statusCode: error.response.statusCode,
              body: error.response.body
            } : undefined,
            nextRetry: attempt < maxRetries ? `${currentDelay}ms` : 'giving up'
          });

          if (attempt === maxRetries) {
            throw lastError;
          }

          elizaLogger.log(`[Instagram] Waiting ${currentDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, currentDelay));
        }
      }
      throw lastError;
    }

    private async processActivity(item: any) {
      try {
        elizaLogger.log("[Instagram] Processing activity:", {
          type: item.type,
          userId: item.user_id,
          mediaId: item.media_id,
          itemDetails: {
            hasUser: !!item.user,
            username: item.user?.username,
            hasText: !!item.text,
            textPreview: item.text?.substring(0, 50),
            timestamp: new Date().toISOString()
          }
        });

        // Process based on activity type
        switch (item.type) {
          case 2: // Comment
            elizaLogger.log("[Instagram] Responding to comment", {
              mediaId: item.media_id,
              commentId: item.id,
              username: item.user?.username,
              textPreview: item.text?.substring(0, 50),
              hasLikedComment: item.has_liked_comment
            });
            await this.handleComment(item);
            break;
          case 3: // Like
            elizaLogger.log("[Instagram] Processing like activity", {
              mediaId: item.media_id,
              username: item.user?.username,
              timestamp: item.timestamp,
              hasPost: !!item.media
            });
            await this.handleLike(item);
            break;
          case 12: // Mention
            elizaLogger.log("[Instagram] Processing mention", {
              mediaId: item.media_id,
              username: item.user?.username,
              textPreview: item.text?.substring(0, 50),
              hasCaption: !!item.caption,
              captionPreview: item.caption?.text?.substring(0, 50)
            });
            await this.handleMention(item);
            break;
          default:
            elizaLogger.log("[Instagram] Skipping unhandled activity type:", {
              type: item.type,
              supportedTypes: [2, 3, 12],
              itemDetails: item
            });
        }
      } catch (error) {
        elizaLogger.error("[Instagram] Error processing activity:", {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name,
          code: error.code,
          apiError: error.apiError,
          activityType: item.type,
          mediaId: item.media_id,
          response: error.response ? {
            statusCode: error.response.statusCode,
            statusMessage: error.response.statusMessage,
            body: error.response.body
          } : undefined,
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    }

    private async generateResponse(
      text: string,
      username: string,
      action: string
    ) {
      try {
        elizaLogger.log("[Instagram] Generating response:", {
          action,
          username,
          textLength: text?.length,
          textPreview: text?.substring(0, 50),
          timestamp: new Date().toISOString()
        });

        const state = await this.runtime.composeState(
          {
            userId: this.runtime.agentId,
            roomId: stringToUuid(`instagram-temp-${Date.now()}-${this.runtime.agentId}`),
            agentId: this.runtime.agentId,
            content: {
              text,
              action,
            },
          },
          {
            instagramUsername: this.state.profile?.username,
            commentUsername: username,
            commentText: text,
          }
        );

        const context = composeContext({
          state,
          template: instagramCommentTemplate,
        });

        const response = await generateText({
          runtime: this.runtime,
          context,
          modelClass: ModelClass.SMALL,
        });

        const cleanedResponse = this.cleanResponse(response);

        elizaLogger.log("[Instagram] Generated response:", {
          action,
          username,
          originalLength: response?.length,
          cleanedLength: cleanedResponse?.length,
          responsePreview: cleanedResponse?.substring(0, 50)
        });

        return cleanedResponse;
      } catch (error) {
        elizaLogger.error("[Instagram] Error generating response:", {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name,
          action,
          username,
          textLength: text?.length,
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }
    }

    private cleanResponse(response: string): string {
      return response
        .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "")
        .replace(/^['"](.*)['"]$/g, "$1")
        .replace(/\\"/g, '"')
        .trim();
    }

    private async handleDirectMessage(activity: any) {
      try {
        elizaLogger.log("[Instagram] Processing direct message:", {
          threadId: activity.thread_id,
          userId: activity.user_id,
          timestamp: new Date().toISOString()
        });

        const ig = getIgClient();
        if (!ig) {
          elizaLogger.error("[Instagram] Cannot handle direct message - client not initialized");
          return;
        }

        // Get thread with retry
        const thread = await this.retryOperation(
          () => ig.feed.directThread({
            thread_id: activity.thread_id,
            oldest_cursor: null
          }).items(),
          'fetch direct thread'
        );

        // Process messages
        for (const message of thread) {
          if (message.item_type === 'text' && message.user_id !== Number(ig.state.cookieUserId)) {
            const messageKey = `instagram-dm-${message.item_id}`;
            if (await this.runtime.cacheManager.get(messageKey)) {
              elizaLogger.log("[Instagram] Direct message already processed:", message.item_id);
              continue;
            }

            const response = await this.generateResponse(
              message.text,
              message.user_id.toString(),
              'DIRECT'
            );

            if (response && !this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
              // Send message with retry
              await this.retryOperation(
                async () => {
                  const dmThread = await ig.entity.directThread(activity.thread_id.toString());
                  await dmThread.broadcastText(response);
                },
                'send direct message'
              );

              elizaLogger.log("[Instagram] Sent direct message reply:", {
                threadId: activity.thread_id,
                response: response
              });

              await this.runtime.cacheManager.set(messageKey, true);
            }
          }
        }
      } catch (error) {
        elizaLogger.error("[Instagram] Error handling direct message:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          threadId: activity.thread_id
        });
      }
    }

    private async handlePostActivity(activity: any) {
      try {
        elizaLogger.log("[Instagram] Processing post activity:", {
          mediaId: activity.id,
          type: activity.type,
          isOwnPost: activity.user?.pk === getIgClient()?.state?.cookieUserId
        });

        const ig = getIgClient();
        if (!ig) return;

        // Get comments using retryOperation
        const comments = await this.retryOperation(
          async () => {
            const commentsFeed = ig.feed.mediaComments(activity.id);
            return await commentsFeed.items();
          },
          'fetch comments for post'
        );

        // Process comments if we got them
        for (const comment of comments) {
          // Process comments on own posts even if liked, but for others' posts only process new ones
          const isOwnPost = activity.user?.pk === ig.state.cookieUserId;
          if (isOwnPost || !comment.has_liked_comment) {
            await this.handleComment({
              type: 2,
              pk: comment.pk,
              user_id: comment.user_id,
              media_id: activity.id,
              text: comment.text,
              user: {
                pk: comment.user.pk,
                username: comment.user.username
              }
            });
          }
        }

        // Check for mentions in caption
        if (activity.caption?.text &&
          activity.caption.text.includes(`@${this.state.profile?.username}`)) {
          await this.handleMention({
            type: 12,
            pk: activity.pk,
            user_id: activity.user.pk,
            media_id: activity.id,
            text: activity.caption.text
          });
        }

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling post activity:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          activityId: activity.id,
          errorType: error?.constructor?.name,
          apiError: error.apiError,
          code: error.code,
          response: error.response ? {
            statusCode: error.response.statusCode,
            statusMessage: error.response.statusMessage,
            body: error.response.body
          } : undefined
        });
      }
    }

    private async handleComment(item: any) {
      try {
        const ig = getIgClient();
        if (!ig) {
          elizaLogger.error("[Instagram] Cannot handle comment - client not initialized");
          return;
        }

        elizaLogger.log("[Instagram] Processing comment:", {
          mediaId: item.media_id,
          commentId: item.pk,
          text: item.text?.substring(0, 50)
        });

        const commentKey = `instagram-comment-${item.pk}`;
        if (await this.runtime.cacheManager.get(commentKey)) {
          elizaLogger.log("[Instagram] Comment already processed:", item.pk);
          return;
        }

        const response = await this.generateResponse(
          item.text,
          item.user.username,
          'COMMENT'
        );

        if (response && !this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
          // Post comment with retry
          const result = await this.retryOperation(
            () => ig.media.comment({
              mediaId: item.media_id,
              text: response,
              replyToCommentId: item.pk
            }),
            'post comment reply'
          );

          elizaLogger.log("[Instagram] Posted comment reply:", {
            mediaId: item.media_id,
            commentId: item.pk,
            response: response,
            result: result
          });
        }

        await this.runtime.cacheManager.set(commentKey, true);

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling comment:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          commentId: item.pk,
          mediaId: item.media_id,
          text: item.text
        });
      }
    }

    private async handleLike(item: any) {
      try {
        const ig = getIgClient();
        if (!ig) {
          elizaLogger.error("[Instagram] Cannot handle like - client not initialized");
          return;
        }

        elizaLogger.log("[Instagram] Processing like:", {
          mediaId: item.media_id,
          userId: item.user_id
        });

        const likeKey = `instagram-like-${item.media_id}-${item.user_id}`;
        if (await this.runtime.cacheManager.get(likeKey)) {
          elizaLogger.log("[Instagram] Like already processed:", item.media_id);
          return;
        }

        if (!this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
          // Get user feed with retry
          const userFeed = await this.retryOperation(
            () => ig.feed.user(item.user_id).items(),
            'fetch user feed'
          );

          if (userFeed.length > 0) {
            const recentPost = userFeed[0];
            // Like post with retry
            await this.retryOperation(
              () => ig.media.like({
                mediaId: recentPost.id,
                d: 1,
                moduleInfo: {
                  module_name: "photo_view_profile",
                  username: item.user?.username || "unknown",
                  user_id: item.user_id
                }
              }),
              'like post'
            );

            elizaLogger.log("[Instagram] Reciprocated like:", {
              originalMediaId: item.media_id,
              reciprocatedMediaId: recentPost.id,
              userId: item.user_id
            });
          }
        }

        await this.runtime.cacheManager.set(likeKey, true);

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling like:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mediaId: item.media_id,
          userId: item.user_id
        });
      }
    }

    private async handleMention(item: any) {
      try {
        const ig = getIgClient();
        if (!ig) return;

        elizaLogger.log("[Instagram] Processing mention:", {
          mediaId: item.media_id,
          userId: item.user_id,
          text: item.text
        });

        const mentionKey = `instagram-mention-${item.media_id}`;
        if (await this.runtime.cacheManager.get(mentionKey)) {
          elizaLogger.log("[Instagram] Mention already processed:", item.media_id);
          return;
        }

        const response = await this.generateResponse(
          item.text,
          item.user?.username || item.user_id.toString(),
          'MENTION'
        );

        if (response && !this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
          // Post response with retry
          await this.retryOperation(
            () => ig.media.comment({
              mediaId: item.media_id,
              text: response
            }),
            'post mention response'
          );

          elizaLogger.log("[Instagram] Posted response to mention:", {
            mediaId: item.media_id,
            response: response
          });
        }

        await this.runtime.cacheManager.set(mentionKey, true);

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling mention:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mediaId: item.media_id,
          userId: item.user_id
        });
      }
    }

    private async ensureLogin() {
      elizaLogger.log("[Instagram] Ensuring login session...", {
        hasUsername: !!this.runtime.getSetting("INSTAGRAM_USERNAME"),
        hasPassword: !!this.runtime.getSetting("INSTAGRAM_PASSWORD"),
        timestamp: new Date().toISOString()
      });

      try {
        const success = await refreshSession(this.runtime, {
          INSTAGRAM_USERNAME: this.runtime.getSetting("INSTAGRAM_USERNAME"),
          INSTAGRAM_PASSWORD: this.runtime.getSetting("INSTAGRAM_PASSWORD")
        });

        if (!success) {
          elizaLogger.error("[Instagram] Failed to ensure valid session", {
            username: this.runtime.getSetting("INSTAGRAM_USERNAME"),
            hasPassword: !!this.runtime.getSetting("INSTAGRAM_PASSWORD"),
            timestamp: new Date().toISOString()
          });
          return false;
        }

        const ig = getIgClient();
        if (ig?.state?.cookieUserId) {
          elizaLogger.log("[Instagram] Login session verified", {
            cookieUserId: ig.state.cookieUserId,
            timestamp: new Date().toISOString()
          });
        } else {
          elizaLogger.warn("[Instagram] Session verified but no cookieUserId found");
        }

        return true;
      } catch (error) {
        elizaLogger.error("[Instagram] Error ensuring login:", {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name,
          apiError: error.apiError,
          code: error.code,
          response: error.response ? {
            statusCode: error.response.statusCode,
            statusMessage: error.response.statusMessage,
            body: error.response.body
          } : undefined,
          stack: error instanceof Error ? error.stack : undefined
        });
        return false;
      }
    }

    private async fetchTimelinePosts() {
      try {
        const ig = getIgClient();
        if (!ig) return [];

        // Fetch timeline with retry
        const posts = await this.retryOperation(
          async () => {
            const feed = ig.feed.timeline();
            return await feed.items();
          },
          'fetch timeline posts'
        );

        elizaLogger.log("[Instagram] Fetched timeline posts:", {
          count: posts.length
        });

        return posts;
      } catch (error) {
        elizaLogger.error("[Instagram] Error fetching timeline:", {
          error: error instanceof Error ? error.message : String(error),
          errorType: error?.constructor?.name,
          code: error.code,
          apiError: error.apiError
        });
        return [];
      }
    }

    private async processTimelinePost(post: any) {
      try {
        const ig = getIgClient();
        if (!ig) {
          elizaLogger.error("[Instagram] Cannot process timeline post - client not initialized");
          return;
        }

        elizaLogger.log("[Instagram] Processing timeline post:", {
          mediaId: post.id,
          userId: post.user.pk,
          username: post.user.username,
          hasCaption: !!post.caption,
          captionPreview: post.caption?.text?.substring(0, 50)
        });

        const postKey = `instagram-timeline-${post.id}`;
        if (await this.runtime.cacheManager.get(postKey)) {
          elizaLogger.log("[Instagram] Timeline post already processed:", post.id);
          return;
        }

        // Decide whether to like or comment based on content
        if (post.caption?.text) {
          const response = await this.generateResponse(
            post.caption.text,
            post.user.username,
            'TIMELINE'
          );

          if (response && !this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
            // Comment on post with retry
            await this.retryOperation(
              () => ig.media.comment({
                mediaId: post.id,
                text: response
              }),
              'comment on timeline post'
            );

            elizaLogger.log("[Instagram] Commented on timeline post:", {
              mediaId: post.id,
              response: response
            });
          }
        } else {
          // If no caption, just like the post
          if (!this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
            await this.retryOperation(
              () => ig.media.like({
                mediaId: post.id,
                d: 1,
                moduleInfo: {
                  module_name: "feed_timeline",
                  username: post.user.username,
                  user_id: post.user.pk
                }
              }),
              'like timeline post'
            );

            elizaLogger.log("[Instagram] Liked timeline post:", {
              mediaId: post.id,
              username: post.user.username
            });
          }
        }

        await this.runtime.cacheManager.set(postKey, true);
      } catch (error) {
        elizaLogger.error("[Instagram] Error processing timeline post:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          mediaId: post.id,
          errorType: error?.constructor?.name,
          apiError: error.apiError
        });
      }
    }

    private async evaluateInteraction(post: any): Promise<boolean> {
      try {
        elizaLogger.debug("[Instagram] Evaluating interaction for post:", {
          username: post.user.username,
          caption: post.caption?.text,
          mediaType: post.media_type
        });

        const context = composeContext({
          state: {
            interactionType: 'Post Engagement',
            username: post.user.username,
            content: post.caption?.text || '',
            instagramUsername: this.state.profile?.username
          },
          template: shouldInteractTemplate
        });

        elizaLogger.debug("[Instagram] Interaction evaluation prompt:", context);

        const decision = await generateText({
          runtime: this.runtime,
          context,
          modelClass: ModelClass.SMALL
        });

        elizaLogger.debug("[Instagram] Raw interaction decision:", decision);

        const shouldInteract = decision.includes('[INTERACT]');
        elizaLogger.debug("[Instagram] Final interaction decision:", {
          shouldInteract,
          rawDecision: decision
        });

        return shouldInteract;
      } catch (error) {
        elizaLogger.error("[Instagram] Error evaluating interaction:", {
          error: error instanceof Error ? error.message : String(error),
          post: {
            username: post.user.username,
            caption: post.caption?.text
          }
        });
        return false;
      }
    }
  }