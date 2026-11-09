import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SequenzyClient, type FetchLike } from "../src/client";
import {
  LIVE_UPDATE_ENDED_LINGER_MS,
  MAX_LIVE_UPDATE_ACTIVITIES,
  dismissLiveUpdate,
  parseLiveUpdate,
  parseLiveUpdateRecords,
  receiveLiveUpdate,
  startLiveUpdateLocally,
  type LiveUpdatePayload,
} from "../src/live-updates";
import { createMemoryStorage } from "../src/storage";
import type { SequenzyConfig } from "../src/types";

const fixtures = join(import.meta.dir, "../../contract/fixtures");
const read = (name: string) =>
  JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const contract = read("requests.json") as {
  config: SequenzyConfig & { apiBaseUrl: string };
  requests: Array<{
    name: string;
    body: Record<string, unknown>;
    dynamicBodyFields: string[];
    optionalBodyFields: string[];
    absentBodyFields: string[];
  }>;
};
const messages = read("live-update-fcm-data.json") as {
  messages: Array<{
    name: string;
    data: Record<string, string>;
    expected: Record<string, unknown>;
  }>;
  ignored: Array<{ name: string; data: Record<string, string> }>;
};
const data = (name: string) =>
  messages.messages.find((entry) => entry.name === name)!.data;
const payload = (name: string) => parseLiveUpdate(data(name))!;

const email = "jane@example.com";
const identityToken = "seq_wid_contract.token";
const fcmToken = "fcm_contract_token";
const registerPath = "/api/v1/push/live-activities";
const removePath = "/api/v1/push/live-activities/remove";

interface Recorded {
  url: string;
  body: Record<string, unknown>;
}

function createHarness() {
  const requests: Recorded[] = [];
  let now = 1_792_000_050_000;
  let uuid = 0;
  const storage = createMemoryStorage();
  const removed: string[][] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith("/api/v1/push/app-devices")) {
      return {
        status: 201,
        text: async () =>
          '{"success":true,"deviceId":"dev_1","identified":true,"pushConfigured":true}',
      };
    }
    return { status: 200, text: async () => '{"success":true}' };
  };
  const make = (platform: "ios" | "android" = "android") =>
    new SequenzyClient(
      {
        ...contract.config,
        platform,
        storage,
        device: { appVersion: "1.0", osVersion: "16" },
        logLevel: "none",
        onLiveUpdatesRemoved: (ids) => removed.push(ids),
      },
      {
        fetch,
        now: () => now,
        // 32 hex characters per call, as crypto.randomUUID gives.
        uuid: () => (++uuid).toString(16).padStart(32, "0"),
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      }
    );
  return {
    make,
    removed,
    requests,
    to: (path: string) =>
      requests
        .filter((request) => request.url.endsWith(path))
        .map((request) => request.body),
    setNow: (value: number) => {
      now = value;
    },
  };
}

function expectContract(
  body: Record<string, unknown> | undefined,
  name: string
) {
  expect(body).toBeDefined();
  const spec = contract.requests.find((entry) => entry.name === name)!;
  for (const [key, value] of Object.entries(spec.body)) {
    expect(body![key]).toEqual(value);
  }
  for (const key of spec.absentBodyFields) expect(body![key]).toBeUndefined();
  for (const key of spec.dynamicBodyFields) expect(body![key]).toBeDefined();
  const allowed = new Set([
    ...Object.keys(spec.body),
    ...spec.dynamicBodyFields,
    ...spec.optionalBodyFields,
  ]);
  expect(Object.keys(body!).filter((key) => !allowed.has(key))).toEqual([]);
}

describe("parseLiveUpdate", () => {
  it("parses every message the server sends", () => {
    for (const entry of messages.messages) {
      const parsed = parseLiveUpdate(entry.data);
      expect(parsed).toEqual(
        expect.objectContaining({
          event: entry.expected["event"],
          activityType: entry.expected["activityType"],
          activityId: entry.expected["activityId"],
          timestamp: entry.expected["timestamp"],
          contentState: entry.expected["contentState"],
          attributes: entry.expected["attributes"],
          staleDate: entry.expected["staleDate"],
          dismissalDate: entry.expected["dismissalDate"],
          relevanceScore: entry.expected["relevanceScore"],
          updateToken: entry.expected["updateToken"],
        }) as LiveUpdatePayload
      );
      const alert = entry.expected["alert"] as Record<string, unknown> | null;
      expect(parsed!.alert?.title ?? null).toBe(
        (alert?.["title"] as string | undefined) ?? null
      );
      expect(parsed!.alert?.body ?? null).toBe(
        (alert?.["body"] as string | null | undefined) ?? null
      );
    }
  });

  it("ignores everything else", () => {
    for (const entry of messages.ignored) {
      expect(parseLiveUpdate(entry.data)).toBeNull();
    }
    expect(parseLiveUpdate(null)).toBeNull();
    expect(parseLiveUpdate("text")).toBeNull();
    expect(
      parseLiveUpdate({ ...data("start"), updateToken: "not-hex" })!.updateToken
    ).toBeNull();
    expect(
      parseLiveUpdate({ ...data("start"), relevanceScore: "x" })!.relevanceScore
    ).toBeNull();
  });
});

describe("Live Update rules", () => {
  const options = {
    canShow: true,
    nowMs: 1_000,
    newToken: () => "a".repeat(64),
  };

  it("shows a start, applies newer pushes and drops older or duplicate ones", () => {
    const started = receiveLiveUpdate([], payload("start"), options);
    expect(started.decision).toMatchObject({
      action: "show",
      activity: { activityId: "order-1234", isEnded: false },
      alert: { title: "Order confirmed" },
    });
    expect(started.register?.token).toBe(payload("start").updateToken!);

    expect(
      receiveLiveUpdate(started.records, payload("start"), options).decision
    ).toEqual({ action: "ignore", reason: "stale" });

    const updated = receiveLiveUpdate(
      started.records,
      payload("update"),
      options
    );
    expect(updated.decision).toMatchObject({
      action: "show",
      activity: {
        contentState: { status: "on the way", progress: 60 },
        attributes: { orderNumber: "1234" },
      },
    });

    const ended = receiveLiveUpdate(updated.records, payload("end"), options);
    expect(ended.decision).toMatchObject({
      action: "show",
      activity: { isEnded: true },
      dismissAtMs: 1_792_000_200_000,
    });
    expect(ended.forget).toBe(payload("start").updateToken!);
    expect(
      receiveLiveUpdate(
        ended.records,
        { ...payload("update"), timestamp: 1_792_000_300 },
        options
      ).decision
    ).toEqual({ action: "ignore", reason: "ended" });
  });

  it("lingers four hours after an end without a dismissal date", () => {
    const started = receiveLiveUpdate([], payload("start"), options);
    const ended = receiveLiveUpdate(
      started.records,
      { ...payload("end"), dismissalDate: null },
      options
    );
    expect(ended.decision).toMatchObject({
      dismissAtMs: 1_000 + LIVE_UPDATE_ENDED_LINGER_MS,
    });
  });

  it("refuses a start it cannot show and reports its token", () => {
    const step = receiveLiveUpdate([], payload("start"), {
      ...options,
      canShow: false,
    });
    expect(step.decision).toEqual({ action: "ignore", reason: "not_shown" });
    expect(step.remove).toBe(payload("start").updateToken!);
    expect(
      receiveLiveUpdate(
        [],
        { ...payload("start"), updateToken: null },
        { ...options, canShow: false }
      ).remove
    ).toBeUndefined();
  });

  it("ignores updates and ends for unknown or hidden activities", () => {
    expect(receiveLiveUpdate([], payload("update"), options).decision).toEqual({
      action: "ignore",
      reason: "unknown_activity",
    });
    const started = receiveLiveUpdate([], payload("start"), options);
    expect(
      receiveLiveUpdate(started.records, payload("update"), {
        ...options,
        canShow: false,
      }).decision
    ).toEqual({ action: "ignore", reason: "not_shown" });
    const dismissed = dismissLiveUpdate(started.records, "order-1234");
    expect(dismissed.remove).toBe(payload("start").updateToken!);
    expect(
      receiveLiveUpdate(dismissed.records, payload("end"), options).decision
    ).toEqual({ action: "ignore", reason: "dismissed" });
    expect(dismissLiveUpdate(dismissed.records, "order-1234").remove).toBe(
      undefined
    );
  });

  it("gives a start without a token a new one and replaces a restarted activity's token", () => {
    const first = receiveLiveUpdate(
      [],
      { ...payload("start"), updateToken: null },
      options
    );
    expect(first.register?.token).toBe("a".repeat(64));
    const again = receiveLiveUpdate(
      first.records,
      { ...payload("start"), timestamp: 1_792_000_500 },
      options
    );
    expect(again.forget).toBe("a".repeat(64));
  });

  it("keeps running activities when trimming", () => {
    let records = startLiveUpdateLocally(
      [],
      {
        activityType: "DeliveryAttributes",
        activityId: "keep",
        attributes: {},
        contentState: {},
      },
      options
    ).records;
    for (let index = 0; index < MAX_LIVE_UPDATE_ACTIVITIES + 3; index += 1) {
      records = startLiveUpdateLocally(
        records,
        {
          activityType: "DeliveryAttributes",
          activityId: `done-${index}`,
          attributes: {},
          contentState: {},
        },
        options
      ).records;
      records = dismissLiveUpdate(records, `done-${index}`).records;
    }
    expect(records).toHaveLength(MAX_LIVE_UPDATE_ACTIVITIES);
    expect(records.some((record) => record.activityId === "keep")).toBe(true);
  });

  it("restores only well-formed stored records", () => {
    expect(parseLiveUpdateRecords(null)).toEqual([]);
    expect(parseLiveUpdateRecords("{")).toEqual([]);
    expect(parseLiveUpdateRecords("{}")).toEqual([]);
    expect(
      parseLiveUpdateRecords(
        JSON.stringify([
          { activityId: "a", token: "t", timestamp: 1, state: "active" },
          { activityId: "b", token: "t", timestamp: 1, state: "paused" },
          null,
        ])
      )
    ).toHaveLength(1);
  });
});

describe("SequenzyClient Android Live Updates", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });

  it("registers a push-to-start token per observed type once the FCM token is known", async () => {
    const client = harness.make();
    await client.observeLiveUpdates("DeliveryAttributes");
    expect(harness.to(registerPath)).toEqual([]);

    await client.setPushToken(fcmToken);
    const [sent] = harness.to(registerPath);
    expectContract(sent, "registerLiveUpdatePushToStart");
    expect(sent!["token"]).toMatch(/^[0-9a-f]{64}$/);

    await client.observeLiveUpdates("DeliveryAttributes");
    expect(harness.to(registerPath).at(-1)!["token"]).toBe(sent!["token"]);
    await client.observeLiveUpdates("not a type");
    expect(await client.getLiveActivityTokens()).toHaveLength(1);
  });

  it("shows a pushed start and reports the token it carried for the contact", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.identify(email, identityToken);

    const decision = await client.handleLiveUpdate(data("start"));

    expect(decision).toMatchObject({ action: "show" });
    expectContract(
      harness.to(registerPath).at(-1),
      "registerLiveUpdateActivity"
    );
    expect(await client.getLiveUpdates()).toHaveLength(1);
    expect(await client.handleLiveUpdate({ title: "regular push" })).toBeNull();
    // State survives a restart.
    expect(await harness.make().getLiveUpdates()).toHaveLength(1);
  });

  it("reports a start the app cannot show", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.handleLiveUpdate(data("start"), { canShow: false });
    expect(harness.to(removePath)).toEqual([
      expect.objectContaining({ token: payload("start").updateToken }),
    ]);
    expect(harness.to(removePath)[0]!["unlinkSubscriber"]).toBeUndefined();
  });

  it("starts, updates and ends an activity from the app", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    const started = await client.startLiveUpdate({
      activityType: "DeliveryAttributes",
      activityId: "order-9",
      contentState: { status: "placed" },
    });
    expect(started).toMatchObject({ action: "show" });
    const registered = harness.to(registerPath).at(-1)!;
    expect(registered).toMatchObject({
      platform: "android",
      kind: "update",
      activityId: "order-9",
    });

    expect(
      await client.updateLiveUpdate("order-9", { status: "packed" })
    ).toMatchObject({ activity: { contentState: { status: "packed" } } });
    const ended = await client.endLiveUpdate("order-9", { dismissAtMs: 5 });
    expect(ended).toMatchObject({ action: "show", dismissAtMs: 5 });
    expect(harness.to(removePath).at(-1)!["token"]).toBe(registered["token"]);
    expect(await client.getLiveActivityTokens()).toEqual([]);
    expect(
      await client.startLiveUpdate({ activityType: "x y", activityId: "a" })
    ).toEqual({ action: "ignore", reason: "invalid" });
  });

  it("reports a dismissed activity", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.handleLiveUpdate(data("start"));
    await client.liveUpdateDismissed("order-1234");
    expect(harness.to(removePath).at(-1)!["token"]).toBe(
      payload("start").updateToken
    );
    expect(await client.handleLiveUpdate(data("update"))).toEqual({
      action: "ignore",
      reason: "dismissed",
    });
  });

  it("unlinks on reset, removes running notifications and relinks with the next device registration", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.identify(email, identityToken);
    await client.observeLiveUpdates("DeliveryAttributes");
    await client.handleLiveUpdate(data("start"));
    const [pushToStart] = await client.getLiveActivityTokens();
    const before = harness.to(registerPath).length;

    await client.reset();

    expect(harness.removed).toEqual([["order-1234"]]);
    expect(
      harness.to(removePath).every((body) => body["unlinkSubscriber"] === true)
    ).toBe(true);
    // Nothing is linked to the unregistered device.
    expect(harness.to(registerPath)).toHaveLength(before);
    expect(await client.getLiveUpdates()).toEqual([]);

    await client.registerPushIfNeeded();
    const relinked = harness.to(registerPath).at(-1)!;
    expect(relinked["token"]).toBe(pushToStart!.token);
    expect(relinked["email"]).toBeUndefined();
  });

  it("keeps only push-to-start tokens when another person signs in", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.identify(email, identityToken);
    await client.observeLiveUpdates("DeliveryAttributes");
    await client.handleLiveUpdate(data("start"));
    const before = harness.to(registerPath).length;

    await client.identify("sam@example.com", "seq_wid_sam");

    expect(harness.removed).toEqual([["order-1234"]]);
    const sent = harness.to(registerPath).slice(before);
    expect(sent.map((body) => body["kind"])).toEqual(["push_to_start"]);
    expect(sent[0]!["email"]).toBe("sam@example.com");
  });

  it("keeps Live Update methods to Android", async () => {
    const client = harness.make("ios");
    await client.observeLiveUpdates("DeliveryAttributes");
    expect(
      await client.startLiveUpdate({
        activityType: "DeliveryAttributes",
        activityId: "a",
      })
    ).toEqual({ action: "ignore", reason: "invalid" });
    expect(await client.getLiveActivityTokens()).toEqual([]);
  });

  it("never hides backend pushes behind app changes, even with a fast device clock", async () => {
    const client = harness.make();
    harness.setNow(1_792_003_600_000);
    await client.startLiveUpdate({
      activityType: "DeliveryAttributes",
      activityId: "order-1234",
    });
    await client.updateLiveUpdate("order-1234", { status: "app" });
    expect(await client.handleLiveUpdate(data("update"))).toMatchObject({
      action: "show",
      activity: { contentState: { status: "on the way" } },
    });
  });

  it("drops a start that arrives after its end", async () => {
    const client = harness.make();
    expect(await client.handleLiveUpdate(data("end"))).toEqual({
      action: "ignore",
      reason: "unknown_activity",
    });
    expect(await client.handleLiveUpdate(data("start"))).toEqual({
      action: "ignore",
      reason: "stale",
    });
  });

  it("removes ended notifications on reset too", async () => {
    const client = harness.make();
    await client.handleLiveUpdate(data("start"));
    await client.handleLiveUpdate(data("end"));
    await client.reset();
    expect(harness.removed).toEqual([["order-1234"]]);
  });

  it("unlinks the previous person's tokens on the server when another person signs in", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.identify(email, identityToken);
    await client.observeLiveUpdates("DeliveryAttributes");
    await client.handleLiveUpdate(data("start"));
    await client.identify("sam@example.com", "seq_wid_sam");
    const removals = harness.to(removePath);
    expect(removals).toHaveLength(2);
    expect(removals.every((body) => body["unlinkSubscriber"] === true)).toBe(
      true
    );
  });

  it("generates tokens with crypto.getRandomValues and keeps push-to-start tokens when trimming", async () => {
    const client = harness.make();
    await client.setPushToken(fcmToken);
    await client.observeLiveUpdates("DeliveryAttributes");
    for (let index = 0; index < 40; index += 1) {
      await client.startLiveUpdate({
        activityType: "DeliveryAttributes",
        activityId: `order-${index}`,
      });
    }
    const tokens = await client.getLiveActivityTokens();
    expect(tokens).toHaveLength(32);
    expect(
      tokens.filter((token) => token.kind === "push_to_start")
    ).toHaveLength(1);
    // Not built from the harness's counter-based uuid().
    expect(tokens[0]!.token).not.toMatch(/^0{20}/);
  });
});
