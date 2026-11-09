import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";

const opened: string[] = [];
const appStateListeners: Array<(state: string) => void> = [];
const backListeners: Array<() => boolean> = [];

// react-native ships Flow sources that Bun cannot load; host components are
// plain elements here so the tests exercise the SDK's own logic.
function host(name: string) {
  return ({
    children,
    ...props
  }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement(name, props, children as ReactNode);
}

// Animations finish at once so exit callbacks run synchronously.
class AnimatedValue {
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
  }
}
const finished = {
  start: (callback?: (result: { finished: boolean }) => void) =>
    callback?.({ finished: true }),
};
const easing = (value: unknown) => value;

mock.module("react-native", () => ({
  Animated: {
    View: host("Animated.View"),
    Value: AnimatedValue,
    timing: () => finished,
    spring: () => finished,
    parallel: () => finished,
  },
  Easing: { in: easing, out: easing, cubic: easing },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
  },
  StatusBar: { currentHeight: 0 },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: host("View"),
  Text: host("Text"),
  Pressable: host("Pressable"),
  Image: host("Image"),
  ScrollView: host("ScrollView"),
  Modal: host("Modal"),
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
  },
  Platform: { OS: "ios" },
  Linking: {
    openURL: async (url: string) => {
      opened.push(url);
    },
    openSettings: async () => {
      opened.push("app-settings:");
    },
  },
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      backListeners.push(listener);
      return {
        remove: () => backListeners.splice(backListeners.indexOf(listener), 1),
      };
    },
  },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.push(listener);
      return {
        remove: () =>
          appStateListeners.splice(appStateListeners.indexOf(listener), 1),
      };
    },
  },
}));

const { act, create } = await import("react-test-renderer");
const { Sequenzy } = await import("../src/sequenzy");
const { createMemoryStorage } = await import("../src/storage");
const { SequenzyInAppHost } = await import("../src/react/SequenzyInAppHost");
const { InAppCard } = await import("../src/react/InAppCard");
const { useInAppCards } = await import("../src/react/useInAppCards");
const { SequenzyPlacement, refreshPlacements } =
  await import("../src/react/SequenzyPlacement");
const { createPlacementStore } = await import("../src/react/placementStore");
const { resolveFontFamily } = await import("../src/react/styles");
const platform = (await import("react-native")).Platform as { OS: string };

const feed = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../contract/fixtures/feed-response.json"),
    "utf8"
  )
);
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  path: string;
  body: Record<string, any>;
}

let calls: Call[] = [];
let feedMessages: unknown[] = [];
const placementFixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../contract/fixtures/placements-response.json"),
    "utf8"
  )
);
// What each placement key shows; keys not listed are empty.
let placementItems: Record<string, unknown> = {};

async function configure(
  pushPermission?: Parameters<typeof Sequenzy.configure>[0]["pushPermission"]
) {
  Sequenzy.unconfigure();
  Sequenzy.configure(
    {
      publicKey: "seq_pk_test",
      companyId: "company_1",
      appId: "com.example.app",
      platform: "ios",
      storage: createMemoryStorage(),
      logLevel: "none",
      ...(pushPermission ? { pushPermission } : {}),
    },
    {
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        calls.push({ path, body });
        if (path === "/api/v1/in-app/feed/placements") {
          const placements = (body.placements as string[]).map((key) => ({
            placement: key,
            message: placementItems[key] ?? null,
          }));
          return {
            status: 200,
            text: async () => JSON.stringify({ success: true, placements }),
          };
        }
        if (path === "/api/v1/in-app/feed") {
          // Like the API: html items only for callers that list html, push
          // primers only for callers that list the action.
          const messages = feedMessages.filter(
            (message: any) =>
              (!body.kind || message.kind === body.kind) &&
              (message.format !== "html" ||
                (body.formats ?? []).includes("html")) &&
              (body.actions?.includes("request_push_permission") ||
                !(message.buttons ?? []).some(
                  (button: any) => button.action === "request_push_permission"
                ))
          );
          return {
            status: 200,
            text: async () => JSON.stringify({ success: true, messages }),
          };
        }
        return { status: 200, text: async () => '{"success":true}' };
      },
    }
  );
  await Sequenzy.identify("jane@example.com", "seq_wid_test");
}

type Node = ReturnType<ReturnType<typeof create>["root"]["findByType"]>;
const textOf = (node: Node): string =>
  node
    .findAllByType("Text" as never)
    .flatMap((text) => [text.props.children].flat())
    .filter((child) => typeof child === "string")
    .join(" ");

const settle = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const reports = (type: string) =>
  calls
    .filter(
      (call) =>
        call.path === "/api/v1/in-app/feed/events" && call.body.type === type
    )
    .map((call) => call.body.messageId);

beforeEach(async () => {
  calls = [];
  opened.length = 0;
  feedMessages = feed.messages;
  placementItems = {
    home_hero: placementFixture.placements[0].message,
  };
  await configure();
});

afterEach(() => {
  Sequenzy.unconfigure();
});

describe("SequenzyInAppHost", () => {
  it("shows messages one at a time and reports displayed and dismissed", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();

    const modal = renderer.root.findByProps({ testID: "sequenzy-sheet" });
    expect(textOf(modal)).toContain("Your trial ends in 3 days.");
    expect(
      renderer.root
        .findAllByType("Text" as never)
        .map((node) => node.props.children)
    ).toContain("Welcome, Jane");
    expect(reports("displayed")).toEqual(["iam_modal"]);

    await act(async () => {
      renderer.root
        .findAllByProps({ testID: "sequenzy-close" })[0]!
        .props.onPress();
    });
    await settle();
    expect(reports("dismissed")).toEqual(["iam_modal"]);
    // The banner is next; cards never show as messages.
    expect(
      renderer.root.findByProps({ testID: "sequenzy-banner" })
    ).toBeDefined();
    expect(reports("displayed")).toEqual(["iam_modal", "iam_banner"]);
    expect(
      renderer.root.findAllByProps({ testID: "sequenzy-card-iam_card" })
    ).toHaveLength(0);
  });

  it("reports the click and opens the button URL", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const upgrade = renderer.root
      .findAllByType("Pressable" as never)
      .find(
        (node) =>
          node.props.accessibilityRole === "button" &&
          textOf(node).includes("Upgrade")
      );
    await act(async () => {
      upgrade!.props.onPress();
    });
    await settle();
    expect(reports("clicked")).toEqual(["iam_modal"]);
    expect(opened).toEqual(["myapp://billing"]);
  });

  it("lets the app veto messages and handle URLs itself", async () => {
    const handled: string[] = [];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <SequenzyInAppHost
          shouldShow={(message) => message.id !== "iam_modal"}
          onOpenUrl={(url) => {
            handled.push(url);
            return true;
          }}
        />
      );
    });
    await settle();
    expect(reports("displayed")).toEqual(["iam_banner"]);
    expect(
      renderer.root.findAllByProps({ testID: "sequenzy-sheet" })
    ).toHaveLength(0);
    expect(handled).toEqual([]);
  });

  it("does not show a message twice after a foreground refresh", async () => {
    await act(async () => {
      create(<SequenzyInAppHost refreshIntervalMs={0} />);
    });
    await settle();
    await act(async () => {
      for (const listener of [...appStateListeners]) listener("active");
    });
    await settle();
    expect(reports("displayed")).toEqual(["iam_modal"]);
  });

  it("clears messages on reset", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    await act(async () => {
      await Sequenzy.reset();
    });
    await settle();
    expect(renderer.toJSON()).toBeNull();
  });
});

describe("cards", () => {
  function Cards() {
    const { cards, dismiss, loading } = useInAppCards();
    if (loading) return null;
    return (
      <>
        {cards.map((card) => (
          <InAppCard key={card.id} card={card} onDismiss={dismiss} />
        ))}
      </>
    );
  }

  it("lists cards and reports a dismissal exactly once", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Cards />);
    });
    await settle();
    expect(
      renderer.root.findByProps({ testID: "sequenzy-card-iam_card" })
    ).toBeDefined();
    const dismissButton = renderer.root
      .findByProps({ testID: "sequenzy-card-iam_card" })
      .findByProps({ testID: "sequenzy-close" });
    await act(async () => {
      dismissButton.props.onPress();
    });
    await settle();
    expect(reports("dismissed")).toEqual(["iam_card"]);
    expect(
      renderer.root.findAllByProps({ testID: "sequenzy-card-iam_card" })
    ).toHaveLength(0);
  });

  it("reports each card read once even with stale copies", async () => {
    let api!: ReturnType<typeof useInAppCards>;
    function Probe() {
      api = useInAppCards();
      return null;
    }
    await act(async () => {
      create(<Probe />);
    });
    await settle();
    const stale = api.cards[0]!;
    await act(async () => {
      api.markRead(stale);
      api.markRead(stale);
    });
    await settle();
    expect(reports("read")).toEqual(["iam_card"]);
  });

  it("opens the primary button and reports the click", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <InAppCard
          card={feed.messages.find((item: any) => item.id === "iam_card")}
        />
      );
    });
    const button = renderer.root
      .findAllByType("Pressable" as never)
      .find((node) => textOf(node).includes("See details"));
    await act(async () => {
      await button!.props.onPress();
    });
    expect(reports("clicked")).toEqual(["iam_card"]);
  });
});

describe("push primers", () => {
  const primer = () =>
    feed.messages.find((item: any) => item.id === "iam_primer");

  function permissionHandler(statuses: string[]) {
    const asked: string[] = [];
    const settings: number[] = [];
    let status = statuses[0]!;
    return {
      asked,
      settings,
      handler: {
        getStatus: async () => status as any,
        request: async () => {
          asked.push(status);
          status = statuses[1] ?? status;
          return status as any;
        },
        openSettings: () => {
          settings.push(1);
        },
      },
    };
  }

  it("never shows a primer to an app that cannot ask for permission", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const feedCall = calls.find((call) => call.path === "/api/v1/in-app/feed");
    expect(feedCall?.body.actions).toBeUndefined();
    expect(reports("displayed")).not.toContain("iam_primer");
    await act(async () => renderer.unmount());
  });

  it("asks for permission from the primer and reports the result with the click", async () => {
    const { handler, asked, settings } = permissionHandler([
      "not_determined",
      "granted",
    ]);
    await configure(handler);
    feedMessages = [primer()];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const feedCall = calls.find((call) => call.path === "/api/v1/in-app/feed");
    expect(feedCall?.body.actions).toEqual(["request_push_permission"]);
    expect(reports("displayed")).toEqual(["iam_primer"]);

    const button = renderer.root
      .findAllByType("Pressable" as never)
      .find((node) => textOf(node).includes("Turn on notifications"));
    await act(async () => {
      button!.props.onPress();
    });
    await settle();
    expect(asked).toEqual(["not_determined"]);
    expect(settings).toEqual([]);
    expect(opened).toEqual([]);
    const click = calls.find(
      (call) =>
        call.path === "/api/v1/in-app/feed/events" &&
        call.body.type === "clicked"
    );
    expect(click?.body).toMatchObject({
      messageId: "iam_primer",
      pushPermission: "granted",
    });
    expect(
      renderer.root.findAllByProps({ testID: "sequenzy-sheet" })
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it("opens the app's settings by default when the handler has no opener", async () => {
    const { handler } = permissionHandler(["denied", "denied"]);
    const { openSettings: _unused, ...withoutOpener } = handler;
    await configure(withoutOpener);
    expect(await Sequenzy.requestPushPermission()).toBe("denied");
    expect(opened).toEqual(["app-settings:"]);
  });

  it("opens notification settings when the contact turned them off", async () => {
    const { handler, settings } = permissionHandler(["denied", "denied"]);
    await configure(handler);
    await Sequenzy.handleButtonPress(primer().buttons[0], primer());
    expect(settings).toEqual([1]);
    const click = calls.find(
      (call) => call.path === "/api/v1/in-app/feed/events"
    );
    expect(click?.body).toMatchObject({
      type: "clicked",
      pushPermission: "denied",
    });
  });

  it("makes the permission button primary and the dismiss button plain text", async () => {
    await configure(permissionHandler(["not_determined"]).handler);
    feedMessages = [primer()];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const labels = renderer.root
      .findAllByType("Pressable" as never)
      .map((node) => textOf(node))
      .filter((text) => text !== "");
    expect(labels.indexOf("Turn on notifications")).toBeLessThan(
      labels.indexOf("Not now")
    );
    await act(async () => renderer.unmount());
  });
});

describe("polling and fonts", () => {
  it("shows a message created while the app stays in the foreground", async () => {
    feedMessages = [];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost refreshIntervalMs={15} />);
    });
    await settle();
    expect(renderer.toJSON()).toBeNull();
    feedMessages = [feed.messages[0]];
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(
      renderer.root.findByProps({ testID: "sequenzy-sheet" })
    ).toBeDefined();
    await act(async () => renderer.unmount());
  });

  it("uses the CSS stack on web and only mapped fonts on native", () => {
    const style = feed.messages[0].style;
    expect(resolveFontFamily(style)).toBeUndefined();
    expect(resolveFontFamily(style, { Arial: "ArialMT" })).toBe("ArialMT");
    expect(
      resolveFontFamily(style, { Inter: "Inter-Regular", Arial: "ArialMT" })
    ).toBe("Inter-Regular");
    platform.OS = "web";
    try {
      expect(resolveFontFamily(style)).toBe("Inter, Arial, sans-serif");
    } finally {
      platform.OS = "ios";
    }
  });

  it("keeps the banner close button outside the tappable area", async () => {
    feedMessages = [feed.messages[1]];
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const banner = renderer.root.findByProps({ testID: "sequenzy-banner" });
    const tappable = banner
      .findAllByType("Pressable" as never)
      .filter((node) => node.props.testID !== "sequenzy-close");
    for (const node of tappable) {
      expect(node.findAllByProps({ testID: "sequenzy-close" })).toHaveLength(0);
    }
  });
});

describe("Sequenzy push helpers", () => {
  it("reports taps on Sequenzy notifications and ignores others", async () => {
    const opener: string[] = [];
    Sequenzy.setUrlOpener((url) => {
      opener.push(url);
    });
    const data = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../contract/fixtures/push-payload-fcm-data.json"
        ),
        "utf8"
      )
    );
    expect(await Sequenzy.handleNotificationResponse(data)).toBe(true);
    expect(opener).toEqual(["myapp://orders/123"]);
    expect(calls.at(-1)).toMatchObject({
      path: "/api/v1/push/events",
      body: { type: "clicked" },
    });
    expect(await Sequenzy.handleNotificationReceived(data)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ body: { type: "delivered" } });
    expect(await Sequenzy.handleNotificationResponse({ title: "Other" })).toBe(
      false
    );
  });
});

describe("modal accessibility", () => {
  it("keeps the buttons out of any pressable parent", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    const card = renderer.root.findByProps({ testID: "sequenzy-sheet" });
    let node = card.parent;
    while (node) {
      expect(node.type).not.toBe("Pressable");
      node = node.parent;
    }
  });

  it("shows the first message under StrictMode", async () => {
    const { StrictMode } = await import("react");
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <StrictMode>
          <SequenzyInAppHost />
        </StrictMode>
      );
    });
    await settle();
    expect(
      textOf(renderer.root.findByProps({ testID: "sequenzy-sheet" }))
    ).toContain("Welcome, Jane");
  });
});

describe("Sequenzy.identify", () => {
  it("reports success and only announces valid identities", async () => {
    const events: string[] = [];
    const remove = Sequenzy.addListener((event) => events.push(event));
    expect(await Sequenzy.identify("not-an-email")).toBe(false);
    expect(events).toEqual([]);
    expect(await Sequenzy.identify(" Bob@Example.com ", "seq_wid_bob")).toBe(
      true
    );
    expect(events).toEqual(["identified"]);
    remove();
  });
});

describe("message layouts", () => {
  const modal = () =>
    feed.messages.find((message: any) => message.id === "iam_modal");

  async function show(overrides: Record<string, unknown>) {
    feedMessages = [{ ...modal(), ...overrides }];
    await configure();
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    return renderer;
  }

  it("draws a centered dialog with centered text and the eyebrow", async () => {
    const renderer = await show({ position: "center", eyebrow: "3 days left" });
    const dialog = renderer.root.findByProps({ testID: "sequenzy-modal" });
    expect(textOf(dialog)).toContain("3 days left");
    const title = dialog
      .findAllByType("Text" as never)
      .find((node) => node.props.accessibilityRole === "header")!;
    expect(JSON.stringify(title.props.style)).toContain('"textAlign":"center"');
  });

  it("puts the text over the image with a background placement", async () => {
    const renderer = await show({ imagePlacement: "background" });
    const sheet = renderer.root.findByProps({ testID: "sequenzy-sheet" });
    const title = sheet
      .findAllByType("Text" as never)
      .find((node) => node.props.accessibilityRole === "header")!;
    expect(JSON.stringify(title.props.style)).toContain('"color":"#ffffff"');
    expect(JSON.stringify(sheet.props.style)).toContain('"minHeight":460');
  });

  it("drops a failed top image instead of leaving a gap", async () => {
    const renderer = await show({ imagePlacement: "top" });
    const image = () => renderer.root.findAllByType("Image" as never).length;
    expect(image()).toBe(1);
    await act(async () => {
      renderer.root.findByType("Image" as never).props.onError();
    });
    expect(image()).toBe(0);
  });

  it("scrolls long copy inside a height-capped panel", async () => {
    const renderer = await show({ position: "center" });
    const dialog = renderer.root.findByProps({ testID: "sequenzy-modal" });
    expect(JSON.stringify(dialog.props.style)).toContain('"maxHeight":');
    const scroll = dialog.findByProps({ testID: "sequenzy-modal-scroll" });
    expect(textOf(scroll)).toContain("Welcome, Jane");
    // The close button sits outside the scrolling content.
    expect(scroll.findAllByProps({ testID: "sequenzy-close" }).length).toBe(0);
  });

  it("runs Android back through the exit animation once", async () => {
    const renderer = await show({ imagePlacement: "top" });
    const modal = renderer.root.findByType("Modal" as never);
    await act(async () => {
      modal.props.onRequestClose();
      modal.props.onRequestClose();
    });
    await settle();
    expect(reports("dismissed")).toEqual(["iam_modal"]);
  });

  it("makes the link button primary and the dismiss button plain text", async () => {
    const renderer = await show({ imagePlacement: "top" });
    const sheet = renderer.root.findByProps({ testID: "sequenzy-sheet" });
    const [primary, secondary] = sheet
      .findAllByType("Pressable" as never)
      .filter(
        (node) =>
          node.props.accessibilityRole === "button" &&
          node.props.testID !== "sequenzy-close"
      );
    const style = (node: Node) =>
      JSON.stringify(
        typeof node.props.style === "function"
          ? node.props.style({ pressed: false })
          : node.props.style
      );
    expect(style(primary!)).toContain('"backgroundColor":"#4f46e5"');
    expect(style(secondary!)).not.toContain("backgroundColor");
    await act(async () => {
      secondary!.props.onPress();
    });
    await settle();
    expect(reports("dismissed")).toEqual(["iam_modal"]);
  });
});

describe("custom HTML messages", () => {
  const htmlFeed = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../contract/fixtures/feed-response-html.json"),
      "utf8"
    )
  );
  const FakeWebView = host("WebView");
  const webViewOf = (renderer: ReturnType<typeof create>) =>
    renderer.root.findByType("WebView" as never);
  const overlayOf = (renderer: ReturnType<typeof create>) =>
    renderer.root.findAll(
      (node) => node.type === "View" && "accessibilityViewIsModal" in node.props
    )[0]!;

  beforeEach(() => {
    feedMessages = [...htmlFeed.messages, ...feed.messages];
    backListeners.length = 0;
  });

  it("stays in the feed when the app passes no WebView", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost />);
    });
    await settle();
    expect(renderer.root.findAllByType("WebView" as never)).toHaveLength(0);
    const feedCall = calls.find((call) => call.path === "/api/v1/in-app/feed");
    expect(feedCall?.body["formats"]).toBeUndefined();
    expect(reports("displayed")).toEqual(["iam_modal"]);
  });

  it("loads the document sandboxed and reports displayed only once loaded", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost webView={FakeWebView} />);
    });
    await settle();
    const feedCall = calls.find((call) => call.path === "/api/v1/in-app/feed");
    expect(feedCall?.body["formats"]).toEqual([
      "modal",
      "banner",
      "fullscreen",
      "html",
    ]);
    const web = webViewOf(renderer);
    expect(web.props.source).toEqual({
      html: htmlFeed.messages[0].html,
      baseUrl: "https://in-app.sequenzy.com/",
    });
    expect(web.props).toMatchObject({
      incognito: true,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      allowFileAccess: false,
      setSupportMultipleWindows: false,
      originWhitelist: ["*"],
    });
    // Touches reach the app while it loads; nothing is reported yet.
    expect(overlayOf(renderer).props.pointerEvents).toBe("none");
    expect(reports("displayed")).toEqual([]);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "Close" })
    ).toHaveLength(0);

    await act(async () => web.props.onLoadEnd());
    await settle();
    expect(reports("displayed")).toEqual(["iam_html"]);
    expect(overlayOf(renderer).props.pointerEvents).toBe("auto");
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "Close" }).length
    ).toBeGreaterThan(0);

    // The document's own load and embedded frames are allowed; other
    // main-frame navigations open through the app instead.
    const decide = webViewOf(renderer).props.onShouldStartLoadWithRequest;
    expect(
      decide({ url: "https://in-app.sequenzy.com/", isTopFrame: true })
    ).toBe(true);
    expect(
      decide({ url: "https://player.example.com/embed", isTopFrame: false })
    ).toBe(true);
    expect(decide({ url: "javascript:alert(1)", isTopFrame: true })).toBe(
      false
    );
    // Hash routing inside the document stays inside it.
    expect(
      decide({ url: "https://in-app.sequenzy.com/#step-2", isTopFrame: true })
    ).toBe(true);
    // Android does not say which frame asked: https loads stay (an embedded
    // frame must not close the message), app links still go to the app.
    expect(decide({ url: "https://player.example.com/embed" })).toBe(true);
    expect(opened).toEqual([]);
  });

  it("runs bridge calls for the contact and closes on openUrl", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost webView={FakeWebView} />);
    });
    await settle();
    await act(async () => webViewOf(renderer).props.onLoadEnd());
    const post = async (message: unknown) =>
      act(async () =>
        webViewOf(renderer).props.onMessage({
          nativeEvent: { data: JSON.stringify(message) },
        })
      );
    await post({
      __sequenzyInApp: 1,
      method: "logClick",
      args: { buttonId: "q1" },
    });
    await post({
      __sequenzyInApp: 1,
      method: "setAttributes",
      args: { attributes: { nps_score: 10 } },
    });
    await post({
      __sequenzyInApp: 1,
      method: "track",
      args: { name: "nps", properties: { score: 10 } },
    });
    await post({ __sequenzyInApp: 1, method: "eval", args: {} });
    await act(async () => Sequenzy.flush());
    await settle();
    const clicks = calls.filter(
      (call) =>
        call.path === "/api/v1/in-app/feed/events" &&
        call.body.type === "clicked"
    );
    expect(clicks.map((call) => call.body["buttonId"])).toEqual(["q1"]);
    expect(
      calls.find((call) => call.path === "/api/v1/app-attributes")?.body[
        "attributes"
      ]
    ).toEqual({ nps_score: 10 });
    expect(
      calls
        .filter((call) => call.path === "/api/v1/app-events")
        .flatMap((call) => call.body["events"])
        .map((event: { name: string }) => event.name)
    ).toContain("nps");

    await post({
      __sequenzyInApp: 1,
      method: "openUrl",
      args: { url: "myapp://plans", buttonId: "upgrade" },
    });
    await settle();
    expect(opened).toEqual(["myapp://plans"]);
    expect(reports("clicked")).toEqual(["iam_html", "iam_html"]);
    // The next message (the native modal) takes its place.
    expect(renderer.root.findAllByType("WebView" as never)).toHaveLength(0);
    expect(reports("displayed")).toEqual(["iam_html", "iam_modal"]);
  });

  it("drops the previous contact's document and its bridge calls after identify", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost webView={FakeWebView} />);
    });
    await settle();
    const stale = webViewOf(renderer);
    await act(async () => stale.props.onLoadEnd());
    await settle();
    const postFromStale = stale.props.onMessage;
    feedMessages = [];
    await act(async () => {
      await Sequenzy.identify("bob@example.com", "seq_wid_bob");
    });
    await settle();
    expect(renderer.root.findAllByType("WebView" as never)).toHaveLength(0);
    // A call already on its way from Jane's survey is not sent as Bob.
    await act(async () =>
      postFromStale({
        nativeEvent: {
          data: JSON.stringify({
            __sequenzyInApp: 1,
            method: "setAttributes",
            args: { attributes: { nps_score: 2 } },
          }),
        },
      })
    );
    await act(async () => Sequenzy.flush());
    await settle();
    expect(
      calls.filter((call) => call.path === "/api/v1/app-attributes")
    ).toEqual([]);
    expect(reports("dismissed")).toEqual([]);
  });

  it("closes with the close button, Android back and the bridge, reporting dismissed", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost webView={FakeWebView} />);
    });
    await settle();
    // Back does nothing until the document is on screen.
    expect(backListeners.map((listener) => listener())).toEqual([false]);
    await act(async () => webViewOf(renderer).props.onLoadEnd());
    await act(async () => {
      expect(backListeners[0]!()).toBe(true);
    });
    await settle();
    expect(reports("dismissed")).toEqual(["iam_html"]);
  });

  it("drops a document that never loads without reporting it", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyInAppHost webView={FakeWebView} />);
    });
    await settle();
    await act(async () => webViewOf(renderer).props.onError());
    await settle();
    expect(reports("displayed")).toEqual(["iam_modal"]);
    expect(reports("dismissed")).toEqual([]);
  });
});

describe("SequenzyPlacement", () => {
  it("draws the slot's item inline, collapses empty slots and batches the fetch", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <>
          <SequenzyPlacement placementId="home_hero" />
          <SequenzyPlacement placementId="checkout_upsell" />
        </>
      );
    });
    await settle();

    const placementCalls = calls.filter(
      (call) => call.path === "/api/v1/in-app/feed/placements"
    );
    expect(placementCalls).toHaveLength(1);
    expect(placementCalls[0]!.body.placements).toEqual([
      "home_hero",
      "checkout_upsell",
    ]);
    const slot = renderer.root.findByProps({
      testID: "sequenzy-placement-home_hero",
    });
    expect(textOf(slot)).toContain("Upgrade to Pro, Jane");
    // No unread dot or close control on placement items.
    expect(slot.findAllByProps({ accessibilityLabel: "Unread" })).toHaveLength(
      0
    );
    expect(slot.findAllByProps({ accessibilityLabel: "Close" })).toHaveLength(
      0
    );
    expect(
      renderer.root.findAllByProps({
        testID: "sequenzy-placement-checkout_upsell",
      })
    ).toHaveLength(0);
    expect(reports("displayed")).toEqual(["iam_placement"]);
  });

  it("draws banner and hero layouts with a filled primary button", async () => {
    const flat = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? Object.assign({}, ...style.map(flat))
        : typeof style === "function"
          ? flat(style({ pressed: false }))
          : ((style ?? {}) as Record<string, unknown>);
    const fixture = placementFixture.placements[0].message;
    for (const layout of ["banner", "hero"] as const) {
      placementItems = {
        home_hero: { ...fixture, id: `iam_${layout}`, layout },
      };
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(<SequenzyPlacement placementId="home_hero" />);
      });
      // The shared store still holds the previous test's item.
      await act(async () => refreshPlacements());
      await settle();
      const item = renderer.root.findByProps({
        testID: `sequenzy-placement-item-iam_${layout}`,
      });
      const [primary] = item
        .findAllByType("Pressable" as never)
        .filter((node) => node.props.accessibilityRole === "button");
      expect(flat(primary!.props.style).backgroundColor).toBe(
        fixture.style.buttonColor
      );
      expect(flat(primary!.props.style).height).toBe(36);
      const title = item
        .findAllByType("Text" as never)
        .find((node) => node.props.children === fixture.title);
      // A hero draws its text over the image in white.
      expect(flat(title!.props.style).color).toBe(
        layout === "hero" ? "#ffffff" : fixture.style.textColor
      );
      // Leave the shared store as the other tests expect it.
      placementItems = { home_hero: fixture };
      await act(async () => refreshPlacements());
      await settle();
      act(() => renderer.unmount());
    }
  });

  it("opens links, and on dismiss shows the next item", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<SequenzyPlacement placementId="home_hero" />);
    });
    await settle();
    const buttons = () =>
      renderer.root
        .findAllByType("Pressable" as never)
        .filter((node) => node.props.accessibilityRole === "button");

    await act(async () => buttons()[0]!.props.onPress());
    await settle();
    expect(reports("clicked")).toEqual(["iam_placement"]);
    expect(opened).toEqual(["myapp://billing"]);

    placementItems = {
      home_hero: {
        ...placementFixture.placements[0].message,
        id: "iam_next",
        title: "Next up",
        buttons: [],
      },
    };
    await act(async () => buttons()[1]!.props.onPress());
    await settle();
    expect(reports("dismissed")).toEqual(["iam_placement"]);
    expect(
      textOf(
        renderer.root.findByProps({ testID: "sequenzy-placement-home_hero" })
      )
    ).toContain("Next up");
  });

  it("empties slots on reset and drops answers for the previous contact", async () => {
    const listeners: Array<
      (event: "identified" | "reset", email?: string) => void
    > = [];
    const resolvers: Array<(items: Record<string, unknown>) => void> = [];
    const store = createPlacementStore({
      fetchPlacements: () =>
        new Promise((done) => {
          resolvers.push(done as (items: Record<string, unknown>) => void);
        }) as never,
      report: async () => true,
      addListener: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    });
    const seen: unknown[] = [];
    const stop = store.subscribe("home_hero", (state) => seen.push(state.item));
    await settle();
    listeners.forEach((listener) => listener("reset"));
    resolvers[0]?.({ home_hero: placementFixture.placements[0].message });
    await settle();
    expect(seen.every((item) => item === null)).toBe(true);
    expect(store.get("home_hero").item).toBeNull();

    // A different contact identifies while nothing is mounted: the cached
    // slot is forgotten, so mounting again fetches for the new contact.
    stop();
    listeners.forEach((listener) => listener("identified", "ben@example.com"));
    await settle();
    store.subscribe("home_hero", () => undefined);
    await settle();
    expect(resolvers.length).toBe(2);
  });

  it("does not refetch from scratch or re-report when the same contact identifies again", async () => {
    const listeners: Array<
      (event: "identified" | "reset", email?: string) => void
    > = [];
    const item = placementFixture.placements[0].message;
    const reported: string[] = [];
    const store = createPlacementStore({
      fetchPlacements: async () => ({ home_hero: item }) as never,
      report: async (type) => {
        reported.push(type);
        return true;
      },
      addListener: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      // Jane identified at launch, before any placement mounted.
      identifiedEmail: async () => "jane@example.com",
    });
    const seen: unknown[] = [];
    store.subscribe("home_hero", (state) => seen.push(state.item));
    await settle();
    store.logDisplayed(item);
    listeners.forEach((listener) => listener("identified", "jane@example.com"));
    await settle();
    store.logDisplayed(item);
    expect(seen.filter((entry) => entry === null)).toHaveLength(0);
    expect(reported).toEqual(["displayed"]);
  });

  it("keeps a dismissed item hidden when a racing fetch returns it", async () => {
    const item = placementFixture.placements[0].message;
    const store = createPlacementStore({
      fetchPlacements: async () => ({ home_hero: item }) as never,
      report: async () => true,
      addListener: () => () => undefined,
    });
    store.subscribe("home_hero", () => undefined);
    await settle();
    expect(store.get("home_hero").item?.id).toBe("iam_placement");
    store.dismissed(item);
    await settle();
    expect(store.get("home_hero").item).toBeNull();
  });

  it("asks for the next item only after the dismissal is recorded", async () => {
    const item = placementFixture.placements[0].message;
    let fetches = 0;
    const store = createPlacementStore({
      fetchPlacements: async () => {
        fetches += 1;
        return { home_hero: { ...item, id: `iam_${fetches}` } } as never;
      },
      report: async () => true,
      addListener: () => () => undefined,
    });
    store.subscribe("home_hero", () => undefined);
    await settle();
    const shown = store.get("home_hero").item!;
    let record: () => void = () => undefined;
    store.dismissed(shown, new Promise<void>((resolve) => (record = resolve)));
    await settle();
    // No refetch while the server may still serve the dismissed item.
    expect(fetches).toBe(1);
    record();
    await settle();
    expect(fetches).toBe(2);
    expect(store.get("home_hero").item?.id).toBe("iam_2");
  });

  it("ignores an older answer that arrives after a newer one", async () => {
    const item = placementFixture.placements[0].message;
    let fetches = 0;
    let answerStale: () => void = () => undefined;
    const store = createPlacementStore({
      fetchPlacements: async () => {
        fetches += 1;
        if (fetches === 2) {
          await new Promise<void>((resolve) => (answerStale = resolve));
          return { home_hero: item } as never;
        }
        return { home_hero: { ...item, id: `iam_${fetches}` } } as never;
      },
      report: async () => true,
      addListener: () => () => undefined,
    });
    store.subscribe("home_hero", () => undefined);
    await settle();
    // A refresh is in flight with the old winner when the contact dismisses.
    store.refresh("home_hero");
    await settle();
    store.dismissed(store.get("home_hero").item!);
    await settle();
    expect(store.get("home_hero").item?.id).toBe("iam_3");
    answerStale();
    await settle();
    expect(store.get("home_hero").item?.id).toBe("iam_3");
  });

  it("resets failed-image state when a refreshed item replaces the slot", async () => {
    const fixture = placementFixture.placements[0].message;
    for (const layout of ["card", "banner", "hero"] as const) {
      placementItems = {
        home_hero: { ...fixture, id: `failed_${layout}`, layout },
      };
      let renderer!: ReturnType<typeof create>;
      await act(async () => {
        renderer = create(<SequenzyPlacement placementId="home_hero" />);
      });
      await act(async () => refreshPlacements());
      await settle();
      await act(async () => {
        renderer.root.findByType("Image" as never).props.onError();
      });
      expect(renderer.root.findAllByType("Image" as never)).toHaveLength(0);
      placementItems = {
        home_hero: { ...fixture, id: `replacement_${layout}`, layout },
      };
      await act(async () => refreshPlacements());
      await settle();
      expect(renderer.root.findAllByType("Image" as never)).toHaveLength(1);
      act(() => renderer.unmount());
    }
    placementItems = { home_hero: fixture };
    await act(async () => refreshPlacements());
    await settle();
  });
});
