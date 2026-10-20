import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";

const opened: string[] = [];
const appStateListeners: Array<(state: string) => void> = [];

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

async function configure() {
  Sequenzy.unconfigure();
  Sequenzy.configure(
    {
      publicKey: "seq_pk_test",
      companyId: "company_1",
      appId: "com.example.app",
      platform: "ios",
      storage: createMemoryStorage(),
      logLevel: "none",
    },
    {
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        calls.push({ path, body });
        if (path === "/api/v1/in-app/feed") {
          const messages = feedMessages.filter(
            (message: any) => !body.kind || message.kind === body.kind
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
      renderer = create(<InAppCard card={feed.messages[2]} />);
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
