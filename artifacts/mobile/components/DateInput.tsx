import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { CalendarPicker } from './CalendarPicker';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  DATE_PRECISIONS,
  formatForPrecision,
  normalizeToPrecision,
  precisionHelp,
  precisionLabel,
  type DatePrecision,
} from '@/lib/date-precision';

interface DateInputProps {
  value: Date | undefined;
  onChange: (date: Date) => void;
  placeholder?: string;
  error?: string;
  minDate?: Date;
  /**
   * How precise an answer this field wants. Controls both which panes the
   * picker offers and how the chosen value is rendered — a `year` field shows
   * "2044", never "January 1, 2044".
   */
  precision?: DatePrecision;
  /**
   * Supply to let the user change precision inline. The selector is hidden when
   * this is omitted, which is right for fields whose precision is fixed.
   */
  onPrecisionChange?: (precision: DatePrecision) => void;
  testID?: string;
}

export function DateInput({
  value,
  onChange,
  placeholder = 'Select date',
  error,
  minDate,
  precision = 'exact',
  onPrecisionChange,
  testID,
}: DateInputProps) {
  const colors = useColors();
  const [showPicker, setShowPicker] = useState(false);

  /**
   * The native spinner has no month-only or year-only mode — it always shows a
   * day wheel. Using it for a coarse field would put a day in front of someone
   * who was asked for a year, so coarse precisions use the same three-pane
   * calendar on every platform and only `exact` gets the platform spinner.
   */
  const useCalendar = Platform.OS === 'web' || precision !== 'exact';

  return (
    <View style={styles.container}>
      {onPrecisionChange ? (
        <View style={styles.precisionRow}>
          {DATE_PRECISIONS.map((p) => {
            const active = p === precision;
            return (
              <Pressable
                key={p}
                testID={`date-precision-${p}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  if (p === precision) return;
                  onPrecisionChange(p);
                  // Re-snap any existing answer so the stored value cannot keep
                  // a day the user is no longer claiming to know.
                  if (value) onChange(normalizeToPrecision(value, p));
                }}
                style={[
                  styles.precisionChip,
                  { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.secondary : 'transparent' },
                ]}
              >
                <Text
                  style={[
                    styles.precisionChipText,
                    { color: active ? colors.primary : colors.mutedForeground },
                  ]}
                >
                  {precisionLabel(p)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Pressable
        testID={testID}
        accessibilityRole="button"
        style={[
          styles.inputContainer,
          { borderColor: error ? colors.destructive : showPicker ? colors.primary : colors.input, backgroundColor: colors.card },
        ]}
        onPress={() => setShowPicker((s) => !s)}
      >
        <Feather name="calendar" size={20} color={showPicker ? colors.primary : colors.mutedForeground} style={styles.icon} />
        <Text
          style={[
            styles.text,
            { color: value ? colors.foreground : colors.mutedForeground },
          ]}
        >
          {value ? formatForPrecision(value, precision) : placeholder}
        </Text>
        <Feather
          name={showPicker ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>

      {onPrecisionChange ? (
        <Text style={[styles.precisionHelp, { color: colors.mutedForeground }]}>
          {precisionHelp(precision)}
        </Text>
      ) : null}

      {error ? (
        <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
      ) : null}

      {showPicker && (
        useCalendar ? (
          <View style={styles.calendarWrapper}>
            <CalendarPicker
              value={value}
              onChange={(date) => {
                onChange(date);
                setShowPicker(false);
              }}
              minDate={minDate}
              precision={precision}
            />
          </View>
        ) : (
          <DateTimePicker
            value={value || new Date()}
            mode="date"
            display="spinner"
            minimumDate={minDate}
            onChange={(event, date) => {
              setShowPicker(false);
              if (date) onChange(normalizeToPrecision(date, precision));
            }}
          />
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  precisionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  precisionChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  precisionChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  precisionHelp: {
    fontSize: 12,
    marginTop: 6,
    marginLeft: 4,
    lineHeight: 16,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 56,
  },
  icon: {
    marginRight: 12,
  },
  text: {
    fontSize: 16,
    flex: 1,
  },
  errorText: {
    fontSize: 13,
    marginTop: 6,
    marginLeft: 4,
  },
  calendarWrapper: {
    marginTop: 8,
  },
});
