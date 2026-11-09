// Android Live Updates: the FCM data messages Sequenzy sends for Live
// Activity starts, updates and ends, and the rules for applying them. The
// SDK keeps the state; your app draws the notification (for example with
// Notifee) from the decision these functions return. Mirrors the Kotlin
// SDK's LiveUpdates.kt.

export type LiveUpdateEvent = "start" | "update" | "end";

export interface LiveUpdateAlert {
  title: string | null;
  body: string | null;
  sound: string | null;
}

/** A Sequenzy Live Update push, parsed from FCM `remoteMessage.data`. */
export interface LiveUpdatePayload {
  event: LiveUpdateEvent;
  activityType: string;
  activityId: string;
  /** Unix seconds; a push not newer than the last one applied is ignored. */
  timestamp: number;
  contentState: Record<string, unknown>;
  /** Start only. */
  attributes: Record<string, unknown> | null;
  alert: LiveUpdateAlert | null;
  /** Unix seconds after which the content is out of date. */
  staleDate: number | null;
  /** End only: Unix seconds when the notification should go away. */
  dismissalDate: number | null;
  relevanceScore: number | null;
  /** Start only: the token Sequenzy registered for the new activity. */
  updateToken: string | null;
}

/** One Live Update as your app draws it. */
export interface LiveUpdateActivity {
  activityType: string;
  activityId: string;
  /** Fixed when it started. */
  attributes: Record<string, unknown>;
  contentState: Record<string, unknown>;
  staleDateMs: number | null;
  /** True once it ended: show the final content, not as ongoing. */
  isEnded: boolean;
}

export type LiveUpdateDecision =
  | {
      action: "show";
      activity: LiveUpdateActivity;
      alert: LiveUpdateAlert | null;
      /** Ended activities: remove the notification at this time (ms). */
      dismissAtMs: number | null;
    }
  | {
      action: "ignore";
      /** stale, unknown_activity, ended, dismissed, not_shown or invalid. */
      reason: string;
    };

/** Ended Live Updates stay until dismissed, at most this long, as on iOS. */
export const LIVE_UPDATE_ENDED_LINGER_MS = 4 * 60 * 60 * 1000;
/** Stored activities; the newest are kept, running ones first. */
export const MAX_LIVE_UPDATE_ACTIVITIES = 32;

const TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;

export function isLiveUpdateActivityType(value: string): boolean {
  return TYPE_PATTERN.test(value);
}

export function isLiveUpdateActivityId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function integer(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Reads `remoteMessage.data` from @react-native-firebase/messaging (both
 * `onMessage` and `setBackgroundMessageHandler`). Returns null for anything
 * that is not a Sequenzy Live Update.
 */
export function parseLiveUpdate(data: unknown): LiveUpdatePayload | null {
  if (!data || typeof data !== "object") return null;
  const source = data as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  };
  if (text("sequenzyLiveUpdate") !== "1") return null;
  const event = text("event");
  if (event !== "start" && event !== "update" && event !== "end") return null;
  const activityType = text("activityType");
  const activityId = text("activityId");
  const timestamp = integer(source["timestamp"]);
  const contentState = parseObject(source["contentState"]);
  if (
    !activityType ||
    !isLiveUpdateActivityType(activityType) ||
    !activityId ||
    !isLiveUpdateActivityId(activityId) ||
    timestamp === null ||
    !contentState
  ) {
    return null;
  }
  const title = text("alertTitle");
  const body = text("alertBody");
  const relevance = text("relevanceScore");
  const updateToken = text("updateToken")?.toLowerCase() ?? null;
  return {
    event,
    activityType,
    activityId,
    timestamp,
    contentState,
    attributes: parseObject(source["attributes"]),
    alert:
      title !== null || body !== null
        ? { title, body, sound: text("alertSound") }
        : null,
    staleDate: integer(source["staleDate"]),
    dismissalDate: integer(source["dismissalDate"]),
    relevanceScore:
      relevance !== null && Number.isFinite(Number(relevance))
        ? Number(relevance)
        : null,
    updateToken:
      updateToken && TOKEN_PATTERN.test(updateToken) ? updateToken : null,
  };
}

/** A Live Update this device shows or showed, as the SDK stores it. */
export interface LiveUpdateRecord {
  activityType: string;
  activityId: string;
  token: string;
  attributes: Record<string, unknown>;
  contentState: Record<string, unknown>;
  timestamp: number;
  state: "active" | "ended" | "dismissed";
  staleDate: number | null;
}

/** The result of one change: new records, what to show, and token work. */
export interface LiveUpdateStep {
  records: LiveUpdateRecord[];
  decision: LiveUpdateDecision;
  /** Update token to store and register with Sequenzy. */
  register?: { activityType: string; activityId: string; token: string };
  /** Token to forget locally (Sequenzy already knows it ended). */
  forget?: string;
  /** Token to forget and report ended to Sequenzy. */
  remove?: string;
}

export function toLiveUpdateActivity(
  record: LiveUpdateRecord
): LiveUpdateActivity {
  return {
    activityType: record.activityType,
    activityId: record.activityId,
    attributes: record.attributes,
    contentState: record.contentState,
    staleDateMs: record.staleDate === null ? null : record.staleDate * 1000,
    isEnded: record.state !== "active",
  };
}

function save(
  records: LiveUpdateRecord[],
  record: LiveUpdateRecord
): LiveUpdateRecord[] {
  const all = [
    ...records.filter((entry) => entry.activityId !== record.activityId),
    record,
  ];
  const running = all.filter((entry) => entry.state === "active");
  const finished = all.filter((entry) => entry.state !== "active");
  const room = Math.max(0, MAX_LIVE_UPDATE_ACTIVITIES - running.length);
  return [
    ...finished.slice(Math.max(0, finished.length - room)),
    ...running,
  ].slice(-MAX_LIVE_UPDATE_ACTIVITIES);
}

const ignore = (
  records: LiveUpdateRecord[],
  reason: string,
  extra: Partial<LiveUpdateStep> = {}
): LiveUpdateStep => ({
  records,
  decision: { action: "ignore", reason },
  ...extra,
});

/**
 * Applies a received push. `canShow` is false when the app does not draw
 * this activity type or may not post notifications; a start is then
 * refused and reported ended, so Sequenzy does not count it as running.
 */
export function receiveLiveUpdate(
  records: LiveUpdateRecord[],
  payload: LiveUpdatePayload,
  options: { canShow: boolean; nowMs: number; newToken: () => string }
): LiveUpdateStep {
  const record = records.find(
    (entry) => entry.activityId === payload.activityId
  );
  if (record && payload.timestamp <= record.timestamp) {
    return ignore(records, "stale");
  }
  if (payload.event === "start") {
    if (!options.canShow) {
      return ignore(
        records,
        "not_shown",
        payload.updateToken ? { remove: payload.updateToken } : {}
      );
    }
    const next: LiveUpdateRecord = {
      activityType: payload.activityType,
      activityId: payload.activityId,
      token: payload.updateToken ?? options.newToken(),
      attributes: payload.attributes ?? {},
      contentState: payload.contentState,
      timestamp: payload.timestamp,
      state: "active",
      staleDate: payload.staleDate,
    };
    return {
      records: save(records, next),
      decision: {
        action: "show",
        activity: toLiveUpdateActivity(next),
        alert: payload.alert,
        dismissAtMs: null,
      },
      register: {
        activityType: next.activityType,
        activityId: next.activityId,
        token: next.token,
      },
      ...(record && record.token !== next.token
        ? { forget: record.token }
        : {}),
    };
  }
  if (!record) {
    if (payload.event === "update") return ignore(records, "unknown_activity");
    // FCM may deliver an end before its start: remember it, so the late
    // start is dropped as stale.
    return ignore(
      save(records, {
        activityType: payload.activityType,
        activityId: payload.activityId,
        token: "",
        attributes: {},
        contentState: payload.contentState,
        timestamp: payload.timestamp,
        state: "ended",
        staleDate: null,
      }),
      "unknown_activity"
    );
  }
  if (record.state !== "active") return ignore(records, record.state);
  if (payload.event === "update") {
    if (!options.canShow) return ignore(records, "not_shown");
    const next: LiveUpdateRecord = {
      ...record,
      contentState: payload.contentState,
      timestamp: payload.timestamp,
      staleDate: payload.staleDate ?? record.staleDate,
    };
    return {
      records: save(records, next),
      decision: {
        action: "show",
        activity: toLiveUpdateActivity(next),
        alert: payload.alert,
        dismissAtMs: null,
      },
    };
  }
  const next: LiveUpdateRecord = {
    ...record,
    contentState: payload.contentState,
    timestamp: payload.timestamp,
    state: "ended",
  };
  return {
    records: save(records, next),
    decision: {
      action: "show",
      activity: toLiveUpdateActivity(next),
      alert: payload.alert,
      dismissAtMs:
        payload.dismissalDate !== null
          ? payload.dismissalDate * 1000
          : options.nowMs + LIVE_UPDATE_ENDED_LINGER_MS,
    },
    // Sequenzy marked the token ended when FCM accepted the end.
    forget: record.token,
  };
}

/** Starts an activity from the app, so your backend can update and end it. */
export function startLiveUpdateLocally(
  records: LiveUpdateRecord[],
  input: {
    activityType: string;
    activityId: string;
    attributes: Record<string, unknown>;
    contentState: Record<string, unknown>;
    staleDateMs?: number | null;
  },
  options: { nowMs: number; newToken: () => string }
): LiveUpdateStep {
  if (
    !isLiveUpdateActivityType(input.activityType) ||
    !isLiveUpdateActivityId(input.activityId)
  ) {
    return ignore(records, "invalid");
  }
  const previous = records.find(
    (entry) => entry.activityId === input.activityId
  );
  const next: LiveUpdateRecord = {
    activityType: input.activityType,
    activityId: input.activityId,
    token: options.newToken(),
    attributes: input.attributes,
    contentState: input.contentState,
    // Pushes are ordered by the server's clock; app changes never move
    // that, so a fast device clock cannot hide updates.
    timestamp: previous?.timestamp ?? 0,
    state: "active",
    staleDate:
      input.staleDateMs == null ? null : Math.floor(input.staleDateMs / 1000),
  };
  return {
    records: save(records, next),
    decision: {
      action: "show",
      activity: toLiveUpdateActivity(next),
      alert: null,
      dismissAtMs: null,
    },
    register: {
      activityType: next.activityType,
      activityId: next.activityId,
      token: next.token,
    },
    ...(previous ? { forget: previous.token } : {}),
  };
}

export function updateLiveUpdateLocally(
  records: LiveUpdateRecord[],
  activityId: string,
  contentState: Record<string, unknown>,
  _nowMs: number
): LiveUpdateStep {
  const record = records.find(
    (entry) => entry.activityId === activityId && entry.state === "active"
  );
  if (!record) return ignore(records, "unknown_activity");
  const next: LiveUpdateRecord = {
    ...record,
    contentState,
  };
  return {
    records: save(records, next),
    decision: {
      action: "show",
      activity: toLiveUpdateActivity(next),
      alert: null,
      dismissAtMs: null,
    },
  };
}

export function endLiveUpdateLocally(
  records: LiveUpdateRecord[],
  activityId: string,
  input: { contentState?: Record<string, unknown>; dismissAtMs?: number },
  nowMs: number
): LiveUpdateStep {
  const record = records.find(
    (entry) => entry.activityId === activityId && entry.state === "active"
  );
  if (!record) return ignore(records, "unknown_activity");
  const next: LiveUpdateRecord = {
    ...record,
    contentState: input.contentState ?? record.contentState,
    state: "ended",
  };
  return {
    records: save(records, next),
    decision: {
      action: "show",
      activity: toLiveUpdateActivity(next),
      alert: null,
      dismissAtMs: input.dismissAtMs ?? nowMs + LIVE_UPDATE_ENDED_LINGER_MS,
    },
    remove: record.token,
  };
}

/**
 * The person swiped the notification away. Android asks apps not to post
 * it again, so later pushes are ignored and Sequenzy stops sending them.
 */
export function dismissLiveUpdate(
  records: LiveUpdateRecord[],
  activityId: string
): LiveUpdateStep {
  const record = records.find((entry) => entry.activityId === activityId);
  if (!record || record.state === "dismissed") {
    return ignore(records, "unknown_activity");
  }
  return {
    records: save(records, { ...record, state: "dismissed" }),
    decision: { action: "ignore", reason: "dismissed" },
    ...(record.state === "active" ? { remove: record.token } : {}),
  };
}

export function parseLiveUpdateRecords(raw: string | null): LiveUpdateRecord[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is LiveUpdateRecord =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as LiveUpdateRecord).activityId === "string" &&
        typeof (entry as LiveUpdateRecord).token === "string" &&
        typeof (entry as LiveUpdateRecord).timestamp === "number" &&
        ["active", "ended", "dismissed"].includes(
          (entry as LiveUpdateRecord).state
        )
    );
  } catch {
    return [];
  }
}
