import {
    Client,
    IAgentRuntime,
    elizaLogger,
    generateText,
    ModelClass,
    composeContext,
    Memory,
    stringToUuid,
    State,
} from "@elizaos/core";

import { createMeIdUser, getWearables, createNewOutfit } from "../utils/api";
import { bnvTemplate } from "../utils/templates";
import { WearablesResponse, AvatarAttributes } from "../types";

const templateGeneration = async (runtime: IAgentRuntime) => {
    try {
        console.time("generateAvatarAttributesFromWearables");

        // Fetch memories only if agentId exists
        const roomIds = await runtime.databaseAdapter.getRoomsForParticipant(runtime.agentId);

        const memories = await runtime.messageManager.getMemoriesByRoomIds({
            roomIds: roomIds,
        });

        const eightHrsAgo = Date.now() - 8 * 60 * 60 * 1000;

        const recentMemories = memories.filter(item => item.createdAt >= eightHrsAgo);

        // Filter relevant memories efficiently
        const relevantMemories = recentMemories.filter(({ content }) =>
            ["fashion", "style", "outfit", "look", "trend"].some((keyword) =>
                content.text.toLowerCase().includes(keyword)
            )
        );

        elizaLogger.info(
            `[${runtime.agentId}] Relevant memories count: ${relevantMemories.length}`
        );
        let contents = [];
        relevantMemories.forEach((item) => {
            contents.push(item.content.text);
        });
        let relevantMemoryContent = contents.join("-");
        // **Updated composeContext state object**
        const context = composeContext({
            state: {
                bio: Array.isArray(runtime.character.bio)
                    ? runtime.character.bio.join(" ")
                    : runtime.character.bio,
                lore: Array.isArray(runtime.character.lore)
                    ? runtime.character.lore.join(" ")
                    : runtime.character.lore || "Default lore...",
                messageDirections: "north",
                postDirections: "south",
                roomId: stringToUuid(runtime.agentId),
                actors: "",
                context: "",
                agentId: runtime.agentId,
                agentName: runtime.character.name,
                memories: relevantMemories,
                recentMessages: "",
                recentMessagesData: [],
                memoryContent: relevantMemoryContent,
            },
            template: bnvTemplate,
        });

        elizaLogger.info("Template context:", JSON.stringify(context, null, 2));

        // Generate text
        const templateGenerated = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        elizaLogger.info("Generated object:", templateGenerated);

        // Parse response safely
        const templateParsed = JSON.parse(
            templateGenerated
                .replace(/^\s*```json/, "")
                .replace(/```$/, "")
                .trim()
        );

        console.timeEnd("generateAvatarAttributesFromWearables");

        return templateParsed;
    } catch (error) {
        console.error("Error generating avatar parameters:", error);
        throw error;
    }
};

const generateOutfit = async (
    avatarAttributes: AvatarAttributes,
    runtime: IAgentRuntime
) => {
    elizaLogger.info("Starting outfit generation...");

    const memories = await runtime.messageManager.getMemoriesByRoomIds({
        roomIds: [stringToUuid(runtime.agentId)],
    });

    if (!memories || memories.length === 0) {
        elizaLogger.info(
            "No memories found for the agent. Please provide some memories to generate an outfit."
        );
        return;
    }

    const wearableAttributes = [
        { key: "TOP", value: avatarAttributes.top },
        { key: "HAT", value: avatarAttributes.hat },
        { key: "BOTTOM", value: avatarAttributes.bottom },
        { key: "SHOES", value: avatarAttributes.shoes },
        { key: "ACCESSORIES", value: avatarAttributes.accessories },
        { key: "EYEWEAR", value: avatarAttributes.eyewear },
    ];

    elizaLogger.info("Processing wearable attributes...");
    const groupedMemories = wearableAttributes.reduce((acc, { key }) => {
        const matches = memories.filter((mem) =>
            mem.content.slots.includes(key)
        );
        if (matches.length > 0) {
            acc[key] = matches;
        }
        return acc;
    }, {});

    if (Object.keys(groupedMemories).length === 0) {
        elizaLogger.info("No matching memories found for the outfit.");
        return;
    }

    Object.entries(groupedMemories).forEach(([key, items]) => {
        elizaLogger.info(`Matched ${items.length} items for ${key}`);
    });

    for (const [key, items] of Object.entries(groupedMemories)) {
        for (const item of items) {
            const memory = {
                id: stringToUuid(
                    `template-model-response-${key}-${runtime.agentId}-${item.content.text}`
                ),
                agentId: runtime.agentId,
                roomId: stringToUuid(runtime.agentId + key),
                userId: runtime.agentId,
                content: item.content,
                createdAt: Date.now(),
            };
            await runtime.messageManager.addEmbeddingToMemory(memory);
            await runtime.messageManager.createMemory(memory);
        }
    }

    let expandedWearableAttributes = [];

    wearableAttributes.forEach(({ key, value }) => {
        elizaLogger.info(
            `Processing wearable attribute: ${key} - Type:`,
            typeof value
        );

        if (
            typeof value === "object" &&
            value !== null &&
            Array.isArray(value) &&
            value.length > 0
        ) {
            elizaLogger.info(
                `Expanding wearable attribute ${key}, size: ${value.length}`
            );
            value.forEach((item, index) => {
                expandedWearableAttributes.push({ key: `${key}`, value: item });
            });
        } else {
            expandedWearableAttributes.push({ key, value });
        }
    });

    elizaLogger.info("Expanded Wearable Attributes:", expandedWearableAttributes);

    // Generate memory entries
    const memoryEntries = expandedWearableAttributes.map(({ key, value }) => ({
        id: stringToUuid(`wearable-model-response-${key}-${Date.now()}`),
        agentId: runtime.agentId,
        roomId: stringToUuid(runtime.agentId),
        userId: runtime.agentId,
        content: { text: value, metadata: { type: key } },
    }));

    elizaLogger.info("Generated memory entries:", memoryEntries);

    const searchResultsCollection = await Promise.all(
        memoryEntries.map(async (memoryEntry) => {
            elizaLogger.info("Processing memory entry:", memoryEntry);
            elizaLogger.info(
                "Adding embedding to memory:",
                memoryEntry.content.metadata.type
            );
            const embeddingData =
                await runtime.messageManager.addEmbeddingToMemory(memoryEntry);
            const searchResults =
                await runtime.messageManager.searchMemoriesByEmbedding(
                    embeddingData.embedding,
                    {
                        roomId: stringToUuid(
                            runtime.agentId + memoryEntry.content.metadata.type
                        ),
                        match_threshold: 0.8,
                    }
                );
            return {
                search: searchResults.length > 0 ? searchResults[0] : null,
                llm: memoryEntry,
            }
        })
    );

    elizaLogger.info("Final processed search results:", searchResultsCollection);

    const finalMemories = searchResultsCollection
        .filter(Boolean)
        .map(({ search, llm }) => ({
            id: stringToUuid(search.id),
            content: {
                text: search.content.text,
                slots: search.content.slots,
                metadata: { source: "OUTFIT_GENERATION", similarity: search.similarity, llmText: llm.content.text, wearableId: search.id },
            },
            roomId: stringToUuid(runtime.agentId + "OUTFIT"),
            agentId: runtime.agentId,
            userId: runtime.agentId,
        }));

    await Promise.all(
        finalMemories.map(async (memory) =>
            await runtime.messageManager.createMemory(memory)
        )
    );

    elizaLogger.info("Final memory list stored:", finalMemories);
    // elizaLogger.info("Final memory list stored: - - ", searchResultsCollection);

    const wearableList = Array.from(
        new Set(
            searchResultsCollection
                .filter(Boolean)
                .map(({ search }) => search.content.text.split(",")[0].trim()) // Trim to remove extra spaces
        )
    ).map((wearable) => ({ wearable }));

    elizaLogger.info("Unique Wearable List:", wearableList);

    const requestPayload = {
        elizaUserName: runtime.character.name,
        wearables: wearableList,
        body: avatarAttributes.skinTone,
        head: avatarAttributes.facialFeatures,
    };

    const outfit = await createNewOutfit(
        runtime.getSetting("BNV_URL"),
        requestPayload,
        runtime.agentId
    );

    elizaLogger.info("- - - - ", outfit);

    elizaLogger.info("Final data to be sent to BNV API:", requestPayload);

    const roomIdsToRemove = new Set();
    for (const key of ["TOP", "HAT", "BOTTOM", "SHOES", "ACCESSORY"]) {
        const memoriesToRemove =
            await runtime.messageManager.getMemoriesByRoomIds({
                roomIds: [stringToUuid(runtime.agentId + key)],
            });
        memoriesToRemove.forEach((mem) => roomIdsToRemove.add(mem.id));
    }

    elizaLogger.info("Removing outdated memories:", Array.from(roomIdsToRemove));

    await Promise.all(
        Array.from(roomIdsToRemove).map(async (roomId) => {
            try {
                await runtime.messageManager.removeMemory(roomId);
                elizaLogger.info(`Memory ${roomId} successfully removed.`);
            } catch (error) {
                console.error(`Error removing memory ${roomId}:`, error);
            }
        })
    );

    elizaLogger.info("Outfit generation complete.");
};

const handleTimeoutWithInterval = async (runtime: IAgentRuntime) => {
    const OUTFIT_CREATION_FREQUENCY =
        parseInt(runtime.getSetting("OUTFIT_CREATION_FREQUENCY")) ||
        1440 * 60 * 1000; // de1 day

    const timeoutMs = OUTFIT_CREATION_FREQUENCY;
    elizaLogger.info(
        `Timer initiated with ${OUTFIT_CREATION_FREQUENCY} minutes timeout`
    );
    let intervalId: NodeJS.Timeout;
    let cleanup: () => void;

    const timeoutPromise = new Promise((resolve, reject) => {
        elizaLogger.info("Starting interval checks...");
        intervalId = setInterval(async () => {
            elizaLogger.info("timeout function called.");
            const avatarAttributes = await templateGeneration(runtime);
            elizaLogger.info(" - - - avatar params ---- ", avatarAttributes);
            await generateOutfit(avatarAttributes, runtime);
        }, timeoutMs);

        cleanup = () => {
            if (intervalId) {
                elizaLogger.info("Cleaning up interval timer");
                clearInterval(intervalId);
            }
        };
    });

    return { promise: timeoutPromise, cleanup };
};

const createNewUser = async (runtime: IAgentRuntime) => {
    elizaLogger.info("new user function called --- ", runtime.getSetting("BNV_URL"));
    await createMeIdUser(
        runtime.getSetting("BNV_URL"),
        runtime.character.name,
        runtime.agentId
    );
};

const transformWearable = (wearable: Record<string, any>) => {
    const slotsArray = Object.keys(wearable)
        .filter((key) => key.startsWith("slots["))
        .sort(
            (a, b) =>
                parseInt(a.match(/\d+/)?.[0] ?? "0") -
                parseInt(b.match(/\d+/)?.[0] ?? "0")
        ) // Sort by numeric index
        .map((key) => wearable[key])
        .filter((slot) => slot.trim() !== "");

    return {
        _id: wearable._id,
        aiDescription: wearable.aiDescription,
        slots: slotsArray,
    };
};

const createWearableProcessor = async (
    wearablesResponse: WearablesResponse,
    runtime: IAgentRuntime
): Promise<void> => {
    elizaLogger.info("Processing wearables...");
    const wearables = wearablesResponse.data.wearables;

    // Convert JSON to Object
    let transformedObject = [];
    wearables.forEach((wearable) => {
        const tt = transformWearable(wearable);
        elizaLogger.info(tt);
        transformedObject.push(tt);
    });
    for (let i = 0; i < transformedObject.length; i++) {
        const wearable = transformedObject[i];
        const memoryId = stringToUuid(
            `wearable-${wearable._id}-${wearable.aiDescription}-${runtime.agentId}`
        );

        try {
            // Check if memory already exists to avoid duplicates
            const existingMemory = await runtime.messageManager.getMemoryById(
                memoryId
            );
            if (existingMemory) {
                elizaLogger.info(
                    `⚠️ Skipping duplicate entry for wearable ${i + 1}`
                );
                continue;
            }
        } catch (error) {
            console.error("Error checking existing memory:", error);
        }

        const memory: Memory = {
            id: memoryId,
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: stringToUuid(runtime.agentId),
            content: {
                text: `${wearable._id},${
                    wearable.aiDescription
                },${wearable.slots.join(",")}`,
                slots: wearable.slots,
            },
            createdAt: Date.now(),
            unique: true,
        };

        for (let retry = 0; retry < 3; retry++) {
            try {
                elizaLogger.info(
                    `⏳ Writing wearable ${i + 1}/${wearables.length} to DB...`
                );
                // await runtime.messageManager.addEmbeddingToMemory(memory);
                const result = await runtime.messageManager.createMemory(
                    memory
                );
                elizaLogger.info(`✅ Success! Wearable ${i + 1} saved.`, result);
                break;
            } catch (error) {
                console.error(`❌ Write failed (Attempt ${retry + 1}):`, error);
                if (retry === 2)
                    console.error("🚨 Skipping this entry after 3 failures.");
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100)); // Avoid rate limits
    }

    elizaLogger.info("🎉 All wearables processed.");
};

const updateWearableEntry = async (runtime: IAgentRuntime) => {
    const wearablesResponse = await getWearables(
        runtime.getSetting("BNV_URL"),
        runtime.agentId
    );
    await createWearableProcessor(wearablesResponse, runtime);
};

export const startupClient: Client = {
    async start(runtime) {
        elizaLogger.info("StartupClient triggered on agent start");

        try {
            try {
                await runtime.initialize();
                elizaLogger.info("Runtime initialized");
                elizaLogger.info("Agent ID:", runtime.agentId);
                elizaLogger.info("Character name:", runtime.character.name);

                await createNewUser(runtime);
                await updateWearableEntry(runtime);

                const avatarAttributes = await templateGeneration(
                    runtime
                );
                elizaLogger.info(" - - - avatar params ---- ", avatarAttributes);
                await generateOutfit(avatarAttributes, runtime);

                const { promise: timeoutPromise, cleanup } =
                    await handleTimeoutWithInterval(runtime);

                //cleanup();
            } catch (error) {
                throw error;
            }
        } catch (error) {
            if (error.message.includes("timed out")) {
                console.error("Operation timed out:", error);
            } else {
                console.error("Error during startup:", error);
            }
            throw error;
        }
    },

    async stop() {
        elizaLogger.info("StartupClient stopped");
        // Add any cleanup or shutdown logic here if needed
    },
};
