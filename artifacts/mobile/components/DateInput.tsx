import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { CalendarPicker } from './CalendarPicker';
import DateTimePicker from '@react-native-community/datetimepicker';

interface DateInputProps {
  value: Date | undefined;
  onChange: (date: Date) => void;
  placeholder?: string;
  error?: string;
  minDate?: Date;
}

export function DateInput({ value, onChange, placeholder = 'Select date', error, minDate }: DateInputProps) {
  const colors = useColors();
  const [showPicker, setShowPicker] = useState(false);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const handleSelect = (date: Date) => {
    onChange(date);
    // Keep open on web so user can see selection; they dismiss by tapping the button again
  };

  return (
    <View style={styles.container}>
      <Pressable
        style={[
          styles.inputContainer,
          { borderColor: error ? colors.destructive : showPicker ? colors.primary : colors.input, backgroundColor: colors.card },
        ]}
        onPress={() => setShowPicker(s => !s)}
      >
        <Feather name="calendar" size={20} color={showPicker ? colors.primary : colors.mutedForeground} style={styles.icon} />
        <Text
          style={[
            styles.text,
            { color: value ? colors.foreground : colors.mutedForeground },
          ]}
        >
          {value ? formatDate(value) : placeholder}
        </Text>
        <Feather
          name={showPicker ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.mutedForeground}
        />
      </Pressable>

      {error ? (
        <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
      ) : null}

      {showPicker && (
        Platform.OS === 'web' ? (
          <View style={styles.calendarWrapper}>
            <CalendarPicker
              value={value}
              onChange={(date) => {
                handleSelect(date);
                setShowPicker(false);
              }}
              minDate={minDate}
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
              if (date) onChange(date);
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
