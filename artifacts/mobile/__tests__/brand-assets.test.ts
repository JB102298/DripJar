/**
 * Brand asset guard — Owner QA item 12.
 *
 * The approved logo files are inputs, not source: the rule for this pass is
 * that the artwork is placed and scaled, never redrawn, recoloured, or
 * regenerated. Two things can break that quietly.
 *
 * The first is a swapped asset. Nothing at runtime notices that a file is now a
 * different shape — the logo just renders squashed, and it looks like a CSS
 * problem. These tests read the PNG headers of the real files and assert the
 * dimensions the sizing maths is built on.
 *
 * The second is drift between `lib/brand-logo-geometry.ts` (which declares the
 * file names and dimensions, and which tests can import) and
 * `components/BrandLogo.tsx` (which `require()`s the files, and which a jsdom
 * runner cannot load). The component's source is scanned so the two lists
 * cannot diverge.
 *
 * `app.json` is checked too: the icon, adaptive icon, and favicon must all
 * point at the approved mark, and those are the strings nobody notices are
 * wrong until a build is in a store listing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND_ASSETS,
  brandLogoAspectRatio,
  brandLogoHeight,
  type BrandLogoVariant,
} from "../lib/brand-logo-geometry";

const MOBILE_ROOT = join(__dirname, "..");
const BRAND_DIR = join(MOBILE_ROOT, "assets", "images", "brand");

/**
 * Read width and height from a PNG's IHDR chunk.
 *
 * A PNG begins with an 8-byte signature, then a 4-byte length and the 4-byte
 * type "IHDR"; width and height are the next two big-endian 32-bit integers, at
 * byte offsets 16 and 20.
 */
function pngDimensions(filePath: string): { width: number; height: number } {
  const buf = readFileSync(filePath);
  expect(buf.subarray(1, 4).toString("ascii"), `${filePath} is not a PNG`).toBe("PNG");
  expect(buf.subarray(12, 16).toString("ascii"), `${filePath} has no IHDR`).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const VARIANTS = Object.keys(BRAND_ASSETS) as BrandLogoVariant[];

describe("approved brand files", () => {
  for (const variant of VARIANTS) {
    const spec = BRAND_ASSETS[variant];

    it(`${variant} — ${spec.fileName} exists`, () => {
      expect(existsSync(join(BRAND_DIR, spec.fileName))).toBe(true);
    });

    it(`${variant} — declared dimensions match the file`, () => {
      const { width, height } = pngDimensions(join(BRAND_DIR, spec.fileName));
      expect({ width, height }).toEqual({
        width: spec.intrinsicWidth,
        height: spec.intrinsicHeight,
      });
    });
  }

  it("keeps the untouched original alongside the derivatives", () => {
    // The approved source is retained so a derivative can always be re-derived
    // from it rather than from another derivative.
    expect(existsSync(join(BRAND_DIR, "dripjar-logo-source.png"))).toBe(true);
  });
});

describe("aspect ratio is preserved by construction", () => {
  it("derives height from width for every variant", () => {
    for (const variant of VARIANTS) {
      const spec = BRAND_ASSETS[variant];
      const width = 240;
      const height = brandLogoHeight(variant, width);
      expect(width / height).toBeCloseTo(spec.intrinsicWidth / spec.intrinsicHeight, 10);
    }
  });

  it("scales linearly", () => {
    for (const variant of VARIANTS) {
      expect(brandLogoHeight(variant, 200)).toBeCloseTo(brandLogoHeight(variant, 100) * 2, 10);
    }
  });

  it("gives the mark a square ratio and the lockups a wide one", () => {
    expect(brandLogoAspectRatio("mark")).toBe(1);
    expect(brandLogoAspectRatio("wordmark")).toBeGreaterThan(2);
    expect(brandLogoAspectRatio("lockup")).toBeGreaterThan(2);
    // The lockup is taller than the wordmark — it carries the strapline.
    expect(brandLogoAspectRatio("lockup")).toBeLessThan(brandLogoAspectRatio("wordmark"));
  });
});

describe("BrandLogo component references exactly the declared files", () => {
  const source = readFileSync(join(MOBILE_ROOT, "components", "BrandLogo.tsx"), "utf-8");

  for (const variant of VARIANTS) {
    it(`${variant} — component requires ${BRAND_ASSETS[variant].fileName}`, () => {
      expect(source).toContain(BRAND_ASSETS[variant].fileName);
    });
  }

  it("requires no brand file that is not declared", () => {
    const required = [...source.matchAll(/assets\/images\/brand\/([\w.-]+\.png)/g)].map((m) => m[1]!);
    const declared = new Set(VARIANTS.map((v) => BRAND_ASSETS[v].fileName));
    for (const fileName of required) {
      expect(declared.has(fileName), `${fileName} is required but not declared`).toBe(true);
    }
    expect(new Set(required).size).toBe(declared.size);
  });

  it("places the artwork on a light plate for dark surfaces", () => {
    // The jar is drawn as glass: on the brand green or a photographic hero its
    // transparent interior reads as dark-filled. The fix is compositional.
    expect(source).toContain("onDark");
    expect(source).toContain("PLATE_BACKGROUND");
  });
});

describe("app.json points at the approved mark", () => {
  const appConfig = JSON.parse(readFileSync(join(MOBILE_ROOT, "app.json"), "utf-8")) as {
    expo: {
      icon: string;
      android: { adaptiveIcon: { foregroundImage: string } };
      web: { favicon: string };
    };
  };

  const markPath = `./assets/images/brand/${BRAND_ASSETS.mark.fileName}`;

  it("uses the mark as the app icon", () => {
    expect(appConfig.expo.icon).toBe(markPath);
  });

  it("uses the mark as the Android adaptive icon foreground", () => {
    expect(appConfig.expo.android.adaptiveIcon.foregroundImage).toBe(markPath);
  });

  it("uses the mark as the web favicon", () => {
    expect(appConfig.expo.web.favicon).toBe(markPath);
  });
});
