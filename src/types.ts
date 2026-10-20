/** An item in the contact's in-app feed. Mirrors `InAppMessageView` on the server. */
export interface InAppMessage {
  id: string;
  kind: "message" | "card";
  format: "modal" | "banner" | "fullscreen" | null;
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
  sequenceId?: string | null;
  stepId?: string | null;
  createdAt: string;
  expiresAt: string | null;
  displayedAt: string | null;
  clickedAt?: string | null;
  clickCount?: number;
  dismissedAt: string | null;
  readAt: string | null;
}

export interface InAppButton {
  label: string;
  action: "open_url" | "dismiss";
  /** Null for dismiss buttons. */
  url: string | null;
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

export type LogLevel = "none" | "error" | "info" | "debug";

export interface DeviceInfo {
  appVersion?: string | null;
  osVersion?: string | null;
  deviceName?: string | null;
  locale?: string | null;
  timezone?: string | null;
}

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
  storage?: KeyValueStorage;
  device?: DeviceInfo;
  logLevel?: LogLevel;
}

/** AsyncStorage-compatible persistence. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
