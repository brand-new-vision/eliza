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
      while (!this.stopProcessing) {
        await this.handleInteractions();
        await new Promise(resolve => setTimeout(resolve, this.checkInterval));
      }
    }

    private async handleInteractions() {
      if (this.isProcessing) return;

      try {
        this.isProcessing = true;
        elizaLogger.log("[Instagram] Starting interaction check");

        // Single session check at the start
        if (!await this.ensureLogin()) {
          elizaLogger.error("[Instagram] No valid session, skipping interactions");
          return;
        }

        const activities = await fetchActivities();

        for (const activity of activities) {
          if (activity.type === 'direct') {
            await this.handleDirectMessage(activity);
          } else if (activity.type === 'post') {
            await this.handlePostActivity(activity);
          }
        }

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling interactions:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      } finally {
        this.isProcessing = false;
      }
    }

    private async retryOperation<T>(
      operation: () => Promise<T>,
      operationName: string,
      maxRetries = 3
    ): Promise<T> {
      let lastError: Error | null = null;
      let delay = 5000;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await operation();
        } catch (error) {
          lastError = error;
          elizaLogger.warn(`[Instagram] ${operationName} failed (attempt ${attempt}/${maxRetries}):`, {
            error: error.message,
            nextDelay: attempt < maxRetries ? delay : 'giving up'
          });

          if (attempt === maxRetries) break;

          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        }
      }

      throw lastError;
    }

    private async processActivity(item: any) {
      try {
        elizaLogger.log("[Instagram] Processing activity:", {
          type: item.type,
          userId: item.user_id,
          mediaId: item.media_id
        });

        // Process based on activity type
        switch (item.type) {
          case 2: // Comment
            await this.handleComment(item);
            break;
          case 3: // Like
            await this.handleLike(item);
            break;
          case 12: // Mention
            await this.handleMention(item);
            break;
          default:
            elizaLogger.log("[Instagram] Unhandled activity type:", item.type);
        }
      } catch (error) {
        elizaLogger.error("[Instagram] Error processing activity:", {
          error: error instanceof Error ? error.message : String(error),
          activityType: item.type
        });
      }
    }

    private async generateResponse(
      text: string,
      username: string,
      action: string
    ) {
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

      return this.cleanResponse(response);
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
          userId: activity.user_id
        });

        // Handle direct message using the latest API methods
        const ig = getIgClient();
        if (!ig) return;

        const thread = await ig.feed.directThread({
          thread_id: activity.thread_id,
          oldest_cursor: null
        }).items();

        // Process messages
        for (const message of thread) {
          if (message.item_type === 'text' && message.user_id !== Number(ig.state.cookieUserId)) {
            await this.generateResponse(
              message.text,
              message.user_id.toString(),
              'DIRECT'
            );
          }
        }
      } catch (error) {
        elizaLogger.error("[Instagram] Error handling direct message:", error);
      }
    }

    private async handlePostActivity(activity: any) {
      try {
        elizaLogger.log("[Instagram] Processing post activity:", {
          mediaId: activity.id,
          type: activity.type
        });

        // Get comments using the latest pagination method
        const ig = getIgClient();
        if (!ig) return;

        const commentsFeed = ig.feed.mediaComments(activity.id);
        const comments = await commentsFeed.items();

        for (const comment of comments) {
          if (!comment.has_liked_comment) {  // Only process new comments
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
          activityId: activity.id
        });
      }
    }

    private async handleComment(item: any) {
      try {
        const ig = getIgClient();
        if (!ig) return;

        elizaLogger.log("[Instagram] Processing comment:", {
          mediaId: item.media_id,
          commentId: item.pk
        });

        // Check if we've already processed this comment
        const commentKey = `instagram-comment-${item.pk}`;
        if (await this.runtime.cacheManager.get(commentKey)) {
          elizaLogger.log("[Instagram] Comment already processed:", item.pk);
          return;
        }

        // Generate and post response
        const response = await this.generateResponse(
          item.text,
          item.user.username,
          'COMMENT'
        );

        if (response && !this.runtime.getSetting("INSTAGRAM_DRY_RUN")) {
          await ig.media.comment({
            mediaId: item.media_id,
            text: response,
            replyToCommentId: item.pk  // This ensures it's threaded as a reply
          });
        }

        // Mark comment as processed
        await this.runtime.cacheManager.set(commentKey, true);

      } catch (error) {
        elizaLogger.error("[Instagram] Error handling comment:", {
          error: error instanceof Error ? error.message : String(error),
          commentId: item.pk
        });
      }
    }

    private async handleLike(item: any) {
      try {
        elizaLogger.log("[Instagram] Processing like:", {
          mediaId: item.media_id,
          userId: item.user_id
        });
        // Add like handling logic here if needed
      } catch (error) {
        elizaLogger.error("[Instagram] Error handling like:", error);
      }
    }

    private async handleMention(item: any) {
      try {
        elizaLogger.log("[Instagram] Processing mention:", {
          mediaId: item.media_id,
          userId: item.user_id,
          text: item.text
        });
        // Add mention handling logic here if needed
      } catch (error) {
        elizaLogger.error("[Instagram] Error handling mention:", error);
      }
    }

    private async ensureLogin() {
      try {
        // Use the new refreshSession function from auth.ts
        const success = await refreshSession(this.runtime, {
          INSTAGRAM_USERNAME: this.runtime.getSetting("INSTAGRAM_USERNAME"),
          INSTAGRAM_PASSWORD: this.runtime.getSetting("INSTAGRAM_PASSWORD"),
          INSTAGRAM_PROXY_URL: this.runtime.getSetting("INSTAGRAM_PROXY_URL")
        });

        if (!success) {
          elizaLogger.error("[Instagram] Failed to ensure valid session");
          return false;
        }
        return true;
      } catch (error) {
        elizaLogger.error("[Instagram] Error ensuring login:", error);
        return false;
      }
    }
  }