import { elizaLogger, type IAgentRuntime, composeContext, generateText, ModelClass, getEmbeddingZeroVector, stringToUuid, type UUID } from "@elizaos/core";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";
import {
    fetchTimelinePosts,
    likeMedia,
    postComment,
    fetchDirectInbox,
    sendDirectMessage,
    replyToComment,
    fetchComments,
    hasLikedMedia
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
        if (!this.runtime.character) {
            throw new Error("Character configuration is required");
        }

        // Ensure the character object has a name
        if (!this.runtime.character.name) {
            throw new Error("Character configuration is missing required properties");
        }

        // Get interval from settings or use default
        this.checkInterval = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_ACTION_INTERVAL") || "5",
            10
        ) * 60 * 1000; // Convert to milliseconds

        // Use the validated config value for max actions
        this.maxActions = Number.parseInt(
            this.runtime.getSetting("INSTAGRAM_MAX_ACTIONS") || "1",
            10
        );

        elizaLogger.debug("[Instagram] Interaction service initialized:", {
            checkIntervalMinutes: this.checkInterval / (60 * 1000),
            maxActions: this.maxActions,
            characterName: this.runtime.character.name
        });

        elizaLogger.debug("[Instagram] Character configuration:", {
            name: this.runtime.character.name,
            hasCharacter: !!this.runtime.character
        });
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

                try {
                    elizaLogger.debug("[Instagram] Processing post:", {
                        mediaId: post.id,
                        mediaType: post.mediaType,
                        timestamp: post.timestamp
                    });

                    // First evaluate if we should interact with this post
                    const shouldInteract = await this.evaluateInteraction(post);
                    if (shouldInteract) {
                        // Process the post first since it's already evaluated
                        await this.processTimelinePost(post);
                        actionCount++;
                        if (actionCount >= this.maxActions) break;

                        // Add delay between actions
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    // Then check for comments if we still have actions left
                    if (actionCount < this.maxActions) {
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

                        // Process comments
                        for (const comment of comments) {
                            if (!this.isRunning || actionCount >= this.maxActions) break;
                            await this.handleComment(comment);
                            actionCount++;
                            if (actionCount < this.maxActions) {
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }
                        }
                    }
                } catch (postError) {
                    elizaLogger.error("[Instagram] Error processing individual post:", {
                        error: postError instanceof Error ? postError.message : String(postError),
                        errorName: postError.name,
                        postId: post.id,
                        stack: postError instanceof Error ? postError.stack : undefined
                    });
                    // Continue with next post
                    continue;
                }
            }

            // Fetch and process direct messages if we haven't hit limits
            if (actionCount < this.maxActions) {
                try {
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
                } catch (dmError) {
                    elizaLogger.error("[Instagram] Error processing direct messages:", {
                        error: dmError instanceof Error ? dmError.message : String(dmError),
                        errorName: dmError.name,
                        stack: dmError instanceof Error ? dmError.stack : undefined
                    });
                }
            }

            const processingTime = Date.now() - startTime;
            elizaLogger.debug("[Instagram] Interaction processing completed:", {
                actionCount,
                processingTimeMs: processingTime,
                maxActions: this.maxActions
            });

        } catch (error) {
            // Handle AggregateError specifically
            if (error.name === 'AggregateError' && Array.isArray(error.errors)) {
                elizaLogger.error("[Instagram] Multiple errors during interaction processing:", {
                    errors: error.errors.map(e => e.message || String(e)),
                    username: this.state.profile?.username,
                    stack: error.stack
                });
            } else {
                elizaLogger.error("[Instagram] Error processing interactions:", {
                    error: error instanceof Error ? error.message : String(error),
                    errorName: error.name,
                    username: this.state.profile?.username,
                    stack: error instanceof Error ? error.stack : undefined,
                    details: error.response?.body || error.response || undefined
                });
            }

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
            elizaLogger.debug("[Instagram] Evaluating post for interaction:", {
                postId: post.id,
                username: post.user?.username,
                hasCaption: !!post.caption?.text,
                characterName: this.runtime.character?.name
            });

            // Skip if no caption
            if (!post.caption?.text) {
                elizaLogger.debug("[Instagram] Skipping post - no caption");
                return false;
            }

            // Skip posts from the agent itself
            if (post.user.username === this.state.profile?.username) {
                elizaLogger.debug("[Instagram] Skipping own post");
                return false;
            }

            // Skip if already liked
            try {
                const hasLiked = await hasLikedMedia(post.id);
                if (hasLiked) {
                    elizaLogger.debug("[Instagram] Skipping already liked post:", {
                        postId: post.id
                    });
                    return false;
        }
      } catch (error) {
                // If we can't check like status, proceed anyway
                elizaLogger.warn("[Instagram] Could not check like status:", {
                    postId: post.id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }

            // Get character name safely
            const characterName = this.runtime.character?.name || this.state.profile?.username || 'Agent';

            // Generate evaluation using AI
            const state = {
                agentName: this.runtime.character?.name || 'Fashion Commentator',
                username: post.user.username,
                caption: post.caption.text,
                bio: this.runtime.character?.bio?.join('\n') || '',
                lore: this.runtime.character?.lore?.join('\n') || '',
                topics: this.runtime.character?.topics?.join('\n') || '',
                knowledge: this.runtime.character?.knowledge?.join('\n') || ''
            };

            elizaLogger.debug("[Instagram] State object before composeContext:", {
                state,
                hasAgentName: !!state.agentName,
                hasCharacter: !!state.character,
                characterName: state.character?.name
            });

            const template = `
# Task: Evaluate if {{agentName}} should interact with this Instagram post
Post from @{{username}}: "{{caption}}"

Consider:
1. Is the content relevant to {{agentName}}'s interests and expertise?
2. Would {{agentName}} have a meaningful perspective to share?
3. Is the post recent and engaging?

Your expertise and interests:
{{knowledge}}
{{topics}}

Respond with either "true" or "false".
`;

            const response = await generateText({
                runtime: this.runtime,
                context: composeContext({
                    state: {
                        ...state,
                        characterName: this.runtime.character?.name || 'Fashion Commentator',
                        characterBio: this.runtime.character?.bio?.join('\n') || '',
                        characterLore: this.runtime.character?.lore?.join('\n') || ''
                    },
                    template,
                    templatingEngine: "handlebars"
                }),
                modelClass: ModelClass.FAST
            });

            const shouldInteract = response?.toLowerCase().includes('true') || false;
            elizaLogger.debug("[Instagram] Post evaluation result:", {
                postId: post.id,
                shouldInteract,
                response,
                characterName
            });

            return shouldInteract;
        } catch (error) {
            elizaLogger.error("[Instagram] Error evaluating interaction:", {
                error: error instanceof Error ? error.message : String(error),
                postId: post.id,
                username: post.user?.username
            });
            return false;
        }
    }

    private async processTimelinePost(post: any) {
        try {
            // Add post tracking
            const postKey = `instagram/post/${post.id}`;
            const postContentKey = `instagram/post_content/${post.id}`;
            const hasProcessed = await this.runtime.cacheManager.get(postKey);

            // Cache post content for context in responses
            if (post.caption?.text) {
                await this.runtime.cacheManager.set(
                    postContentKey,
                    post.caption.text,
                    60 * 60 * 24 // 24 hour cache
                );
            }

            // Check if this is our own post
            const isOwnPost = post.user?.username === this.state.profile?.username;

            // For our own posts, we want to process comments but not interact with the post
            if (isOwnPost) {
                elizaLogger.debug("[Instagram] Processing own post for comments:", {
                    postId: post.id,
                    caption: post.caption?.text?.substring(0, 100) // Log first 100 chars
                });

                try {
                    // Fetch and process comments on our own post
                    const comments = await fetchComments(post.id);
                    elizaLogger.debug("[Instagram] Comments found on own post:", {
                        postId: post.id,
                        commentCount: comments.length
                    });

                    // Process each comment with rate limiting
                    for (const comment of comments) {
                        if (!this.isRunning) break;

                        // Add delay between processing comments
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        await this.handleComment({
                            id: comment.id,
                            text: comment.text,
                            username: comment.username,
                            media_id: post.id
                        });
        }
      } catch (error) {
                    elizaLogger.error("[Instagram] Error processing comments on own post:", {
                        postId: post.id,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                return;
            }

            // For other users' posts, proceed with normal processing
            if (hasProcessed) {
                elizaLogger.debug("[Instagram] Skipping already processed post:", {
                    postId: post.id,
                    mediaType: post.mediaType
                });
                return;
            }

            // Log the post details before processing
            elizaLogger.debug("[Instagram] Processing timeline post:", {
                postId: post.id,
                mediaType: post.mediaType,
                userId: post.user?.pk,
                username: post.user?.username,
                caption: post.caption?.text?.substring(0, 100) // Log first 100 chars
            });

            // First attempt to like the post
            try {
                await likeMedia(post.id);
                elizaLogger.debug("[Instagram] Successfully liked post:", {
                    postId: post.id
                });

                // Add delay between like and comment
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Generate and post comment if appropriate
                const shouldComment = await this.evaluateInteraction(post);
                if (shouldComment) {
                    const response = await this.generateResponse(
                        post.caption.text,
                        post.user.username,
                        'post_comment',
                        post.id
                    );

                    if (response) {
                        await postComment(post.id, response);
                        elizaLogger.debug("[Instagram] Successfully commented on post:", {
                            postId: post.id,
                            response
            });
          }
        }

                // Mark post as processed
                await this.runtime.cacheManager.set(postKey, {
                    processedAt: new Date().toISOString(),
                    liked: true,
                    commented: shouldComment
                });

            } catch (error) {
                elizaLogger.error("[Instagram] Error processing post:", {
                    postId: post.id,
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error;
        }

      } catch (error) {
            elizaLogger.error("[Instagram] Error in processTimelinePost:", {
          error: error instanceof Error ? error.message : String(error),
                postData: {
                    id: post.id,
                    mediaType: post.mediaType,
                    username: post.user?.username
                }
            });
            throw error;
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
            // Skip if comment is from the agent itself
            if (comment.username === this.state.profile?.username) {
                elizaLogger.debug("[Instagram] Skipping own comment:", {
                    commentId: comment.id,
                    mediaId: comment.media_id
                });
                return;
            }

            // Check if we've already processed this comment
            const commentKey = `instagram/comment/${comment.id}`;
            const hasProcessed = await this.runtime.cacheManager.get(commentKey);
            if (hasProcessed) {
                elizaLogger.debug("[Instagram] Skipping already processed comment:", {
                    commentId: comment.id,
                    mediaId: comment.media_id
                });
                return;
            }

            // Add delay before processing to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Generate response with enhanced context
            const response = await this.generateResponse(
                comment.text,
                comment.username,
                'comment',
                comment.media_id
            );

            if (response) {
                try {
                    // Reply to the comment
                    await replyToComment(comment.media_id, comment.id, response);

                    // Cache the comment as processed
                    await this.runtime.cacheManager.set(commentKey, 'true', 60 * 60 * 24); // 24 hour cache

                    elizaLogger.debug("[Instagram] Successfully replied to comment:", {
                        commentId: comment.id,
                        mediaId: comment.media_id,
                        response
                    });
                } catch (error) {
                    if (error.message?.includes('feedback_required')) {
                        // Handle rate limiting with exponential backoff
                        const backoffMs = Math.min(this.checkInterval * 2, 30 * 60 * 1000); // Max 30 minutes
                        elizaLogger.warn("[Instagram] Rate limit hit, increasing backoff:", {
                            currentInterval: this.checkInterval,
                            newInterval: backoffMs
                        });
                        this.checkInterval = backoffMs;
                        throw error;
                    }
                    elizaLogger.error("[Instagram] Error replying to comment:", {
                        commentId: comment.id,
                        mediaId: comment.media_id,
                        error: error instanceof Error ? error.message : String(error)
                    });
                    throw error;
                }
            }
      } catch (error) {
            elizaLogger.error("[Instagram] Error handling comment:", {
                error: error instanceof Error ? error.message : String(error),
                commentData: comment,
                stack: error instanceof Error ? error.stack : undefined
            });
            throw error;
        }
    }

    private async generateResponse(
        text: string,
        username: string,
        action: string,
        mediaId?: string
    ): Promise<string | null> {
        try {
            // Add debug logging for character state
            elizaLogger.debug("[Instagram] Character state before response generation:", {
                hasCharacter: !!this.runtime.character,
                characterName: this.runtime.character?.name,
                characterExists: this.runtime.character !== undefined,
                characterIsNull: this.runtime.character === null,
                runtimeExists: !!this.runtime
            });

            // Get post context if mediaId is provided
            let postContext = '';
            if (mediaId) {
                try {
                    const post = await this.runtime.cacheManager.get(`instagram/post_content/${mediaId}`);
                    if (post) {
                        postContext = `This is in response to a post about: "${post}"`;
                    }
                } catch (error) {
                    elizaLogger.warn("[Instagram] Could not fetch post context:", {
                        mediaId,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            const state = {
                agentName: this.runtime.character?.name || 'Fashion Commentator',
                bio: this.runtime.character?.bio?.join('\n') || '',
                lore: this.runtime.character?.lore?.join('\n') || '',
                topics: this.runtime.character?.topics?.join('\n') || '',
                knowledge: this.runtime.character?.knowledge?.join('\n') || '',
                username: username || '',
                text: text || '',
                postContext: postContext || '',
                action: action
            };

            // Ensure required properties are present
            if (!state.agentName) {
                state.agentName = this.runtime.character?.name || "Default Agent Name";
            }
            if (!state.character) {
                state.character = this.runtime.character || { name: "Default Agent Name" };
            }

            const template = `
You are {{agentName}}, a fashion commentator on Instagram.

# Your Profile
{{bio}}
{{lore}}

# Your Knowledge & Topics
{{knowledge}}
{{topics}}

{{#if postContext}}
# Context
{{postContext}}
{{/if}}

# Task
Generate a brief, engaging response to this Instagram {{action}}:
@{{username}}: {{text}}

Your response should be:
1. In your unique voice and style
2. Brief (1-2 sentences)
3. Natural and conversational
4. Engaging and on-brand for your character

Response:`;

            const context = composeContext({
                state: {
                    ...state,
                    // Convert actionNames array to string
                    actionNames: Array.isArray(state.actionNames)
                        ? state.actionNames.join(', ')
                        : state.actionNames || '',
                    actions: Array.isArray(state.actions)
                        ? state.actions.join('\n')
                        : state.actions || '',
                    // Ensure character examples are included
                    characterPostExamples: this.runtime.character.messageExamples
                        ? this.runtime.character.messageExamples
                            .map(example =>
                                example.map(msg =>
                                    `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ''}`
                                ).join('\n')
                            ).join('\n\n')
                        : '',
                },
                template:
                    this.runtime.character.templates
                        ?.twitterMessageHandlerTemplate ||
                    this.runtime.character?.templates?.messageHandlerTemplate ||
                    template,
            });

            const response = await generateText({
                runtime: this.runtime,
                context: context,
                modelClass: ModelClass.FAST
            });

            if (!response) {
                elizaLogger.warn("[Instagram] No response generated:", {
                    text,
                    username,
                    action
                });
                return null;
            }

            // Create memory for this interaction
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`instagram-${action}-${Date.now()}`),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: `${username}: ${text}\nResponse: ${response}`,
                    source: "instagram",
                    action: action,
                    postContext: postContext || undefined
                },
                roomId: stringToUuid(`instagram-room-${Date.now()}`),
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now(),
            });

            return this.cleanResponse(response);
        } catch (error) {
            elizaLogger.error("[Instagram] Error generating response:", {
                error: error instanceof Error ? error.message : String(error),
                text,
                username,
                action,
                characterName: this.runtime.character?.name,
                hasCharacter: !!this.runtime.character
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