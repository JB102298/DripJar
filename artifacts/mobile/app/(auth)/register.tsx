import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@/contexts/auth-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sanitizeReturnPath } from '@/lib/return-path';

export default function RegisterScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { register } = useAuth();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const safeReturnTo = sanitizeReturnPath(returnTo);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const getPasswordStrength = (): { width: `${number}%`; color: string } => {
    if (password.length === 0) return { width: '0%', color: colors.muted };
    if (password.length < 6) return { width: '33%', color: colors.destructive };
    if (password.length < 10) return { width: '66%', color: colors.warning };
    return { width: '100%', color: colors.success };
  };

  const handleRegister = async () => {
    if (!firstName || !lastName || !email || !password) {
      setError('Please fill out all fields');
      return;
    }
    try {
      setIsLoading(true);
      setError('');
      await register({ firstName, lastName, email, password });
      // If the user arrived from an invitation, send them straight back to
      // it after registering; profile setup can be completed later.
      router.replace((safeReturnTo ?? '/(auth)/profile-setup') as any);
    } catch (e: any) {
      setError(e.message || 'Failed to create account. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View style={[styles.content, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.header}>
            <View style={styles.logoRow}>
              <Feather name="archive" size={32} color={colors.primary} />
              <Text style={[styles.brandName, { color: colors.primary }]}>DripJar</Text>
            </View>
            <Text style={[styles.title, { color: colors.foreground }]}>Create your account</Text>
          </View>

          <View style={styles.form}>
            <View style={styles.row}>
              <View style={[styles.inputGroup, { flex: 1, marginRight: 8 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>First Name</Text>
                <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <TextInput
                    style={[styles.input, { color: colors.foreground }]}
                    placeholder="Jane"
                    placeholderTextColor={colors.mutedForeground}
                    value={firstName}
                    onChangeText={setFirstName}
                  />
                </View>
              </View>
              <View style={[styles.inputGroup, { flex: 1, marginLeft: 8 }]}>
                <Text style={[styles.label, { color: colors.foreground }]}>Last Name</Text>
                <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <TextInput
                    style={[styles.input, { color: colors.foreground }]}
                    placeholder="Doe"
                    placeholderTextColor={colors.mutedForeground}
                    value={lastName}
                    onChangeText={setLastName}
                  />
                </View>
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Email</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Password</Text>
              <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="••••••••"
                  placeholderTextColor={colors.mutedForeground}
                  secureTextEntry={!showPassword}
                  value={password}
                  onChangeText={setPassword}
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeIcon}>
                  <Feather name={showPassword ? 'eye-off' : 'eye'} size={20} color={colors.mutedForeground} />
                </Pressable>
              </View>
              {password.length > 0 && (
                <View style={styles.strengthContainer}>
                  <View style={[styles.strengthBar, { backgroundColor: colors.muted }]}>
                    <View style={[styles.strengthFill, getPasswordStrength()]} />
                  </View>
                </View>
              )}
            </View>

            {error ? <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text> : null}

            <Pressable
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9 },
              ]}
              onPress={handleRegister}
              disabled={isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Create Account</Text>
              )}
            </Pressable>
            
            <Text style={[styles.termsText, { color: colors.mutedForeground }]}>
              By creating an account, you agree to the DripJar Terms of Service and Privacy Policy.
            </Text>
          </View>

          <Pressable
            onPress={() =>
              router.push(
                safeReturnTo
                  ? { pathname: '/(auth)/login', params: { returnTo: safeReturnTo } }
                  : '/(auth)/login',
              )
            }
            style={styles.footerLink}
          >
            <Text style={{ color: colors.mutedForeground }}>
              Already have an account? <Text style={{ color: colors.primary, fontWeight: 'bold' }}>Sign in</Text>
            </Text>
          </Pressable>
        </View>
      </ScrollView>
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
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  brandName: {
    fontSize: 24,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
  },
  form: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
  },
  inputGroup: {
    marginBottom: 20,
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
  eyeIcon: {
    padding: 16,
  },
  strengthContainer: {
    marginTop: 8,
  },
  strengthBar: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  strengthFill: {
    height: '100%',
    borderRadius: 2,
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
    marginTop: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  termsText: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },
  footerLink: {
    alignItems: 'center',
    marginTop: 32,
  },
});
