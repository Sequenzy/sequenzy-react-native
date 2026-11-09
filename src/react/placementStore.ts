import { AppState } from "react-native";

import { MAX_PLACEMENTS_PER_REQUEST } from "../client";
import { Sequenzy } from "../sequenzy";
import type { InAppMessage } from "../types";

export interface PlacementState {
  item: InAppMessage | null;
  /** True until the first answer for the placement arrives. */
  loading: boolean;
  error: Error | null;
}

type Listener = (state: PlacementState) => void;

// Refetch on foreground at most this often.
const FOREGROUND_REFRESH_MS = 60_000;

const EMPTY: PlacementState = { item: null, loading: true, error: null };

/**
 * Shared by every `SequenzyPlacement` and `usePlacement` in the app: one
 * cache per placement key, fetches batched across placements mounted in the
 * same tick, and each item reported displayed once per app session. Content
 * belongs to one contact: identifying someone else or resetting empties the
 * cache, and answers for the previous contact are dropped.
 */
export function createPlacementStore(
  sequenzy: Pick<
    typeof Sequenzy,
    "fetchPlacements" | "report" | "addListener"
  > &
    Partial<
      Pick<typeof Sequenzy, "identifiedEmail" | "identifiedContact">
    > = Sequenzy
) {
  const states = new Map<string, PlacementState>();
  const listeners = new Map<string, Set<Listener>>();
  // Item ids are per contact, so these never need clearing.
  const displayed = new Set<string>();
  // Dismissed this session: a fetch that raced the report must not bring the
  // item back.
  const dismissedIds = new Set<string>();
  let pending = new Set<string>();
  let scheduled = false;
  let lastFetch = 0;
  // Who the cached content belongs to; undefined until known.
  let contact: string | null | undefined;
  // Identity events wait for the first lookup, so an event for the contact
  // already signed in never empties the cache.
  let contactLookup: Promise<void> = Promise.resolve();
  // Bumped when the contact changes so a late answer for the previous one is
  // dropped.
  let generation = 0;

  const emit = (key: string) => {
    const state = states.get(key) ?? EMPTY;
    for (const listener of listeners.get(key) ?? []) listener(state);
  };

  const set = (key: string, state: PlacementState) => {
    states.set(key, state);
    emit(key);
  };

  const visible = (item: InAppMessage | null | undefined) =>
    item && !dismissedIds.has(item.id) ? item : null;

  // The newest request sent for each key: an older answer arriving later
  // (a refresh that was in flight during a dismissal) must not win.
  const latestRequest = new Map<string, number>();
  let requests = 0;

  const fetchKeys = async (keys: string[]) => {
    const started = generation;
    lastFetch = Date.now();
    for (let at = 0; at < keys.length; at += MAX_PLACEMENTS_PER_REQUEST) {
      const chunk = keys.slice(at, at + MAX_PLACEMENTS_PER_REQUEST);
      const request = ++requests;
      for (const key of chunk) latestRequest.set(key, request);
      const current = (key: string) => latestRequest.get(key) === request;
      try {
        const items = await sequenzy.fetchPlacements(chunk);
        if (started !== generation) return;
        for (const key of chunk.filter(current)) {
          set(key, { item: visible(items[key]), loading: false, error: null });
        }
      } catch (caught) {
        if (started !== generation) return;
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        // Keep what was showing; an empty slot stays collapsed.
        for (const key of chunk.filter(current)) {
          const shown = states.get(key);
          set(key, { item: shown?.item ?? null, loading: false, error });
        }
      }
    }
  };

  const schedule = (keys: Iterable<string>) => {
    for (const key of keys) pending.add(key);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = [...pending];
      pending = new Set();
      if (batch.length > 0) void fetchKeys(batch);
    });
  };

  const refreshAll = () => schedule(listeners.keys());

  // Another contact's content must never show: empty every slot (cached ones
  // too, so a placement mounted later fetches instead of reusing it).
  const forgetContent = () => {
    generation += 1;
    pending = new Set();
    states.clear();
    for (const key of listeners.keys()) {
      set(key, { item: null, loading: true, error: null });
    }
  };

  // Listening for the store's whole life: an identity change while no
  // placement is mounted must still empty the cache.
  let attached = false;
  // The contact key (external ID or email) when the SDK provides it, so users
  // identified by user ID are told apart too; the email otherwise.
  const currentContact = (): Promise<string | null | undefined> =>
    Promise.resolve(
      sequenzy.identifiedContact
        ? sequenzy.identifiedContact()
        : sequenzy.identifiedEmail?.()
    );
  const attach = () => {
    if (attached) return;
    attached = true;
    // Whoever is signed in now owns what the first fetches return.
    contactLookup = currentContact()
      .then((current) => {
        if (contact === undefined && current !== undefined) contact = current;
      })
      .catch(() => undefined);
    sequenzy.addListener((event, email) => {
      if (event === "reset") {
        contact = null;
        forgetContent();
        for (const key of listeners.keys()) {
          set(key, { item: null, loading: false, error: null });
        }
        return;
      }
      void contactLookup.then(async () => {
        const current = sequenzy.identifiedContact
          ? await currentContact().catch(() => email)
          : email;
        if (contact === undefined || (current ?? null) !== contact) {
          contact = current ?? null;
          forgetContent();
        }
        refreshAll();
      });
    });
    AppState.addEventListener("change", (state) => {
      if (
        state === "active" &&
        Date.now() - lastFetch >= FOREGROUND_REFRESH_MS
      ) {
        refreshAll();
      }
    });
  };

  return {
    get(key: string): PlacementState {
      return states.get(key) ?? EMPTY;
    },
    subscribe(key: string, listener: Listener): () => void {
      attach();
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);
      if (!states.has(key)) schedule([key]);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },
    refresh(key?: string) {
      schedule(key ? [key] : listeners.keys());
    },
    logDisplayed(item: InAppMessage) {
      if (displayed.has(item.id)) return;
      displayed.add(item.id);
      void sequenzy.report("displayed", item).catch(() => undefined);
    },
    /**
     * The dismiss was reported elsewhere: empty the slot, and ask for the next
     * item once `reported` settles. Asked sooner, the server still answers
     * with the dismissed item.
     */
    dismissed(
      item: InAppMessage,
      reported: Promise<unknown> = Promise.resolve()
    ) {
      dismissedIds.add(item.id);
      const key = item.placement;
      if (!key) return;
      if (states.get(key)?.item?.id === item.id) {
        set(key, { item: null, loading: false, error: null });
      }
      void reported.then(
        () => schedule([key]),
        () => schedule([key])
      );
    },
  };
}

export type PlacementStore = ReturnType<typeof createPlacementStore>;

let shared: PlacementStore | null = null;

export function placementStore(): PlacementStore {
  shared ??= createPlacementStore();
  return shared;
}
