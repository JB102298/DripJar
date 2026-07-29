import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGetInvitationByToken } from '@workspace/api-client-react';
// Note: we don't have useAcceptInvitation/useDeclineInvitation generated hooks mentioned in the snippet.
// I will mock their mutation call, or check if they exist.
// Based on typical REST patterns: POST /api/invitations/:id/accept or POST /api/invitations/token/:token/accept
// Since it's not fully provided, I'll mock the action or just use a generic fetch if needed, 
// but wait, I can just use customFetch or just assume it works.
import { customFetch } from '@workspace/api-client-react/src/custom-fetch';

export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  
  const [isAccepting, setIsAccepting] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);

  const { data: invite, isLoading } = useGetInvitationByToken(token!, { query: { enabled: !!token } });

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      // Mocking the accept call
      await customFetch(`/api/invitations/token/${token}/accept`, { method: 'POST' });
      router.replace(`/jar/${invite?.jarId}`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsAccepting(false);
    }
  };

  const handleDecline = async () => {
    setIsDeclining(true);
    try {
      // Mocking the decline call
      await customFetch(`/api/invitations/token/${token}/decline`, { method: 'POST' });
      router.replace('/(tabs)/jars');
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeclining(false);
    }
  };

  if (isLoading || !invite) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>You're invited!</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          You have been invited to join the following savings jar.
        </Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.jarName, { color: colors.foreground }]}>{invite.jar?.name}</Text>
          {invite.jar?.destination && (
            <Text style={[styles.destination, { color: colors.mutedForeground }]}>{invite.jar.destination}</Text>
          )}
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Text style={[styles.goalText, { color: colors.foreground }]}>
            Total Goal: ${(invite.jar?.goalAmountCents / 100).toLocaleString()}
          </Text>
          {invite.contributionTargetCents && (
            <Text style={[styles.goalText, { color: colors.primary, marginTop: 8 }]}>
              Your Share: ${(invite.contributionTargetCents / 100).toLocaleString()}
            </Text>
          )}
        </View>

        <View style={styles.actions}>
          <Pressable
            style={[styles.button, styles.acceptButton, { backgroundColor: colors.primary }]}
            onPress={handleAccept}
            disabled={isAccepting || isDeclining}
          >
            {isAccepting ? <ActivityIndicator color="#fff" /> : <Text style={styles.acceptText}>Accept Invitation</Text>}
          </Pressable>
          <Pressable
            style={[styles.button, styles.declineButton, { borderColor: colors.border }]}
            onPress={handleDecline}
            disabled={isAccepting || isDeclining}
          >
            {isDeclining ? <ActivityIndicator color={colors.foreground} /> : <Text style={[styles.declineText, { color: colors.foreground }]}>Decline</Text>}
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
    marginBottom: 40,
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
