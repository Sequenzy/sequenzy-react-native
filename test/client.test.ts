import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_EVENT_AGE_MS,
  PROVIDER_RETRY_MS,
  PUSH_REFRESH_INTERVAL_MS,
  SequenzyClient,
  type FetchLike,
} from "../src/client";
import { parsePushPayload } from "../src/push";
import { createMemoryStorage } from "../src/storage";

const fixtures = join(import.meta.dir, "../../contract/fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const contract = JSON.parse(fixture("requests.json")) as {
  config: {
    publicKey: string;
    companyId: string;
    appId: string;
    apiBaseUrl: string;
  };
  headers: Record<string, string>;
  requests: Array<{
    name: string;
    method: string;
    path?: string;
    url?: string;
    body: Record<string, unknown>;
    dynamicBodyFields: string[];
    optionalBodyFields: string[];
    absentBodyFields: string[];
  }>;
};
const token = contract.requests[0]!.body["token"] as string;
const email = "jane@example.com";
const identityToken = "seq_wid_contract.token";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

type Responder = (
  request: Recorded
) => { status: number; body: unknown } | null | Promise<never>;

function createHarness() {
  const requests: Recorded[] = [];
  const responders: Responder[] = [];
  let now = 1_792_000_000_000;
  let uuid = 0;
  const timers: Array<() => void> = [];
  const storage = createMemoryStorage();

  const fetch: FetchLike = async (url, init) => {
    const request: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    requests.push(request);
    for (const responder of responders) {
      const result = await responder(request);
      if (result)
        return {
          status: result.status,
          text: async () => JSON.stringify(result.body),
        };
    }
    if (url.endsWith("/api/v1/app-events")) {
      return {
        status: 202,
        text: async () => '{"success":true,"accepted":1,"rejected":[]}',
      };
    }
    if (url.endsWith("/api/v1/push/app-devices")) {
      return {
        status: 201,
        text: async () =>
          '{"success":true,"deviceId":"dev_1","identified":true,"pushConfigured":true}',
      };
    }
    return { status: 200, text: async () => '{"success":true}' };
  };

  const make = (provider?: (email: string) => Promise<string>) =>
    new SequenzyClient(
      {
        ...contract.config,
        platform: "ios",
        storage,
        identityTokenProvider: provider,
        device: {
          appVersion: "1.0",
          osVersion: "18.0",
          deviceName: "Test",
          locale: "en-US",
          timezone: "UTC",
        },
        logLevel: "none",
      },
      {
        fetch,
        now: () => now,
        uuid: () => `uuid-${++uuid}`,
        // Retries never fire on their own; tests advance the clock and flush.
        setTimeout: (callback) => {
          timers.push(callback);
          return timers.length;
        },
        clearTimeout: () => undefined,
      }
    );

  return {
    requests,
    storage,
    make,
    to: (path: string) =>
      requests.filter((request) => request.url.endsWith(path)),
    respond: (responder: Responder) => responders.unshift(responder),
    respondTo: (
      path: string,
      status: number,
      body: unknown,
      times = Infinity
    ) => {
      let remaining = times;
      responders.unshift((request) => {
        if (!request.url.endsWith(path) || remaining <= 0) return null;
        remaining -= 1;
        return { status, body };
      });
    },
    advance: (ms: number) => {
      now += ms;
    },
    timers,
  };
}

function expectContract(request: Recorded | undefined, name: string) {
  expect(request).toBeDefined();
  const spec = contract.requests.find((entry) => entry.name === name)!;
  if (spec.path) {
    expect(request!.url).toBe(contract.config.apiBaseUrl + spec.path);
    for (const [header, value] of Object.entries(contract.headers)) {
      expect(request!.headers[header]).toBe(value);
    }
  } else {
    expect(request!.url).toBe(spec.url!);
  }
  expect(request!.method).toBe(spec.method);
  for (const [key, value] of Object.entries(spec.body)) {
    if (key !== "events") expect(request!.body[key]).toEqual(value);
  }
  for (const key of spec.absentBodyFields)
    expect(request!.body[key]).toBeUndefined();
  for (const key of spec.dynamicBodyFields.filter(
    (field) => !field.includes("[]")
  )) {
    expect(typeof request!.body[key]).toBe("string");
    expect(request!.body[key].length).toBeGreaterThan(0);
  }
  const allowed = new Set([
    ...Object.keys(spec.body),
    ...spec.dynamicBodyFields,
    ...spec.optionalBodyFields,
  ]);
  expect(Object.keys(request!.body).filter((key) => !allowed.has(key))).toEqual(
    []
  );
}

describe("SequenzyClient contract", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it("registers the device before and after identify", async () => {
    const client = harness.make();
    await client.setPushToken(token);
    expectContract(harness.requests.at(-1), "registerAnonymousDevice");
    const anonymousId = harness.requests.at(-1)!.body["anonymousId"];

    await client.identify("Jane@Example.com ", identityToken);
    const identified = harness.to("/api/v1/push/app-devices").at(-1);
    expectContract(identified, "registerIdentifiedDevice");
    expect(identified!.body["anonymousId"]).toBe(anonymousId);
    expect(identified!.body["appVersion"]).toBe("1.0");
  });

  it("tracks events", async () => {
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.track("workout_completed", { minutes: 30 });
    const request = harness.to("/api/v1/app-events").at(-1);
    expectContract(request, "trackEvents");
    expect(request!.body["events"]).toEqual([
      {
        name: "workout_completed",
        eventId: expect.stringMatching(/^uuid-/),
        properties: { minutes: 30 },
        occurredAt: "2026-10-14T17:46:40.000Z",
      },
    ]);
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("fetches the feed and reports in-app events", async () => {
    harness.respondTo(
      "/api/v1/in-app/feed",
      200,
      JSON.parse(fixture("feed-response.json"))
    );
    const client = harness.make();
    await client.identify(email, identityToken);
    const messages = await client.fetchFeed({ kind: "message" });
    expectContract(harness.to("/api/v1/in-app/feed").at(-1), "fetchFeed");
    expect(messages.map((message) => message.id)).toEqual([
      "iam_modal",
      "iam_banner",
      "iam_card",
    ]);
    expect(messages[0]!.buttons[1]).toEqual({
      label: "Later",
      action: "dismiss",
      url: null,
    });

    expect(await client.report("displayed", "iam_modal")).toBe(true);
    expectContract(harness.requests.at(-1), "reportInAppEvent");
  });

  it("unregisters on reset and forgets the user", async () => {
    const client = harness.make();
    await client.setPushToken(token);
    await client.identify(email, identityToken);
    const before = await client.getAnonymousId();
    await client.reset();
    expectContract(harness.requests.at(-1), "removeDevice");
    expect(await client.getAnonymousId()).not.toBe(before);
    expect(await client.getEmail()).toBeNull();
    expect(
      harness.storage.snapshot()["@sequenzy/identityToken"]
    ).toBeUndefined();
  });

  it("parses push payloads from every delivery shape and reports clicks", async () => {
    const apns = parsePushPayload(
      JSON.parse(fixture("push-payload-apns.json"))
    );
    const fcm = parsePushPayload(
      JSON.parse(fixture("push-payload-fcm-data.json"))
    );
    expect(apns).toEqual(fcm);
    expect(apns?.url).toBe("myapp://orders/123");
    expect(parsePushPayload({ title: "Other sender" })).toBeNull();
    expect(parsePushPayload(null)).toBeNull();
    expect(
      parsePushPayload({
        pushSendId: "p",
        deviceId: "d",
        clickToken: "t",
        eventsUrl: "javascript:x",
      })
    ).toBeNull();

    await harness.make().reportPush("clicked", apns!);
    expectContract(harness.requests.at(-1), "reportPushClicked");
    expect(harness.requests.at(-1)!.headers["x-sequenzy-key"]).toBeUndefined();
  });
});

describe("SequenzyClient queue", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it("sends events tracked before identify once identified", async () => {
    const client = harness.make();
    await client.track("viewed_onboarding");
    expect(harness.to("/api/v1/app-events")).toHaveLength(0);
    await client.identify(email, identityToken);
    expect(harness.to("/api/v1/app-events")[0]!.body["events"][0].name).toBe(
      "viewed_onboarding"
    );
  });

  it("persists, caps and batches the queue", async () => {
    const first = harness.make();
    for (let index = 0; index < 105; index += 1)
      await first.track(`event_${index}`);
    expect(await first.queuedEventCount()).toBe(100);
    const second = harness.make();
    expect(await second.queuedEventCount()).toBe(100);
    await second.identify(email, identityToken);
    expect(
      harness
        .to("/api/v1/app-events")
        .map((request) => request.body["events"].length)
    ).toEqual([20, 20, 20, 20, 20]);
  });

  it("keeps the batch and backs off on retryable failures", async () => {
    harness.respondTo("/api/v1/app-events", 503, {}, 1);
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.track("a");
    expect(await client.queuedEventCount()).toBe(1);
    expect(harness.timers).toHaveLength(1);
    await client.flush();
    expect(harness.to("/api/v1/app-events")).toHaveLength(1);
    harness.advance(2_000);
    harness.timers[0]!();
    expect(await client.queuedEventCount()).toBe(0);
    const ids = harness
      .to("/api/v1/app-events")
      .map((request) => request.body["events"][0].eventId);
    expect(new Set(ids).size).toBe(1);
  });

  it("treats network errors as retryable", async () => {
    let failures = 1;
    harness.respond((request) =>
      request.url.endsWith("/api/v1/app-events") && failures-- > 0
        ? Promise.reject(new Error("offline"))
        : null
    );
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.track("a");
    expect(await client.queuedEventCount()).toBe(1);
    harness.advance(2_000);
    await client.flush();
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("drops batches on permanent failures and partial rejections", async () => {
    harness.respondTo("/api/v1/app-events", 400, { error: "bad" }, 1);
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.track("a");
    expect(await client.queuedEventCount()).toBe(0);
    harness.respondTo(
      "/api/v1/app-events",
      202,
      {
        success: true,
        accepted: 0,
        rejected: [{ index: 0, eventId: "x", error: "built-in" }],
      },
      1
    );
    await client.track("saas.purchase");
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("drops stale events and clears the queue when the user changes", async () => {
    const client = harness.make();
    await client.track("old");
    harness.advance(MAX_EVENT_AGE_MS + 1);
    await client.identify(email, identityToken);
    expect(harness.to("/api/v1/app-events")).toHaveLength(0);

    harness.respondTo("/api/v1/app-events", 503, {});
    await client.track("jane_only");
    await client.identify("bob@example.com", "seq_wid_bob");
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("serializes concurrent calls in order", async () => {
    const client = harness.make();
    await Promise.all([
      client.identify(email, identityToken),
      client.track("a"),
      client.track("b"),
    ]);
    const names = harness
      .to("/api/v1/app-events")
      .flatMap((request) =>
        request.body["events"].map((event: { name: string }) => event.name)
      );
    expect(names).toEqual(["a", "b"]);
  });
});

describe("SequenzyClient identity tokens", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it("refreshes a rejected token once from the provider", async () => {
    let calls = 0;
    harness.respond((request) =>
      request.url.endsWith("/api/v1/app-events") &&
      request.body["identityToken"] !== "seq_wid_fresh"
        ? {
            status: 403,
            body: { success: false, code: "invalid_web_tracking_identity" },
          }
        : null
    );
    const client = harness.make(async (requested) => {
      calls += 1;
      expect(requested).toBe(email);
      return "seq_wid_fresh";
    });
    await client.identify(email, "seq_wid_expired");
    await client.track("a");
    expect(calls).toBe(1);
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("uses the provider when identify has no token", async () => {
    const client = harness.make(async () => "seq_wid_from_backend");
    await client.identify(email);
    await client.track("a");
    expect(harness.to("/api/v1/app-events").at(-1)!.body["identityToken"]).toBe(
      "seq_wid_from_backend"
    );
  });

  it("holds events after a rejection without a provider until the next identify", async () => {
    harness.respondTo(
      "/api/v1/app-events",
      403,
      { code: "invalid_web_tracking_identity" },
      1
    );
    const client = harness.make();
    await client.identify(email, "seq_wid_expired");
    await client.track("a");
    await client.track("b");
    expect(harness.to("/api/v1/app-events")).toHaveLength(1);
    expect(await client.queuedEventCount()).toBe(2);
    await client.identify(email, identityToken);
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("requires identity for the feed", async () => {
    await expect(harness.make().fetchFeed()).rejects.toMatchObject({
      code: "not_identified",
    });
  });
});

describe("SequenzyClient input guards", () => {
  it("drops events that cannot be sent instead of wedging the queue", async () => {
    const harness = createHarness();
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.track("huge", { blob: "x".repeat(9_000) });
    await client.track("bigint", { value: 1n as unknown as number });
    expect(await client.queuedEventCount()).toBe(0);
    expect(harness.to("/api/v1/app-events")).toHaveLength(0);
  });

  it("does not ask a failing provider again for a minute", async () => {
    const harness = createHarness();
    let calls = 0;
    const client = harness.make(async () => {
      calls += 1;
      throw new Error("backend down");
    });
    await client.identify(email);
    await client.track("a");
    await client.track("b");
    expect(calls).toBe(1);
    harness.advance(PROVIDER_RETRY_MS + 1);
    await client.flush();
    expect(calls).toBe(2);
  });

  it("refuses FCM tokens on iOS", async () => {
    const harness = createHarness();
    await harness.make().setPushToken("dXk3:APA91b" + "x".repeat(140));
    expect(harness.to("/api/v1/push/app-devices")).toHaveLength(0);
  });

  it("retries loading state after a storage read fails", async () => {
    const harness = createHarness();
    await harness.make().track("kept");
    let failNext = true;
    const flaky = {
      ...harness.storage,
      getItem: async (key: string) => {
        if (failNext) {
          failNext = false;
          throw new Error("storage locked");
        }
        return harness.storage.getItem(key);
      },
    };
    const client = new SequenzyClient(
      { ...contract.config, platform: "ios", storage: flaky, logLevel: "none" },
      { fetch: async () => ({ status: 202, text: async () => "{}" }) }
    );
    await expect(client.queuedEventCount()).rejects.toThrow("storage locked");
    expect(await client.queuedEventCount()).toBe(1);
  });
});

describe("SequenzyClient push registration", () => {
  it("throttles until the token or user changes", async () => {
    const harness = createHarness();
    const client = harness.make();
    await client.setPushToken(token);
    await client.setPushToken(token);
    await client.registerPushIfNeeded();
    expect(harness.to("/api/v1/push/app-devices")).toHaveLength(1);
    harness.advance(PUSH_REFRESH_INTERVAL_MS + 1);
    await client.registerPushIfNeeded();
    expect(harness.to("/api/v1/push/app-devices")).toHaveLength(2);
    await client.setPushToken(`b${token.slice(1)}`);
    expect(harness.to("/api/v1/push/app-devices")).toHaveLength(3);
  });

  it("registers anonymously when the identity is rejected", async () => {
    const harness = createHarness();
    harness.respondTo(
      "/api/v1/push/app-devices",
      403,
      { code: "invalid_web_tracking_identity" },
      1
    );
    const client = harness.make();
    await client.identify(email, "seq_wid_expired");
    await client.setPushToken(token);
    const registrations = harness.to("/api/v1/push/app-devices");
    expect(registrations).toHaveLength(2);
    expect(registrations[1]!.body["email"]).toBeUndefined();
  });

  it("never registers tokens on web", async () => {
    const harness = createHarness();
    const client = new SequenzyClient(
      {
        ...contract.config,
        platform: "web",
        storage: createMemoryStorage(),
        logLevel: "none",
      },
      { fetch: async () => ({ status: 200, text: async () => "{}" }) }
    );
    await client.setPushToken(token);
    expect(harness.requests).toHaveLength(0);
    expect(await client.getPushToken()).toBeNull();
  });
});

describe("SequenzyClient screens, commerce, profile and signup", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it("sends screens and commerce events as typed events in the queue", async () => {
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.screen(" Pricing ", { plan: "pro" });
    await client.viewedProduct({ providerProductId: "sku-1", title: "Shoe" });
    await client.addedToCart({ providerProductId: "sku-1", quantity: 2 });
    await client.searched(" running shoes ");
    await client.track("custom_thing");
    const events = harness
      .to("/api/v1/app-events")
      .map((request) => request.body["events"][0]);
    expect(events[0]).toMatchObject({
      type: "screen",
      properties: { screen: "Pricing", plan: "pro" },
    });
    expect(events[1]).toMatchObject({
      type: "commerce",
      name: "product_viewed",
      properties: { product: { providerProductId: "sku-1", title: "Shoe" } },
    });
    expect(events[2]).toMatchObject({
      type: "commerce",
      name: "product_added_to_cart",
      properties: { cartLine: { quantity: 2 } },
    });
    expect(events[3]?.properties).toEqual({ searchQuery: "running shoes" });
    // Custom events keep the original shape older servers accept.
    expect(events[4]).not.toHaveProperty("type");
  });

  it("ignores a screen without a name", async () => {
    const client = harness.make();
    await client.screen("   ");
    expect(await client.queuedEventCount()).toBe(0);
  });

  it("merges profile updates, sends them once identified and retries failures", async () => {
    const client = harness.make();
    await client.setProfile({ firstName: "Jane", attributes: { goal: "run" } });
    await client.setProfile({ attributes: { level: 3 } });
    expect(harness.to("/api/v1/app-attributes")).toHaveLength(0);

    harness.respondTo("/api/v1/app-attributes", 503, {}, 1);
    await client.identify(email, identityToken);
    expect(harness.to("/api/v1/app-attributes")).toHaveLength(1);
    // Kept after the failure, and survives a restart.
    const restarted = harness.make();
    harness.advance(2_000);
    await restarted.flush();
    const sent = harness.to("/api/v1/app-attributes");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toMatchObject({
      email,
      identityToken,
      firstName: "Jane",
      attributes: { goal: "run", level: 3 },
    });
    await restarted.flush();
    expect(harness.to("/api/v1/app-attributes")).toHaveLength(2);
  });

  it("drops a profile update the server rejects and forgets it on reset", async () => {
    harness.respondTo("/api/v1/app-attributes", 400, { error: "reserved" });
    const client = harness.make();
    await client.identify(email, identityToken);
    await client.setProfile({ attributes: { mrr: 1 } });
    await client.flush();
    expect(harness.to("/api/v1/app-attributes")).toHaveLength(1);

    const other = createHarness();
    const signedOut = other.make();
    await signedOut.setProfile({ firstName: "Old" });
    await signedOut.reset();
    await signedOut.identify(email, identityToken);
    expect(other.to("/api/v1/app-attributes")).toHaveLength(0);
  });

  it("subscribes through a form without identifying", async () => {
    const client = harness.make();
    expect(
      await client.subscribe({
        formId: "form_1",
        email: " new@example.com ",
        firstName: "Nia",
        phone: "+14155550123",
      })
    ).toEqual({ ok: true });
    const request = harness.to("/api/v1/app-subscribe")[0]!;
    expect(request.body).toEqual({
      companyId: contract.config.companyId,
      publicKey: contract.config.publicKey,
      formId: "form_1",
      email: "new@example.com",
      firstName: "Nia",
      phone: "+14155550123",
    });
    expect(request.headers["x-sequenzy-app-id"]).toBe(contract.config.appId);
    expect(await client.getEmail()).toBeNull();

    harness.respondTo("/api/v1/app-subscribe", 429, { error: "Too many" }, 1);
    expect(
      await client.subscribe({ formId: "form_1", email: "a@b.co" })
    ).toEqual({ ok: false, error: "Too many", retryable: true });
    expect(
      await client.subscribe({ formId: "form_1", email: "not-an-email" })
    ).toMatchObject({ ok: false, retryable: false });
  });
});
