import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useGetInvitationByToken,
  useAcceptInvitation,
  useDeclineInvitation,
} from '@workspace/api-client-react';
import { useAuth } from '@/contexts/auth-context';

export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();

  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);

  const {
    data: invite,
    isLoading,
    isError,
  } = useGetInvitationByToken(token!, { query: { enabled: !!token } });

  const acceptMutation = useAcceptInvitation();
  const declineMutation = useDeclineInvitation();

  const handleAccept = async () => {
    if (!invite) return;

    if (!isAuthenticated) {
      // Redirect to login carrying a return path so the user comes straight
      // back to this invitation after signing in or registering. Only the
      // in-app path is passed — the raw token never leaves navigation state.
      router.push({
        pathname: '/(auth)/login',
        params: { returnTo: `/invite/${token}` },
      });
      return;
    }

    setAccepting(true);
    try {
      const member = await acceptMutation.mutateAsync({ invitationId: invite.id });
      router.replace(`/jar/${member.jarId}`);
    } catch (e: any) {
      Alert.alert(
        'Could not accept',
        e?.message ?? 'Something went wrong. Please try again.',
      );
    } finally {
      setAccepting(false);
    }
  };

  const handleDecline = async () => {
    if (!invite) return;

    if (!isAuthenticated) {
      router.replace('/(tabs)/jars');
      return;
    }

    setDeclining(true);
    try {
      await declineMutation.mutateAsync({ invitationId: invite.id });
      router.replace('/(tabs)/jars');
    } catch (e: any) {
      Alert.alert(
        'Could not decline',
        e?.message ?? 'Something went wrong. Please try again.',
      );
    } finally {
      setDeclining(false);
    }
  };

  if (isLoading) {
    return (
      <View
        style={[
          styles.container,
          {
            backgroundColor: colors.background,
            justifyContent: 'center',
            alignItems: 'center',
          },
        ]}
      >
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isError || !invite) {
    return (
      <View
        style={[
          styles.container,
          {
            backgroundColor: colors.background,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 32,
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground, marginBottom: 12 }]}>
          Invitation not found
        </Text>
        <Text
          style={[
            styles.subtitle,
            { color: colors.mutedForeground, marginBottom: 32 },
          ]}
        >
          This invitation link may have expired or already been used.
        </Text>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => router.replace('/(tabs)/jars')}
        >
          <Text style={styles.acceptText}>Go to My Jars</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>
          You're invited!
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          You have been invited to join a savings jar.
        </Text>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.jarName, { color: colors.foreground }]}>
            {invite.jar?.name}
          </Text>
          {invite.jar?.destination ? (
            <Text style={[styles.destination, { color: colors.mutedForeground }]}>
              {invite.jar.destination}
            </Text>
          ) : null}
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          {invite.jar?.goalAmountCents != null ? (
            <Text style={[styles.goalText, { color: colors.foreground }]}>
              Total Goal: ${(invite.jar.goalAmountCents / 100).toLocaleString()}
            </Text>
          ) : null}
          {invite.contributionTargetCents ? (
            <Text
              style={[
                styles.goalText,
                { color: colors.primary, marginTop: 8 },
              ]}
            >
              Your Share: $
              {(invite.contributionTargetCents / 100).toLocaleString()}
            </Text>
          ) : null}
        </View>

        {!isAuthenticated && (
          <View
            style={[
              styles.authNotice,
              { backgroundColor: colors.muted, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.authNoticeText, { color: colors.mutedForeground }]}>
              You'll need to sign in or create an account before accepting.
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          <Pressable
            style={[
              styles.button,
              styles.acceptButton,
              { backgroundColor: colors.primary },
            ]}
            onPress={handleAccept}
            disabled={accepting || declining}
          >
            {accepting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.acceptText}>
                {isAuthenticated ? 'Accept Invitation' : 'Sign in to Accept'}
              </Text>
            )}
          </Pressable>
          <Pressable
            style={[
              styles.button,
              styles.declineButton,
              { borderColor: colors.border },
            ]}
            onPress={handleDecline}
            disabled={accepting || declining}
          >
            {declining ? (
              <ActivityIndicator color={colors.foreground} />
            ) : (
              <Text style={[styles.declineText, { color: colors.foreground }]}>
                Decline
              </Text>
            )}
          </Pressable>
        </View>
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
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 40,
    lineHeight: 24,
  },
  card: {
    padding: 24,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 24,
  },
  jarName: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
    textAlign: 'center',
  },
  destination: {
    fontSize: 16,
    textAlign: 'center',
  },
  divider: {
    height: 1,
    marginVertical: 16,
  },
  goalText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  authNotice: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
  },
  authNoticeText: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  actions: {
    gap: 16,
  },
  button: {
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptButton: {},
  acceptText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  declineButton: {
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  declineText: {
    fontSize: 18,
    fontWeight: '600',
  },
});
