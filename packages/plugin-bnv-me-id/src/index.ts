import { Plugin, Client, elizaLogger, IAgentRuntime } from "@elizaos/core";
import launchAgentPlugin from "./actions/createAvatar";
import { getResponseFromBnv, createMeIdUser, getWearables } from "./utils/api";
import { startupClient } from "./actions/startupClient";
// Custom client to trigger the plugin action on agent startup
// ... existing code ...

export const webBnvPlugin: Plugin = {
    name: "webBnv",
    description: "Search web bnv",
    actions: [launchAgentPlugin],
    evaluators: [],
    providers: [],
    clients: [startupClient],
};

export default webBnvPlugin;
