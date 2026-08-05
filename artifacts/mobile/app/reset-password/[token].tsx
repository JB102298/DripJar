import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResetPassword } from '@workspace/api-client-react';

// Mirrors the backend password policy (validation.ts):
// min 8 chars, max 72 chars.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

export default function ResetPasswordScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);

  const { mutateAsync: resetPassword, isPending } = useResetPassword();

  const handleReset = async () => {
    if (!token) {
      setError('This reset link is invalid. Please request a new one.');
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters`);
      return;
    }
    if (password.length > PASSWORD_MAX) {
      setError(`Password must be at most ${PASSWORD_MAX} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    try {
      setError('');
      await resetPassword({ data: { token, password } });
      setIsSuccess(true);
    } catch (e: any) {
      // 400 from the API means invalid/expired token. Never echo the token.
      const status = e?.response?.status ?? e?.status;
      if (status === 400) {
        setError('This reset link is invalid or has expired. Please request a new one.');
      } else {
        setError('Could not reset your password. Please try again.');
      }
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <View style={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.foreground }]}>Choose a new password</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            Enter a new password for your DripJar account.
          </Text>
        </View>

        {isSuccess ? (
          <View
            style={[styles.successBox, { backgroundColor: colors.secondary, borderColor: colors.success }]}
            testID="reset-success"
          >
            <Feather name="check-circle" size={24} color={colors.success} style={{ marginBottom: 12 }} />
            <Text style={[styles.successText, { color: colors.foreground }]}>
              Your password has been reset. Please sign in with your new password.
            </Text>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary, marginTop: 24, width: '100%' }]}
              onPress={() => router.replace('/(auth)/login')}
              testID="go-to-login"
            >
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Go to Sign In</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>New password</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="At least 8 characters"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  secureTextEntry={!showPassword}
                  value={password}
                  onChangeText={setPassword}
                  testID="password-input"
                />
                <Pressable onPress={() => setShowPassword((v) => !v)} style={styles.eyeButton}>
                  <Feather name={showPassword ? 'eye-off' : 'eye'} size={20} color={colors.mutedForeground} />
                </Pressable>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Confirm new password</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="Re-enter your new password"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  secureTextEntry={!showPassword}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  testID="confirm-password-input"
                />
              </View>
            </View>

            {error ? (
              <Text style={[styles.errorText, { color: colors.destructive }]} testID="reset-error">
                {error}
              </Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9 },
              ]}
              onPress={handleReset}
              disabled={isPending}
              testID="submit-reset"
            >
              {isPending ? (
                <ActivityIndicator color={colors.primaryForeground} testID="reset-loading" />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Reset Password</Text>
              )}
            </Pressable>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 24,
  },
  header: {
    marginBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 24,
  },
  form: {
    flex: 1,
  },
  inputGroup: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    height: 56,
  },
  input: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 16,
    fontSize: 16,
  },
  eyeButton: {
    paddingHorizontal: 16,
    height: '100%',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 14,
    marginBottom: 16,
  },
  button: {
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  successBox: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
  },
  successText: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
});
