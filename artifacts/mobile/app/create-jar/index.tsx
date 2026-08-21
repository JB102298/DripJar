import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { CreateJarRequestCategory } from '@workspace/api-client-react';
import {
  CATEGORY_GROUP_LABELS,
  CATEGORY_GROUP_ORDER,
  categoriesInGroup,
  resolveCategory,
} from '@/lib/jar-categories';

export default function CreateJarStep1() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  // Before a category is chosen the copy has to come from somewhere; `Other`'s
  // deliberately neutral wording is the right placeholder for "not yet told".
  const category = resolveCategory(state.category);

  const isFormValid = !!state.name && !!state.category;

  const handleNext = () => {
    if (isFormValid) {
      router.push('/create-jar/dates');
    }
  };

  /**
   * Switching category can invalidate answers already given.
   *
   * A destination entered under "Vacation" is meaningless under "Emergency
   * Fund", which has no place field at all; likewise trip start and end dates
   * under a category with no event. Merely hiding those fields would leave the
   * values in state and ship them to the server, where several screens render
   * `destination` unconditionally — so a jar would show a stale destination the
   * organizer could no longer see or edit. Clear them instead.
   */
  const selectCategory = (id: string) => {
    const next = resolveCategory(id);
    updateState({
      category: id as CreateJarRequestCategory,
      ...(next.locationField ? {} : { destination: undefined }),
      ...(next.eventWindow ? {} : { startDate: undefined, endDate: undefined }),
    });
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
              testID="jar-name-input"
              style={[styles.input, { color: colors.foreground }]}
              placeholder={category.namePlaceholder}
              placeholderTextColor={colors.mutedForeground}
              value={state.name || ''}
              onChangeText={(text) => updateState({ name: text })}
            />
          </View>
        </View>

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Category</Text>
          {CATEGORY_GROUP_ORDER.map((group) => (
            <View key={group} style={styles.groupBlock}>
              <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>
                {CATEGORY_GROUP_LABELS[group]}
              </Text>
              <View style={styles.categoryGrid}>
                {categoriesInGroup(group).map((cat) => {
                  const selected = state.category === cat.id;
                  return (
                    <Pressable
                      key={cat.id}
                      testID={`category-${cat.id}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={[
                        styles.categoryCard,
                        { backgroundColor: colors.card, borderColor: colors.border },
                        selected && { backgroundColor: colors.secondary, borderColor: colors.primary },
                      ]}
                      onPress={() => selectCategory(cat.id)}
                    >
                      <Feather
                        name={cat.icon}
                        size={24}
                        color={selected ? colors.primary : colors.mutedForeground}
                        style={{ marginBottom: 8 }}
                      />
                      <Text
                        style={[
                          styles.categoryText,
                          { color: selected ? colors.primary : colors.foreground },
                        ]}
                      >
                        {cat.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
        </View>

        {category.locationField ? (
          <View style={styles.inputGroup}>
            <Text style={[styles.label, { color: colors.foreground }]}>
              {category.locationField.label}
            </Text>
            <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TextInput
                testID="jar-location-input"
                style={[styles.input, { color: colors.foreground }]}
                placeholder={category.locationField.placeholder}
                placeholderTextColor={colors.mutedForeground}
                value={state.destination || ''}
                onChangeText={(text) => updateState({ destination: text })}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Description (Optional)</Text>
          <View style={[styles.textAreaContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              testID="jar-description-input"
              style={[styles.textArea, { color: colors.foreground }]}
              placeholder={category.descriptionPlaceholder}
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
  groupBlock: { marginBottom: 16 },
  groupLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
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
  categoryText: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
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
