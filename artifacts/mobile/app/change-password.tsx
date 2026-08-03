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
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChangePassword } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';

// Mirrors the backend password policy (validation.ts): min 8, max 72 chars.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

export default function ChangePasswordScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { logout } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);

  const { mutateAsync: changePassword, isPending } = useChangePassword();

  const handleChange = async () => {
    if (!currentPassword) {
      setError('Please enter your current password');
      return;
    }
    if (newPassword.length < PASSWORD_MIN) {
      setError(`New password must be at least ${PASSWORD_MIN} characters`);
      return;
    }
    if (newPassword.length > PASSWORD_MAX) {
      setError(`New password must be at most ${PASSWORD_MAX} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from your current password');
      return;
    }
    try {
      setError('');
      await changePassword({ data: { currentPassword, newPassword } });
      setIsSuccess(true);
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status;
      if (status === 401) {
        setError('Your current password is incorrect.');
      } else if (status === 429) {
        setError('Too many attempts. Please try again later.');
      } else {
        setError(e?.message || 'Could not change your password. Please try again.');
      }
    }
  };

  // Changing the password revokes every session (all devices), so after
  // success the user signs in again with the new password.
  const handleContinue = async () => {
    await logout();
    router.replace('/(auth)/login');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <View style={[styles.content, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} style={styles.backButton} testID="back-button">
            <Feather name="arrow-left" size={24} color={colors.foreground} />
          </Pressable>
        </View>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.foreground }]}>Change password</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            After changing your password you'll be signed out everywhere and need to
            sign in again.
          </Text>
        </View>

        {isSuccess ? (
          <View
            style={[styles.successBox, { backgroundColor: colors.secondary, borderColor: colors.success }]}
            testID="change-success"
          >
            <Feather name="check-circle" size={24} color={colors.success} style={{ marginBottom: 12 }} />
            <Text style={[styles.successText, { color: colors.foreground }]}>
              Your password has been changed. Please sign in with your new password.
            </Text>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary, marginTop: 24, width: '100%' }]}
              onPress={handleContinue}
              testID="go-to-login"
            >
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Go to Sign In</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Current password</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="Your current password"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  secureTextEntry={!showPassword}
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  testID="current-password-input"
                />
                <Pressable onPress={() => setShowPassword((v) => !v)} style={styles.eyeButton}>
                  <Feather name={showPassword ? 'eye-off' : 'eye'} size={20} color={colors.mutedForeground} />
                </Pressable>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>New password</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="At least 8 characters"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  secureTextEntry={!showPassword}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  testID="new-password-input"
                />
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
              <Text style={[styles.errorText, { color: colors.destructive }]} testID="change-error">
                {error}
              </Text>
            ) : null}

            <Pressable
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9 },
              ]}
              onPress={handleChange}
              disabled={isPending}
              testID="submit-change"
            >
              {isPending ? (
                <ActivityIndicator color={colors.primaryForeground} testID="change-loading" />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Change Password</Text>
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
  headerRow: {
    marginBottom: 8,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
  },
  header: {
    marginBottom: 32,
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
    padding: 16,
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
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
  },
  successText: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
});
