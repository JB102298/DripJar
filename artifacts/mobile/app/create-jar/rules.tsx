import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';

export default function CreateJarStep7() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [agreed, setAgreed] = useState(false);

  const handleNext = () => {
    if (agreed) {
      router.push('/create-jar/review');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 7 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={87.5} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Set the rules</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Clear expectations make group trips stress-free. Review the standard agreement below.
        </Text>

        <View style={[styles.agreementCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.ruleTitle, { color: colors.foreground }]}>1. The Commitment</Text>
          <Text style={[styles.ruleText, { color: colors.mutedForeground }]}>
            All members agree to save their designated portion by the target date.
          </Text>

          <Text style={[styles.ruleTitle, { color: colors.foreground }]}>2. Spending Approvals</Text>
          <Text style={[styles.ruleText, { color: colors.mutedForeground }]}>
            Major expenses (like flights and lodging) require a majority vote before the jar funds are spent.
          </Text>

          <Text style={[styles.ruleTitle, { color: colors.foreground }]}>3. Refunds</Text>
          <Text style={[styles.ruleText, { color: colors.mutedForeground }]}>
            Members can withdraw uncommitted funds anytime. Once funds are committed to a booking, refunds are subject to vendor policies.
          </Text>
          
          <Text style={[styles.ruleTitle, { color: colors.foreground }]}>4. Transparency</Text>
          <Text style={[styles.ruleText, { color: colors.mutedForeground }]}>
            All members can see the jar's progress, member contributions, and activity.
          </Text>
        </View>

        <Pressable 
          style={styles.checkboxRow}
          onPress={() => setAgreed(!agreed)}
        >
          <View style={[
            styles.checkbox, 
            { borderColor: agreed ? colors.primary : colors.mutedForeground },
            agreed && { backgroundColor: colors.primary }
          ]}>
            {agreed && <Feather name="check" size={16} color="#fff" />}
          </View>
          <Text style={[styles.checkboxText, { color: colors.foreground }]}>
            I agree to these rules and will ask my group to agree as well.
          </Text>
        </Pressable>

      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          style={[
            styles.button,
            { backgroundColor: agreed ? colors.primary : colors.muted },
          ]}
          onPress={handleNext}
          disabled={!agreed}
        >
          <Text style={[styles.buttonText, { color: agreed ? colors.primaryForeground : colors.mutedForeground }]}>
            Continue
          </Text>
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
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 16 },
  subtitle: { fontSize: 16, lineHeight: 24, marginBottom: 32 },
  agreementCard: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 32,
  },
  ruleTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 8, marginTop: 16 },
  ruleText: { fontSize: 14, lineHeight: 20 },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingRight: 24,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginTop: 2,
  },
  checkboxText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
  },
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
