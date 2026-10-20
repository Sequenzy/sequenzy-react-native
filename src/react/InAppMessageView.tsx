import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import type { InAppButton, InAppMessage } from "../types";

import {
  MAX_FONT_SCALE,
  NATIVE_DRIVER,
  SPRINGS,
  TYPE,
  imagePalette,
  imagePlacement,
  modalLayout,
  splitButtons,
  surfacePalette,
} from "./design";
import {
  ButtonStack,
  CloseButton,
  ImageBox,
  Scrim,
  TextBlock,
  useInsets,
  useReduceMotion,
  type Insets,
} from "./parts";
import { resolveFontFamily, withAlpha } from "./styles";

export interface InAppMessageViewProps {
  message: InAppMessage;
  /** Closed with the X, a dismiss button, a swipe or a tap outside a modal. */
  onDismiss: () => void;
  /** A link button, or the banner itself (null button). */
  onPress: (button: InAppButton | null) => void;
  /** Maps brand font families to fonts the app bundles, e.g. `{ Inter: "Inter-Regular" }`. */
  fonts?: Record<string, string>;
  /** Safe-area insets, when the app does not use react-native-safe-area-context. */
  insets?: Partial<Insets>;
}

/** Draws one in-app message to mobile-sdks/DESIGN.md. */
export function InAppMessageView(props: InAppMessageViewProps) {
  const format = props.message.format ?? "modal";
  // Android back runs the same exit animation and guard as the close button.
  const backRef = useRef<(() => void) | null>(null);
  if (format === "banner") return <Banner {...props} />;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => (backRef.current ?? props.onDismiss)()}
    >
      {format === "fullscreen" ? (
        <Fullscreen {...props} backRef={backRef} />
      ) : (
        <ModalMessage {...props} backRef={backRef} />
      )}
    </Modal>
  );
}

type BackRef = { current: (() => void) | null };

/** Runs the exit animation once, then the callback. */
function useExit(animateOut: (done: () => void) => void) {
  const leaving = useRef(false);
  return (after: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    animateOut(after);
  };
}

function useButtonHandler(
  props: InAppMessageViewProps,
  exit: (after: () => void) => void
) {
  return (button: InAppButton) =>
    exit(() =>
      button.action === "dismiss" ? props.onDismiss() : props.onPress(button)
    );
}

function ModalMessage(props: InAppMessageViewProps & { backRef: BackRef }) {
  const { message } = props;
  const { width, height } = useWindowDimensions();
  const insets = useInsets(props.insets);
  const reduceMotion = useReduceMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const layout = modalLayout(message, width);
  const placement = imageFailed ? null : imagePlacement(message);
  const onImage = placement === "background";
  const palette = onImage
    ? imagePalette(message.style)
    : surfacePalette(message.style);
  const closePalette = placement
    ? imagePalette(message.style)
    : surfacePalette(message.style);
  const font = resolveFontFamily(message.style, props.fonts);
  const radius = message.style.cornerRadius;
  const sheet = layout === "sheet";

  const backdrop = useRef(new Animated.Value(0)).current;
  const offset = useRef(new Animated.Value(sheet ? height : 0)).current;
  const scale = useRef(new Animated.Value(reduceMotion ? 1 : 0.94)).current;
  const sheetHeight = useRef(height);

  useEffect(() => {
    const fade = Animated.timing(backdrop, {
      toValue: 1,
      duration: reduceMotion ? 180 : 220,
      useNativeDriver: NATIVE_DRIVER,
    });
    const enter = reduceMotion
      ? Animated.timing(offset, {
          toValue: 0,
          duration: 0,
          useNativeDriver: NATIVE_DRIVER,
        })
      : sheet
        ? Animated.spring(offset, {
            toValue: 0,
            ...SPRINGS.sheet,
            useNativeDriver: NATIVE_DRIVER,
          })
        : Animated.spring(scale, {
            toValue: 1,
            ...SPRINGS.dialog,
            useNativeDriver: NATIVE_DRIVER,
          });
    Animated.parallel([fade, enter]).start();
  }, [backdrop, offset, scale, sheet, reduceMotion]);

  const exit = useExit((done) => {
    const fade = Animated.timing(backdrop, {
      toValue: 0,
      duration: reduceMotion ? 180 : sheet ? 220 : 160,
      useNativeDriver: NATIVE_DRIVER,
    });
    const leave =
      reduceMotion || !sheet
        ? Animated.timing(scale, {
            toValue: reduceMotion ? 1 : 0.96,
            duration: 160,
            useNativeDriver: NATIVE_DRIVER,
          })
        : Animated.timing(offset, {
            toValue: sheetHeight.current + insets.bottom,
            duration: 220,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: NATIVE_DRIVER,
          });
    Animated.parallel([fade, leave]).start(() => done());
  });
  const dismiss = () => exit(props.onDismiss);
  props.backRef.current = dismiss;
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const onButton = useButtonHandler(props, exit);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          sheet &&
          Math.abs(gesture.dy) > 6 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          // Upward drags resist at a third of the distance.
          offset.setValue(gesture.dy > 0 ? gesture.dy : gesture.dy / 3);
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > sheetHeight.current * 0.3 || gesture.vy > 1) {
            dismissRef.current();
          } else {
            Animated.spring(offset, {
              toValue: 0,
              ...SPRINGS.sheet,
              useNativeDriver: NATIVE_DRIVER,
            }).start();
          }
        },
      }),
    [sheet, offset]
  );

  const dialogWidth = Math.min(width - 40, 360);
  const dialogMaxHeight = height - insets.top - insets.bottom - 48;
  const content = (
    <View
      style={{
        paddingHorizontal: 24,
        paddingTop: placement === "top" ? 20 : 28,
        paddingBottom: sheet ? Math.max(16 + insets.bottom, 24) : 24,
      }}
    >
      <TextBlock
        message={message}
        palette={palette}
        font={font}
        center={!sheet}
      />
      <ButtonStack
        message={message}
        palette={palette}
        font={font}
        onButton={onButton}
      />
    </View>
  );

  const panel = (
    <Animated.View
      testID={sheet ? "sequenzy-sheet" : "sequenzy-modal"}
      accessibilityViewIsModal
      onLayout={(event) => {
        sheetHeight.current = event.nativeEvent.layout.height;
      }}
      {...(sheet ? pan.panHandlers : {})}
      style={[
        {
          backgroundColor: message.style.backgroundColor,
          overflow: "hidden",
        },
        sheet
          ? {
              width: "100%",
              maxHeight: height - insets.top - 24,
              borderTopLeftRadius: radius,
              borderTopRightRadius: radius,
              opacity: reduceMotion ? backdrop : 1,
              transform: [{ translateY: offset }],
            }
          : {
              width: dialogWidth,
              maxHeight: dialogMaxHeight,
              borderRadius: radius,
              opacity: backdrop,
              transform: [{ scale }],
            },
        onImage
          ? sheet
            ? {
                // Yoga lets minHeight beat maxHeight, so cap it here.
                minHeight: Math.min(460, height - insets.top - 24),
                justifyContent: "flex-end",
              }
            : {
                minHeight: Math.min(dialogWidth * 1.25, dialogMaxHeight),
                justifyContent: "flex-end",
              }
          : null,
      ]}
    >
      {placement === "background" && message.imageUrl ? (
        <ImageBox
          uri={message.imageUrl}
          placeholder={message.style}
          onError={() => setImageFailed(true)}
          style={StyleSheet.absoluteFill}
        >
          <Scrim />
        </ImageBox>
      ) : null}
      {/* Long copy at large text sizes scrolls; the close button stays put. */}
      <ScrollView
        testID="sequenzy-modal-scroll"
        style={styles.modalScroll}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        {placement === "top" && message.imageUrl ? (
          <ImageBox
            uri={message.imageUrl}
            placeholder={message.style}
            onError={() => setImageFailed(true)}
            style={{ width: "100%", aspectRatio: 16 / 9, maxHeight: 260 }}
          />
        ) : null}
        {content}
      </ScrollView>
      {sheet ? (
        <View
          pointerEvents="none"
          style={[
            styles.grabber,
            {
              backgroundColor: placement
                ? "rgba(255,255,255,0.7)"
                : withAlpha(message.style.textColor, 0.2),
            },
          ]}
        />
      ) : null}
      <CloseButton
        palette={closePalette}
        onPress={dismiss}
        style={styles.modalClose}
      />
    </Animated.View>
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: onImage ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.4)",
            opacity: backdrop,
          },
        ]}
      >
        {/* A sibling behind the panel, not its parent: a pressable parent
            would group the panel's buttons into one screen-reader element. */}
        <Pressable
          testID="sequenzy-backdrop"
          accessible={false}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
          onPress={dismiss}
        />
      </Animated.View>
      <View
        pointerEvents="box-none"
        style={[
          StyleSheet.absoluteFill,
          sheet ? styles.sheetLayer : styles.dialogLayer,
        ]}
      >
        {panel}
      </View>
    </View>
  );
}

function Fullscreen(props: InAppMessageViewProps & { backRef: BackRef }) {
  const { message } = props;
  const { height } = useWindowDimensions();
  const insets = useInsets(props.insets);
  const reduceMotion = useReduceMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const placement = imageFailed ? null : imagePlacement(message);
  const onImage = placement === "background";
  const palette = onImage
    ? imagePalette(message.style)
    : surfacePalette(message.style);
  const font = resolveFontFamily(message.style, props.fonts);

  const opacity = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(reduceMotion ? 0 : 24)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: reduceMotion ? 180 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: NATIVE_DRIVER,
      }),
      Animated.timing(rise, {
        toValue: 0,
        duration: reduceMotion ? 0 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: NATIVE_DRIVER,
      }),
    ]).start();
  }, [opacity, rise, reduceMotion]);
  const exit = useExit((done) =>
    Animated.timing(opacity, {
      toValue: 0,
      duration: reduceMotion ? 180 : 200,
      useNativeDriver: NATIVE_DRIVER,
    }).start(() => done())
  );
  const onButton = useButtonHandler(props, exit);
  props.backRef.current = () => exit(props.onDismiss);

  return (
    <Animated.View
      testID="sequenzy-fullscreen"
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: message.style.backgroundColor,
          opacity,
          transform: [{ translateY: rise }],
        },
      ]}
    >
      {onImage && message.imageUrl ? (
        <ImageBox
          uri={message.imageUrl}
          placeholder={message.style}
          onError={() => setImageFailed(true)}
          style={StyleSheet.absoluteFill}
        >
          <Scrim />
        </ImageBox>
      ) : placement === "top" && message.imageUrl ? (
        <ImageBox
          uri={message.imageUrl}
          placeholder={message.style}
          onError={() => setImageFailed(true)}
          style={{ width: "100%", height: height * 0.48 }}
        />
      ) : null}
      <ScrollView
        bounces={false}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 24,
          paddingTop: placement === "top" ? 28 : insets.top + 56,
          paddingBottom: 16 + insets.bottom,
        }}
      >
        {placement === "top" ? null : <View style={{ flex: 1 }} />}
        <TextBlock message={message} palette={palette} font={font} fullscreen />
        {onImage ? null : <View style={{ flex: placement ? 1 : 1.4 }} />}
        <ButtonStack
          message={message}
          palette={palette}
          font={font}
          onButton={onButton}
        />
      </ScrollView>
      <CloseButton
        palette={placement ? imagePalette(message.style) : palette}
        size={32}
        onPress={() => exit(props.onDismiss)}
        style={{ position: "absolute", top: insets.top + 12, right: 16 }}
      />
    </Animated.View>
  );
}

function Banner(props: InAppMessageViewProps) {
  const { message } = props;
  const insets = useInsets(props.insets);
  const reduceMotion = useReduceMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const palette = surfacePalette(message.style);
  const font = resolveFontFamily(message.style, props.fonts);
  const top = message.position === "top";
  const edge = top ? 8 + insets.top : 12 + insets.bottom;
  const { primary } = splitButtons(message.buttons);
  const link = primary?.action === "open_url" ? primary : null;
  const direction = top ? -1 : 1;

  const offset = useRef(new Animated.Value(direction * 200)).current;
  const opacity = useRef(new Animated.Value(reduceMotion ? 0 : 1)).current;
  const bannerHeight = useRef(80);
  useEffect(() => {
    if (reduceMotion) {
      offset.setValue(0);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    } else {
      Animated.spring(offset, {
        toValue: 0,
        ...SPRINGS.banner,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    }
  }, [offset, opacity, reduceMotion]);
  const exit = useExit((done) =>
    (reduceMotion
      ? Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          useNativeDriver: NATIVE_DRIVER,
        })
      : Animated.timing(offset, {
          toValue: direction * (bannerHeight.current + edge + 16),
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: NATIVE_DRIVER,
        })
    ).start(() => done())
  );
  const closeRef = useRef(() => exit(props.onDismiss));
  closeRef.current = () => exit(props.onDismiss);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dy) > 6 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          const towardEdge = gesture.dy * direction > 0;
          offset.setValue(towardEdge ? gesture.dy : gesture.dy / 3);
        },
        onPanResponderRelease: (_, gesture) => {
          const distance = gesture.dy * direction;
          if (
            distance > bannerHeight.current * 0.4 ||
            gesture.vy * direction > 0.8
          ) {
            closeRef.current();
          } else {
            Animated.spring(offset, {
              toValue: 0,
              ...SPRINGS.banner,
              useNativeDriver: NATIVE_DRIVER,
            }).start();
          }
        },
      }),
    [direction, offset]
  );

  return (
    <View
      pointerEvents="box-none"
      style={[styles.bannerLayer, top ? { top: edge } : { bottom: edge }]}
    >
      <Animated.View
        testID="sequenzy-banner"
        {...pan.panHandlers}
        onLayout={(event) => {
          bannerHeight.current = event.nativeEvent.layout.height;
        }}
        style={[
          styles.banner,
          {
            backgroundColor: message.style.backgroundColor,
            borderRadius: Math.min(message.style.cornerRadius, 24),
            borderColor: withAlpha(message.style.textColor, 0.06),
            opacity,
            transform: [{ translateY: offset }],
          },
        ]}
      >
        {/* The close button is a sibling of the tappable area, not inside it:
            nested buttons are invalid on the web and confuse screen readers. */}
        <Pressable
          accessibilityRole={link ? "button" : undefined}
          disabled={!link}
          onPress={() => exit(() => props.onPress(null))}
          style={({ pressed }) => [
            styles.bannerContent,
            { opacity: pressed ? 0.85 : 1 },
          ]}
        >
          {message.imageUrl && !imageFailed ? (
            <ImageBox
              uri={message.imageUrl}
              placeholder={message.style}
              onError={() => setImageFailed(true)}
              style={styles.bannerImage}
            />
          ) : null}
          <View style={styles.bannerText}>
            {message.title ? (
              <Text
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[
                  TYPE.bannerTitle,
                  { color: palette.text, fontFamily: font },
                ]}
              >
                {message.title}
              </Text>
            ) : null}
            {message.body ? (
              <Text
                numberOfLines={message.title ? 2 : 3}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[
                  message.title
                    ? [TYPE.bannerBody, { color: palette.muted, marginTop: 2 }]
                    : {
                        fontSize: 15,
                        lineHeight: 20,
                        fontWeight: "500",
                        color: palette.text,
                      },
                  { fontFamily: font },
                ]}
              >
                {message.body}
              </Text>
            ) : null}
            {link ? (
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[
                  TYPE.bannerLink,
                  { color: palette.eyebrow, fontFamily: font, marginTop: 6 },
                ]}
              >
                {link.label}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <CloseButton
          palette={palette}
          size={28}
          onPress={() => exit(props.onDismiss)}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetLayer: { justifyContent: "flex-end" },
  dialogLayer: { alignItems: "center", justifyContent: "center" },
  grabber: {
    position: "absolute",
    top: 6,
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 2.5,
  },
  modalClose: { position: "absolute", top: 14, right: 14 },
  modalScroll: { flexGrow: 0, flexShrink: 1 },
  bannerLayer: {
    position: "absolute",
    left: 12,
    right: 12,
    alignItems: "center",
  },
  banner: {
    width: "100%",
    maxWidth: 480,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 8,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  bannerContent: { flex: 1, flexDirection: "row", gap: 12 },
  bannerImage: { width: 44, height: 44, borderRadius: 10 },
  bannerText: { flex: 1, paddingTop: 1 },
});
