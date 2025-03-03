import {
    ActionExample,
    Memory,
    Action,
    IAgentRuntime,
    HandlerCallback,
    elizaLogger,
    State,
    generateText,
    ModelClass,
    composeContext,
} from "@elizaos/core";

import { getResponseFromBnv } from "../utils/api";
import { webSearchPlugin } from "@elizaos/plugin-web-search";

// The main action to handle launching the agent
export const LaunchAgentAction: Action = {
    name: "LAUNCH_AGENT",
    similes: ["CREATE_AGENT", "DEPLOY_AGENT", "DEPLOY_ELIZA", "DEPLOY_BOT"],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        elizaLogger.log("bnv plugin has been started");
        const triggerWords = ["bnv", "fashion"];
        const shouldTrigger = triggerWords.some((word) =>
            message.content.text.toLowerCase().includes(word)
        );

        if (shouldTrigger) {
            elizaLogger.log(`Validation passed: Trigger word found.`);
            return true;
        }

        elizaLogger.log(`Validation failed: No trigger words detected.`);
        return false;
    },
    description: "Launch an Eliza agent when fashion or BNV is mentioned",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            await runtime.initialize(); // Proper initialization method
            elizaLogger.log("LAUNCH_AGENT handler triggered...");

            const gameState =
                state ?? ((await runtime.composeState(message)) as State);

            state.gameState = {
                ...((state.gameState as Record<string, any>) || {}),
                ...gameState,
            };

            elizaLogger.info("Current State", {
                state: state.gameState,
            });

            let agentSummaryMemory =
                await runtime.knowledgeManager.getMemoryById(message.agentId);
            if (!agentSummaryMemory) {
                // Fetch & set summary memory.
                elizaLogger.debug("asterai agent summary fetched:", message);
                await runtime.knowledgeManager.createMemory({
                    id: message.agentId,
                    userId: message.userId,
                    agentId: message.agentId,
                    roomId: message.roomId,
                    createdAt: Date.now(),
                    content: {
                        text: message.roomId,
                    },
                });
                agentSummaryMemory =
                    await runtime.knowledgeManager.getMemoryById(
                        message.agentId
                    );
            }

            // Step 1: Trigger Web Search Plugin
            const searchResults = (await webSearchPlugin.actions[0].handler(
                runtime,
                message,
                gameState,
                {},
                async (response) => {
                    elizaLogger.log("Web search results :", response);
                    return [
                        {
                            userId: message.userId,
                            agentId: message.agentId,
                            roomId: message.roomId,
                            content: response,
                        },
                    ];
                }
            )) as Memory[];
            elizaLogger.log("Web search results received:", searchResults);

            const resp = await getResponseFromBnv("https://id-station-alpha-api.bnv.me");
            elizaLogger.log("BNV API Response:", resp);

            callback?.({
                text: `Agent successfully triggered due to mention of 'BNV' or 'fashion'. Response: ${resp.message}`,
            });
            return true;
        } catch (error) {
            elizaLogger.error("Error during agent launch:", error);
            callback?.({
                text: `Error launching agent: ${error.message}`,
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Tell me about BNV fashion.",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "BNV is a leading brand in fashion. Launching agent now...",
                    action: "LAUNCH_AGENT",
                },
            },
        ],
        [
            {
                user: "{{user2}}",
                content: {
                    text: "Do you know the latest trends in fashion?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Fashion is ever-changing. Let me fetch some insights for you...",
                    action: "LAUNCH_AGENT",
                },
            },
        ],
        [
            {
                user: "{{user3}}",
                content: {
                    text: "What's the story behind BNV?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "BNV is a digital fashion brand making waves in the metaverse. Triggering action...",
                    action: "LAUNCH_AGENT",
                },
            },
        ],
    ] as ActionExample[][],
};

export default LaunchAgentAction;
