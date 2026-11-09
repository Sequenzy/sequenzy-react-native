/** An item in the contact's in-app feed. Mirrors `InAppMessageView` on the server. */
export interface InAppMessage {
  id: string;
  /** `placement`: shown inline by `SequenzyPlacement`, never in the feed. */
  kind: "message" | "card" | "placement";
  /** `html`: a custom HTML message, shown by `SequenzyInAppHost` with a `webView`. */
  format: InAppFormat | null;
  /** Banners: top or bottom. Modals: bottom (a sheet) or center. */
  position: "top" | "bottom" | "center" | null;
  /** Short line above the title; may be missing from older servers. */
  eyebrow?: string;
  title: string;
  body: string;
  imageUrl: string | null;
  /** Modals and full screens with an image. */
  imagePlacement?: "top" | "background" | null;
  buttons: InAppButton[];
  data: Record<string, string>;
  style: InAppStyle;
  pinned: boolean;
  /** Placement items: the placement key they fill. */
  placement?: string | null;
  /** Placement items: how the item is drawn; missing or unknown = card. */
  layout?: "card" | "banner" | "hero" | null;
  sequenceId?: string | null;
  stepId?: string | null;
  createdAt: string;
  expiresAt: string | null;
  displayedAt: string | null;
  clickedAt?: string | null;
  clickCount?: number;
  dismissedAt: string | null;
  readAt: string | null;
  /** `html` messages: the document to load, with the Sequenzy bridge already in it. */
  html?: string | null;
  /** `html` messages: draw a close button over the document. */
  showCloseButton?: boolean;
}

export type InAppFormat = "modal" | "banner" | "fullscreen" | "html";

export interface InAppButton {
  label: string;
  /**
   * `request_push_permission` (a push primer) asks for notification
   * permission; feeds include it only when `pushPermission` is configured.
   */
  action: "open_url" | "dismiss" | "request_push_permission";
  /** Null unless the button opens a link. */
  url: string | null;
}

/**
 * The OS notification permission. `provisional` (iOS) delivers quietly to
 * Notification Center; `ephemeral` is an App Clip's temporary permission.
 */
export type PushPermissionStatus =
  "granted" | "provisional" | "ephemeral" | "denied" | "not_determined";

/**
 * How the SDK reads and asks for notification permission. React Native has
 * no built-in API for it, so pass your notifications library's calls, for
 * example expo-notifications through `pushPermissionFromExpo`.
 */
export interface PushPermissionHandler {
  /** The current permission, without prompting. */
  getStatus(): Promise<PushPermissionStatus>;
  /** Shows the system prompt (when the OS still allows it) and returns the result. */
  request(): Promise<PushPermissionStatus>;
  /**
   * Opens the app's notification settings, for contacts who turned
   * notifications off. Defaults to `Linking.openSettings()`.
   */
  openSettings?(): Promise<unknown> | unknown;
}

/** Resolved colors (`#rrggbb`), radii and the brand font stack. */
export interface InAppStyle {
  preset?: string;
  backgroundColor: string;
  textColor: string;
  mutedTextColor: string;
  buttonColor: string;
  buttonTextColor: string;
  cornerRadius: number;
  buttonRadius: number;
  fontFamily: string;
}

export type InAppEventType = "displayed" | "clicked" | "dismissed" | "read";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type EventProperties = Record<string, JsonValue>;

/** A product, with the same fields as the web SDK's `viewedProduct`. */
export interface CommerceProduct {
  providerProductId: string;
  providerVariantId?: string;
  title?: string;
  variantTitle?: string;
  imageUrl?: string;
  url?: string;
  /** Major units, e.g. 19.99; or pass priceCents. */
  price?: number;
  priceCents?: number;
  currency?: string;
  sku?: string;
}

export interface CommerceCartLine extends CommerceProduct {
  quantity: number;
  lineItemId?: string;
}

export interface CommerceCart {
  cartId?: string;
  /** Number of distinct lines. */
  itemCount: number;
  totalQuantity?: number;
  totalPriceCents?: number;
  currency?: string;
  lineItems: CommerceCartLine[];
}

export interface CommerceCollection {
  providerCollectionId: string;
  title?: string;
  handle?: string;
  url?: string;
}

/**
 * A change to the signed-in contact's profile. Omitted fields stay as they
 * are; null clears a name or an attribute.
 */
export interface ProfileUpdate {
  firstName?: string | null;
  lastName?: string | null;
  attributes?: EventProperties;
}

export interface SubscribeInput {
  /** A published Sequenzy form: its lists, tags and opt-in settings apply. */
  formId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** For forms with a phone field; E.164 such as +14155550123. */
  phone?: string;
  /** Values for the form's custom fields. */
  attributes?: EventProperties;
}

export type SubscribeResult =
  { ok: true } | { ok: false; error: string; retryable: boolean };

/** The fields Sequenzy adds to every push notification. */
export interface PushPayload {
  title: string;
  body: string;
  url: string | null;
  imageUrl: string | null;
  pushSendId: string;
  deviceId: string;
  clickToken: string;
  eventsUrl: string;
}

/**
 * An ActivityKit push token from your app's native Live Activity code (iOS).
 * `push_to_start` tokens (iOS 17.2+, one per ActivityAttributes type) let
 * your backend start activities; `update` tokens (one per running activity)
 * let it update and end them. On Android the SDK generates these tokens
 * for Live Updates (`observeLiveUpdates`, `handleLiveUpdate`).
 */
export interface LiveActivityToken {
  kind: "push_to_start" | "update";
  /** The Swift ActivityAttributes type name, e.g. "DeliveryAttributes". */
  activityType: string;
  /** Update tokens: the activity's `sequenzy.activityId` attribute. */
  activityId?: string;
  /** The token data as hex. */
  token: string;
}

/** An Android Live Update the app starts itself (`startLiveUpdate`). */
export interface LiveUpdateActivityInput {
  /** The same name as your iOS ActivityAttributes type, e.g. "DeliveryAttributes". */
  activityType: string;
  /** The id your backend updates and ends it with, e.g. "order-1234". */
  activityId: string;
  attributes?: Record<string, unknown>;
  contentState?: Record<string, unknown>;
  staleDateMs?: number | null;
}

export type {
  LiveUpdateActivity,
  LiveUpdateAlert,
  LiveUpdateDecision,
  LiveUpdateEvent,
  LiveUpdatePayload,
} from "./live-updates";

export type LogLevel = "none" | "error" | "info" | "debug";

export interface DeviceInfo {
  appVersion?: string | null;
  osVersion?: string | null;
  deviceName?: string | null;
  locale?: string | null;
  /**
   * IANA timezone, used to deliver push campaigns in the contact's local
   * time. Defaults to the zone `Intl` reports; pass null to not send one.
   */
  timezone?: string | null;
}

export type UserIdentityTokenProvider = (identity: {
  externalId: string;
  email: string | null;
}) => Promise<string>;

export interface SequenzyConfig {
  /** Publishable key (`seq_pk_...`) restricted to your app IDs. */
  publicKey: string;
  companyId: string;
  /**
   * Bundle ID (iOS) or package name (Android), sent as `x-sequenzy-app-id`.
   * With Expo, use `Application.applicationId` from expo-application.
   */
  appId: string;
  /** `ios` or `android`; usually `Platform.OS`. */
  platform: "ios" | "android" | "web";
  apiBaseUrl?: string;
  /** Asks your backend for a fresh identity token for `email`. */
  identityTokenProvider?: (email: string) => Promise<string>;
  /**
   * Asks your backend for a fresh identity token for a user identified with
   * `identifyUser`: mint it for `externalId`, plus `email` when it is set.
   */
  userIdentityTokenProvider?: UserIdentityTokenProvider;
  storage?: KeyValueStorage;
  device?: DeviceInfo;
  logLevel?: LogLevel;
  /**
   * Reads and requests notification permission. With it the SDK reports
   * each device's permission (for your opt-in rate and the contact's
   * `pushPermission` attribute) and shows push primers: in-app messages
   * whose button asks for permission.
   */
  pushPermission?: PushPermissionHandler;
  /**
   * Android Live Updates: called with the activity ids whose notifications
   * to remove, after `reset()` or when another person signs in. Cancel
   * them in your notification library.
   */
  onLiveUpdatesRemoved?: (activityIds: string[]) => void;
}

/** AsyncStorage-compatible persistence. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
