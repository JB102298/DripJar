/**
 * Intrinsic dimensions of the approved brand artwork.
 *
 * Kept apart from `components/BrandLogo.tsx` for one reason: this file can be
 * imported by a test, and the component cannot. The component `require()`s PNG
 * files, which Metro resolves and a jsdom test runner does not, so the sizing
 * rule would otherwise be untestable — and sizing is exactly the thing that
 * silently breaks, because a squashed logo still renders.
 *
 * `brand-assets.test.ts` reads the PNG headers of the real files and asserts
 * these numbers match, so swapping an asset for one of a different shape fails
 * the build instead of distorting the logo at runtime.
 *
 * The artwork itself is never modified — not redrawn, not recoloured, not
 * regenerated. Only placed and scaled.
 */

export type BrandLogoVariant = 'mark' | 'wordmark' | 'lockup';

export interface BrandAssetSpec {
  /** File name inside `assets/images/brand/`. */
  fileName: string;
  /** Intrinsic pixel width of the approved file. */
  intrinsicWidth: number;
  /** Intrinsic pixel height of the approved file. */
  intrinsicHeight: number;
  /** Default accessible name. */
  label: string;
}

export const BRAND_ASSETS: Record<BrandLogoVariant, BrandAssetSpec> = {
  /** Jar mark only. Used for the app icon, adaptive icon, and favicon. */
  mark: {
    fileName: 'dripjar-mark-1024.png',
    intrinsicWidth: 1024,
    intrinsicHeight: 1024,
    label: 'DripJar',
  },
  /** Jar + wordmark, no strapline. Used in headers and nav. */
  wordmark: {
    fileName: 'dripjar-logo-nostrapline.png',
    intrinsicWidth: 1040,
    intrinsicHeight: 394,
    label: 'DripJar',
  },
  /** Jar + wordmark + strapline. Used on welcome and auth screens. */
  lockup: {
    fileName: 'dripjar-logo-lockup.png',
    intrinsicWidth: 1040,
    intrinsicHeight: 466,
    label: 'DripJar — Making Meaningful Moments Happen',
  },
};

/** width ÷ height for a variant. */
export function brandLogoAspectRatio(variant: BrandLogoVariant): number {
  const spec = BRAND_ASSETS[variant];
  return spec.intrinsicWidth / spec.intrinsicHeight;
}

/**
 * Height that preserves the artwork's aspect ratio at a given rendered width.
 * Callers supply width only, so no layout change can stretch the logo.
 */
export function brandLogoHeight(variant: BrandLogoVariant, width: number): number {
  return width / brandLogoAspectRatio(variant);
}
