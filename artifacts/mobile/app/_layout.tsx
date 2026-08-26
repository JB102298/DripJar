import React, { useEffect } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack, Redirect, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { CreateJarProvider } from "@/contexts/create-jar-context";
import { setBaseUrl } from "@workspace/api-client-react";
import { isPublicRoute } from "@/lib/auth-gate";
import { queryClient } from "@/lib/query-client";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

/**
 * App-foreground refresh on native.
 *
 * React Query's `refetchOnWindowFocus` is on by default, but its default focus
 * detection listens for DOM `visibilitychange`/`focus` events. Those do not
 * exist in React Native, so on iOS and Android the app returning from the
 * background refetched nothing — a stale unread badge and a stale notification
 * list survived indefinitely. Bridging AppState into `focusManager` is the
 * supported way to make that default true off the web.
 *
 * Web is left alone: the DOM listeners already work there, and installing a
 * second source of truth would fight them.
 */
function subscribeAppStateFocus(): () => void {
  if (Platform.OS === "web") return () => {};
  const subscription = AppState.addEventListener("change", (status: AppStateStatus) => {
    focusManager.setFocused(status === "active");
  });
  return () => subscription.remove();
}

// API base URL for the generated client.
//
// EXPO_PUBLIC_API_URL is the primary source and is used verbatim, so it can
// carry its own scheme and port (e.g. http://localhost:5000 for local preview).
// auth-context already treats this variable as the API location, so honouring it
// here keeps both request paths pointed at the same server.
//
// EXPO_PUBLIC_DOMAIN remains as the fallback with its original https:// form,
// preserving existing Replit preview behaviour unchanged.
const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : null);

if (apiBaseUrl) {
  setBaseUrl(apiBaseUrl);
}

function RootLayoutNav() {
  const { isAuthenticated, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!isAuthenticated && !isPublicRoute(segments[0])) {
      // (see lib/auth-gate.ts for the public-route rules)
      router.replace("/(auth)");
    } else if (isAuthenticated && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [isAuthenticated, isLoading, segments]);

  if (isLoading) {
    return null; // Or a splash screen
  }

  return (
    <Stack screenOptions={{ headerShown: false, headerBackTitle: "Back" }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="create-jar" options={{ headerShown: false }} />
      <Stack.Screen name="jar/[id]" options={{ headerShown: false }} />
      <Stack.Screen
        name="invite/[token]"
        options={{ headerShown: false, presentation: "modal" }}
      />
      <Stack.Screen name="reset-password/[token]" options={{ headerShown: false }} />
      <Stack.Screen
        name="contribution/[jarId]"
        options={{ headerShown: false, presentation: "modal" }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(subscribeAppStateFocus, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <CreateJarProvider>
                  <RootLayoutNav />
                </CreateJarProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
