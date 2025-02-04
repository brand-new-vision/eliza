import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";
import { fetchActivities } from "../lib/actions";
import { composeContext, generateText, ModelClass } from "@elizaos/core";

export class InstagramInteractionService {
    private isRunning = false;
    private intervalId?: NodeJS.Timeout;
    private checkInterval: number;
    private maxActions: number;

    constructor(
        private runtime: IAgentRuntime,
        private state: InstagramState
    ) {
        // Get interval from settings or use default
        this.checkInterval = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_ACTION_INTERVAL") || "5",
            10
        ) * 60 * 1000; // Convert to milliseconds

        this.maxActions = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_MAX_ACTIONS") || "1",
            10
        );
    }

    async start() {
        if (this.isRunning) {
            elizaLogger.warn("[Instagram] Interaction service already running");
            return;
        }

        this.isRunning = true;
        elizaLogger.log("[Instagram] Starting interaction service", {
            checkInterval: this.checkInterval / 1000,
            maxActions: this.maxActions
        });

        // Initial check
        await this.processInteractions();

        // Set up interval for periodic checks
        this.intervalId = setInterval(() => {
            this.processInteractions().catch(error => {
                elizaLogger.error("[Instagram] Error in interaction processing:", {
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }, this.checkInterval);
    }

    async stop() {
        elizaLogger.log("[Instagram] Stopping interaction service");
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
    }

    private async processInteractions() {
        if (!this.isRunning) return;

        const ig = getIgClient();
        if (!ig) {
            elizaLogger.error("[Instagram] Client not initialized");
            return;
        }

        try {
            elizaLogger.debug("[Instagram] Processing interactions");

            // Get user info using searchExact instead of currentUser
            const user = await ig.user.searchExact(this.state.profile?.username || '');
            elizaLogger.debug("[Instagram] User details:", {
                userId: user.pk,
                username: user.username
            });

            // Fetch direct messages
            const inbox = await ig.feed.directInbox().items();
            elizaLogger.debug("[Instagram] Direct messages fetched:", {
                count: inbox.length
            });

            // Process each direct message
            for (const thread of inbox) {
                if (!this.isRunning) break;
                await this.handleDirectMessage(thread);
            }

            // Fetch user's recent posts using the proper user ID
            const userFeed = await ig.feed.user(user.pk).items();
            elizaLogger.debug("[Instagram] User feed fetched:", {
                count: userFeed.length
            });

            // Process comments on recent posts
            for (const post of userFeed.slice(0, 5)) {
                if (!this.isRunning) break;
                const comments = await ig.feed.mediaComments(post.id).items();
                elizaLogger.debug("[Instagram] Comments fetched for post:", {
                    postId: post.id,
                    commentCount: comments.length
                });

                for (const comment of comments) {
                    if (!this.isRunning) break;
                    await this.handleComment(comment);
                }
            }

            elizaLogger.debug("[Instagram] Interaction processing completed");
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing interactions:", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleDirectMessage(thread: any) {
        const ig = getIgClient();
        if (!ig) {
            elizaLogger.error("[Instagram] Client not initialized");
            return;
        }

        try {
            const lastMessage = thread.items[0];
            if (!lastMessage || lastMessage.item_type !== 'text') return;

            const senderId = lastMessage.user_id;
            if (senderId === this.state.profile?.id) return;

            const response = await this.generateResponse(
                lastMessage.text,
                thread.users[0].username,
                'direct_message'
            );

            if (response && this.isRunning) {
                await ig.directThread.broadcast({
                    item: 'text',
                    threadIds: [thread.thread_id],
                    form: { text: response }
                });

                elizaLogger.debug("[Instagram] Sent direct message response:", {
                    threadId: thread.thread_id,
                    responseLength: response.length
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error handling direct message:", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async handleComment(comment: any) {
        const ig = getIgClient();
        if (!ig) {
            elizaLogger.error("[Instagram] Client not initialized");
            return;
        }

        try {
            if (comment.user_id === this.state.profile?.id) return;

            const response = await this.generateResponse(
                comment.text,
                comment.user.username,
                'comment'
            );

            if (response && this.isRunning) {
                await ig.media.comment({
                    mediaId: comment.media_id,
                    text: response,
                    replyToCommentId: comment.pk
                });

                elizaLogger.debug("[Instagram] Replied to comment:", {
                    mediaId: comment.media_id,
                    commentId: comment.pk
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error handling comment:", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async generateResponse(
        text: string,
        username: string,
        action: string
    ): Promise<string | null> {
        try {
            // First compose the state with message context
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text,
                        action,
                        source: 'instagram',
                        username,
                    },
                },
                {
                    instagramUsername: this.state.profile?.username,
                }
            );

            // Use appropriate template based on action type
            const templateKey = action === 'direct_message'
                ? 'instagramDmTemplate'
                : 'instagramCommentTemplate';

            const template = this.runtime.character.templates?.[templateKey] || `
# Task: Respond to an Instagram ${action} as {{agentName}}
Previous message from @${username}: "${text}"

Write a natural, engaging response that:
1. Stays in character as {{agentName}}
2. Is appropriate for Instagram
3. Is brief and conversational
4. Maintains a professional tone

Response:`;

            // Generate the response using the template
            const context = composeContext({
                state,
                template,
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!response) {
                throw new Error("No response generated");
            }

            return this.cleanResponse(response);
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating response:", {
                error: error instanceof Error ? error.message : String(error),
                text,
                username,
                action,
            });
            return null;
        }
    }

    private cleanResponse(response: string): string {
        return response
            .trim()
            .replace(/^['"](.*)['"]$/, "$1")
            .replace(/\\n/g, "\n")
            .slice(0, 2200); // Instagram comment length limit
    }
}