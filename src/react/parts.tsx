import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Image,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { InAppButton, InAppMessage, InAppStyle } from "../types";

import {
  MAX_FONT_SCALE,
  SCRIM_STOPS,
  TYPE,
  splitButtons,
  type Palette,
} from "./design";
import { withAlpha } from "./styles";

// region Safe area

export interface Insets {
  top: number;
  bottom: number;
}

type SafeAreaModule = {
  SafeAreaInsetsContext?: React.Context<Insets | null>;
  initialWindowMetrics?: { insets: Insets } | null;
};

// Optional: Metro treats a require inside try/catch as optional, so apps
// without react-native-safe-area-context still build.
let safeArea: SafeAreaModule | null = null;
try {
  safeArea = require("react-native-safe-area-context") as SafeAreaModule;
} catch {
  safeArea = null;
}
const NoSafeAreaContext = createContext<Insets | null>(null);

/**
 * Status bar and home indicator insets: from react-native-safe-area-context
 * when the app uses it, else the initial window metrics, else the Android
 * status bar height.
 */
export function useInsets(override?: Partial<Insets>): Insets {
  const fromContext = useContext(
    safeArea?.SafeAreaInsetsContext ?? NoSafeAreaContext
  );
  const measured = fromContext ??
    safeArea?.initialWindowMetrics?.insets ?? {
      top: Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0,
      bottom: 0,
    };
  return {
    top: override?.top ?? measured.top,
    bottom: override?.bottom ?? measured.bottom,
  };
}

// endregion

export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduce(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.(
      "reduceMotionChanged",
      setReduce
    );
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  return reduce;
}

/** A 12 × 12 X from two round-capped strokes, on a circle. */
export function CloseButton({
  palette,
  size = 30,
  onPress,
  style,
}: {
  palette: Palette;
  size?: number;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const stroke = {
    position: "absolute" as const,
    width: 2,
    height: 15,
    borderRadius: 1,
    backgroundColor: palette.closeStroke,
  };
  return (
    <Pressable
      testID="sequenzy-close"
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={10}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: palette.closeFill,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      <View style={[stroke, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[stroke, { transform: [{ rotate: "-45deg" }] }]} />
    </Pressable>
  );
}

export function TextBlock({
  message,
  palette,
  font,
  fullscreen = false,
  center = false,
}: {
  message: InAppMessage;
  palette: Palette;
  font: string | undefined;
  fullscreen?: boolean;
  center?: boolean;
}) {
  const align = center ? ("center" as const) : ("left" as const);
  // Centered headings keep clear of the close button in the corner.
  const headingInset = center ? 20 : 0;
  const eyebrow = message.eyebrow?.trim();
  return (
    <View>
      {eyebrow ? (
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            TYPE.eyebrow,
            { color: palette.eyebrow, fontFamily: font, textAlign: align },
            { marginBottom: 6, marginHorizontal: headingInset },
          ]}
        >
          {eyebrow}
        </Text>
      ) : null}
      {message.title ? (
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            fullscreen ? TYPE.fullscreenTitle : TYPE.title,
            { color: palette.text, fontFamily: font, textAlign: align },
            { marginHorizontal: headingInset },
          ]}
        >
          {message.title}
        </Text>
      ) : null}
      {message.body ? (
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            fullscreen ? TYPE.fullscreenBody : TYPE.body,
            {
              color: palette.muted,
              fontFamily: font,
              textAlign: align,
              marginTop: message.title ? 8 : 0,
            },
          ]}
        >
          {message.body}
        </Text>
      ) : null}
    </View>
  );
}

/** Primary filled button, the other as plain text below it. */
export function ButtonStack({
  message,
  palette,
  font,
  onButton,
}: {
  message: InAppMessage;
  palette: Palette;
  font: string | undefined;
  onButton: (button: InAppButton) => void;
}) {
  const { primary, secondary } = splitButtons(message.buttons);
  if (!primary) return null;
  return (
    <View style={{ marginTop: 24 }}>
      <Pressable
        accessibilityRole="button"
        onPress={() => onButton(primary)}
        style={({ pressed }) => [
          styles.primary,
          {
            borderRadius: Math.min(message.style.buttonRadius, 26),
            backgroundColor: palette.primaryBackground,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            TYPE.button,
            { color: palette.primaryText, fontFamily: font },
          ]}
        >
          {primary.label}
        </Text>
      </Pressable>
      {secondary ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onButton(secondary)}
          style={({ pressed }) => [
            styles.secondary,
            { opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              TYPE.button,
              {
                fontFamily: font,
                color:
                  secondary.action === "open_url"
                    ? palette.secondaryLink
                    : palette.secondaryDismiss,
              },
            ]}
          >
            {secondary.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Thin enough that steps between bands (about 1% alpha) do not show as
// stripes over smooth areas such as sky.
const SCRIM_BANDS = 96;

function scrimAlpha(position: number): number {
  for (let index = 1; index < SCRIM_STOPS.length; index += 1) {
    const stop = SCRIM_STOPS[index];
    const previous = SCRIM_STOPS[index - 1];
    if (!stop || !previous) break;
    const [end, endAlpha] = stop;
    const [start, startAlpha] = previous;
    if (position <= end) {
      return (
        startAlpha +
        ((position - start) / (end - start)) * (endAlpha - startAlpha)
      );
    }
  }
  return SCRIM_STOPS[SCRIM_STOPS.length - 1]?.[1] ?? 0;
}

/**
 * The dark gradient over a background image, drawn as thin bands so the SDK
 * needs no gradient library.
 */
export function Scrim() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {Array.from({ length: SCRIM_BANDS }, (_, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            backgroundColor: `rgba(0,0,0,${scrimAlpha(
              (index + 0.5) / SCRIM_BANDS
            ).toFixed(3)})`,
          }}
        />
      ))}
    </View>
  );
}

/**
 * An image on a faint placeholder; reports a load failure so callers can
 * drop it (top) or fall back to the surface (background).
 */
export function ImageBox({
  uri,
  style,
  placeholder,
  onError,
  children,
}: {
  uri: string;
  style: StyleProp<ViewStyle>;
  placeholder: InAppStyle;
  onError: () => void;
  children?: ReactNode;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: withAlpha(placeholder.textColor, 0.06),
          overflow: "hidden",
        },
        style,
      ]}
    >
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri }}
        resizeMode="cover"
        onError={onError}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  primary: {
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  secondary: {
    height: 48,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
});
