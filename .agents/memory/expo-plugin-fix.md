---
name: Expo build-properties plugin fix
description: expo-build-properties removed from app.json — not installed, blocked startup
---

# expo-build-properties Plugin Removed

## What Happened
`app.json` had `expo-build-properties` listed in the `plugins` array but the package was not installed in `artifacts/mobile/package.json`. This caused:
```
PluginError: Failed to resolve plugin for module "expo-build-properties"
```
…and prevented the Expo dev server from starting.

## Fix Applied
Removed the plugin entry from `app.json` `expo.plugins`. The remaining plugins are `["expo-router", "expo-font"]`.

**Why:** The new architecture flag (`newArchEnabled: true`) this plugin was enabling is not needed for the web/preview build target used in development.

## If You Need It Back
Install it first: add `expo-build-properties` to `artifacts/mobile/package.json` dependencies, run `pnpm install`, then re-add the plugin to `app.json`.
