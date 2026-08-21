import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ImageBackground } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import { ProgressBar } from './ProgressBar';
import { JarHealthBadge } from './JarHealthBadge';
import { useRouter } from 'expo-router';
import type { JarSummary } from '@workspace/api-client-react';
import { Feather } from '@expo/vector-icons';
import { describeTimeRemaining, resolvePrecision } from '@/lib/date-precision';

interface JarCardProps {
  jar: JarSummary;
  hero?: boolean;
}

export function JarCard({ jar, hero = false }: JarCardProps) {
  const colors = useColors();
  const router = useRouter();

  // Phrased at the jar's stored precision — see lib/date-precision.ts.
  const timeRemaining = describeTimeRemaining(
    jar.targetDate,
    resolvePrecision(jar.targetDatePrecision),
    jar.daysRemaining,
  );

  const formatCurrency = (cents: number) => {
    return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const onPress = () => {
    router.push(`/jar/${jar.id}`);
  };

  const imageSource = jar.coverImageUrl
    ? { uri: jar.coverImageUrl }
    : require('../assets/images/hawaii-cover.jpg');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        pressed && { opacity: 0.95, transform: [{ scale: 0.98 }] },
        hero ? styles.heroCard : styles.standardCard,
      ]}
    >
      <View style={[styles.imageContainer, hero ? { height: 180 } : { height: 120 }]}>
        <ImageBackground
          source={imageSource}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        >
          <LinearGradient
            colors={['transparent', 'rgba(0,0,0,0.8)']}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.imageOverlayContent}>
            {timeRemaining ? (
              <View style={styles.daysChip}>
                <Text testID="jar-card-time-remaining" style={styles.daysText}>{timeRemaining}</Text>
              </View>
            ) : null}
            <View style={styles.titleContainer}>
              <Text style={styles.title} numberOfLines={1}>
                {jar.name}
              </Text>
              {jar.destination && (
                <View style={styles.locationRow}>
                  <Feather name="map-pin" size={12} color="#fff" />
                  <Text style={styles.destination} numberOfLines={1}>
                    {jar.destination}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </ImageBackground>
      </View>

      <View style={styles.content}>
        <View style={styles.progressRow}>
          <Text style={[styles.amountText, { color: colors.foreground }]}>
            <Text style={{ fontWeight: 'bold' }}>{formatCurrency(jar.totalSavedCents)}</Text>
            <Text style={{ color: colors.mutedForeground }}> of {formatCurrency(jar.goalAmountCents)}</Text>
          </Text>
          <Text style={[styles.percentText, { color: colors.primary }]}>
            {jar.percentFunded}%
          </Text>
        </View>

        <ProgressBar progress={jar.percentFunded} height={hero ? 10 : 6} />

        <View style={styles.footerRow}>
          <View style={styles.membersRow}>
            <Feather name="users" size={14} color={colors.mutedForeground} />
            <Text style={[styles.membersText, { color: colors.mutedForeground }]}>
              {jar.memberCount} members
            </Text>
          </View>
          {jar.health && <JarHealthBadge status={jar.health.status} />}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  heroCard: {
    marginBottom: 24,
  },
  standardCard: {
    marginBottom: 16,
  },
  imageContainer: {
    width: '100%',
    backgroundColor: '#178B57', // Fallback
  },
  imageOverlayContent: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 16,
  },
  daysChip: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backdropFilter: 'blur(4px)', // web
  },
  daysText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  titleContainer: {
    marginTop: 'auto',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  destination: {
    color: '#E8F6EF',
    fontSize: 14,
    fontWeight: '500',
  },
  content: {
    padding: 16,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: 10,
  },
  amountText: {
    fontSize: 16,
  },
  percentText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },
  membersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  membersText: {
    fontSize: 13,
  },
});
