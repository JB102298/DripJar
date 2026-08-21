import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useCreateJarContext } from '@/contexts/create-jar-context';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProgressBar } from '@/components/ProgressBar';
import { DateInput } from '@/components/DateInput';
import { resolveCategory } from '@/lib/jar-categories';
import {
  formatISOForPrecision,
  normalizeToPrecision,
  parseLocalISO,
  toLocalISO,
  type DatePrecision,
} from '@/lib/date-precision';

export default function CreateJarStep2() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, updateState } = useCreateJarContext();

  const category = resolveCategory(state.category);

  // Precision falls back to the category default until the organizer picks one.
  const targetPrecision: DatePrecision = state.targetDatePrecision ?? category.defaultTargetPrecision;
  const eventPrecision: DatePrecision = state.eventDatePrecision ?? category.defaultEventPrecision;

  const startDate = parseLocalISO(state.startDate);
  const endDate = parseLocalISO(state.endDate);
  const targetDate = parseLocalISO(state.targetDate);
  const cutoffDate = parseLocalISO(state.cutoffDate);

  const targetAfterStart = !!targetDate && !!startDate && targetDate > startDate;

  /**
   * Commitment date must fall strictly before the savings target.
   *
   * Compared on the STORED strings, not on parsed Dates. The stored target is
   * already normalised to its precision — the 1st of the month at `monthYear`,
   * 1 January at `year` — so a lexicographic `yyyy-MM-dd` comparison asks
   * exactly the question the server will ask, with no invented day anywhere. A
   * year-precision target of "2044" is the boundary 2044-01-01, which is both
   * what is stored and what the API enforces, so the screen and the server
   * cannot disagree about which dates are legal.
   */
  const cutoffNotBeforeTarget =
    !!state.cutoffDate && !!state.targetDate && state.cutoffDate >= state.targetDate;

  /**
   * Continue is blocked while any date relationship is invalid.
   *
   * Previously the screen rendered the commitment-date error and let the user
   * continue anyway — six further steps, then a 400 from the server at the
   * final "Launch Jar". Showing someone why they are stuck and then not
   * stopping them is worse than either alternative.
   */
  const isFormValid = !!targetDate && !targetAfterStart && !cutoffNotBeforeTarget;

  const handleNext = () => {
    // Guarded here as well as on `disabled`, so a press that slips through
    // (web keyboard activation, a stale render) still cannot advance.
    if (!isFormValid) return;
    router.push('/create-jar/goal');
  };

  const setTargetPrecision = (precision: DatePrecision) => {
    updateState({ targetDatePrecision: precision });
  };

  const setEventPrecision = (precision: DatePrecision) => {
    // Re-snap both ends of the window together; leaving one at day precision
    // while the other is coarse renders as a window nobody chose.
    const next: Record<string, unknown> = { eventDatePrecision: precision };
    if (startDate) next.startDate = toLocalISO(normalizeToPrecision(startDate, precision));
    if (endDate) next.endDate = toLocalISO(normalizeToPrecision(endDate, precision));
    updateState(next);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.stepText, { color: colors.mutedForeground }]}>Step 2 of 8</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
        <ProgressBar progress={25} height={4} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>{category.dateHeading}</Text>

        {category.eventWindow ? (
          <>
            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                {category.eventWindow.startLabel}
              </Text>
              <DateInput
                testID="event-start-date"
                value={startDate}
                onChange={(d) => updateState({ startDate: toLocalISO(d) })}
                placeholder={category.eventWindow.startPlaceholder}
                precision={eventPrecision}
                onPrecisionChange={setEventPrecision}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                {category.eventWindow.endLabel}
              </Text>
              <DateInput
                testID="event-end-date"
                value={endDate}
                onChange={(d) => updateState({ endDate: toLocalISO(d) })}
                placeholder={category.eventWindow.endPlaceholder}
                precision={eventPrecision}
              />
            </View>

            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </>
        ) : null}

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>{category.targetDateLabel}</Text>
          <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>
            {category.targetDateHelp}
          </Text>
          <DateInput
            testID="savings-target-date"
            value={targetDate}
            onChange={(d) => updateState({ targetDate: toLocalISO(d) })}
            placeholder="Select target date"
            precision={targetPrecision}
            onPrecisionChange={setTargetPrecision}
          />
          {targetAfterStart && category.eventWindow ? (
            <Text style={[styles.errorText, { color: colors.destructive }]}>
              {category.eventWindow.targetAfterStartError}
            </Text>
          ) : null}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        <View style={styles.inputGroup}>
          <Text style={[styles.label, { color: colors.foreground }]}>Commitment Date (Optional)</Text>
          <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>
            The date when contributions become committed to the jar&apos;s purpose. After this date, members
            enter the Commitment phase and schedules can no longer be changed. Must be before the{' '}
            {category.targetDateLabel}.
          </Text>
          {/*
            Always an exact day. The server compares it to today and to the
            target date to drive the jar's phase transition, so a coarse answer
            would move real lifecycle behaviour by up to a year.
          */}
          <DateInput
            testID="commitment-date"
            value={cutoffDate}
            onChange={(d) => updateState({ cutoffDate: toLocalISO(d) })}
            placeholder="Select commitment date (optional)"
            precision="exact"
          />
          {cutoffNotBeforeTarget ? (
            <Text testID="cutoff-error" style={[styles.errorText, { color: colors.destructive }]}>
              Commitment date must be before the {category.targetDateLabel.toLowerCase()}
              {targetPrecision === 'exact'
                ? ''
                : ` (${formatISOForPrecision(state.targetDate, targetPrecision)}, which starts on ${formatISOForPrecision(state.targetDate, 'exact')})`}
              .
            </Text>
          ) : null}
        </View>

      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <Pressable
          testID="dates-continue"
          accessibilityRole="button"
          accessibilityState={{ disabled: !isFormValid }}
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
  label: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  subLabel: { fontSize: 14, marginBottom: 12, lineHeight: 20 },
  divider: { height: 1, marginVertical: 16 },
  errorText: { marginTop: 8, fontSize: 14 },
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
