import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Sequenzy } from "../sequenzy";
import type { InAppButton, InAppMessage } from "../types";

import { MAX_FONT_SCALE, TYPE, splitButtons, surfacePalette } from "./design";
import { CloseButton, ImageBox } from "./parts";
import { resolveFontFamily, withAlpha } from "./styles";

export interface InAppCardProps {
  card: InAppMessage;
  /**
   * Handles the dismiss button. Pass `useInAppCards().dismiss`, which reports
   * the dismissal and drops the card; without it the card reports it itself.
   */
  onDismiss?: (card: InAppMessage) => void;
  /** Maps brand font families to fonts the app bundles. */
  fonts?: Record<string, string>;
}

/** A small pin: a round head on a short needle, tilted. */
function PinGlyph({ color }: { color: string }) {
  return (
    <View accessibilityLabel="Pinned" accessible style={styles.pin}>
      <View style={{ transform: [{ rotate: "35deg" }], alignItems: "center" }}>
        <View style={[styles.pinHead, { backgroundColor: color }]} />
        <View style={[styles.pinNeedle, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/** A content card drawn to mobile-sdks/DESIGN.md. Reports clicks and dismissals. */
export function InAppCard({ card, onDismiss, fonts }: InAppCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const font = resolveFontFamily(card.style, fonts);
  const palette = surfacePalette(card.style);
  const { primary, secondary } = splitButtons(card.buttons);
  const eyebrow = card.eyebrow?.trim();
  const dismiss = () => {
    if (onDismiss) onDismiss(card);
    else void Sequenzy.report("dismissed", card);
  };
  const press = (button: InAppButton) => {
    if (button.action === "dismiss") dismiss();
    else void Sequenzy.handleButtonPress(button, card);
  };

  return (
    <View
      testID={`sequenzy-card-${card.id}`}
      style={[
        styles.card,
        {
          backgroundColor: card.style.backgroundColor,
          borderRadius: card.style.cornerRadius,
          borderColor: withAlpha(card.style.textColor, 0.08),
        },
      ]}
    >
      {card.imageUrl && !imageFailed ? (
        <ImageBox
          uri={card.imageUrl}
          placeholder={card.style}
          onError={() => setImageFailed(true)}
          style={{ width: "100%", aspectRatio: 2 }}
        />
      ) : null}
      <View style={styles.body}>
        {eyebrow ? (
          <Text
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              TYPE.cardEyebrow,
              { color: palette.eyebrow, fontFamily: font, marginBottom: 4 },
            ]}
          >
            {eyebrow}
          </Text>
        ) : null}
        <View style={styles.header}>
          {!card.readAt ? (
            <View
              accessibilityLabel="Unread"
              accessible
              style={[
                styles.unread,
                { backgroundColor: card.style.buttonColor },
              ]}
            />
          ) : null}
          <Text
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              TYPE.cardTitle,
              styles.title,
              { color: palette.text, fontFamily: font },
            ]}
          >
            {card.title}
          </Text>
          {card.pinned ? <PinGlyph color={palette.muted} /> : null}
          <CloseButton palette={palette} size={24} onPress={dismiss} />
        </View>
        {card.body ? (
          <Text
            numberOfLines={4}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[
              TYPE.cardBody,
              { color: palette.muted, fontFamily: font, marginTop: 6 },
            ]}
          >
            {card.body}
          </Text>
        ) : null}
        {primary ? (
          <View style={styles.links}>
            {[primary, secondary].map((button, index) =>
              button ? (
                <Pressable
                  key={`${index}-${button.label}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => press(button)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                >
                  <Text
                    maxFontSizeMultiplier={MAX_FONT_SCALE}
                    style={[
                      TYPE.cardLink,
                      {
                        color: index === 0 ? palette.eyebrow : palette.muted,
                        fontFamily: font,
                      },
                    ]}
                  >
                    {button.label}
                  </Text>
                </Pressable>
              ) : null
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  body: { padding: 16 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  unread: { width: 8, height: 8, borderRadius: 4, marginTop: 6.5 },
  title: { flex: 1 },
  links: { flexDirection: "row", gap: 20, marginTop: 12 },
  pin: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  pinHead: { width: 8, height: 8, borderRadius: 4 },
  pinNeedle: { width: 1.5, height: 7, borderRadius: 1 },
});
