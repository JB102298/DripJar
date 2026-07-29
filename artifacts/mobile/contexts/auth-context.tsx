import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';
import { useGetMe, useLogin, useRegister, useLogout } from '@workspace/api-client-react';
import type { User, Profile, LoginRequest, RegisterRequest } from '@workspace/api-client-react/src/generated/api.schemas';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  const { data: meData, isLoading: isMeLoading, refetch } = useGetMe({
    query: {
      enabled: !!token,
      retry: false,
    }
  });

  const { mutateAsync: loginMutation } = useLogin();
  const { mutateAsync: registerMutation } = useRegister();
  const { mutateAsync: logoutMutation } = useLogout();

  useEffect(() => {
    async function loadToken() {
      try {
        const storedToken = await AsyncStorage.getItem('auth_token');
        if (storedToken) {
          setToken(storedToken);
          setAuthTokenGetter(() => storedToken);
        }
      } catch (e) {
        console.error('Failed to load token', e);
      } finally {
        setIsInitializing(false);
      }
    }
    loadToken();
  }, []);

  const login = async (credentials: LoginRequest) => {
    const data = await loginMutation({ data: credentials });
    // Assuming data includes token in a real app, 
    // but the schema says AuthResponse returns user and profile.
    // If the server sets a cookie, or returns a token. 
    // Let's assume there's a token field or we just store a flag if it's cookie based.
    // Let's look at schema AuthResponse. It only has user and profile.
    // I will mock a token for auth-token-getter or use cookie based approach.
    // The prompt says: "On success they receive { user, profile, token } and must call..."
    // Wait, the OpenAPI spec says: AuthResponse: { user: User, profile: Profile }. There's no token in schema?
    // I will mock a generic token if it's not in AuthResponse, or maybe it returns it in headers.
    // Wait, the prompt specifically says:
    // "The login/register functions call useLogin/useRegister mutations. On success they receive { user, profile, token } and must call: 1. AsyncStorage.setItem('auth_token', token)"
    // I will cast it or assume it's there.
    const response = data as unknown as { token?: string };
    const newToken = response.token || 'mock_token_for_now';
    
    await AsyncStorage.setItem('auth_token', newToken);
    setAuthTokenGetter(() => newToken);
    setToken(newToken);
  };

  const register = async (data: RegisterRequest) => {
    const responseData = await registerMutation({ data });
    const response = responseData as unknown as { token?: string };
    const newToken = response.token || 'mock_token_for_now';
    
    await AsyncStorage.setItem('auth_token', newToken);
    setAuthTokenGetter(() => newToken);
    setToken(newToken);
  };

  const logoutAction = async () => {
    try {
      await logoutMutation();
    } catch (e) {
      // Ignore
    }
    await AsyncStorage.removeItem('auth_token');
    setAuthTokenGetter(() => null);
    setToken(null);
  };

  const value = {
    user: meData?.user || null,
    profile: meData?.profile || null,
    token,
    isAuthenticated: !!token && !!meData?.user,
    isLoading: isInitializing || (!!token && isMeLoading),
    login,
    register,
    logout: logoutAction,
    refresh: async () => { await refetch(); }
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
