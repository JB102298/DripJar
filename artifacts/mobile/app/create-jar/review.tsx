import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { useCreateJar, useQueryClient } from '@workspace/api-client-react';

export default function CreateJarStep8() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, resetState } = useCreateJarContext();
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);
  const { mutateAsync: createJar } = useCreateJar();

  const handleLaunch = async () => {
    try {
      setIsLoading(true);
      // Construct API payload
      const response = await createJar({
        data: {
          name: state.name!,
          category: state.category!,
          destination: state.destination,
          description: state.description,
          targetDate: state.targetDate!,
          goalAmountCents: state.goalAmountCents!,
          startDate: state.startDate,
          endDate: state.endDate,
          currency: 'USD',
        }
      });
      
      // We would also create milestones and invite members here, 
      // but assuming the MVP jar creation handles it or we do it sequentially.
      
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['/api/jars'] });
      
      resetState();
      router.replace(`/jar/${response.id}`);
    } catch (e: any) {
      console.error('Failed to create jar', e);
      setIsLoading(false);
    }
  };

  const formatCurrency = (cents: number) => {
    return '$' + (Math.round(cents / 100)).toLocaleString('en-US');
  };

  const totalPeople = (state.invitees?.length || 0) + 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 8 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={100} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconContainer}>
          <Feather name="check-circle" size={64} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>Ready for takeoff!</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Review your trip details before we create your jar.
        </Text>

        <View style={[styles.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Jar Name</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{state.name}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Destination</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{state.destination}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Goal Amount</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{formatCurrency(state.goalAmountCents || 0)}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Target Date</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{state.targetDate ? new Date(state.targetDate).toLocaleDateString() : ''}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />

          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Group Size</Text>
            <Text style={[styles.summaryValue, { color: colors.foreground }]}>{totalPeople} members</Text>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={handleLaunch}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
              Launch Jar
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  stepText: { fontSize: 14, fontWeight: '600' },
  content: { padding: 24, paddingBottom: 40 },
  iconContainer: {
    alignItems: 'center',
    marginBottom: 24,
  },
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
  subtitle: { fontSize: 16, lineHeight: 24, marginBottom: 40, textAlign: 'center' },
  summaryCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  summaryLabel: { fontSize: 15, fontWeight: '500' },
  summaryValue: { fontSize: 16, fontWeight: 'bold' },
  divider: { height: 1, marginVertical: 4 },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  button: {
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 18, fontWeight: 'bold' },
});
