import { IgApiClient } from 'instagram-private-api';
import { elizaLogger } from "@elizaos/core";
import type { InstagramState } from '../types';

// We'll keep track of the current active client instance
let activeClient: IgApiClient | null = null;

/**
 * Gets the current active client. Note: This should only be used after proper initialization.
 * For new client creation, always create a fresh IgApiClient instance.
 */
export const getIgClient = () => {
    if (!activeClient) {
        elizaLogger.warn("[Instagram] Attempted to get client before initialization");
        return null;
    }
    return activeClient;
};

/**
 * Sets the active client after successful authentication
 */
export const setIgClient = (client: IgApiClient) => {
    activeClient = client;
    elizaLogger.debug("[Instagram] Active client updated");
};

/**
 * Creates the initial state object with default values
 */
export const createInitialState = (): InstagramState => ({
    profile: null,
    isInitialized: false,
    accessToken: null,
    longLivedToken: null,
    lastCheckedMediaId: null
});