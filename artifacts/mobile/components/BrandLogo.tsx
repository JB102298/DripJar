import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import {
  BRAND_ASSETS,
  brandLogoHeight,
  type BrandLogoVariant,
} from '@/lib/brand-logo-geometry';

/**
 * The DripJar logo.
 *
 * ─── WHY A COMPONENT AND NOT A BARE <Image> ─────────────────────────────────
 *
 * The approved artwork has a transparent background, and the jar in it is drawn
 * as glass — its interior is transparent so it picks up whatever is behind it.
 * On the app's light surfaces that is exactly right: the jar reads as clear
 * glass on white. On the brand green, or over a photographic hero, the same
 * transparency makes the jar's interior go dark, and it reads as a jar full of
 * something rather than an empty glass one. It is the same file behaving
 * correctly in one place and wrongly in another.
 *
 * The fix is compositional, not artistic: on dark surfaces the logo sits on a
 * subtle light rounded plate, which restores the backdrop the glass was drawn
 * against. THE ARTWORK IS NEVER REDRAWN, RECOLOURED, OR REGENERATED — only
 * placed. `tone` selects which treatment applies.
 *
 * ─── ASPECT RATIOS ───────────────────────────────────────────────────────────
 *
 * Measured from the approved files, not guessed. Callers give a width and the
 * height follows, so the logo cannot be stretched by a layout change:
 *
 *   mark      dripjar-mark-1024.png        1024 × 1024
 *   wordmark  dripjar-logo-nostrapline.png 1040 × 394
 *   lockup    dripjar-logo-lockup.png      1040 × 466
 *
 * `contentFit="contain"` is belt-and-braces: even if a caller forces both
 * dimensions, the artwork letterboxes rather than distorts.
 */

export type { BrandLogoVariant };

/**
 * `onLight`  — transparent artwork placed directly on the surface.
 * `onDark`   — artwork on a light rounded plate, for green or photographic
 *              backgrounds, so the glass jar keeps its intended appearance.
 */
export type BrandLogoTone = 'onLight' | 'onDark';

/**
 * Metro asset handles. Dimensions and file names live in
 * lib/brand-logo-geometry.ts; `brand-assets.test.ts` asserts the file names
 * referenced here are exactly the ones declared there, so the two cannot drift.
 */
const SOURCES: Record<BrandLogoVariant, number> = {
  mark: require('../assets/images/brand/dripjar-mark-1024.png'),
  wordmark: require('../assets/images/brand/dripjar-logo-nostrapline.png'),
  lockup: require('../assets/images/brand/dripjar-logo-lockup.png'),
};

/** Plate colour. Matches `colors.light.card`, the surface the artwork was drawn for. */
const PLATE_BACKGROUND = '#FFFFFF';

interface BrandLogoProps {
  variant?: BrandLogoVariant;
  /** Rendered width in points. Height is derived from the artwork's aspect ratio. */
  width: number;
  tone?: BrandLogoTone;
  /** Padding inside the light plate. Ignored when `tone` is `onLight`. */
  platePadding?: number;
  /** Corner radius of the light plate. Ignored when `tone` is `onLight`. */
  plateRadius?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BrandLogo({
  variant = 'wordmark',
  width,
  tone = 'onLight',
  platePadding = 16,
  plateRadius = 20,
  accessibilityLabel,
  style,
  testID,
}: BrandLogoProps) {
  const spec = BRAND_ASSETS[variant];
  const height = brandLogoHeight(variant, width);

  const image = (
    <Image
      source={SOURCES[variant]}
      style={{ width, height }}
      contentFit="contain"
      accessible
      accessibilityLabel={accessibilityLabel ?? spec.label}
      testID={testID}
    />
  );

  if (tone === 'onLight') {
    return <View style={style}>{image}</View>;
  }

  return (
    <View
      testID={testID ? `${testID}-plate` : undefined}
      style={[
        styles.plate,
        { padding: platePadding, borderRadius: plateRadius, backgroundColor: PLATE_BACKGROUND },
        style,
      ]}
    >
      {image}
    </View>
  );
}

const styles = StyleSheet.create({
  plate: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
});
