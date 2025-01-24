import type { IgApiClient } from 'instagram-private-api';

export interface InstagramState {
  profile: InstagramProfile | null;
  isInitialized: boolean;
  accessToken: string | null;
  longLivedToken: string | null;
  lastCheckedMediaId: string | null;
}

export interface InstagramProfile {
  id: string;
  username: string;
  name: string;
  biography: string;
  mediaCount: number;
  followerCount: number;
  followingCount: number;
}

export interface MediaItem {
  id: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  mediaUrl: string;
  thumbnailUrl?: string;
  permalink: string;
  caption?: string;
  timestamp: string;
  children?: MediaItem[];
}

export interface Comment {
  id: string;
  text: string;
  timestamp: string;
  username: string;
  replies?: Comment[];
}

export interface InstagramConfig {
  INSTAGRAM_USERNAME?: string;
  INSTAGRAM_PASSWORD?: string;
  INSTAGRAM_PROXY_URL?: string;
  INSTAGRAM_DRY_RUN?: boolean;
  INSTAGRAM_ENABLE_ACTION_PROCESSING?: boolean;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  INSTAGRAM_BUSINESS_ACCOUNT_ID?: string;
  INSTAGRAM_MAX_ACTIONS?: number;
}