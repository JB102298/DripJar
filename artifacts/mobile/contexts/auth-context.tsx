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
    const newToken = data.token;
    await AsyncStorage.setItem('auth_token', newToken);
    setAuthTokenGetter(() => newToken);
    setToken(newToken);
  };

  const register = async (data: RegisterRequest) => {
    const responseData = await registerMutation({ data });
    const newToken = responseData.token;
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
