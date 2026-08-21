import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import {
  MONTH_LABELS,
  MONTH_LABELS_SHORT,
  normalizeToPrecision,
  yearRange,
  type DatePrecision,
} from '@/lib/date-precision';

/**
 * Calendar picker with three panes: day, month, and year.
 *
 * The previous implementation had one pane and two arrows that stepped a single
 * month at a time. Reaching a newborn's college-fund target date — eighteen
 * years out — took 216 taps, and there was no other way to get there. Nothing
 * about the component was wrong for a vacation four months away; it simply
 * could not express a long-horizon goal at all.
 *
 * So the header label is now a button that zooms out (day → month → year), each
 * pane picks directly, and `precision` decides which pane the picker *stops*
 * at:
 *
 *   exact      day pane; selecting a day commits
 *   monthYear  month pane; selecting a month commits the 1st of it
 *   year       year pane; selecting a year commits 1 January
 *
 * A coarse precision never renders a day grid, because showing one would invite
 * a day-level answer to a question that was not asked. See lib/date-precision.
 */

interface CalendarPickerProps {
  value: Date | undefined;
  onChange: (date: Date) => void;
  minDate?: Date;
  /** How precise an answer this field wants. Defaults to an exact day. */
  precision?: DatePrecision;
  /** Overrides the default 30-year forward horizon of the year pane. */
  yearHorizon?: number;
}

type Pane = 'day' | 'month' | 'year';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** Years shown per page of the year pane. */
const YEAR_PAGE_SIZE = 12;

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

/** The pane a given precision settles on. */
function terminalPane(precision: DatePrecision): Pane {
  switch (precision) {
    case 'year': return 'year';
    case 'monthYear': return 'month';
    default: return 'day';
  }
}

export function CalendarPicker({
  value,
  onChange,
  minDate,
  precision = 'exact',
  yearHorizon,
}: CalendarPickerProps) {
  const colors = useColors();
  const today = new Date();

  const [viewYear, setViewYear] = useState(value ? value.getFullYear() : today.getFullYear());
  const [viewMonth, setViewMonth] = useState(value ? value.getMonth() : today.getMonth());
  const [pane, setPane] = useState<Pane>(terminalPane(precision));

  const { minYear, maxYear } = yearRange(today, value?.getFullYear(), yearHorizon);

  // Page of the year pane, anchored so the currently viewed year is on it.
  const [yearPageStart, setYearPageStart] = useState(() => {
    const offset = Math.floor(((value?.getFullYear() ?? today.getFullYear()) - minYear) / YEAR_PAGE_SIZE);
    return minYear + offset * YEAR_PAGE_SIZE;
  });

  const commit = (date: Date) => onChange(normalizeToPrecision(date, precision));

  // ─── Navigation ────────────────────────────────────────────────────────────

  const stepBack = () => {
    if (pane === 'day') {
      if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); }
      else setViewMonth((m) => m - 1);
    } else if (pane === 'month') {
      setViewYear((y) => Math.max(minYear, y - 1));
    } else {
      setYearPageStart((s) => Math.max(minYear, s - YEAR_PAGE_SIZE));
    }
  };

  const stepForward = () => {
    if (pane === 'day') {
      if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); }
      else setViewMonth((m) => m + 1);
    } else if (pane === 'month') {
      setViewYear((y) => Math.min(maxYear, y + 1));
    } else {
      setYearPageStart((s) => Math.min(maxYear - YEAR_PAGE_SIZE + 1, s + YEAR_PAGE_SIZE));
    }
  };

  /**
   * Zoom out one level. The header label is the affordance — tapping "March
   * 2044" opens 2044's months, tapping "2044" opens the year pane.
   *
   * Precision governs where a selection COMMITS, not how far you may navigate.
   * A month-precision field still has to let you change the year, so its
   * opening pane is not a floor; only the year pane is, because there is
   * nothing coarser.
   */
  const zoomOut = () => {
    if (pane === 'day') {
      setPane('month');
    } else if (pane === 'month') {
      setYearPageStart(minYear + Math.floor((viewYear - minYear) / YEAR_PAGE_SIZE) * YEAR_PAGE_SIZE);
      setPane('year');
    }
  };

  const headerLabel =
    pane === 'day' ? `${MONTH_LABELS[viewMonth]} ${viewYear}`
      : pane === 'month' ? String(viewYear)
        : `${yearPageStart} – ${Math.min(maxYear, yearPageStart + YEAR_PAGE_SIZE - 1)}`;

  const canZoomOut = pane !== 'year';

  // ─── Disabled-state helpers ────────────────────────────────────────────────
  //
  // A coarse selection resolves to the START of its period, so a month or year
  // is only unreachable when its whole period ends before minDate. Disabling
  // "March 2027" because the 1st is before a minDate of 15 March would make a
  // legitimate answer unselectable.

  const yearDisabled = (year: number) => {
    if (!minDate) return false;
    return new Date(year, 11, 31, 12) < minDate;
  };

  const monthDisabled = (year: number, month: number) => {
    if (!minDate) return false;
    return new Date(year, month + 1, 0, 12) < minDate;
  };

  // ─── Panes ─────────────────────────────────────────────────────────────────

  const renderYearPane = () => {
    const years: number[] = [];
    for (let y = yearPageStart; y < yearPageStart + YEAR_PAGE_SIZE && y <= maxYear; y++) years.push(y);

    return (
      <View style={styles.gridWrap}>
        {years.map((year) => {
          const selected = value?.getFullYear() === year;
          const disabled = yearDisabled(year);
          return (
            <Pressable
              key={year}
              testID={`calendar-year-${year}`}
              accessibilityRole="button"
              style={[
                styles.chip,
                { borderColor: colors.border },
                selected && { backgroundColor: colors.primary, borderColor: colors.primary },
              ]}
              disabled={disabled}
              onPress={() => {
                if (disabled) return;
                setViewYear(year);
                if (terminalPane(precision) === 'year') commit(new Date(year, 0, 1, 12));
                else setPane('month');
              }}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: selected ? '#fff' : disabled ? colors.mutedForeground : colors.foreground },
                ]}
              >
                {year}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  };

  const renderMonthPane = () => (
    <View style={styles.gridWrap}>
      {MONTH_LABELS_SHORT.map((label, month) => {
        const selected = value?.getFullYear() === viewYear && value?.getMonth() === month;
        const disabled = monthDisabled(viewYear, month);
        return (
          <Pressable
            key={label}
            testID={`calendar-month-${viewYear}-${month + 1}`}
            accessibilityRole="button"
            style={[
              styles.chip,
              { borderColor: colors.border },
              selected && { backgroundColor: colors.primary, borderColor: colors.primary },
            ]}
            disabled={disabled}
            onPress={() => {
              if (disabled) return;
              setViewMonth(month);
              if (terminalPane(precision) === 'month') commit(new Date(viewYear, month, 1, 12));
              else setPane('day');
            }}
          >
            <Text
              style={[
                styles.chipText,
                { color: selected ? '#fff' : disabled ? colors.mutedForeground : colors.foreground },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  const renderDayPane = () => {
    const firstDay = startOfMonth(viewYear, viewMonth);
    const totalDays = daysInMonth(viewYear, viewMonth);

    const cells: (number | null)[] = [
      ...Array(firstDay).fill(null),
      ...Array.from({ length: totalDays }, (_, i) => i + 1),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const rows: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

    return (
      <>
        <View style={styles.dayHeaders}>
          {DAYS.map((d) => (
            <Text key={d} style={[styles.dayHeader, { color: colors.mutedForeground }]}>{d}</Text>
          ))}
        </View>

        {rows.map((row, ri) => (
          <View key={ri} style={styles.row}>
            {row.map((day, ci) => {
              if (!day) return <View key={ci} style={styles.cell} />;

              // Noon avoids the UTC-shift off-by-one when serialising.
              const cellDate = new Date(viewYear, viewMonth, day, 12, 0, 0);
              const isSelected = value ? isSameDay(cellDate, value) : false;
              const isToday = isSameDay(cellDate, today);
              const isDisabled = minDate ? cellDate < minDate : false;

              return (
                <Pressable
                  key={ci}
                  testID={`calendar-day-${viewYear}-${viewMonth + 1}-${day}`}
                  accessibilityRole="button"
                  style={[
                    styles.cell,
                    isSelected && { backgroundColor: colors.primary, borderRadius: 22 },
                    !isSelected && isToday && { borderRadius: 22, borderWidth: 2, borderColor: colors.primary },
                  ]}
                  onPress={() => !isDisabled && commit(cellDate)}
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
      </>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Pressable
          onPress={stepBack}
          testID="calendar-step-back"
          accessibilityRole="button"
          accessibilityLabel="Previous"
          style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.6 }]}
          hitSlop={12}
        >
          <Feather name="chevron-left" size={22} color={colors.foreground} />
        </Pressable>

        <Pressable
          onPress={canZoomOut ? zoomOut : undefined}
          disabled={!canZoomOut}
          testID="calendar-header-label"
          accessibilityRole={canZoomOut ? 'button' : 'text'}
          style={({ pressed }) => [styles.headerLabelBtn, pressed && canZoomOut && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <Text style={[styles.monthLabel, { color: colors.foreground }]}>{headerLabel}</Text>
          {canZoomOut ? (
            <Feather name="chevron-down" size={16} color={colors.mutedForeground} style={{ marginLeft: 4 }} />
          ) : null}
        </Pressable>

        <Pressable
          onPress={stepForward}
          testID="calendar-step-forward"
          accessibilityRole="button"
          accessibilityLabel="Next"
          style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.6 }]}
          hitSlop={12}
        >
          <Feather name="chevron-right" size={22} color={colors.foreground} />
        </Pressable>
      </View>

      <ScrollView style={styles.paneScroll} contentContainerStyle={styles.paneContent}>
        {pane === 'year' ? renderYearPane() : pane === 'month' ? renderMonthPane() : renderDayPane()}
      </ScrollView>
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
  headerLabelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  monthLabel: {
    fontSize: 17,
    fontWeight: '700',
  },
  paneScroll: {
    maxHeight: 320,
  },
  paneContent: {
    paddingBottom: 4,
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    width: '30%',
    minWidth: 84,
    flexGrow: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 15,
    fontWeight: '600',
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
