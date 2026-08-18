import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { InvitationWithJar } from '@workspace/api-client-react';

interface InvitationCardProps {
  invitation: InvitationWithJar;
}

function formatCurrency(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/** Whole days until `iso`, floored at 0. */
function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/**
 * A jar the user has been invited to but has not joined.
 *
 * Deliberately NOT a JarCard: tapping a JarCard opens `/jar/:id`, which returns
 * 403 for someone who is not yet a member. This routes to the existing
 * accept/decline screen instead, and shows only the fields the invitation
 * payload can be trusted to carry — an invitee has no business seeing the
 * jar's saved balance before they join.
 */
export function InvitationCard({ invitation }: InvitationCardProps) {
  const colors = useColors();
  const router = useRouter();

  const { jar, token, contributionTargetCents, expiresAt } = invitation;
  const expiresInDays = daysUntil(expiresAt);

  // `token` is nullable in the schema. Without it there is no screen to open,
  // so the card stays inert rather than navigating to a broken route.
  const onPress = token ? () => router.push(`/invite/${token}`) : undefined;

  return (
    <Pressable
      onPress={onPress}
      disabled={!token}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && token ? { opacity: 0.95, transform: [{ scale: 0.98 }] } : null,
      ]}
    >
      <View style={[styles.badge, { backgroundColor: colors.secondary }]}>
        <Feather name="mail" size={12} color={colors.primary} />
        <Text style={[styles.badgeText, { color: colors.secondaryForeground }]}>
          Invitation
        </Text>
      </View>

      <Text style={[styles.jarName, { color: colors.foreground }]} numberOfLines={1}>
        {jar.name}
      </Text>
      {jar.destination ? (
        <View style={styles.locationRow}>
          <Feather name="map-pin" size={12} color={colors.mutedForeground} />
          <Text style={[styles.destination, { color: colors.mutedForeground }]} numberOfLines={1}>
            {jar.destination}
          </Text>
        </View>
      ) : null}

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.detailRow}>
        <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Jar goal</Text>
        <Text style={[styles.detailValue, { color: colors.foreground }]}>
          {formatCurrency(jar.goalAmountCents)}
        </Text>
      </View>
      {contributionTargetCents ? (
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Your share</Text>
          <Text style={[styles.detailValue, { color: colors.primary }]}>
            {formatCurrency(contributionTargetCents)}
          </Text>
        </View>
      ) : null}

      <Text style={[styles.expiry, { color: colors.mutedForeground }]}>
        {expiresInDays === 0
          ? 'Expires today'
          : `Expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}`}
      </Text>

      {token ? (
        <View style={[styles.cta, { backgroundColor: colors.primary }]}>
          <Text style={[styles.ctaText, { color: colors.primaryForeground }]}>
            Review invitation
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 16,
  },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  jarName: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  destination: {
    fontSize: 14,
  },
  divider: {
    height: 1,
    marginVertical: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  detailLabel: {
    fontSize: 14,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  expiry: {
    fontSize: 13,
    marginTop: 6,
  },
  cta: {
    marginTop: 16,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontSize: 15,
    fontWeight: 'bold',
  },
});
