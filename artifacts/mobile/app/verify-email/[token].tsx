import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVerifyEmail } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';

export default function VerifyEmailScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();

  const [state, setState] = useState<'verifying' | 'success' | 'error'>('verifying');
  const { mutateAsync: verifyEmail } = useVerifyEmail();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    if (!token) {
      setState('error');
      return;
    }

    verifyEmail({ data: { token } })
      .then(() => setState('success'))
      .catch(() => setState('error'));
  }, [token, verifyEmail]);

  const goHome = () => {
    router.replace(isAuthenticated ? '/(tabs)' : '/(auth)/login');
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <View style={styles.content}>
        {state === 'verifying' ? (
          <>
            <ActivityIndicator size="large" color={colors.primary} testID="verify-loading" />
            <Text style={[styles.subtitle, { color: colors.mutedForeground, marginTop: 24 }]}>
              Verifying your email…
            </Text>
          </>
        ) : state === 'success' ? (
          <View style={styles.resultBox} testID="verify-success">
            <Feather name="check-circle" size={48} color={colors.success} />
            <Text style={[styles.title, { color: colors.foreground }]}>Email verified!</Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              Your email address has been confirmed.
            </Text>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={goHome}
              testID="verify-continue"
            >
              <Text style={styles.buttonText}>
                {isAuthenticated ? 'Continue' : 'Go to Sign In'}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.resultBox} testID="verify-error">
            <Feather name="alert-circle" size={48} color={colors.destructive} />
            <Text style={[styles.title, { color: colors.foreground }]}>
              Verification failed
            </Text>
            <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
              This verification link is invalid or has expired. You can request a
              new one from your profile.
            </Text>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={goHome}
              testID="verify-continue"
            >
              <Text style={styles.buttonText}>
                {isAuthenticated ? 'Continue' : 'Go to Sign In'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resultBox: {
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
  button: {
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    marginTop: 16,
  },
  buttonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: 'bold',
  },
});
