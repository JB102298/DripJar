import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ImageBackground } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import * as Haptics from 'expo-haptics';
import { BrandLogo } from '@/components/BrandLogo';

export default function WelcomeScreen() {
  const router = useRouter();
  const colors = useColors();

  return (
    <View style={styles.container}>
      <ImageBackground
        source={require('../../assets/images/travel-hero.jpg')}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
      >
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.8)']}
          style={StyleSheet.absoluteFill}
        />
        
        <View style={styles.content}>
          {/*
            The full lockup, which already carries the strapline — so the
            wordmark and slogan are the approved artwork rather than a
            re-typeset imitation of it. Over a photographic hero the jar is
            glass on nothing, so it goes on a light plate.
          */}
          <View style={styles.logoContainer}>
            <BrandLogo variant="lockup" width={280} tone="onDark" testID="welcome-logo" />
          </View>

          <View style={styles.actionContainer}>
            <Pressable
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
              ]}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push('/(auth)/register');
              }}
            >
              <Text style={styles.primaryButtonText}>Get Started</Text>
            </Pressable>
            
            <Pressable
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => router.push('/(auth)/login')}
            >
              <Text style={styles.secondaryButtonText}>Sign In</Text>
            </Pressable>
          </View>
        </View>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'space-between',
    paddingBottom: 48,
  },
  logoContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionContainer: {
    width: '100%',
    gap: 16,
  },
  primaryButton: {
    width: '100%',
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
  },
  secondaryButton: {
    width: '100%',
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
