import { useCallback, useEffect, useState } from "react";

import { Sequenzy } from "../sequenzy";
import type { InAppMessage } from "../types";

import { placementStore, type PlacementState } from "./placementStore";

export interface UsePlacementResult extends PlacementState {
  refresh: () => void;
  /** Report the item shown; once per item per app session. */
  logDisplayed: () => void;
  /** Report a dismissal and show the slot's next item, if any. */
  dismiss: () => void;
}

/**
 * What a placement shows the identified contact, for apps that draw the
 * content with their own components. `item` is null when the slot should
 * collapse. Refreshed after identify, reset and app foreground.
 */
export function usePlacement(placementId: string): UsePlacementResult {
  const store = placementStore();
  const [state, setState] = useState<PlacementState>(() =>
    store.get(placementId)
  );

  useEffect(() => {
    setState(store.get(placementId));
    return store.subscribe(placementId, setState);
  }, [store, placementId]);

  const item: InAppMessage | null = state.item;
  const refresh = useCallback(
    () => store.refresh(placementId),
    [store, placementId]
  );
  const logDisplayed = useCallback(() => {
    if (item) store.logDisplayed(item);
  }, [store, item]);
  const dismiss = useCallback(() => {
    if (!item) return;
    store.dismissed(
      item,
      Sequenzy.report("dismissed", item).catch(() => undefined)
    );
  }, [store, item]);

  return { ...state, refresh, logDisplayed, dismiss };
}
