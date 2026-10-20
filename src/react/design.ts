// Drawing rules from mobile-sdks/DESIGN.md, shared by the message view and
// cards. Every renderer (iOS, Android, Flutter, the dashboard preview) uses
// the same numbers.

import { Platform } from "react-native";

import type { InAppButton, InAppMessage, InAppStyle } from "../types";

import { withAlpha } from "./styles";

export const TYPE = {
  eyebrow: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  title: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  fullscreenTitle: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -0.6,
  },
  body: { fontSize: 16, lineHeight: 23 },
  fullscreenBody: { fontSize: 17, lineHeight: 25 },
  button: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  bannerTitle: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  bannerBody: { fontSize: 14, lineHeight: 19 },
  bannerLink: { fontSize: 14, lineHeight: 19, fontWeight: "600" },
  cardEyebrow: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  cardTitle: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  cardBody: { fontSize: 14, lineHeight: 20 },
  cardLink: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
} as const;

/** The web has no native animation driver; asking for it only warns. */
export const NATIVE_DRIVER = Platform.OS !== "web";

/** Text scales with the system size, up to this much. */
export const MAX_FONT_SCALE = 1.4;

// Springs as (damping ratio, response) converted for Animated.spring with a
// mass of 1: stiffness = (2π / response)², damping = 2 · ratio · √stiffness.
function spring(ratio: number, response: number) {
  const stiffness = (2 * Math.PI) ** 2 / response ** 2;
  return { stiffness, damping: 2 * ratio * Math.sqrt(stiffness), mass: 1 };
}
export const SPRINGS = {
  sheet: spring(0.86, 0.42),
  dialog: spring(0.86, 0.32),
  banner: spring(0.86, 0.38),
} as const;

/** Gradient over a background image: [position, black alpha] stops. */
export const SCRIM_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.55, 0.55],
  [1, 0.82],
];

function channel(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return 0;
  const [r, g, b] = [0, 1, 2].map((index) => {
    const value = channel(hex, index);
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

export interface Palette {
  text: string;
  muted: string;
  eyebrow: string;
  primaryBackground: string;
  primaryText: string;
  secondaryLink: string;
  secondaryDismiss: string;
  closeFill: string;
  closeStroke: string;
}

export function surfacePalette(style: InAppStyle): Palette {
  return {
    text: style.textColor,
    muted: style.mutedTextColor,
    eyebrow:
      contrastRatio(style.buttonColor, style.backgroundColor) >= 3
        ? style.buttonColor
        : style.mutedTextColor,
    primaryBackground: style.buttonColor,
    primaryText: style.buttonTextColor,
    secondaryLink: style.textColor,
    secondaryDismiss: style.mutedTextColor,
    closeFill: withAlpha(style.textColor, 0.06),
    closeStroke: withAlpha(style.textColor, 0.6),
  };
}

export function imagePalette(style: InAppStyle): Palette {
  const keepsAccent = contrastRatio(style.buttonColor, "#1f1f1f") >= 2;
  return {
    text: "#ffffff",
    muted: "rgba(255,255,255,0.82)",
    eyebrow: "rgba(255,255,255,0.9)",
    primaryBackground: keepsAccent ? style.buttonColor : "#ffffff",
    primaryText: keepsAccent ? style.buttonTextColor : "#111111",
    secondaryLink: "#ffffff",
    secondaryDismiss: "rgba(255,255,255,0.82)",
    closeFill: "rgba(0,0,0,0.32)",
    closeStroke: "#ffffff",
  };
}

/** The primary button and the other one (DESIGN.md: Buttons). */
export function splitButtons(buttons: InAppButton[]): {
  primary: InAppButton | null;
  secondary: InAppButton | null;
} {
  const index = buttons.findIndex((button) => button.action === "open_url");
  const primaryIndex = index === -1 ? 0 : index;
  return {
    primary: buttons[primaryIndex] ?? null,
    secondary: buttons.find((_, i) => i !== primaryIndex) ?? null,
  };
}

export type ModalLayout = "sheet" | "dialog";

/** Sheets become dialogs on screens 600 or wider. */
export function modalLayout(message: InAppMessage, width: number): ModalLayout {
  return message.position === "center" || width >= 600 ? "dialog" : "sheet";
}

/** "background" only when there is an image to put behind the text. */
export function imagePlacement(
  message: InAppMessage
): "top" | "background" | null {
  if (!message.imageUrl) return null;
  return message.imagePlacement === "background" ? "background" : "top";
}
