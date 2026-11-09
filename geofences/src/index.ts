import {
  SDK_VERSION,
  Sequenzy,
  type SequenzyClient,
} from "@sequenzy/react-native";
import { requireNativeModule } from "expo-modules-core";
import { AppState } from "react-native";

/** Location access as the OS reports it. Geofencing needs `always`. */
export type GeofenceAuthorization =
  "notDetermined" | "denied" | "whenInUse" | "always";

export interface GeofenceStatus {
  enabled: boolean;
  authorization: GeofenceAuthorization;
  preciseLocation: boolean;
  /** Regions registered with the OS, including the refresh region. */
  regionIds: string[];
  /** Transitions recorded on the device and not yet accepted by Sequenzy. */
  queuedEvents: number;
  maxRegions: number;
  /** Enabled, with "Always" access and precise location. */
  isMonitoring: boolean;
}

/** The native module; see ios/SequenzyGeofencesModule.swift and the Android twin. */
export interface GeofenceNativeModule {
  configure(
    apiBaseUrl: string,
    companyId: string,
    publicKey: string,
    appId: string,
    userAgent: string
  ): Promise<void>;
  /**
   * Resolves true when the native side holds this token as rejected.
   * `externalId` is set for users identified with `identifyUser`.
   */
  setIdentity(
    email: string | null,
    identityToken: string | null,
    externalId: string | null
  ): Promise<boolean>;
  authorization(): Promise<string>;
  requestAuthorization(): Promise<string>;
  enable(maxRegions: number | null): Promise<void>;
  disable(): Promise<void>;
  refresh(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  addListener(
    event: "identityRejected",
    listener: () => void
  ): { remove(): void };
}

interface Dependencies {
  native: () => GeofenceNativeModule;
  client: () => SequenzyClient | null;
  onIdentityChange: (listener: () => void) => () => void;
  onForeground: (listener: () => void) => () => void;
  now: () => number;
}

/** Tokens that expire sooner are replaced through the identity token
 * provider, since native code may report while JavaScript is not running. */
export const REFRESH_TOKEN_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** When a `seq_wid_` identity token expires (ms), or null when unreadable. */
export function identityTokenExpiry(token: string): number | null {
  if (!token.startsWith("seq_wid_")) return null;
  const parts = token.slice(8).split(".");
  if (parts.length !== 2 || !parts[0]) return null;
  try {
    const base64 = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const claims = JSON.parse(globalThis.atob(padded)) as {
      expiresAt?: unknown;
    };
    return typeof claims.expiresAt === "number" ? claims.expiresAt : null;
  } catch {
    return null;
  }
}

function authorization(value: unknown): GeofenceAuthorization {
  return value === "always" ||
    value === "whenInUse" ||
    value === "notDetermined"
    ? value
    : "denied";
}

export function createSequenzyGeofences(dependencies: Dependencies) {
  let started: Promise<void> | null = null;
  let syncing: Promise<void> = Promise.resolve();
  let unsubscribe: Array<() => void> = [];
  const ignore = () => undefined;

  async function syncNow(refreshToken: boolean): Promise<void> {
    const client = dependencies.client();
    if (!client) throw new Error("Call Sequenzy.configure(...) first");
    const native = dependencies.native();
    const { config } = client;
    await native.configure(
      config.apiBaseUrl,
      config.companyId,
      config.publicKey,
      config.appId,
      `sequenzy-react-native-geofences/${SDK_VERSION}`
    );
    let credentials = await client.identityCredentials({
      refresh: refreshToken,
    });
    if (credentials && !refreshToken) {
      const expiresAt = identityTokenExpiry(credentials.identityToken);
      if (
        expiresAt !== null &&
        expiresAt < dependencies.now() + REFRESH_TOKEN_WITHIN_MS
      ) {
        credentials =
          (await client.identityCredentials({ refresh: true })) ?? credentials;
      }
    }
    const rejected = await native.setIdentity(
      credentials?.email ?? null,
      credentials?.identityToken ?? null,
      credentials?.externalId ?? null
    );
    // The native side saw this token rejected while JavaScript was not running.
    if (rejected === true && !refreshToken && credentials) {
      const fresh = await client.identityCredentials({ refresh: true });
      if (fresh && fresh.identityToken !== credentials.identityToken) {
        await native.setIdentity(
          fresh.email,
          fresh.identityToken,
          fresh.externalId
        );
      }
    }
  }

  /** One at a time, so an older identity never overwrites a newer one. */
  function sync(refreshToken = false): Promise<void> {
    const next = syncing.then(() => syncNow(refreshToken));
    syncing = next.catch(ignore);
    return next;
  }

  const api = {
    /** Hands the Sequenzy configuration and the signed-in contact to the
     * native side and keeps them current. Call after `Sequenzy.configure`
     * on every launch. */
    start(): Promise<void> {
      started ??= (async () => {
        const native = dependencies.native();
        const subscription = native.addListener("identityRejected", () => {
          sync(true).catch(ignore);
        });
        unsubscribe = [
          () => subscription.remove(),
          dependencies.onIdentityChange(() => {
            sync().catch(ignore);
          }),
          dependencies.onForeground(() => {
            sync()
              .then(() => native.resume())
              .catch(ignore);
          }),
        ];
        await sync();
      })().catch((error: unknown) => {
        started = null;
        unsubscribe.forEach((remove) => remove());
        unsubscribe = [];
        throw error;
      });
      return started;
    },

    /** Asks for location access: "While using the app" first, then "Always"
     * (on Android 10 and later this opens the settings page). */
    async requestAuthorization(): Promise<GeofenceAuthorization> {
      return authorization(await dependencies.native().requestAuthorization());
    },

    async authorization(): Promise<GeofenceAuthorization> {
      return authorization(await dependencies.native().authorization());
    },

    /** Turns geofencing on and fetches the nearest geofences. `maxRegions`
     * caps the regions Sequenzy registers (iOS 20, Android 50 by default);
     * lower it when the app monitors regions of its own. */
    async enable(options: { maxRegions?: number } = {}): Promise<void> {
      await api.start();
      await dependencies.native().enable(options.maxRegions ?? null);
    },

    /** Turns geofencing off and stops watching every Sequenzy region. */
    disable(): Promise<void> {
      return dependencies.native().disable();
    },

    /** Fetches the nearest geofences for the current position now. */
    refresh(): Promise<void> {
      return dependencies.native().refresh();
    },

    async status(): Promise<GeofenceStatus> {
      const raw = await dependencies.native().status();
      const status = {
        enabled: raw["enabled"] === true,
        authorization: authorization(raw["authorization"]),
        preciseLocation: raw["preciseLocation"] === true,
        regionIds: Array.isArray(raw["regionIds"])
          ? raw["regionIds"].filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        queuedEvents:
          typeof raw["queuedEvents"] === "number" ? raw["queuedEvents"] : 0,
        maxRegions:
          typeof raw["maxRegions"] === "number" ? raw["maxRegions"] : 0,
      };
      return {
        ...status,
        isMonitoring:
          status.enabled &&
          status.authorization === "always" &&
          status.preciseLocation,
      };
    },

    /** For tests: forget `start`. */
    stop(): void {
      unsubscribe.forEach((remove) => remove());
      unsubscribe = [];
      started = null;
      syncing = Promise.resolve();
    },
  };
  return api;
}

let nativeModule: GeofenceNativeModule | null = null;

/**
 * Watches the nearest of your geofences with the OS and reports when the
 * signed-in contact enters or leaves one, also while the app is in the
 * background or not running.
 *
 * ```ts
 * Sequenzy.configure({ ... });
 * await SequenzyGeofences.start();
 * // once the user agreed to location-based messages
 * await SequenzyGeofences.requestAuthorization();
 * await SequenzyGeofences.enable();
 * ```
 */
export const SequenzyGeofences = createSequenzyGeofences({
  native: () =>
    (nativeModule ??=
      requireNativeModule<GeofenceNativeModule>("SequenzyGeofences")),
  client: () => Sequenzy.client,
  onIdentityChange: (listener) => Sequenzy.addListener(listener),
  onForeground: (listener) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") listener();
    });
    return () => subscription.remove();
  },
  now: () => Date.now(),
});
