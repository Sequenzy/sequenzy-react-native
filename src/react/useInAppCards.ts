import { useCallback, useEffect, useRef, useState } from "react";

import { Sequenzy } from "../sequenzy";
import type { InAppMessage } from "../types";

export interface UseInAppCardsResult {
  cards: InAppMessage[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Marks a card read (e.g. when it scrolls into view). */
  markRead: (card: InAppMessage) => void;
  /** Reports a dismissal and removes the card from the list. */
  dismiss: (card: InAppMessage) => void;
}

/** The identified contact's content cards, refreshed after identify and reset. */
export function useInAppCards(
  options: { limit?: number } = {}
): UseInAppCardsResult {
  const [cards, setCards] = useState<InAppMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const readReported = useRef(new Set<string>());
  const { limit } = options;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCards(await Sequenzy.fetchCards(limit));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
    return Sequenzy.addListener((event) => {
      if (event === "identified") void refresh();
      if (event === "reset") setCards([]);
    });
  }, [refresh]);

  // Safe to call again with a stale copy of the card: each card is reported once.
  const markRead = useCallback((card: InAppMessage) => {
    if (card.readAt || readReported.current.has(card.id)) return;
    readReported.current.add(card.id);
    void Sequenzy.report("read", card);
    setCards((current) =>
      current.map((item) =>
        item.id === card.id
          ? { ...item, readAt: new Date().toISOString() }
          : item
      )
    );
  }, []);

  const dismiss = useCallback((card: InAppMessage) => {
    void Sequenzy.report("dismissed", card);
    setCards((current) => current.filter((item) => item.id !== card.id));
  }, []);

  return { cards, loading, error, refresh, markRead, dismiss };
}
