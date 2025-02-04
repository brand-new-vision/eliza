import { elizaLogger, type IAgentRuntime, composeContext, generateText, ModelClass } from "@elizaos/core";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";
import {
    fetchActivities,
    fetchTimelinePosts,
    likeMedia,
    postComment,
    fetchDirectInbox,
    sendDirectMessage,
    replyToComment
} from "../lib/actions";

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

            // Get user info using searchExact
            const user = await ig.user.searchExact(this.state.profile?.username || '');
            elizaLogger.debug("[Instagram] User details:", {
                userId: user.pk,
                username: user.username
            });

            // Fetch timeline posts using typed function
            const timelinePosts = await fetchTimelinePosts(20);
            elizaLogger.debug("[Instagram] Fetched timeline:", {
                count: timelinePosts.length,
                posts: timelinePosts.map(p => ({
                    mediaId: p.id,
                    mediaType: p.mediaType,
                    timestamp: p.timestamp,
                    permalink: p.permalink
                }))
            });

            // Process timeline posts
            for (const post of timelinePosts) {
                if (!this.isRunning) break;

                elizaLogger.debug("[Instagram] Processing timeline post:", {
                    mediaId: post.id,
                    mediaType: post.mediaType,
                    timestamp: post.timestamp
                });

                const shouldInteract = await this.evaluateInteraction(post);
                if (shouldInteract) {
                    await this.processTimelinePost(post);
                }
            }

            // Fetch and process direct messages
            const inbox = await fetchDirectInbox();
            elizaLogger.debug("[Instagram] Direct messages fetched:", {
                count: inbox.length
            });

            // Process each direct message
            for (const thread of inbox) {
                if (!this.isRunning) break;
                await this.handleDirectMessage(thread);
            }

            // Fetch user's recent activities
            const activities = await fetchActivities(this.state.profile?.username || '');
            elizaLogger.debug("[Instagram] Activities fetched:", {
                count: activities.length
            });

            elizaLogger.debug("[Instagram] Interaction processing completed");
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing interactions:", {
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private async evaluateInteraction(post: any): Promise<boolean> {
        try {
            // Skip if no caption
            if (!post.caption?.text) {
                return false;
            }

            // Skip posts from the agent itself
            if (post.user.username === this.state.profile?.username) {
                return false;
            }

            // Generate evaluation using AI
            const context = composeContext({
                state: await this.runtime.composeState({
                    userId: this.runtime.agentId,
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: post.caption.text,
                        action: "EVALUATE_POST",
                        source: "instagram",
                        username: post.user.username
                    }
                }),
                template: `
# Task: Evaluate if {{agentName}} should interact with this Instagram post
Post from @${post.user.username}: "${post.caption.text}"

Consider:
1. Is the content relevant to {{agentName}}'s interests and expertise?
2. Would {{agentName}} have a meaningful perspective to share?
3. Is the post recent and engaging?

Respond with either "true" or "false".
`
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            return response?.toLowerCase().includes('true') || false;
        } catch (error) {
            elizaLogger.error("[Instagram] Error evaluating interaction:", {
                error: error instanceof Error ? error.message : String(error),
                postId: post.id,
                username: post.user.username
            });
            return false;
        }
    }

    private async processTimelinePost(post: any) {
        try {
            // Generate comment using AI
            const context = composeContext({
                state: await this.runtime.composeState({
                    userId: this.runtime.agentId,
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: post.caption || '',
                        action: "COMMENT",
                        source: "instagram",
                        mediaType: post.mediaType
                    }
                }),
                template: `
# Task: Write a comment as {{agentName}} on this Instagram post
Post type: ${post.mediaType}
${post.caption ? `Caption: "${post.caption}"` : 'No caption'}

Write a brief, engaging comment that:
1. Is relevant to the post content
2. Shows {{agentName}}'s personality
3. Adds value to the conversation
4. Is appropriate for Instagram
5. Is 1-2 sentences maximum

Comment:`
            });

            const comment = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            if (comment) {
                // Like the post using typed function
                await likeMedia(post.id);

                // Post the comment using typed function
                await postComment(post.id, comment);

                elizaLogger.debug("[Instagram] Processed timeline post:", {
                    postId: post.id,
                    comment
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing timeline post:", {
                error: error instanceof Error ? error.message : String(error),
                postId: post.id
            });
        }
    }

    private async handleDirectMessage(thread: any) {
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
                await sendDirectMessage(thread.thread_id, response);

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
        try {
            if (comment.user_id === this.state.profile?.id) return;

            const response = await this.generateResponse(
                comment.text,
                comment.user.username,
                'comment'
            );

            if (response && this.isRunning) {
                await replyToComment(comment.media_id, comment.pk, response);

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