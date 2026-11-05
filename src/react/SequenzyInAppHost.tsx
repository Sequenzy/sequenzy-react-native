import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";

import { Sequenzy } from "../sequenzy";
import type { InAppButton, InAppMessage } from "../types";

import {
  InAppHtmlMessageView,
  type WebViewComponent,
} from "./InAppHtmlMessageView";
import { InAppMessageView } from "./InAppMessageView";

export interface SequenzyInAppHostProps {
  /** Return false to keep a message from showing now; it is offered again later. */
  shouldShow?: (message: InAppMessage) => boolean;
  /** Return true when the app handled the URL itself. */
  onOpenUrl?: (url: string, message: InAppMessage | null) => boolean | void;
  /** How often the feed is fetched while the app is in the foreground. */
  refreshIntervalMs?: number;
  /** Maps brand font families to fonts the app bundles, e.g. `{ Inter: "Inter-Regular" }`. */
  fonts?: Record<string, string>;
  /**
   * Status bar and home indicator insets. Read from
   * react-native-safe-area-context when the app uses it.
   */
  insets?: { top?: number; bottom?: number };
  /**
   * `WebView` from react-native-webview. Pass it to show custom HTML in-app
   * messages (surveys, Braze-style custom HTML); without it they stay in the
   * feed for an app version that can show them.
   */
  webView?: WebViewComponent;
}

/**
 * Fetches the identified contact's in-app messages when the app comes to the
 * foreground and after identify, and shows them one at a time. Render it
 * once, at the root of the app, above your navigation.
 */
export function SequenzyInAppHost({
  shouldShow,
  onOpenUrl,
  refreshIntervalMs = 60_000,
  fonts,
  insets,
  webView,
}: SequenzyInAppHostProps) {
  const showsHtml = webView !== undefined;
  const [current, setCurrent] = useState<InAppMessage | null>(null);
  const queue = useRef<InAppMessage[]>([]);
  const shown = useRef(new Set<string>());
  const lastFetch = useRef(0);
  const callbacks = useRef({ shouldShow, onOpenUrl });
  callbacks.current = { shouldShow, onOpenUrl };

  // Mirrors `current` so showNext can decide synchronously: state updaters
  // must stay pure (StrictMode runs them twice), so the queue is never
  // touched inside one.
  const visible = useRef<InAppMessage | null>(null);
  // The contact the queued and visible messages were fetched for.
  const owner = useRef<string | null>(null);

  const clearMessages = useCallback(() => {
    queue.current = [];
    shown.current.clear();
    visible.current = null;
    setCurrent(null);
  }, []);

  const showNext = useCallback(() => {
    if (visible.current) return;
    for (let next = queue.current.shift(); next; next = queue.current.shift()) {
      if (callbacks.current.shouldShow?.(next) === false) continue;
      shown.current.add(next.id);
      visible.current = next;
      setCurrent(next);
      return;
    }
  }, []);

  const refresh = useCallback(
    async (force: boolean) => {
      const client = Sequenzy.client;
      if (!client) return;
      const now = Date.now();
      // 90%: a poll firing on the interval must not lose a cycle to a fetch
      // that ran a moment after it was scheduled.
      if (!force && now - lastFetch.current < refreshIntervalMs * 0.9) return;
      lastFetch.current = now;
      // Another contact signed in: the previous one's messages go.
      const email = await client.getEmail();
      if (email !== owner.current) {
        clearMessages();
        owner.current = email;
      }
      const messages = await Sequenzy.fetchMessages({
        includeHtml: showsHtml,
      }).catch(() => null);
      if (!messages || (await client.getEmail()) !== email) return;
      for (const message of messages) {
        if (message.kind !== "message" || shown.current.has(message.id))
          continue;
        if (message.format === "html" && (!showsHtml || !message.html))
          continue;
        if (queue.current.some((queued) => queued.id === message.id)) continue;
        queue.current.push(message);
      }
      showNext();
    },
    [clearMessages, refreshIntervalMs, showNext, showsHtml]
  );

  useEffect(() => {
    Sequenzy.setUrlOpener((url) => {
      if (callbacks.current.onOpenUrl?.(url, null) === true) return;
      return Linking.openURL(url).catch(() => undefined);
    });
    void refresh(true);
    // Poll while in the foreground so a message created by something the
    // user just did (a tracked event starting a sequence) shows up without
    // leaving the app.
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (poll === null && refreshIntervalMs > 0) {
        poll = setInterval(() => void refresh(false), refreshIntervalMs);
      }
    };
    const stopPolling = () => {
      if (poll !== null) clearInterval(poll);
      poll = null;
    };
    if (AppState.currentState !== "background") startPolling();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void Sequenzy.client?.flush();
        void Sequenzy.client?.registerPushIfNeeded();
        void refresh(false);
        startPolling();
      } else {
        stopPolling();
      }
    });
    const removeListener = Sequenzy.addListener((event) => {
      if (event === "identified") void refresh(true);
      if (event === "reset") {
        clearMessages();
        owner.current = null;
      }
    });
    return () => {
      stopPolling();
      appState.remove();
      removeListener();
    };
  }, [clearMessages, refresh, refreshIntervalMs]);

  useEffect(() => {
    // Custom HTML reports displayed once its document has loaded.
    if (current && current.format !== "html") {
      void Sequenzy.report("displayed", current);
    }
  }, [current]);

  if (!current) return null;

  const close = () => {
    visible.current = null;
    setCurrent(null);
    showNext();
  };

  const openUrl = (url: string, message: InAppMessage) => {
    if (callbacks.current.onOpenUrl?.(url, message) !== true) {
      void Linking.openURL(url).catch(() => undefined);
    }
  };

  if (current.format === "html" && webView) {
    const message = current;
    const messageOwner = owner.current;
    // The document acts for the contact it was fetched for: after identify
    // as someone else its calls are dropped and it closes, unreported.
    const forOwner = (action: () => void) => {
      void (async () => {
        if ((await Sequenzy.client?.getEmail()) !== messageOwner) {
          if (visible.current?.id === message.id) close();
          return;
        }
        action();
      })();
    };
    return (
      <InAppHtmlMessageView
        key={message.id}
        message={message}
        webView={webView}
        topInset={insets?.top ?? 0}
        onLoaded={() =>
          forOwner(() => void Sequenzy.report("displayed", message))
        }
        onBridge={(call) =>
          forOwner(() => {
            if (call.method === "logClick") {
              void Sequenzy.report("clicked", message, call.buttonId);
            } else if (call.method === "track") {
              void Sequenzy.track(call.name, call.properties);
            } else if (call.method === "setAttributes") {
              void Sequenzy.setProfile({ attributes: call.attributes });
            } else if (call.method === "setName") {
              void Sequenzy.setProfile({
                ...(call.firstName ? { firstName: call.firstName } : {}),
                ...(call.lastName ? { lastName: call.lastName } : {}),
              });
            }
          })
        }
        onFinish={(outcome) =>
          forOwner(() => {
            if (outcome.kind === "dismissed") {
              void Sequenzy.report("dismissed", message);
            } else if (outcome.kind === "opened") {
              void Sequenzy.report("clicked", message, outcome.buttonId);
              openUrl(outcome.url, message);
            }
            close();
          })
        }
      />
    );
  }

  return (
    <InAppMessageView
      key={current.id}
      message={current}
      fonts={fonts}
      {...(insets ? { insets } : {})}
      onDismiss={() => {
        void Sequenzy.report("dismissed", current);
        close();
      }}
      onPress={(button: InAppButton | null) => {
        void Sequenzy.report("clicked", current);
        const url =
          button?.url ??
          current.buttons.find((candidate) => candidate.action === "open_url")
            ?.url ??
          null;
        if (url) openUrl(url, current);
        close();
      }}
    />
  );
}
