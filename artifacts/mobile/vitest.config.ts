import { defineConfig } from "vitest/config";

// Minimal test infrastructure for auth-context behavior tests (Task 4).
// Runs auth-context.tsx (plain React — no native components) under jsdom
// with expo-secure-store, AsyncStorage, and the API client fully mocked.
// No device, emulator, or Expo/Metro runtime is required.
export default defineConfig({
  resolve: {
    // Platform-specific modules (e.g. lib/token-storage.web.ts vs
    // .native.ts) are resolved by Metro at bundle time. Vite does not apply
    // React Native platform extensions, so they are declared here.
    //
    // ".web" comes first deliberately: this suite runs under jsdom with
    // react-native-web, which IS the web platform. Tests therefore exercise the
    // same implementation the browser bundle uses. ".native" variants are
    // covered by importing them directly.
    extensions: [".web.tsx", ".web.ts", ".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"],
    // Screen tests render react-native primitives under jsdom via
    // react-native-web (same mapping Expo web uses).
    alias: {
      "react-native": "react-native-web",
      // Mirror the Expo tsconfig "@/*" path alias
      "@": new URL(".", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    include: ["__tests__/**/*.test.{ts,tsx}"],
    globals: false,
  },
  esbuild: {
    jsx: "automatic",
  },
});
