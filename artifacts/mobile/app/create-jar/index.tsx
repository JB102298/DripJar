import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { CreateJarRequestCategory } from '@workspace/api-client-react/src/generated/api.schemas';

const CATEGORIES = [
  { id: 'Vacation', icon: 'sun', label: 'Vacation' },
  { id: 'Cruise', icon: 'anchor', label: 'Cruise' },
  { id: 'Wedding', icon: 'heart', label: 'Wedding' },
  { id: 'Honeymoon', icon: 'map', label: 'Honeymoon' },
  { id: 'MissionTrip', icon: 'globe', label: 'Mission Trip' },
  { id: 'Reunion', icon: 'users', label: 'Reunion' },
  { id: 'Celebration', icon: 'award', label: 'Celebration' },
  { id: 'Other', icon: 'star', label: 'Other' },
] as const;

export default function CreateJarStep1() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  const isFormValid = state.name && state.category;

  const handleNext = () => {
    if (isFormValid) {
      router.push('/create-jar/dates');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="x" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 1 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={12.5} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.foreground }]}>What are you saving for?</Text>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Jar Name</Text>
          <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="e.g., Hawaii 2027"
              placeholderTextColor={colors.mutedForeground}
              value={state.name || ''}
              onChangeText={(text) => updateState({ name: text })}
            />
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Category</Text>
          <View style={styles.categoryGrid}>
            {CATEGORIES.map((cat) => (
              <Pressable
                key={cat.id}
                style={[
                  styles.categoryCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                  state.category === cat.id && { backgroundColor: colors.secondary, borderColor: colors.primary },
                ]}
                onPress={() => updateState({ category: cat.id as CreateJarRequestCategory })}
              >
                <Feather
                  name={cat.icon as any}
                  size={24}
                  color={state.category === cat.id ? colors.primary : colors.mutedForeground}
                  style={{ marginBottom: 8 }}
                />
                <Text
                  style={[
                    styles.categoryText,
                    { color: state.category === cat.id ? colors.primary : colors.foreground },
                  ]}
                >
                  {cat.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Destination (Optional)</Text>
          <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="e.g., Maui, Hawaii"
              placeholderTextColor={colors.mutedForeground}
              value={state.destination || ''}
              onChangeText={(text) => updateState({ destination: text })}
            />
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Description (Optional)</Text>
          <View style={[styles.textAreaContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[styles.textArea, { color: colors.foreground }]}
              placeholder="What makes this trip special?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={4}
              value={state.description || ''}
              onChangeText={(text) => updateState({ description: text })}
            />
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          style={[
            styles.button,
            { backgroundColor: isFormValid ? colors.primary : colors.muted },
          ]}
          onPress={handleNext}
          disabled={!isFormValid}
        >
          <Text style={[styles.buttonText, { color: isFormValid ? colors.primaryForeground : colors.mutedForeground }]}>
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
  title: { fontSize: 32, fontWeight: 'bold', marginBottom: 32 },
  inputGroup: { marginBottom: 24 },
  label: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  inputContainer: {
    borderWidth: 1,
    borderRadius: 12,
    height: 56,
    paddingHorizontal: 16,
  },
  input: { flex: 1, fontSize: 16 },
  textAreaContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    minHeight: 120,
  },
  textArea: { flex: 1, fontSize: 16, textAlignVertical: 'top' },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  categoryCard: {
    width: '48%',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryText: { fontSize: 14, fontWeight: '600' },
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
