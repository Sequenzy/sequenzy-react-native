import { Platform } from "react-native";

import type { InAppStyle } from "../types";

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "cursive",
]);

/** Named families from the CSS font stack, without quotes or generic names. */
export function fontFamilies(style: InAppStyle): string[] {
  return style.fontFamily
    .split(",")
    .map((family) => family.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family && !GENERIC_FAMILIES.has(family.toLowerCase()));
}

/**
 * The font to draw with. Browsers take the whole CSS stack and fall back by
 * themselves. Native platforms only know fonts the app bundled, and an
 * unknown family warns or errors, so they use the system font unless the app
 * maps brand families to the fonts it ships (`fonts` on the host and cards).
 */
export function resolveFontFamily(
  style: InAppStyle,
  fonts?: Record<string, string>
): string | undefined {
  if (Platform.OS === "web") return style.fontFamily || undefined;
  if (!fonts) return undefined;
  for (const family of fontFamilies(style)) {
    const mapped = fonts[family];
    if (mapped) return mapped;
  }
  return undefined;
}

/** `#rrggbb` with an alpha channel, for hairlines and image placeholders. */
export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${value}`;
}
