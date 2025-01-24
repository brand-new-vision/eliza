import { IgApiClient } from 'instagram-private-api';
import { elizaLogger } from "@elizaos/core";
import type { InstagramState } from '../types';

// Create a singleton for the Instagram API client
let igClient: IgApiClient | null = null;

export const getIgClient = () => {
  if (!igClient) {
    igClient = new IgApiClient();
    elizaLogger.log("[Instagram] Created new client instance");
  }
  return igClient;
};

export const setIgClient = (client: IgApiClient) => {
  igClient = client;
  // Only log details if we have a session
  if (client.state.cookieUserId) {
    elizaLogger.log("[Instagram] Client state updated", {
      username: client.state.cookieUsername,
      userId: client.state.cookieUserId
    });
  }
};

export const clearIgClient = () => {
  igClient = null;
  elizaLogger.log("[Instagram] Client state cleared");
};

// Create initial state with only necessary fields
export const createInitialState = (): InstagramState => ({
  profile: null,
  isInitialized: false,
  accessToken: null,
  longLivedToken: null,
  lastCheckedMediaId: null
});