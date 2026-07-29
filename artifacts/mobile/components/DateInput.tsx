import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Platform, TextInput } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';

interface DateInputProps {
  value: Date | undefined;
  onChange: (date: Date) => void;
  placeholder?: string;
  error?: string;
}

export function DateInput({ value, onChange, placeholder = 'Select date', error }: DateInputProps) {
  const colors = useColors();
  const [showPicker, setShowPicker] = useState(false);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const handleWebChange = (text: string) => {
    const d = new Date(text);
    if (!isNaN(d.getTime())) {
      onChange(d);
    }
  };

  return (
    <View style={styles.container}>
      {Platform.OS === 'web' ? (
        <View
          style={[
            styles.inputContainer,
            { borderColor: error ? colors.destructive : colors.input, backgroundColor: colors.card },
          ]}
        >
          <Feather name="calendar" size={20} color={colors.mutedForeground} style={styles.icon} />
          <TextInput
            style={[styles.webInput, { color: colors.foreground }]}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.mutedForeground}
            onChangeText={handleWebChange}
            value={value ? value.toISOString().split('T')[0] : ''}
          />
        </View>
      ) : (
        <>
          <Pressable
            style={[
              styles.inputContainer,
              { borderColor: error ? colors.destructive : colors.input, backgroundColor: colors.card },
            ]}
            onPress={() => setShowPicker(true)}
          >
            <Feather name="calendar" size={20} color={colors.mutedForeground} style={styles.icon} />
            <Text
              style={[
                styles.text,
                { color: value ? colors.foreground : colors.mutedForeground },
              ]}
            >
              {value ? formatDate(value) : placeholder}
            </Text>
          </Pressable>
          {showPicker && (
            <DateTimePicker
              value={value || new Date()}
              mode="date"
              display="spinner"
              onChange={(event, date) => {
                setShowPicker(false);
                if (date) {
                  onChange(date);
                }
              }}
            />
          )}
        </>
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
  webInput: {
    fontSize: 16,
    flex: 1,
    height: '100%',
    outlineStyle: 'none',
  },
});
