import { Linking } from "react-native";

import {
  SequenzyClient,
  SequenzyError,
  type ClientDependencies,
} from "./client";
import {
  DEFAULT_MAX_REGIONS_IOS,
  geofenceFetchLimit,
  type GeofenceTransition,
  type NearbyGeofences,
} from "./geofences";
import { parsePushPayload } from "./push";
import type {
  CommerceCart,
  CommerceCartLine,
  CommerceCollection,
  CommerceProduct,
  ProfileUpdate,
  SubscribeInput,
  SubscribeResult,
  EventProperties,
  InAppButton,
  InAppEventType,
  InAppMessage,
  LiveActivityToken,
  LiveUpdateActivity,
  LiveUpdateActivityInput,
  LiveUpdateDecision,
  PushPermissionStatus,
  SequenzyConfig,
} from "./types";

/** `email`: the contact identified, normalized; absent on reset. */
type Listener = (event: "identified" | "reset", email?: string) => void;

let client: SequenzyClient | null = null;
const listeners = new Set<Listener>();
let openUrl: (url: string) => Promise<unknown> | unknown = () => undefined;
const openAppSettings = () => Linking.openSettings().catch(() => undefined);
let openSettings: () => Promise<unknown> | unknown = openAppSettings;

function requireClient(): SequenzyClient {
  if (!client) {
    throw new SequenzyError(
      "Call Sequenzy.configure(...) first",
      "not_identified"
    );
  }
  return client;
}

function emit(event: "identified" | "reset", email?: string) {
  for (const listener of listeners) listener(event, email);
}

/**
 * The Sequenzy SDK for React Native and Expo.
 *
 * ```ts
 * Sequenzy.configure({ publicKey, companyId, appId, platform: Platform.OS });
 * await Sequenzy.identify(user.email, tokenFromYourBackend);
 * Sequenzy.track("workout_completed", { minutes: 30 });
 * ```
 */
export const Sequenzy = {
  configure(
    config: SequenzyConfig,
    dependencies?: ClientDependencies
  ): SequenzyClient {
    if (!client) client = new SequenzyClient(config, dependencies);
    return client;
  },

  /** For tests: forget the configured client. */
  unconfigure(): void {
    client = null;
    listeners.clear();
    openSettings = openAppSettings;
  },

  get client(): SequenzyClient | null {
    return client;
  },

  /** How the SDK opens URLs; the React layer sets this to `Linking.openURL`. */
  setUrlOpener(opener: (url: string) => Promise<unknown> | unknown): void {
    openUrl = opener;
  },

  /**
   * How the SDK opens the app's settings when `pushPermission.openSettings`
   * is not set. Defaults to `Linking.openSettings()`.
   */
  setSettingsOpener(opener: () => Promise<unknown> | unknown): void {
    openSettings = opener;
  },

  /**
   * Asks for notification permission (needs `pushPermission` in configure):
   * the system prompt when the OS still shows one, otherwise the app's
   * notification settings. Returns the permission afterwards.
   */
  requestPushPermission(): Promise<PushPermissionStatus | null> {
    return requireClient().requestPushPermission(openSettings);
  },

  /**
   * Links this installation to `email`. Resolves false (and logs why) when the
   * email is not valid; listeners only hear about successful identifies.
   */
  async identify(
    email: string,
    identityToken?: string | null
  ): Promise<boolean> {
    const current = requireClient();
    await current.identify(email, identityToken);
    const identified =
      (await current.getEmail()) === email.trim().toLowerCase();
    if (identified) emit("identified", email.trim().toLowerCase());
    return identified;
  },

  /**
   * Links this installation to the contact with your own user ID, for users
   * without an email. Pass `email` too when you have it; the identity token
   * must be minted for exactly these identifiers. Resolves false (and logs
   * why) when the ID or email is not valid.
   */
  async identifyUser(
    externalId: string,
    options: { email?: string | null; identityToken?: string | null } = {}
  ): Promise<boolean> {
    const current = requireClient();
    await current.identifyUser(externalId, options);
    const identified =
      (await current.getExternalId()) === externalId.trim() &&
      (await current.getEmail()) ===
        (options.email ? options.email.trim().toLowerCase() : null);
    if (identified) {
      emit(
        "identified",
        options.email ? options.email.trim().toLowerCase() : undefined
      );
    }
    return identified;
  },

  /** The identified contact's normalized email, or null. */
  identifiedEmail(): Promise<string | null> {
    return client ? client.getEmail() : Promise.resolve(null);
  },

  /**
   * One string per identified contact (the external ID or the email), or null
   * while anonymous: compare it to notice that another user signed in.
   */
  identifiedContact(): Promise<string | null> {
    return client ? client.getContactKey() : Promise.resolve(null);
  },

  async reset(): Promise<void> {
    await requireClient().reset();
    emit("reset");
  },

  track(name: string, properties?: EventProperties): Promise<void> {
    return requireClient().track(name, properties);
  },

  /** Records a screen view as the built-in "Screen Viewed" event. */
  screen(name: string, properties?: EventProperties): Promise<void> {
    return requireClient().screen(name, properties);
  },

  viewedProduct(product: CommerceProduct): Promise<void> {
    return requireClient().viewedProduct(product);
  },

  addedToCart(line: CommerceCartLine): Promise<void> {
    return requireClient().addedToCart(line);
  },

  removedFromCart(line: CommerceCartLine): Promise<void> {
    return requireClient().removedFromCart(line);
  },

  viewedCart(cart: CommerceCart): Promise<void> {
    return requireClient().viewedCart(cart);
  },

  viewedCollection(collection: CommerceCollection): Promise<void> {
    return requireClient().viewedCollection(collection);
  },

  searched(query: string): Promise<void> {
    return requireClient().searched(query);
  },

  /** Name and custom attributes of the signed-in contact. */
  setProfile(update: ProfileUpdate): Promise<void> {
    return requireClient().setProfile(update);
  },

  /** Newsletter or waitlist signup through a published form. */
  subscribe(input: SubscribeInput): Promise<SubscribeResult> {
    return requireClient().subscribe(input);
  },

  flush(): Promise<void> {
    return requireClient().flush();
  },

  /**
   * Registers the native device token, e.g. from Expo
   * `getDevicePushTokenAsync()` or Firebase Messaging's `getToken()` on
   * Android and `getAPNSToken()` on iOS. Not the Expo push token: Sequenzy
   * sends through APNs and FCM directly.
   */
  setPushToken(token: string): Promise<void> {
    return requireClient().setPushToken(token);
  },

  /**
   * iOS Live Activities: pass the ActivityKit tokens your native code (a
   * Swift module or a library such as expo-live-activity) receives, so your
   * backend can start, update and end activities through Sequenzy.
   */
  registerLiveActivityToken(token: LiveActivityToken): Promise<void> {
    return requireClient().registerLiveActivityToken(token);
  },

  /** Call when an activity ends or is dismissed, with its update token. */
  liveActivityEnded(token: string): Promise<void> {
    return requireClient().liveActivityEnded(token);
  },

  /**
   * Android Live Updates: reports this device can start activities of
   * `activityType` (the same name as your iOS ActivityAttributes type, so
   * one backend call reaches both). Call at launch for each type you draw.
   */
  observeLiveUpdates(activityType: string): Promise<void> {
    return requireClient().observeLiveUpdates(activityType);
  },

  /**
   * Android Live Updates: pass `remoteMessage.data` from Firebase
   * Messaging's `onMessage` and `setBackgroundMessageHandler`. Returns what
   * to show (post or update the notification with id `activityId`), or
   * null for other messages.
   */
  handleLiveUpdate(
    data: unknown,
    options?: { canShow?: boolean }
  ): Promise<LiveUpdateDecision | null> {
    return requireClient().handleLiveUpdate(data, options);
  },

  /** Android Live Updates: starts an activity from the app; your backend updates and ends it by `activityId`. */
  startLiveUpdate(input: LiveUpdateActivityInput): Promise<LiveUpdateDecision> {
    return requireClient().startLiveUpdate(input);
  },

  /** Android Live Updates: updates a running activity from the app. */
  updateLiveUpdate(
    activityId: string,
    contentState: Record<string, unknown>
  ): Promise<LiveUpdateDecision> {
    return requireClient().updateLiveUpdate(activityId, contentState);
  },

  /** Android Live Updates: ends a running activity from the app. */
  endLiveUpdate(
    activityId: string,
    input?: { contentState?: Record<string, unknown>; dismissAtMs?: number }
  ): Promise<LiveUpdateDecision> {
    return requireClient().endLiveUpdate(activityId, input);
  },

  /** Android Live Updates: call when the person swipes one away. */
  liveUpdateDismissed(activityId: string): Promise<void> {
    return requireClient().liveUpdateDismissed(activityId);
  },

  /** Android Live Updates this device shows now. */
  getLiveUpdates(): Promise<LiveUpdateActivity[]> {
    return requireClient().getLiveUpdates();
  },

  /**
   * Call when the user taps a notification, with its data object. Reports the
   * click and opens the push URL. Returns false for other senders.
   */
  async handleNotificationResponse(
    data: unknown,
    options: { openUrl?: boolean } = {}
  ): Promise<boolean> {
    const payload = parsePushPayload(data);
    if (!payload) return false;
    await requireClient().reportPush("clicked", payload);
    if (payload.url && options.openUrl !== false) await openUrl(payload.url);
    return true;
  },

  /** Call when a notification arrives while the app is open. */
  async handleNotificationReceived(data: unknown): Promise<boolean> {
    const payload = parsePushPayload(data);
    if (!payload) return false;
    await requireClient().reportPush("delivered", payload);
    return true;
  },

  /** The nearest active geofences around a position. Usually called by
   * `@sequenzy/react-native-geofences` rather than the app. */
  fetchNearbyGeofences(
    position: { latitude: number; longitude: number },
    limit = geofenceFetchLimit(DEFAULT_MAX_REGIONS_IOS)
  ): Promise<NearbyGeofences> {
    return requireClient().fetchNearbyGeofences(position, limit);
  },

  /** Reports an enter or exit your own region monitoring saw. */
  trackGeofenceTransition(
    geofenceId: string,
    transition: GeofenceTransition,
    at?: Date
  ): Promise<boolean> {
    return requireClient().trackGeofenceTransition(geofenceId, transition, at);
  },

  /**
   * Open in-app messages, for apps that present them themselves. Custom HTML
   * messages are included only with `includeHtml`.
   */
  fetchMessages(
    options: { includeHtml?: boolean } = {}
  ): Promise<InAppMessage[]> {
    return requireClient().fetchFeed({
      kind: "message",
      ...(options.includeHtml
        ? { formats: ["modal", "banner", "fullscreen", "html"] }
        : {}),
    });
  },

  /**
   * What each placement shows the identified contact (null: collapse the
   * slot). `SequenzyPlacement` and `usePlacement` call this for you.
   */
  fetchPlacements(
    placements: string[]
  ): Promise<Record<string, InAppMessage | null>> {
    return requireClient().fetchPlacements(placements);
  },

  fetchCards(limit?: number): Promise<InAppMessage[]> {
    return requireClient().fetchFeed({
      kind: "card",
      ...(limit ? { limit } : {}),
    });
  },

  report(
    type: InAppEventType,
    message: Pick<InAppMessage, "id">,
    buttonId?: string
  ): Promise<boolean> {
    return requireClient().report(type, message.id, buttonId);
  },

  /**
   * Reports the click and performs the button's action: opens its URL, or
   * asks for push permission and reports the result with the click.
   */
  async handleButtonPress(
    button: InAppButton,
    message: Pick<InAppMessage, "id">
  ): Promise<void> {
    const current = requireClient();
    if (button.action === "dismiss") {
      await current.report("dismissed", message.id);
      return;
    }
    if (button.action === "request_push_permission") {
      const pushPermission = await current.requestPushPermission(openSettings);
      await current.report("clicked", message.id, undefined, {
        pushPermission,
      });
      return;
    }
    await current.report("clicked", message.id);
    if (button.url) await openUrl(button.url);
  },

  /** Subscribe to identify/reset, e.g. to refresh a cards screen. */
  addListener(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
