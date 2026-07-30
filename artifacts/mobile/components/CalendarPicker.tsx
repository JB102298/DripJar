import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';

interface CalendarPickerProps {
  value: Date | undefined;
  onChange: (date: Date) => void;
  minDate?: Date;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function startOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay(); // 0 = Sun
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

export function CalendarPicker({ value, onChange, minDate }: CalendarPickerProps) {
  const colors = useColors();
  const today = new Date();

  const [viewYear, setViewYear] = useState(
    value ? value.getFullYear() : today.getFullYear()
  );
  const [viewMonth, setViewMonth] = useState(
    value ? value.getMonth() : today.getMonth()
  );

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const firstDay = startOfMonth(viewYear, viewMonth);
  const totalDays = daysInMonth(viewYear, viewMonth);

  // Build grid cells: nulls for leading blanks, then day numbers
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={prevMonth}
          style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.6 }]}
          hitSlop={12}
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </Pressable>

        <Text style={[styles.monthLabel, { color: colors.foreground }]}>
          {MONTHS[viewMonth]} {viewYear}
        </Text>

        <Pressable
          onPress={nextMonth}
          style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.6 }]}
          hitSlop={12}
        >
          <Feather name="chevron-right" size={22} color={colors.foreground} />
        </Pressable>
      </View>

      {/* Day headers */}
      <View style={styles.dayHeaders}>
        {DAYS.map(d => (
          <Text key={d} style={[styles.dayHeader, { color: colors.mutedForeground }]}>{d}</Text>
        ))}
      </View>

      {/* Date grid */}
      {rows.map((row, ri) => (
        <View key={ri} style={styles.row}>
          {row.map((day, ci) => {
            if (!day) return <View key={ci} style={styles.cell} />;

            // Use noon to avoid UTC-shift off-by-one when calling toISOString()
            const cellDate = new Date(viewYear, viewMonth, day, 12, 0, 0);
            const isSelected = value ? isSameDay(cellDate, value) : false;
            const isToday = isSameDay(cellDate, today);
            const isDisabled = minDate ? cellDate < minDate : false;

            return (
              <Pressable
                key={ci}
                style={[
                  styles.cell,
                  isSelected && { backgroundColor: colors.primary, borderRadius: 22 },
                  !isSelected && isToday && { borderRadius: 22, borderWidth: 2, borderColor: colors.primary },
                ]}
                onPress={() => !isDisabled && onChange(cellDate)}
                disabled={isDisabled}
              >
                <Text style={[
                  styles.dayText,
                  { color: isSelected ? '#fff' : isDisabled ? colors.mutedForeground : colors.foreground },
                  isToday && !isSelected && { color: colors.primary, fontWeight: '700' },
                ]}>
                  {day}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const CELL_SIZE = 44;

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  navBtn: {
    padding: 4,
  },
  monthLabel: {
    fontSize: 17,
    fontWeight: '700',
  },
  dayHeaders: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  dayHeader: {
    width: CELL_SIZE,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
