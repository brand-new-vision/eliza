# BNV ME:ID Plugin

A plugin for ElizaOS that generates and manages 3D avatars with customizable outfits for agent characters.

## Overview

This plugin automatically creates and updates 3D avatars for your ElizaOS agents by:
- Generating detailed visual appearance descriptions based on character profiles
- Converting these descriptions into wearable items 
- Creating outfits by matching descriptions to available wearables
- Periodically refreshing outfits based on recent style-related conversations

## Setup

1. Add the plugin to your agent's configuration:

```json
"plugins": ["@elizaos/plugin-bnv-me-id"]
```

2. Ensure your agent's character file includes necessary configuration:

```json
"settings": {
  "OUTFIT_CREATION_FREQUENCY": "43200000",  // 12 hours in milliseconds
  "secrets": {},
  "voice": {
    "model": "eleven_multilingual_v2"
  }
}
```

## Key Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `BNV_URL` | BNV API endpoint URL for avatar creation | Required |
| `OUTFIT_CREATION_FREQUENCY` | How often to refresh outfits (in milliseconds) | 1440 * 60 * 1000 (1 day) |

## How It Works

1. On agent startup, the plugin:
   - Creates a new ME:ID account 
   - Loads available wearable items from the BNV API
   - Generates initial avatar attributes based on the character profile
   - Creates an initial outfit

2. The plugin periodically:
   - Analyzes recent conversations for style-related content
   - Generates new visual appearance descriptions
   - Creates updated outfits that reflect the character's evolving style

3. Avatar generation uses:
   - Character bio and lore
   - Recent chat history related to fashion, style, and outfits
   - Embedding-based similarity matching to available wearables
