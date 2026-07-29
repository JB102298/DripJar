import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';

export default function CreateJarStep5() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  const [invitees, setInvitees] = useState<{email: string}[]>(state.invitees || []);
  const [newEmail, setNewEmail] = useState('');
  const [equalSplit, setEqualSplit] = useState(true);

  const goalAmount = state.goalAmountCents || 0;
  // total people = creator + invitees
  const totalPeople = invitees.length + 1;
  const splitAmount = goalAmount / totalPeople;

  const handleAddInvitee = () => {
    if (newEmail && newEmail.includes('@')) {
      setInvitees([...invitees, { email: newEmail }]);
      setNewEmail('');
    }
  };

  const removeInvitee = (index: number) => {
    const next = [...invitees];
    next.splice(index, 1);
    setInvitees(next);
  };

  const handleNext = () => {
    updateState({ invitees });
    router.push('/create-jar/plan');
  };

  const formatCurrency = (cents: number) => {
    return '$' + (Math.round(cents / 100)).toLocaleString('en-US');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 5 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={62.5} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Who's coming?</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Invite friends or family to save together. You can always add more people later.
        </Text>

        <View style={styles.inputGroup}>
          <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              value={newEmail}
              onChangeText={setNewEmail}
              placeholder="Email address"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Pressable 
              style={[styles.addButton, { backgroundColor: newEmail.includes('@') ? colors.primary : colors.muted }]}
              onPress={handleAddInvitee}
              disabled={!newEmail.includes('@')}
            >
              <Text style={[styles.addButtonText, { color: newEmail.includes('@') ? colors.primaryForeground : colors.mutedForeground }]}>Invite</Text>
            </Pressable>
          </View>
        </View>

        {invitees.length > 0 && (
          <View style={styles.splitToggleRow}>
            <View>
              <Text style={[styles.splitTitle, { color: colors.foreground }]}>Split equally?</Text>
              <Text style={[styles.splitSubtitle, { color: colors.mutedForeground }]}>
                Each person aims for {formatCurrency(splitAmount)}
              </Text>
            </View>
            <Switch
              value={equalSplit}
              onValueChange={setEqualSplit}
              trackColor={{ false: colors.muted, true: colors.primary }}
            />
          </View>
        )}

        <View style={styles.listContainer}>
          <Text style={[styles.listHeader, { color: colors.foreground }]}>Group Members ({totalPeople})</Text>
          
          <View style={[styles.memberRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.avatarPlaceholder, { backgroundColor: colors.primary }]}>
              <Text style={styles.avatarText}>You</Text>
            </View>
            <Text style={[styles.memberEmail, { color: colors.foreground }]}>You (Organizer)</Text>
            {equalSplit && goalAmount > 0 && (
              <Text style={[styles.splitAmount, { color: colors.mutedForeground }]}>{formatCurrency(splitAmount)}</Text>
            )}
          </View>

          {invitees.map((invitee, i) => (
            <View key={i} style={[styles.memberRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.avatarPlaceholder, { backgroundColor: colors.muted }]}>
                <Feather name="user" size={16} color={colors.mutedForeground} />
              </View>
              <Text style={[styles.memberEmail, { color: colors.foreground }]}>{invitee.email}</Text>
              {equalSplit && goalAmount > 0 && (
                <Text style={[styles.splitAmount, { color: colors.mutedForeground }]}>{formatCurrency(splitAmount)}</Text>
              )}
              <Pressable onPress={() => removeInvitee(i)} style={styles.removeBtn}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={handleNext}
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
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
  inputGroup: { marginBottom: 24 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    height: 56,
    paddingLeft: 16,
    paddingRight: 8,
  },
  input: { flex: 1, fontSize: 16, height: '100%' },
  addButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addButtonText: { fontWeight: '600', fontSize: 14 },
  splitToggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent', // you can apply border color if needed
  },
  splitTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 4 },
  splitSubtitle: { fontSize: 14 },
  listContainer: { gap: 12 },
  listHeader: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { fontSize: 10, color: '#fff', fontWeight: 'bold' },
  memberEmail: { flex: 1, fontSize: 14, fontWeight: '500' },
  splitAmount: { fontSize: 14, fontWeight: '600', marginRight: 8 },
  removeBtn: { padding: 4 },
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
