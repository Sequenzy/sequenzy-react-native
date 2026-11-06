import { beforeEach, describe, expect, it, mock } from "bun:test";

// The package entry imports React Native and Expo; tests use the factory.
mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
}));
mock.module("expo-modules-core", () => ({ requireNativeModule: () => ({}) }));
mock.module("@sequenzy/react-native", async () => {
  const client = await import("../../src/client");
  return {
    SDK_VERSION: client.SDK_VERSION,
    Sequenzy: { client: null, addListener: () => () => undefined },
  };
});

const { SequenzyClient, SDK_VERSION } = await import("../../src/client");
const { createMemoryStorage } = await import("../../src/storage");
const { createSequenzyGeofences, identityTokenExpiry } =
  await import("../src/index");

type Call = [string, ...unknown[]];

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_792_000_000_000;

function token(expiresAt: number): string {
  const claims = btoa(
    JSON.stringify({
      companyId: "company_1",
      email: "jane@example.com",
      expiresAt,
    })
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `seq_wid_${claims}.signature`;
}

function setup() {
  const calls: Call[] = [];
  const listeners = {
    identity: [] as Array<() => void>,
    foreground: [] as Array<() => void>,
    rejected: [] as Array<() => void>,
  };
  let providerCalls = 0;
  const client = new SequenzyClient(
    {
      publicKey: "seq_pk_test",
      companyId: "company_1",
      appId: "com.example.app",
      platform: "ios",
      apiBaseUrl: "https://api.example.com",
      storage: createMemoryStorage(),
      logLevel: "none",
      identityTokenProvider: async () =>
        token(NOW + (30 + ++providerCalls) * DAY),
    },
    {
      fetch: async () => ({
        status: 200,
        text: async () => '{"success":true}',
      }),
      now: () => NOW,
    }
  );
  const record =
    (name: string, value?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value;
    };
  const native = {
    configure: record("configure"),
    setIdentity: async (email: string | null, token: string | null) => {
      calls.push(["setIdentity", email, token]);
      return token === "seq_wid_rejected.token";
    },
    authorization: record("authorization", "whenInUse"),
    requestAuthorization: record("requestAuthorization", "always"),
    enable: record("enable"),
    disable: record("disable"),
    refresh: record("refresh"),
    resume: record("resume"),
    status: record("status", {
      enabled: true,
      authorization: "always",
      preciseLocation: true,
      regionIds: ["geo_1", "sequenzy.refresh", 7],
      queuedEvents: 2,
      maxRegions: 20,
    }),
    addListener: (_event: "identityRejected", listener: () => void) => {
      listeners.rejected.push(listener);
      return {
        remove: () =>
          listeners.rejected.splice(listeners.rejected.indexOf(listener), 1),
      };
    },
  };
  let current: InstanceType<typeof SequenzyClient> | null = client;
  const geofences = createSequenzyGeofences({
    native: () => native as never,
    client: () => current,
    onIdentityChange: (listener) => {
      listeners.identity.push(listener);
      return () =>
        listeners.identity.splice(listeners.identity.indexOf(listener), 1);
    },
    onForeground: (listener) => {
      listeners.foreground.push(listener);
      return () => undefined;
    },
    now: () => NOW,
  });
  const last = (name: string) =>
    calls
      .filter((call) => call[0] === name)
      .at(-1)
      ?.slice(1);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    calls,
    client,
    geofences,
    last,
    listeners,
    settle,
    providerCalls: () => providerCalls,
    unconfigure: () => {
      current = null;
    },
    reconfigure: () => {
      current = client;
    },
  };
}

describe("SequenzyGeofences", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("hands the configuration and no identity to the native side before identify", async () => {
    await t.geofences.start();
    expect(t.last("configure")).toEqual([
      "https://api.example.com",
      "company_1",
      "seq_pk_test",
      "com.example.app",
      `sequenzy-react-native-geofences/${SDK_VERSION}`,
    ]);
    expect(t.last("setIdentity")).toEqual([null, null]);
  });

  it("follows identify and reset, and keeps a long-lived token", async () => {
    await t.geofences.start();
    const valid = token(NOW + 20 * DAY);
    await t.client.identify("jane@example.com", valid);
    t.listeners.identity.forEach((listener) => listener());
    await t.settle();
    expect(t.last("setIdentity")).toEqual(["jane@example.com", valid]);
    expect(t.providerCalls()).toBe(0);

    await t.client.reset();
    t.listeners.identity.forEach((listener) => listener());
    await t.settle();
    expect(t.last("setIdentity")).toEqual([null, null]);
  });

  it("replaces a token that expires soon, and a rejected one, through the provider", async () => {
    const expiring = token(NOW + 5 * 60 * 60 * 1000);
    await t.client.identify("jane@example.com", expiring);
    await t.geofences.start();
    expect(t.providerCalls()).toBe(1);
    const fresh = t.last("setIdentity")?.[1];
    expect(fresh).not.toBe(expiring);

    t.listeners.rejected.forEach((listener) => listener());
    await t.settle();
    expect(t.providerCalls()).toBe(2);
    expect(t.last("setIdentity")?.[1]).not.toBe(fresh);
  });

  it("asks for a fresh token when the native side holds the stored one as rejected", async () => {
    await t.client.identify("jane@example.com", "seq_wid_rejected.token");
    await t.geofences.start();
    expect(t.providerCalls()).toBe(1);
    expect(t.last("setIdentity")?.[1]).not.toBe("seq_wid_rejected.token");
  });

  it("syncs and resumes when the app comes to the foreground", async () => {
    await t.geofences.start();
    const before = t.calls.length;
    t.listeners.foreground.forEach((listener) => listener());
    await t.settle();
    expect(t.calls.slice(before).map((call) => call[0])).toEqual([
      "configure",
      "setIdentity",
      "resume",
    ]);
  });

  it("enables with a region cap and reads status and authorization", async () => {
    await t.geofences.enable({ maxRegions: 10 });
    expect(t.last("enable")).toEqual([10]);
    await t.geofences.enable();
    expect(t.last("enable")).toEqual([null]);
    expect(await t.geofences.requestAuthorization()).toBe("always");
    expect(await t.geofences.authorization()).toBe("whenInUse");
    expect(await t.geofences.status()).toEqual({
      enabled: true,
      authorization: "always",
      preciseLocation: true,
      regionIds: ["geo_1", "sequenzy.refresh"],
      queuedEvents: 2,
      maxRegions: 20,
      isMonitoring: true,
    });
    await t.geofences.disable();
    await t.geofences.refresh();
    expect(t.calls.map((call) => call[0])).toContain("disable");
    expect(t.calls.map((call) => call[0])).toContain("refresh");
  });

  it("requires Sequenzy.configure first and can start again afterwards", async () => {
    t.unconfigure();
    await expect(t.geofences.start()).rejects.toThrow("Sequenzy.configure");
    expect(t.listeners.rejected).toHaveLength(0);
    t.reconfigure();
    await t.geofences.start();
    expect(t.last("setIdentity")).toEqual([null, null]);
    expect(t.listeners.rejected).toHaveLength(1);
  });

  it("reads token expiry and ignores tokens it cannot read", () => {
    expect(identityTokenExpiry(token(NOW))).toBe(NOW);
    expect(identityTokenExpiry("seq_wid_notjson.sig")).toBeNull();
    expect(identityTokenExpiry("other")).toBeNull();
  });
});
