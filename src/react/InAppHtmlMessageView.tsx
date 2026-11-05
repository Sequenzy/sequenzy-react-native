import { useEffect, useRef, useState, type ComponentType } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";

import {
  IN_APP_HTML_BASE_URL,
  IN_APP_HTML_MAX_CALLS_PER_DISPLAY,
  isAllowedInAppUrl,
  parseInAppHtmlBridgeMessage,
  type InAppHtmlBridgeMessage,
} from "../html";
import type { InAppMessage } from "../types";

// The shape of react-native-webview's WebView this view uses. The app passes
// the component in, so the SDK never depends on the native module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebViewComponent = ComponentType<any>;

export type InAppHtmlOutcome =
  /** Closed by the document, the close button or Android back. */
  | { kind: "dismissed" }
  /** The document asked to open a link; already reported as a click. */
  | { kind: "opened"; url: string; buttonId?: string }
  /** Never finished loading; not reported, so it shows again later. */
  | { kind: "failed" };

export interface InAppHtmlMessageViewProps {
  message: InAppMessage;
  /** `WebView` from react-native-webview. */
  webView: WebViewComponent;
  /** The document loaded and is visible: report it displayed. */
  onLoaded: () => void;
  /** A bridge call the app handles (click, event, attributes). */
  onBridge: (call: InAppHtmlBridgeMessage) => void;
  onFinish: (outcome: InAppHtmlOutcome) => void;
  /** Status bar inset for the close button. */
  topInset?: number;
}

const LOAD_TIMEOUT_MS = 10_000;

/**
 * Whether the WebView may follow a navigation itself: the document, its own
 * #fragments and embedded frames load; other main-frame navigations open
 * through the app. Where the platform doesn't say whether a request is for
 * the main frame (`isTopFrame` missing), https loads are let through so an
 * embedded frame never closes the message; the bridge already routes the
 * document's link taps through the app.
 */
export function shouldLoadInAppHtmlRequest(request: {
  url: string;
  isTopFrame?: boolean;
}): boolean {
  if (request.isTopFrame === false) return true;
  const withoutFragment = request.url.split("#")[0];
  if (
    withoutFragment === IN_APP_HTML_BASE_URL ||
    request.url.startsWith("about:")
  ) {
    return true;
  }
  return request.isTopFrame === undefined && /^https:/i.test(request.url);
}

/**
 * Shows a custom HTML in-app message over the whole screen in a transparent
 * WebView. The document arrives with the Sequenzy JS bridge already in it.
 *
 * Isolation: incognito (no shared cookies, storage or cache with the app's
 * other web views, nothing kept afterwards), no file access, no third-party
 * cookies, no popups; main-frame navigations away from the document are
 * cancelled and go through the app's URL handler. Until the document has
 * loaded the view ignores touches, so a slow document never blocks the app.
 */
export function InAppHtmlMessageView({
  message,
  webView: WebView,
  onLoaded,
  onBridge,
  onFinish,
  topInset = 0,
}: InAppHtmlMessageViewProps) {
  const [loaded, setLoaded] = useState(false);
  const state = useRef({ loaded: false, finished: false, calls: 0 });
  const callbacks = useRef({ onLoaded, onBridge, onFinish });
  callbacks.current = { onLoaded, onBridge, onFinish };

  const finish = (outcome: InAppHtmlOutcome) => {
    if (state.current.finished) return;
    state.current.finished = true;
    callbacks.current.onFinish(outcome);
  };

  const open = (url: string, buttonId?: string) => {
    if (!isAllowedInAppUrl(url)) {
      console.warn(`[Sequenzy] In-app message link blocked: ${url}`);
      return;
    }
    finish({ kind: "opened", url, ...(buttonId ? { buttonId } : {}) });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!state.current.loaded) finish({ kind: "failed" });
    }, LOAD_TIMEOUT_MS);
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!state.current.loaded) return false;
      finish({ kind: "dismissed" });
      return true;
    });
    return () => {
      clearTimeout(timer);
      back.remove();
    };
  }, []);

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    if (state.current.finished) return;
    const call = parseInAppHtmlBridgeMessage(event.nativeEvent.data);
    if (!call) return;
    state.current.calls += 1;
    if (state.current.calls > IN_APP_HTML_MAX_CALLS_PER_DISPLAY) return;
    if (call.method === "close") finish({ kind: "dismissed" });
    else if (call.method === "openUrl") open(call.url, call.buttonId);
    else callbacks.current.onBridge(call);
  };

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={loaded ? "auto" : "none"}
      accessibilityViewIsModal={loaded}
    >
      <WebView
        source={{ html: message.html ?? "", baseUrl: IN_APP_HTML_BASE_URL }}
        // Every navigation goes through onShouldStartLoadWithRequest: URLs
        // outside the whitelist would be handed to Linking unchecked.
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        geolocationEnabled={false}
        mixedContentMode="never"
        allowsInlineMediaPlayback
        accessibilityLabel={message.title || "Message"}
        style={[styles.web, !loaded && styles.hidden]}
        containerStyle={styles.web}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={(request: {
          url: string;
          isTopFrame?: boolean;
        }) => {
          if (shouldLoadInAppHtmlRequest(request)) return true;
          open(request.url);
          return false;
        }}
        onLoadEnd={() => {
          if (state.current.loaded || state.current.finished) return;
          state.current.loaded = true;
          setLoaded(true);
          callbacks.current.onLoaded();
        }}
        onError={() => {
          if (!state.current.loaded) finish({ kind: "failed" });
        }}
        onContentProcessDidTerminate={() =>
          finish(
            state.current.loaded ? { kind: "dismissed" } : { kind: "failed" }
          )
        }
        onRenderProcessGone={() =>
          finish(
            state.current.loaded ? { kind: "dismissed" } : { kind: "failed" }
          )
        }
      />
      {message.showCloseButton && loaded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          onPress={() => finish({ kind: "dismissed" })}
          style={[styles.close, { top: topInset + 12 }]}
        >
          <Text style={styles.closeText}>{"×"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
  hidden: { opacity: 0 },
  close: {
    position: "absolute",
    right: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: "#ffffff", fontSize: 24, lineHeight: 28 },
});
