import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';

interface ProgressBarProps {
  progress: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
}

export function ProgressBar({ progress, height = 8, color, backgroundColor }: ProgressBarProps) {
  const colors = useColors();
  const progressWidth = useSharedValue(0);

  useEffect(() => {
    progressWidth.value = withTiming(Math.min(Math.max(progress, 0), 100), {
      duration: 800,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      width: `${progressWidth.value}%`,
    };
  });

  return (
    <View
      style={[
        styles.track,
        { height, backgroundColor: backgroundColor || colors.muted, borderRadius: height / 2 },
      ]}
    >
      <Animated.View
        style={[
          styles.fill,
          { backgroundColor: color || colors.primary, borderRadius: height / 2 },
          animatedStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
  },
});
