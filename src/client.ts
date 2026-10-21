import { defaultStorage, prefixedStorage } from "./storage";
import type {
  CommerceCart,
  CommerceCartLine,
  CommerceCollection,
  CommerceProduct,
  DeviceInfo,
  EventProperties,
  InAppEventType,
  InAppMessage,
  KeyValueStorage,
  LiveActivityToken,
  LogLevel,
  ProfileUpdate,
  PushPayload,
  SequenzyConfig,
  SubscribeInput,
  SubscribeResult,
} from "./types";

export const SDK_VERSION = "0.1.0";
export const DEFAULT_API_BASE_URL = "https://api.sequenzy.com";
export const MAX_QUEUED_EVENTS = 100;
export const MAX_BATCH_SIZE = 20;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
export const PUSH_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Server limit for one event's properties, serialized. */
export const MAX_PROPERTIES_BYTES = 8 * 1024;
export const PROVIDER_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]{64,200}$/;

/** UTF-8 byte length without TextEncoder, which RN before 0.74 lacks. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Rejects after `ms`, so a hung request or provider cannot stall the queue. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms} ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const KEYS = {
  anonymousId: "anonymousId",
  email: "email",
  identityToken: "identityToken",
  events: "events",
  pushToken: "pushToken",
  pushRegistration: "pushRegistration",
  profile: "profile",
  liveActivityTokens: "liveActivityTokens",
} as const;

/** Stored ActivityKit tokens; the newest are kept. */
export const MAX_LIVE_ACTIVITY_TOKENS = 32;
const LIVE_ACTIVITY_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;
const LIVE_ACTIVITY_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LIVE_ACTIVITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The token as Sequenzy stores it, or null when it cannot be accepted. */
export function normalizeLiveActivityToken(
  input: LiveActivityToken
): LiveActivityToken | null {
  if (
    typeof input.token !== "string" ||
    typeof input.activityType !== "string"
  ) {
    return null;
  }
  const token = input.token.trim().toLowerCase();
  const activityType = input.activityType.trim();
  if (
    (input.kind !== "push_to_start" && input.kind !== "update") ||
    !LIVE_ACTIVITY_TOKEN_PATTERN.test(token) ||
    !LIVE_ACTIVITY_TYPE_PATTERN.test(activityType)
  ) {
    return null;
  }
  if (input.kind === "push_to_start") {
    return { kind: input.kind, activityType, token };
  }
  const activityId =
    typeof input.activityId === "string" ? input.activityId.trim() : "";
  if (!LIVE_ACTIVITY_ID_PATTERN.test(activityId)) return null;
  return { kind: input.kind, activityType, activityId, token };
}

/** A newer token for the same type (push-to-start) or activity replaces it. */
function replacesLiveActivityToken(
  next: LiveActivityToken,
  stored: LiveActivityToken
): boolean {
  if (next.token === stored.token) return true;
  if (next.kind !== stored.kind || next.activityType !== stored.activityType) {
    return false;
  }
  return next.kind === "push_to_start" || next.activityId === stored.activityId;
}

type QueuedEventType = "screen" | "commerce";

interface QueuedEvent {
  /** Absent for custom events (and events queued by older SDK versions). */
  type?: QueuedEventType;
  name: string;
  eventId: string;
  properties: EventProperties;
  occurredAt: string;
}

interface HttpResponse {
  status: number;
  body: Record<string, unknown> | null;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface ClientDependencies {
  fetch?: FetchLike;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  uuid?: () => string;
  log?: (level: Exclude<LogLevel, "none">, message: string) => void;
}

export class SequenzyError extends Error {
  constructor(
    message: string,
    readonly code: "not_identified" | "identity_rejected" | "http",
    readonly status?: number
  ) {
    super(message);
    this.name = "SequenzyError";
  }
}

type IdentifiedResult =
  | { kind: "response"; response: HttpResponse }
  | { kind: "not_identified" }
  | { kind: "rejected" }
  | { kind: "failed"; error: unknown };

const LOG_ORDER: Record<LogLevel, number> = {
  none: 0,
  error: 1,
  info: 2,
  debug: 3,
};

function randomUuid(): string {
  const cryptoObject = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export function isRetryable(status: number): boolean {
  return (
    status === 0 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * The platform-independent SDK engine: identity, the event queue, push
 * registration and the in-app feed. Every public method runs one at a time,
 * in call order.
 */
export class SequenzyClient {
  readonly config: Required<
    Pick<SequenzyConfig, "publicKey" | "companyId" | "appId" | "platform">
  > & {
    apiBaseUrl: string;
  };
  identityTokenProvider: ((email: string) => Promise<string>) | undefined;
  device: DeviceInfo;
  logLevel: LogLevel;

  private readonly storage: KeyValueStorage;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly uuid: () => string;
  private readonly logImpl: (
    level: Exclude<LogLevel, "none">,
    message: string
  ) => void;

  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private events: QueuedEvent[] = [];
  /** Profile changes not yet accepted by the server, merged. */
  private pendingProfile: ProfileUpdate | null = null;
  private state: {
    anonymousId: string | null;
    email: string | null;
    identityToken: string | null;
    pushToken: string | null;
    pushRegistration: {
      token: string;
      email: string;
      registeredAt: number;
    } | null;
    liveActivityTokens: LiveActivityToken[];
  } = {
    anonymousId: null,
    email: null,
    identityToken: null,
    pushToken: null,
    pushRegistration: null,
    liveActivityTokens: [],
  };
  private backoffMs = 0;
  private nextAttemptAt: number | null = null;
  private retryHandle: unknown = null;
  private identityBlocked = false;
  /** After a failed provider call, don't ask again before this time. */
  private providerRetryAt = 0;

  constructor(config: SequenzyConfig, dependencies: ClientDependencies = {}) {
    this.config = {
      publicKey: config.publicKey,
      companyId: config.companyId,
      appId: config.appId,
      platform: config.platform,
      apiBaseUrl: (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(
        /\/+$/,
        ""
      ),
    };
    this.identityTokenProvider = config.identityTokenProvider;
    this.device = config.device ?? {};
    this.logLevel = config.logLevel ?? "error";
    this.logImpl =
      dependencies.log ??
      ((level, message) => {
        const line = `[Sequenzy] ${message}`;
        if (level === "error") console.warn(line);
        else console.log(line);
      });
    this.storage = prefixedStorage(
      config.storage ?? defaultStorage((message) => this.log("error", message))
    );
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    this.fetchImpl =
      dependencies.fetch ??
      ((url, init) => (globalFetch as FetchLike)(url, init));
    this.now = dependencies.now ?? (() => Date.now());
    this.schedule =
      dependencies.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel =
      dependencies.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.uuid = dependencies.uuid ?? randomUuid;
  }

  // region Serialization and persistence

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      await this.load();
      return operation();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    // Mark loaded only after every read succeeded: a failed read (storage not
    // available yet) must be retried, not replaced by empty state that the
    // next write would persist over the saved queue and identity.
    const [
      anonymousId,
      email,
      identityToken,
      events,
      pushToken,
      pushRegistration,
      profile,
      liveActivityTokens,
    ] = await Promise.all([
      this.storage.getItem(KEYS.anonymousId),
      this.storage.getItem(KEYS.email),
      this.storage.getItem(KEYS.identityToken),
      this.storage.getItem(KEYS.events),
      this.storage.getItem(KEYS.pushToken),
      this.storage.getItem(KEYS.pushRegistration),
      this.storage.getItem(KEYS.profile),
      this.storage.getItem(KEYS.liveActivityTokens),
    ]);
    this.pendingProfile = safeParse<ProfileUpdate>(profile);
    this.state = {
      anonymousId,
      email,
      identityToken,
      pushToken,
      pushRegistration: safeParse(pushRegistration),
      liveActivityTokens: parseLiveActivityTokens(liveActivityTokens),
    };
    const parsed = safeParse<QueuedEvent[]>(events);
    this.events = Array.isArray(parsed) ? parsed : [];
    this.loaded = true;
  }

  private async save(
    key: keyof typeof KEYS,
    value: string | null
  ): Promise<void> {
    if (value === null) await this.storage.removeItem(KEYS[key]);
    else await this.storage.setItem(KEYS[key], value);
  }

  private persistEvents(): Promise<void> {
    return this.save("events", JSON.stringify(this.events));
  }

  private async ensureAnonymousId(): Promise<string> {
    if (!this.state.anonymousId) {
      this.state.anonymousId = this.uuid();
      await this.save("anonymousId", this.state.anonymousId);
    }
    return this.state.anonymousId;
  }

  // endregion

  // region Identity

  getAnonymousId(): Promise<string> {
    return this.run(() => this.ensureAnonymousId());
  }

  getEmail(): Promise<string | null> {
    return this.run(async () => this.state.email);
  }

  queuedEventCount(): Promise<number> {
    return this.run(async () => this.events.length);
  }

  /** Links this installation to a contact. */
  identify(email: string, identityToken?: string | null): Promise<void> {
    return this.run(async () => {
      const normalized = email.trim().toLowerCase();
      if (!normalized.includes("@") || /\s/.test(normalized)) {
        this.log("error", "identify was called with an invalid email address");
        return;
      }
      const previous = this.state.email;
      if (previous !== normalized) {
        if (previous !== null) {
          // Events and profile changes queued for the previous user must not
          // be sent as the new one.
          this.events = [];
          this.pendingProfile = null;
          await this.persistEvents();
          await this.save("profile", null);
        }
        this.state.email = normalized;
        this.state.identityToken = null;
        await this.save("email", normalized);
        await this.save("identityToken", null);
      }
      if (identityToken) {
        this.state.identityToken = identityToken;
        await this.save("identityToken", identityToken);
      }
      this.identityBlocked = false;
      this.providerRetryAt = 0;
      await this.registerPushLocked(previous !== normalized);
      if (previous !== normalized) {
        if (previous !== null) {
          // Another user signed in without reset: the previous user's
          // running activities stay theirs, and only the device's
          // push-to-start tokens move to the new contact.
          this.state.liveActivityTokens = this.state.liveActivityTokens.filter(
            (token) => token.kind === "push_to_start"
          );
          await this.persistLiveActivityTokens();
        }
        // Stored ActivityKit tokens link to the contact.
        for (const token of this.state.liveActivityTokens) {
          await this.sendLiveActivityToken(token);
        }
      }
      await this.flushLocked();
    });
  }

  /** Forgets the user: unregisters the push token, clears identity, queue and anonymous id. */
  reset(): Promise<void> {
    return this.run(async () => {
      const token = this.state.pushToken;
      if (token && this.config.platform !== "web") {
        try {
          const response = await this.post("/api/v1/push/app-devices/remove", {
            companyId: this.config.companyId,
            publicKey: this.config.publicKey,
            platform: this.config.platform,
            token,
          });
          if (response.status < 200 || response.status >= 300) {
            this.log(
              "error",
              `Could not unregister the push token (HTTP ${response.status})`
            );
          }
        } catch (error) {
          this.log(
            "error",
            `Could not unregister the push token: ${String(error)}`
          );
        }
      }
      const liveTokens = this.state.liveActivityTokens;
      for (const liveToken of liveTokens) {
        await this.removeLiveActivityToken(liveToken.token, true);
      }
      // A running activity belongs to the previous user; push-to-start
      // tokens belong to the device and are registered again below.
      this.state.liveActivityTokens = liveTokens.filter(
        (liveToken) => liveToken.kind === "push_to_start"
      );
      this.state.email = null;
      this.state.identityToken = null;
      this.state.pushRegistration = null;
      this.state.anonymousId = this.uuid();
      this.events = [];
      this.pendingProfile = null;
      await Promise.all([
        this.save("profile", null),
        this.save("email", null),
        this.save("identityToken", null),
        this.save("pushRegistration", null),
        this.save("anonymousId", this.state.anonymousId),
        this.persistLiveActivityTokens(),
        this.persistEvents(),
      ]);
      if (this.retryHandle !== null) this.cancel(this.retryHandle);
      this.retryHandle = null;
      this.backoffMs = 0;
      this.nextAttemptAt = null;
      this.identityBlocked = false;
      for (const liveToken of this.state.liveActivityTokens) {
        await this.sendLiveActivityToken(liveToken);
      }
    });
  }

  // endregion

  // region Events

  /** Queues a custom event; it is sent once the user is identified. */
  track(name: string, properties: EventProperties = {}): Promise<void> {
    return this.enqueue(undefined, name, properties);
  }

  /**
   * Records that the user opened a screen, as the built-in "Screen Viewed"
   * event that segments and sequences can use.
   */
  screen(name: string, properties: EventProperties = {}): Promise<void> {
    return this.enqueue("screen", "screen", {
      ...properties,
      screen: name.trim(),
    });
  }

  /** Browse abandonment and product interest, like the web SDK. */
  viewedProduct(product: CommerceProduct): Promise<void> {
    return this.enqueue("commerce", "product_viewed", {
      product: { ...product },
    });
  }

  addedToCart(line: CommerceCartLine): Promise<void> {
    return this.enqueue("commerce", "product_added_to_cart", {
      product: { ...line },
      cartLine: { ...line },
    });
  }

  removedFromCart(line: CommerceCartLine): Promise<void> {
    return this.enqueue("commerce", "product_removed_from_cart", {
      product: { ...line },
      cartLine: { ...line },
    });
  }

  /** The whole cart, for cart abandonment. */
  viewedCart(cart: CommerceCart): Promise<void> {
    return this.enqueue("commerce", "cart_viewed", {
      cart: JSON.parse(JSON.stringify(cart)) as EventProperties,
    });
  }

  viewedCollection(collection: CommerceCollection): Promise<void> {
    return this.enqueue("commerce", "collection_viewed", {
      collection: { ...collection },
    });
  }

  searched(query: string): Promise<void> {
    return this.enqueue("commerce", "search_submitted", {
      searchQuery: query.trim(),
    });
  }

  private enqueue(
    type: QueuedEventType | undefined,
    name: string,
    properties: EventProperties
  ): Promise<void> {
    return this.run(async () => {
      const trimmed = name.trim();
      if (!trimmed || (type === "screen" && !properties["screen"])) {
        this.log(
          "error",
          type === "screen"
            ? "screen was called without a screen name"
            : "track was called without an event name"
        );
        return;
      }
      // An event that cannot be sent must be dropped now: queued, it would
      // fail every batch it is in (BigInt and cycles do not serialize; over
      // 8 KB the server rejects the whole request).
      let serialized: string;
      try {
        serialized = JSON.stringify(properties) ?? "{}";
      } catch {
        this.log(
          "error",
          `Dropped "${trimmed}": properties are not valid JSON`
        );
        return;
      }
      if (utf8Length(serialized) > MAX_PROPERTIES_BYTES) {
        this.log(
          "error",
          `Dropped "${trimmed}": properties are larger than 8 KB`
        );
        return;
      }
      this.events.push({
        ...(type ? { type } : {}),
        name: trimmed,
        eventId: this.uuid(),
        // A copy: later changes to the caller's object must not reach the queue.
        properties: JSON.parse(serialized) as EventProperties,
        occurredAt: new Date(this.now()).toISOString(),
      });
      if (this.events.length > MAX_QUEUED_EVENTS) {
        this.events.splice(0, this.events.length - MAX_QUEUED_EVENTS);
      }
      await this.persistEvents();
      await this.flushLocked();
    });
  }

  /** Sends queued events now. */
  flush(): Promise<void> {
    return this.run(() => this.flushLocked());
  }

  /**
   * Sets the signed-in contact's name and custom attributes. Changes are
   * kept on the device and sent once identified, like events; later calls
   * merge into a pending update.
   */
  setProfile(update: ProfileUpdate): Promise<void> {
    return this.run(async () => {
      let copy: ProfileUpdate;
      try {
        copy = JSON.parse(JSON.stringify(update)) as ProfileUpdate;
      } catch {
        this.log(
          "error",
          "setProfile was called with values that are not JSON"
        );
        return;
      }
      if (
        copy.attributes &&
        utf8Length(JSON.stringify(copy.attributes)) > MAX_PROPERTIES_BYTES
      ) {
        this.log("error", "setProfile attributes are larger than 8 KB");
        return;
      }
      const previous = this.pendingProfile ?? {};
      this.pendingProfile = {
        ...previous,
        ...copy,
        ...(previous.attributes || copy.attributes
          ? { attributes: { ...previous.attributes, ...copy.attributes } }
          : {}),
      };
      await this.save("profile", JSON.stringify(this.pendingProfile));
      await this.flushLocked();
    });
  }

  /**
   * Subscribes an email through a published form, for people who are not
   * signed in (newsletter or waitlist screens). Does not identify the
   * device: call `identify` once they have an account.
   */
  async subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    const email = input.email.trim();
    if (!email.includes("@") || /\s/.test(email)) {
      return {
        ok: false,
        error: "Enter a valid email address",
        retryable: false,
      };
    }
    try {
      const response = await this.post("/api/v1/app-subscribe", {
        companyId: this.config.companyId,
        publicKey: this.config.publicKey,
        formId: input.formId,
        email,
        ...(input.firstName ? { firstName: input.firstName } : {}),
        ...(input.lastName ? { lastName: input.lastName } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
      });
      if (response.status >= 200 && response.status < 300) return { ok: true };
      const message =
        typeof response.body?.["message"] === "string"
          ? response.body["message"]
          : errorMessage(response.body) || `HTTP ${response.status}`;
      return {
        ok: false,
        error: message,
        retryable: isRetryable(response.status),
      };
    } catch (error) {
      return { ok: false, error: String(error), retryable: true };
    }
  }

  private async flushLocked(): Promise<void> {
    if (this.pendingProfile) {
      if (!this.state.email || this.identityBlocked) return;
      if (this.nextAttemptAt !== null && this.nextAttemptAt > this.now())
        return;
      const outcome = await this.sendProfile(this.pendingProfile);
      if (outcome === "retry") {
        this.scheduleRetry();
        return;
      }
      if (outcome === "stop") return;
      this.backoffMs = 0;
      this.nextAttemptAt = null;
      this.pendingProfile = null;
      await this.save("profile", null);
    }
    await this.dropStaleEvents();
    while (this.events.length > 0) {
      if (!this.state.email || this.identityBlocked) return;
      if (this.nextAttemptAt !== null && this.nextAttemptAt > this.now())
        return;
      const batch = this.events.slice(0, MAX_BATCH_SIZE);
      const outcome = await this.sendBatch(batch);
      if (outcome === "delivered") {
        this.backoffMs = 0;
        this.nextAttemptAt = null;
        await this.remove(batch);
      } else if (outcome === "dropped") {
        await this.remove(batch);
      } else if (outcome === "retry") {
        this.scheduleRetry();
        return;
      } else {
        return;
      }
    }
  }

  private async sendBatch(
    batch: QueuedEvent[]
  ): Promise<"delivered" | "dropped" | "retry" | "stop"> {
    const result = await this.withIdentity((email, identityToken) =>
      this.post("/api/v1/app-events", {
        companyId: this.config.companyId,
        publicKey: this.config.publicKey,
        email,
        identityToken,
        events: batch,
      })
    );
    if (result.kind === "not_identified" || result.kind === "rejected")
      return "stop";
    if (result.kind === "failed") {
      this.log(
        "info",
        `Event delivery failed, will retry: ${String(result.error)}`
      );
      return "retry";
    }
    const { status, body } = result.response;
    if (status >= 200 && status < 300) {
      const rejected = Array.isArray(body?.["rejected"])
        ? (body["rejected"] as Array<{ error?: string }>)
        : [];
      for (const entry of rejected)
        this.log("error", `Event rejected: ${entry.error ?? "unknown error"}`);
      return "delivered";
    }
    if (isRetryable(status)) return "retry";
    this.log(
      "error",
      `Dropping ${batch.length} events: HTTP ${status} ${errorMessage(body)}`
    );
    return "dropped";
  }

  private async sendProfile(
    update: ProfileUpdate
  ): Promise<"delivered" | "dropped" | "retry" | "stop"> {
    const result = await this.withIdentity((email, identityToken) =>
      this.post("/api/v1/app-attributes", {
        companyId: this.config.companyId,
        publicKey: this.config.publicKey,
        email,
        identityToken,
        ...update,
      })
    );
    if (result.kind === "not_identified" || result.kind === "rejected")
      return "stop";
    if (result.kind === "failed") return "retry";
    const { status, body } = result.response;
    if (status >= 200 && status < 300) return "delivered";
    if (isRetryable(status)) return "retry";
    this.log(
      "error",
      `Profile update rejected: HTTP ${status} ${errorMessage(body)}`
    );
    return "dropped";
  }

  private async remove(batch: QueuedEvent[]): Promise<void> {
    const ids = new Set(batch.map((event) => event.eventId));
    this.events = this.events.filter((event) => !ids.has(event.eventId));
    await this.persistEvents();
  }

  private async dropStaleEvents(): Promise<void> {
    const cutoff = this.now() - MAX_EVENT_AGE_MS;
    const before = this.events.length;
    this.events = this.events.filter((event) => {
      const time = Date.parse(event.occurredAt);
      return Number.isFinite(time) && time >= cutoff;
    });
    if (this.events.length !== before) {
      this.log(
        "info",
        `Dropped ${before - this.events.length} events older than 24 hours`
      );
      await this.persistEvents();
    }
  }

  private scheduleRetry(): void {
    this.backoffMs = Math.min(
      this.backoffMs === 0 ? 1000 : this.backoffMs * 2,
      MAX_BACKOFF_MS
    );
    this.nextAttemptAt = this.now() + this.backoffMs;
    if (this.retryHandle !== null) this.cancel(this.retryHandle);
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      void this.run(async () => {
        this.nextAttemptAt = null;
        await this.flushLocked();
      });
    }, this.backoffMs);
  }

  // endregion

  // region Push

  /** Registers the device's native APNs or FCM token. */
  setPushToken(token: string): Promise<void> {
    return this.run(async () => {
      const trimmed = token.trim();
      if (!trimmed) return;
      if (this.config.platform === "web") {
        this.log(
          "error",
          "Push tokens are only registered on iOS and Android; use the web SDK for browsers"
        );
        return;
      }
      if (this.config.platform === "ios" && !APNS_TOKEN_PATTERN.test(trimmed)) {
        // Sequenzy sends to iOS through APNs, so it needs the device token,
        // not an FCM registration token or an Expo push token.
        this.log(
          "error",
          "On iOS pass the APNs device token: getDevicePushTokenAsync() in Expo or messaging().getAPNSToken() in React Native Firebase"
        );
        return;
      }
      const changed = this.state.pushToken !== trimmed;
      this.state.pushToken = trimmed;
      await this.save("pushToken", trimmed);
      await this.registerPushLocked(changed);
    });
  }

  getPushToken(): Promise<string | null> {
    return this.run(async () => this.state.pushToken);
  }

  /** Registers the token when it or the user changed, or the last registration is a day old. */
  registerPushIfNeeded(force = false): Promise<void> {
    return this.run(() => this.registerPushLocked(force));
  }

  private async registerPushLocked(force: boolean): Promise<void> {
    const token = this.state.pushToken;
    if (!token || this.config.platform === "web") return;
    const identity = this.state.email ?? "";
    const last = this.state.pushRegistration;
    if (
      !force &&
      last &&
      last.token === token &&
      last.email === identity &&
      this.now() - last.registeredAt < PUSH_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    const base: Record<string, unknown> = {
      companyId: this.config.companyId,
      publicKey: this.config.publicKey,
      platform: this.config.platform,
      token,
      anonymousId: await this.ensureAnonymousId(),
    };
    for (const key of [
      "appVersion",
      "osVersion",
      "deviceName",
      "locale",
      "timezone",
    ] as const) {
      const value = this.device[key];
      if (value) base[key] = value;
    }

    let response: HttpResponse | null = null;
    if (this.state.email) {
      const result = await this.withIdentity((email, identityToken) =>
        this.post("/api/v1/push/app-devices", { ...base, email, identityToken })
      );
      if (result.kind === "response") {
        response = result.response;
      } else if (result.kind === "failed") {
        this.log("info", `Push registration failed: ${String(result.error)}`);
        return;
      } else {
        // Keep the device reachable; it links on the next identify with a valid token.
        response = await this.post("/api/v1/push/app-devices", base).catch(
          () => null
        );
      }
    } else {
      response = await this.post("/api/v1/push/app-devices", base).catch(
        (error: unknown) => {
          this.log("info", `Push registration failed: ${String(error)}`);
          return null;
        }
      );
    }
    if (!response) return;
    if (response.status < 200 || response.status >= 300) {
      this.log(
        "error",
        `Push registration failed: HTTP ${response.status} ${errorMessage(response.body)}`
      );
      return;
    }
    const identified = response.body?.["identified"] === true;
    this.state.pushRegistration = {
      token,
      email: identified ? identity : "",
      registeredAt: this.now(),
    };
    await this.save(
      "pushRegistration",
      JSON.stringify(this.state.pushRegistration)
    );
    if (response.body?.["pushConfigured"] === false) {
      this.log(
        "info",
        `Device registered, but ${this.config.platform} push credentials are not set up in Sequenzy yet`
      );
    }
  }

  /**
   * Registers an ActivityKit push token your native Live Activity code
   * received (iOS only): `Activity<T>.pushToStartTokenUpdates` as
   * `push_to_start`, or a running activity's `pushTokenUpdates` as `update`
   * with its `sequenzy.activityId`. A newer token for the same type or
   * activity replaces the stored one.
   */
  registerLiveActivityToken(input: LiveActivityToken): Promise<void> {
    return this.run(async () => {
      if (this.config.platform !== "ios") {
        this.log("error", "Live Activities are only available on iOS");
        return;
      }
      const token = normalizeLiveActivityToken(input);
      if (!token) {
        this.log(
          "error",
          "Ignoring a Live Activity token: it needs a hex token, the Swift type name and, for update tokens, the activity's sequenzy.activityId"
        );
        return;
      }
      this.state.liveActivityTokens = [
        ...this.state.liveActivityTokens.filter(
          (stored) => !replacesLiveActivityToken(token, stored)
        ),
        token,
      ].slice(-MAX_LIVE_ACTIVITY_TOKENS);
      await this.persistLiveActivityTokens();
      await this.sendLiveActivityToken(token);
    });
  }

  /** Reports that an activity ended or was dismissed, so Sequenzy stops sending to it. */
  liveActivityEnded(rawToken: string): Promise<void> {
    return this.run(async () => {
      const token = rawToken.trim().toLowerCase();
      if (
        !this.state.liveActivityTokens.some((stored) => stored.token === token)
      ) {
        return;
      }
      this.state.liveActivityTokens = this.state.liveActivityTokens.filter(
        (stored) => stored.token !== token
      );
      await this.persistLiveActivityTokens();
      await this.removeLiveActivityToken(token, false);
    });
  }

  getLiveActivityTokens(): Promise<LiveActivityToken[]> {
    return this.run(async () => [...this.state.liveActivityTokens]);
  }

  private persistLiveActivityTokens(): Promise<void> {
    return this.save(
      "liveActivityTokens",
      this.state.liveActivityTokens.length > 0
        ? JSON.stringify(this.state.liveActivityTokens)
        : null
    );
  }

  private async sendLiveActivityToken(token: LiveActivityToken): Promise<void> {
    const base: Record<string, unknown> = {
      companyId: this.config.companyId,
      publicKey: this.config.publicKey,
      kind: token.kind,
      activityType: token.activityType,
      ...(token.activityId ? { activityId: token.activityId } : {}),
      token: token.token,
      anonymousId: await this.ensureAnonymousId(),
      // Links the token to this installation's push device, when there is one.
      ...(this.state.pushToken ? { deviceToken: this.state.pushToken } : {}),
    };
    for (const key of ["appVersion", "osVersion"] as const) {
      const value = this.device[key];
      if (value) base[key] = value;
    }
    const path = "/api/v1/push/live-activities";
    let response: HttpResponse | null;
    if (this.state.email) {
      const result = await this.withIdentity((email, identityToken) =>
        this.post(path, { ...base, email, identityToken })
      );
      if (result.kind === "response") {
        response = result.response;
      } else if (result.kind === "failed") {
        this.log(
          "info",
          `Live Activity token registration failed: ${String(result.error)}`
        );
        return;
      } else {
        // Store it anonymously; Sequenzy can address it once the next
        // identify links it to the contact.
        response = await this.post(path, base).catch(() => null);
      }
    } else {
      response = await this.post(path, base).catch((error: unknown) => {
        this.log(
          "info",
          `Live Activity token registration failed: ${String(error)}`
        );
        return null;
      });
    }
    if (response && (response.status < 200 || response.status >= 300)) {
      this.log(
        "error",
        `Live Activity token registration failed: HTTP ${response.status} ${errorMessage(response.body)}`
      );
    }
  }

  private async removeLiveActivityToken(
    token: string,
    unlinkSubscriber: boolean
  ): Promise<void> {
    const response = await this.post("/api/v1/push/live-activities/remove", {
      companyId: this.config.companyId,
      publicKey: this.config.publicKey,
      token,
      ...(unlinkSubscriber ? { unlinkSubscriber: true } : {}),
    }).catch(() => null);
    if (response && (response.status < 200 || response.status >= 300)) {
      this.log(
        "error",
        `Could not report the Live Activity ended (HTTP ${response.status})`
      );
    }
  }

  /** Reports a push as delivered or clicked; the payload's click token authenticates it. */
  async reportPush(
    type: "delivered" | "clicked",
    payload: PushPayload
  ): Promise<void> {
    try {
      const response = await withTimeout(
        this.fetchImpl(payload.eventsUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pushSendId: payload.pushSendId,
            deviceId: payload.deviceId,
            token: payload.clickToken,
            type,
          }),
        }),
        REQUEST_TIMEOUT_MS,
        `Push ${type} report`
      );
      if (response.status < 200 || response.status >= 300) {
        this.log(
          "error",
          `Push ${type} report failed: HTTP ${response.status}`
        );
      }
    } catch (error) {
      this.log("error", `Push ${type} report failed: ${String(error)}`);
    }
  }

  // endregion

  // region In-app

  /** Open messages or cards for the identified contact, in server order. */
  fetchFeed(
    options: { kind?: "message" | "card"; limit?: number } = {}
  ): Promise<InAppMessage[]> {
    return this.run(async () => {
      const result = await this.withIdentity((email, identityToken) =>
        this.post("/api/v1/in-app/feed", {
          companyId: this.config.companyId,
          publicKey: this.config.publicKey,
          email,
          identityToken,
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        })
      );
      if (result.kind === "not_identified")
        throw new SequenzyError(
          "Call identify(email, identityToken) first",
          "not_identified"
        );
      if (result.kind === "rejected")
        throw new SequenzyError(
          "The identity token was rejected",
          "identity_rejected"
        );
      if (result.kind === "failed") throw result.error;
      const { status, body } = result.response;
      if (status < 200 || status >= 300) {
        throw new SequenzyError(
          `HTTP ${status} ${errorMessage(body)}`.trim(),
          "http",
          status
        );
      }
      const messages = body?.["messages"];
      return Array.isArray(messages) ? (messages as InAppMessage[]) : [];
    });
  }

  /** Reports `displayed`, `clicked`, `dismissed` or `read` for a feed item. */
  report(type: InAppEventType, messageId: string): Promise<boolean> {
    return this.run(async () => {
      const result = await this.withIdentity((email, identityToken) =>
        this.post("/api/v1/in-app/feed/events", {
          companyId: this.config.companyId,
          publicKey: this.config.publicKey,
          email,
          identityToken,
          messageId,
          type,
        })
      );
      const ok =
        result.kind === "response" &&
        result.response.status >= 200 &&
        result.response.status < 300;
      if (!ok)
        this.log("error", `Could not report in-app ${type} for ${messageId}`);
      return ok;
    });
  }

  // endregion

  // region Identity tokens and HTTP

  private async withIdentity(
    operation: (email: string, token: string) => Promise<HttpResponse>
  ): Promise<IdentifiedResult> {
    const email = this.state.email;
    if (!email || this.identityBlocked) return { kind: "not_identified" };
    let usedProvider = false;
    let token = this.state.identityToken;
    if (!token) {
      token = await this.tokenFromProvider(email);
      usedProvider = true;
    }
    if (!token) {
      this.log(
        "info",
        "No identity token yet; call identify(email, identityToken) or set identityTokenProvider"
      );
      return { kind: "not_identified" };
    }
    for (;;) {
      let response: HttpResponse;
      try {
        response = await operation(email, token);
      } catch (error) {
        return { kind: "failed", error };
      }
      const rejected =
        (response.status === 401 || response.status === 403) &&
        response.body?.["code"] === "invalid_web_tracking_identity";
      if (!rejected) return { kind: "response", response };
      this.state.identityToken = null;
      await this.save("identityToken", null);
      if (!usedProvider) {
        usedProvider = true;
        const fresh = await this.tokenFromProvider(email);
        if (fresh) {
          token = fresh;
          continue;
        }
      }
      this.identityBlocked = true;
      this.log(
        "error",
        "The identity token was rejected; call identify(email, identityToken) with a fresh token"
      );
      return { kind: "rejected" };
    }
  }

  private async tokenFromProvider(email: string): Promise<string | null> {
    if (!this.identityTokenProvider) return null;
    if (this.now() < this.providerRetryAt) return null;
    try {
      // Calls are serialized, so a provider that never settles (or awaits a
      // Sequenzy call) would stall every later call without the timeout.
      const token = await withTimeout(
        this.identityTokenProvider(email),
        REQUEST_TIMEOUT_MS,
        "The identity token provider"
      );
      if (!token || this.state.email !== email) return null;
      this.state.identityToken = token;
      await this.save("identityToken", token);
      return token;
    } catch (error) {
      this.providerRetryAt = this.now() + PROVIDER_RETRY_MS;
      this.log(
        "error",
        `The identity token provider failed: ${String(error)}; retrying in a minute`
      );
      return null;
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>
  ): Promise<HttpResponse> {
    const response = await withTimeout(
      this.fetchImpl(this.config.apiBaseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sequenzy-key": this.config.publicKey,
          "x-sequenzy-app-id": this.config.appId,
        },
        body: JSON.stringify(body),
      }),
      REQUEST_TIMEOUT_MS,
      `POST ${path}`
    );
    const text = await withTimeout(
      response.text(),
      REQUEST_TIMEOUT_MS,
      `POST ${path}`
    ).catch(() => "");
    return { status: response.status, body: safeParse(text) };
  }

  private log(level: Exclude<LogLevel, "none">, message: string): void {
    if (LOG_ORDER[level] <= LOG_ORDER[this.logLevel])
      this.logImpl(level, message);
  }

  // endregion
}

function parseLiveActivityTokens(raw: string | null): LiveActivityToken[] {
  const parsed = safeParse<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const token = normalizeLiveActivityToken(entry as LiveActivityToken);
    return token ? [token] : [];
  });
}

function safeParse<T = Record<string, unknown>>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function errorMessage(body: Record<string, unknown> | null): string {
  return typeof body?.["error"] === "string" ? body["error"] : "";
}
