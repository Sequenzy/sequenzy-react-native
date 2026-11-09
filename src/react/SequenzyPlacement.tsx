import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";

import { Sequenzy } from "../sequenzy";
import type { InAppButton, InAppMessage } from "../types";

import { InAppCard } from "./InAppCard";
import { PlacementItem } from "./PlacementItem";
import { placementStore } from "./placementStore";
import { usePlacement } from "./usePlacement";

export interface SequenzyPlacementProps {
  /** The placement key defined in Sequenzy, e.g. "home_hero". */
  placementId: string;
  /** Maps brand font families to fonts the app bundles. */
  fonts?: Record<string, string>;
  /** Wraps the content; nothing renders (zero height) when the slot is empty. */
  style?: StyleProp<ViewStyle>;
  /** Called when the slot's content changes; null when it collapses. */
  onChange?: (item: InAppMessage | null) => void;
}

/**
 * A slot in your layout that shows Sequenzy content for one placement, drawn
 * to mobile-sdks/DESIGN.md (the card layout without unread dot, pin or close
 * control). Renders nothing when there is nothing to show, so the slot
 * collapses. Reports displayed (once per item per session), clicks and
 * dismissals.
 */
export function SequenzyPlacement({
  placementId,
  fonts,
  style,
  onChange,
}: SequenzyPlacementProps) {
  const { item, logDisplayed, dismiss } = usePlacement(placementId);

  useEffect(() => {
    onChange?.(item);
  }, [item, onChange]);

  useEffect(() => {
    if (item) logDisplayed();
  }, [item, logDisplayed]);

  if (!item) return null;
  const press = (button: InAppButton) => {
    if (button.action === "dismiss") {
      dismiss();
      return;
    }
    void Sequenzy.handleButtonPress(button, item).catch(() => undefined);
  };
  return (
    <View
      key={item.id}
      testID={`sequenzy-placement-${placementId}`}
      style={style}
    >
      {item.layout === "banner" || item.layout === "hero" ? (
        <PlacementItem item={item} fonts={fonts} onButtonPress={press} />
      ) : (
        <InAppCard
          card={item}
          fonts={fonts}
          variant="placement"
          onButtonPress={press}
        />
      )}
    </View>
  );
}

/** Fetch every mounted placement again, e.g. on pull to refresh. */
export function refreshPlacements(): void {
  placementStore().refresh();
}
