import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { InAppButton, InAppMessage } from "../types";

import {
  MAX_FONT_SCALE,
  TYPE,
  imagePalette,
  splitButtons,
  surfacePalette,
  type Palette,
} from "./design";
import { ImageBox, Scrim } from "./parts";
import { resolveFontFamily, withAlpha } from "./styles";

export interface PlacementItemProps {
  item: InAppMessage;
  /** Runs a button's action. */
  onButtonPress: (button: InAppButton) => void;
  /** Maps brand font families to fonts the app bundles. */
  fonts?: Record<string, string>;
}

/**
 * A placement item with the banner or hero layout of mobile-sdks/DESIGN.md
 * ("Placement"). Card items are drawn by `InAppCard`.
 */
export function PlacementItem({
  item,
  onButtonPress,
  fonts,
}: PlacementItemProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const hero = item.layout === "hero";
  const font = resolveFontFamily(item.style, fonts);
  const image = item.imageUrl && !imageFailed ? item.imageUrl : null;
  const overImage = hero && image !== null;
  const palette = overImage
    ? imagePalette(item.style)
    : surfacePalette(item.style);
  const eyebrow = item.eyebrow?.trim();

  const text = (
    <View style={styles.column}>
      {eyebrow ? (
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            hero ? TYPE.eyebrow : TYPE.cardEyebrow,
            {
              color: palette.eyebrow,
              fontFamily: font,
              marginBottom: hero ? 6 : 4,
            },
          ]}
        >
          {eyebrow}
        </Text>
      ) : null}
      {item.title ? (
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            hero ? TYPE.heroTitle : TYPE.cardTitle,
            { color: palette.text, fontFamily: font },
          ]}
        >
          {item.title}
        </Text>
      ) : null}
      {item.body ? (
        <Text
          numberOfLines={hero ? 3 : 2}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            TYPE.cardBody,
            {
              color: palette.muted,
              fontFamily: font,
              marginTop: item.title ? (hero ? 6 : 4) : 0,
            },
          ]}
        >
          {item.body}
        </Text>
      ) : null}
      <Buttons
        item={item}
        palette={palette}
        font={font}
        marginTop={hero ? 14 : 10}
        onPress={onButtonPress}
      />
    </View>
  );

  const chrome = {
    backgroundColor: item.style.backgroundColor,
    borderRadius: item.style.cornerRadius,
    borderColor: withAlpha(item.style.textColor, 0.08),
  };

  if (!hero) {
    return (
      <View
        testID={`sequenzy-placement-item-${item.id}`}
        style={[styles.chrome, styles.banner, chrome]}
      >
        {image ? (
          <ImageBox
            uri={image}
            placeholder={item.style}
            onError={() => setImageFailed(true)}
            style={[
              styles.thumbnail,
              { borderRadius: Math.min(item.style.cornerRadius, 12) },
            ]}
          />
        ) : null}
        {text}
      </View>
    );
  }

  return (
    <View
      testID={`sequenzy-placement-item-${item.id}`}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.chrome, styles.hero, chrome, { minHeight: width / 2 }]}
    >
      {image ? (
        <ImageBox
          uri={image}
          placeholder={item.style}
          onError={() => setImageFailed(true)}
          style={StyleSheet.absoluteFill}
        >
          <Scrim />
        </ImageBox>
      ) : null}
      <View style={styles.heroContent}>{text}</View>
    </View>
  );
}

/** A filled primary button, then the other button as a text link. */
function Buttons({
  item,
  palette,
  font,
  marginTop,
  onPress,
}: {
  item: InAppMessage;
  palette: Palette;
  font: string | undefined;
  marginTop: number;
  onPress: (button: InAppButton) => void;
}) {
  const { primary, secondary } = splitButtons(item.buttons);
  if (!primary) return null;
  return (
    <View style={[styles.buttons, { marginTop }]}>
      <Pressable
        accessibilityRole="button"
        onPress={() => onPress(primary)}
        style={({ pressed }) => [
          styles.filled,
          {
            backgroundColor: palette.primaryBackground,
            borderRadius: Math.min(item.style.buttonRadius, 18),
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            TYPE.bannerLink,
            { color: palette.primaryText, fontFamily: font },
          ]}
        >
          {primary.label}
        </Text>
      </Pressable>
      {secondary ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => onPress(secondary)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              TYPE.bannerLink,
              { color: palette.muted, fontFamily: font },
            ]}
          >
            {secondary.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chrome: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
  },
  thumbnail: { width: 56, height: 56 },
  column: { flex: 1, minWidth: 0 },
  hero: { justifyContent: "flex-end" },
  heroContent: { padding: 20 },
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 16,
  },
  filled: {
    height: 36,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
});
