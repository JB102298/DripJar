import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { getItem, setItem, deleteItem } from '@/lib/token-storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';
import { useGetMe, useLogin, useRegister, getGetMeQueryKey } from '@workspace/api-client-react';
import type {
  User,
  Profile,
  LoginRequest,
  RegisterRequest,
} from '@workspace/api-client-react';

// ─── Token storage keys ──────────────────────────────────────────────────────
//
// Unchanged from the original SecureStore implementation. Renaming these would
// sign out every existing native user, so the legacy 'tripjar_' prefix stays.

const ACCESS_TOKEN_KEY = 'tripjar_access_token';
const REFRESH_TOKEN_KEY = 'tripjar_refresh_token';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function decodeJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function tokenIsValid(token: string): boolean {
  const exp = decodeJwtExpiry(token);
  if (exp === null) return true; // can't decode — let server decide
  return exp * 1000 > Date.now() + 30_000; // valid if > 30s remaining
}

// ─── Context types ────────────────────────────────────────────────────────────

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// ─── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Mutex: prevents concurrent token refreshes
  const refreshLockRef = useRef<Promise<string | null> | null>(null);

  // ── Auto-refresh logic ──────────────────────────────────────────────────

  const doRefresh = async (): Promise<string | null> => {
    // Deduplicate: if a refresh is already in progress, reuse it
    if (refreshLockRef.current) return refreshLockRef.current;

    refreshLockRef.current = (async () => {
      try {
        const storedRefreshToken = await getItem(REFRESH_TOKEN_KEY);
        if (!storedRefreshToken) {
          await clearAuth();
          return null;
        }

        const apiBase = process.env['EXPO_PUBLIC_API_URL'] ?? '';
        const response = await fetch(`${apiBase}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: storedRefreshToken }),
        });

        if (!response.ok) {
          await clearAuth();
          return null;
        }

        const data = (await response.json()) as {
          token: string;
          refreshToken: string;
        };

        await setItem(ACCESS_TOKEN_KEY, data.token);
        await setItem(REFRESH_TOKEN_KEY, data.refreshToken);
        setAccessToken(data.token);
        return data.token;
      } catch {
        await clearAuth();
        return null;
      } finally {
        refreshLockRef.current = null;
      }
    })();

    return refreshLockRef.current;
  };

  const clearAuth = async () => {
    await deleteItem(ACCESS_TOKEN_KEY);
    await deleteItem(REFRESH_TOKEN_KEY);
    setAccessToken(null);
    setAuthTokenGetter(null);
  };

  // ── Wire up the auth token getter ────────────────────────────────────────

  const wireAuthGetter = (token: string) => {
    setAuthTokenGetter(async () => {
      const current = await getItem(ACCESS_TOKEN_KEY);
      if (!current) return null;

      // Proactively refresh if expiring within 60 seconds
      if (!tokenIsValid(current)) {
        return doRefresh();
      }
      return current;
    });
  };

  // ── Initialize: load tokens from storage (migrate AsyncStorage) ─────────

  useEffect(() => {
    async function init() {
      try {
        // One-time migration: move old AsyncStorage token into token storage
        const legacyToken = await AsyncStorage.getItem('auth_token');
        if (legacyToken) {
          await setItem(ACCESS_TOKEN_KEY, legacyToken);
          await AsyncStorage.removeItem('auth_token');
          // No refresh token from old sessions — user will get one on next login
        }

        const stored = await getItem(ACCESS_TOKEN_KEY);
        if (stored) {
          if (tokenIsValid(stored)) {
            setAccessToken(stored);
            wireAuthGetter(stored);
          } else {
            // Access token expired — try to refresh immediately
            const refreshed = await doRefresh();
            if (refreshed) {
              setAccessToken(refreshed);
              wireAuthGetter(refreshed);
            }
          }
        }
      } catch (e) {
        console.error('[AuthProvider] Init error', e);
      } finally {
        setIsInitializing(false);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Me query ─────────────────────────────────────────────────────────────

  const { data: meData, isLoading: isMeLoading, refetch } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), enabled: !!accessToken, retry: false },
  });

  // ── Auth actions ─────────────────────────────────────────────────────────

  const login = async (credentials: LoginRequest) => {
    const apiBase = process.env['EXPO_PUBLIC_API_URL'] ?? '';
    const response = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    if (!response.ok) {
      const err = (await response.json()) as { message?: string };
      throw new Error(err.message ?? 'Login failed');
    }

    const data = (await response.json()) as {
      token: string;
      refreshToken: string;
    };

    await setItem(ACCESS_TOKEN_KEY, data.token);
    await setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setAccessToken(data.token);
    wireAuthGetter(data.token);
  };

  const register = async (payload: RegisterRequest) => {
    const apiBase = process.env['EXPO_PUBLIC_API_URL'] ?? '';
    const response = await fetch(`${apiBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = (await response.json()) as { message?: string };
      throw new Error(err.message ?? 'Registration failed');
    }

    const data = (await response.json()) as {
      token: string;
      refreshToken: string;
    };

    await setItem(ACCESS_TOKEN_KEY, data.token);
    await setItem(REFRESH_TOKEN_KEY, data.refreshToken);
    setAccessToken(data.token);
    wireAuthGetter(data.token);
  };

  const logoutAction = async () => {
    const apiBase = process.env['EXPO_PUBLIC_API_URL'] ?? '';
    try {
      const current = await getItem(ACCESS_TOKEN_KEY);
      const refreshToken = await getItem(REFRESH_TOKEN_KEY);
      if (current && refreshToken) {
        await fetch(`${apiBase}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${current}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch {
      // Best-effort logout — clear local state regardless
    }
    await clearAuth();
  };

  // ─── Context value ────────────────────────────────────────────────────────

  const value: AuthContextType = {
    user: meData?.user ?? null,
    profile: meData?.profile ?? null,
    token: accessToken,
    isAuthenticated: !!accessToken && !!meData?.user,
    isLoading: isInitializing || (!!accessToken && isMeLoading),
    login,
    register,
    logout: logoutAction,
    refresh: async () => { await refetch(); },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
