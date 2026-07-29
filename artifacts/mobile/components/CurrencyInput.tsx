import React from 'react';
import { View, TextInput, StyleSheet, TextInputProps } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface CurrencyInputProps extends Omit<TextInputProps, 'onChangeText' | 'value'> {
  value: number; // in cents
  onChangeCents: (cents: number) => void;
  label?: string;
  error?: string;
}

export function CurrencyInput({ value, onChangeCents, label, error, style, ...props }: CurrencyInputProps) {
  const colors = useColors();

  const formatDisplay = (cents: number) => {
    if (!cents) return '';
    return (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const handleTextChange = (text: string) => {
    const numericOnly = text.replace(/[^0-9]/g, '');
    if (!numericOnly) {
      onChangeCents(0);
      return;
    }
    onChangeCents(parseInt(numericOnly, 10) * 100);
  };

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.inputContainer,
          { borderColor: error ? colors.destructive : colors.input, backgroundColor: colors.card },
          style,
        ]}
      >
        <Text style={[styles.prefix, { color: colors.foreground }]}>$</Text>
        <TextInput
          style={[styles.input, { color: colors.foreground }]}
          value={formatDisplay(value)}
          onChangeText={handleTextChange}
          keyboardType="number-pad"
          placeholder="0"
          placeholderTextColor={colors.mutedForeground}
          {...props}
        />
      </View>
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
  prefix: {
    fontSize: 24,
    fontWeight: '600',
    marginRight: 4,
  },
  input: {
    flex: 1,
    fontSize: 24,
    fontWeight: '600',
    height: '100%',
  },
});
