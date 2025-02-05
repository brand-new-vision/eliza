import { elizaLogger, type IAgentRuntime, composeContext, generateText, ModelClass } from "@elizaos/core";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";
import {
    fetchTimelinePosts,
    likeMedia,
    postComment,
    fetchDirectInbox,
    sendDirectMessage,
    replyToComment,
    fetchComments
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
            elizaLogger.debug("[Instagram] Interaction service already running");
            return;
        }

        this.isRunning = true;
        elizaLogger.debug("[Instagram] Starting interaction service", {
            checkInterval: this.checkInterval / 1000,
            maxActions: this.maxActions
        });

        // Run initial check immediately
        elizaLogger.debug("[Instagram] Running initial interaction check");
        await this.processInteractions().catch(error => {
            elizaLogger.error("[Instagram] Error in initial interaction check:", {
                error: error instanceof Error ? error.message : String(error)
            });
        });

        // Set up interval for periodic checks
        this.intervalId = setInterval(() => {
            elizaLogger.debug("[Instagram] Running scheduled interaction check");
            this.processInteractions().catch(error => {
                elizaLogger.error("[Instagram] Error in interaction processing:", {
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }, this.checkInterval);

        elizaLogger.debug("[Instagram] Interaction service started successfully");
    }

    async stop() {
        elizaLogger.debug("[Instagram] Stopping interaction service");
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
            elizaLogger.debug("[Instagram] Starting interaction processing cycle");

            // Get user info using searchExact
            const user = await ig.user.searchExact(this.state.profile?.username || '');
            elizaLogger.debug("[Instagram] Processing as user:", {
                userId: user.pk,
                username: user.username
            });

            // Track action count to respect limits
            let actionCount = 0;
            const startTime = Date.now();

            // Fetch timeline posts using typed function
            const timelinePosts = await fetchTimelinePosts(20);
            elizaLogger.debug("[Instagram] Timeline posts fetched:", {
                count: timelinePosts.length,
                posts: timelinePosts.map(p => ({
                    mediaId: p.id,
                    mediaType: p.mediaType,
                    timestamp: p.timestamp
                }))
            });

            // Process timeline posts with rate limiting
            for (const post of timelinePosts) {
                if (!this.isRunning || actionCount >= this.maxActions) break;

                elizaLogger.debug("[Instagram] Processing post:", {
                    mediaId: post.id,
                    mediaType: post.mediaType,
                    timestamp: post.timestamp
                });

                // Check for comments on this post
                const comments = await fetchComments(post.id);
                elizaLogger.debug("[Instagram] Comments found:", {
                    postId: post.id,
                    commentCount: comments.length,
                    comments: comments.map(c => ({
                        id: c.id,
                        username: c.username,
                        timestamp: c.timestamp
                    }))
                });

                // Process comments first
                for (const comment of comments) {
                    if (!this.isRunning || actionCount >= this.maxActions) break;
                    // Add the post's media ID to the comment object
                    const enrichedComment = {
                        ...comment,
                        media_id: post.id // Ensure media_id is available for the comment
                    };
                    await this.handleComment(enrichedComment);
                    actionCount++;
                    if (actionCount < this.maxActions) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }

                // Then process the post itself if we haven't hit limits
                if (actionCount < this.maxActions) {
                    const shouldInteract = await this.evaluateInteraction(post);
                    if (shouldInteract) {
                        await this.processTimelinePost(post);
                        actionCount++;
                        if (actionCount < this.maxActions) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                }
            }

            // Fetch and process direct messages if we haven't hit limits
            if (actionCount < this.maxActions) {
                const inbox = await fetchDirectInbox();
                elizaLogger.debug("[Instagram] Direct messages fetched:", {
                    count: inbox.length
                });

                // Process each direct message with rate limiting
                for (const thread of inbox) {
                    if (!this.isRunning || actionCount >= this.maxActions) break;

                    await this.handleDirectMessage(thread);
                    actionCount++;

                    // Add delay between actions
                    if (actionCount < this.maxActions) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }

            const processingTime = Date.now() - startTime;
            elizaLogger.debug("[Instagram] Interaction processing completed:", {
                actionCount,
                processingTimeMs: processingTime,
                maxActions: this.maxActions
            });

        } catch (error) {
            elizaLogger.error("[Instagram] Error processing interactions:", {
                error: error instanceof Error ? error.message : String(error),
                username: this.state.profile?.username
            });

            // If we get rate limited or encounter API issues, add exponential backoff
            if (error.message?.includes('rate') || error.message?.includes('429')) {
                const backoffMs = Math.min(this.checkInterval * 2, 30 * 60 * 1000); // Max 30 minutes
                elizaLogger.warn("[Instagram] Rate limit detected, increasing check interval:", {
                    newIntervalMs: backoffMs
                });
                this.checkInterval = backoffMs;
            }
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
            // Add post tracking
            const postKey = `instagram/post/${post.id}`;
            const hasProcessed = await this.runtime.cacheManager.get(postKey);
            if (hasProcessed) {
                elizaLogger.debug("[Instagram] Skipping already processed post:", {
                    postId: post.id,
                    mediaType: post.mediaType
                });
                return;
            }

            // Skip posts from the agent itself
            if (post.user?.username === this.state.profile?.username) {
                elizaLogger.debug("[Instagram] Skipping own post:", {
                    postId: post.id
                });
                return;
            }

            // Log the post details before processing
            elizaLogger.debug("[Instagram] Processing timeline post:", {
                postId: post.id,
                mediaType: post.mediaType,
                userId: post.user?.pk,
                username: post.user?.username
            });

            // Generate comment using AI
            const context = composeContext({
                state: await this.runtime.composeState({
                    userId: this.runtime.agentId,
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: post.caption?.text || '',
                        action: "COMMENT",
                        source: "instagram",
                        mediaType: post.mediaType,
                        username: post.user?.username
                    }
                })
            });

            const comment = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            if (comment && this.isRunning) {
                try {
                    // Like the post first
                    await likeMedia(post.id);
                    elizaLogger.debug("[Instagram] Successfully liked post:", {
                        postId: post.id
                    });

                    // Then post the comment
                    await postComment(post.id, comment);
                    elizaLogger.debug("[Instagram] Successfully commented on post:", {
                        postId: post.id,
                        commentLength: comment.length
                    });

                    // Mark post as processed
                    await this.runtime.cacheManager.set(postKey, {
                        processedAt: new Date().toISOString(),
                        comment,
                        mediaType: post.mediaType,
                        username: post.user?.username,
                        caption: post.caption?.text
                    });
                } catch (actionError) {
                    elizaLogger.error("[Instagram] Error during post interaction:", {
                        error: actionError instanceof Error ? actionError.message : String(actionError),
                        postId: post.id,
                        phase: actionError.message?.includes('like') ? 'liking' : 'commenting'
                    });
                    throw actionError;
                }
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error processing timeline post:", {
                error: error instanceof Error ? error.message : String(error),
                postId: post.id,
                mediaType: post.mediaType
            });
        }
    }

    private async handleDirectMessage(thread: any) {
        try {
            const lastMessage = thread.items[0];
            if (!lastMessage || lastMessage.item_type !== 'text') return;

            // Add message tracking
            const messageKey = `instagram/dm/${lastMessage.item_id}`;
            const hasProcessed = await this.runtime.cacheManager.get(messageKey);
            if (hasProcessed) {
                elizaLogger.debug("[Instagram] Skipping already processed message:", {
                    messageId: lastMessage.item_id,
                    threadId: thread.thread_id
                });
                return;
            }

            const senderId = lastMessage.user_id;
            if (senderId === this.state.profile?.id) return;

            const response = await this.generateResponse(
                lastMessage.text,
                thread.users[0].username,
                'direct_message'
            );

            if (response && this.isRunning) {
                await sendDirectMessage(thread.thread_id, response);

                // Mark message as processed
                await this.runtime.cacheManager.set(messageKey, {
                    processedAt: new Date().toISOString(),
                    response,
                    threadId: thread.thread_id,
                    senderId,
                    text: lastMessage.text
                });

                elizaLogger.debug("[Instagram] Sent direct message response:", {
                    threadId: thread.thread_id,
                    messageId: lastMessage.item_id,
                    responseLength: response.length
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error handling direct message:", {
                error: error instanceof Error ? error.message : String(error),
                threadId: thread.thread_id
            });
        }
    }

    private async handleComment(comment: any) {
        try {
            elizaLogger.debug("[Instagram] Processing comment:", {
                commentId: comment.pk,
                mediaId: comment.media_id || comment.pk_post || comment.post_id,
                text: comment.text,
                username: comment.user?.username || comment.username
            });

            if (comment.user_id === this.state.profile?.id) return;

            // Get the media ID - try different possible fields
            const mediaId = comment.media_id || comment.pk_post || comment.post_id;
            if (!mediaId) {
                elizaLogger.error("[Instagram] Cannot process comment - missing media ID:", {
                    commentData: comment
                });
                return;
            }

            // Safely get username, with fallback
            const username = comment.user?.username ||
                           comment.username ||
                           'unknown_user';

            const response = await this.generateResponse(
                comment.text,
                username,
                'comment'
            );

            if (response && this.isRunning) {
                await replyToComment(mediaId, comment.pk, response);

                elizaLogger.debug("[Instagram] Replied to comment:", {
                    mediaId,
                    commentId: comment.pk,
                    username,
                    response
                });
            }
        } catch (error) {
            elizaLogger.error("[Instagram] Error handling comment:", {
                error: error instanceof Error ? error.message : String(error),
                commentData: comment
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