import { defineConfig } from "vitest/config";

// Minimal test infrastructure for auth-context behavior tests (Task 4).
// Runs auth-context.tsx (plain React — no native components) under jsdom
// with expo-secure-store, AsyncStorage, and the API client fully mocked.
// No device, emulator, or Expo/Metro runtime is required.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.{ts,tsx}"],
    globals: false,
  },
  esbuild: {
    jsx: "automatic",
  },
});
