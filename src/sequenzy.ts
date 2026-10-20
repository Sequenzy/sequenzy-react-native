import {
  SequenzyClient,
  SequenzyError,
  type ClientDependencies,
} from "./client";
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
  SequenzyConfig,
} from "./types";

type Listener = (event: "identified" | "reset") => void;

let client: SequenzyClient | null = null;
const listeners = new Set<Listener>();
let openUrl: (url: string) => Promise<unknown> | unknown = () => undefined;

function requireClient(): SequenzyClient {
  if (!client) {
    throw new SequenzyError(
      "Call Sequenzy.configure(...) first",
      "not_identified"
    );
  }
  return client;
}

function emit(event: "identified" | "reset") {
  for (const listener of listeners) listener(event);
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
  },

  get client(): SequenzyClient | null {
    return client;
  },

  /** How the SDK opens URLs; the React layer sets this to `Linking.openURL`. */
  setUrlOpener(opener: (url: string) => Promise<unknown> | unknown): void {
    openUrl = opener;
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
    if (identified) emit("identified");
    return identified;
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

  fetchMessages(): Promise<InAppMessage[]> {
    return requireClient().fetchFeed({ kind: "message" });
  },

  fetchCards(limit?: number): Promise<InAppMessage[]> {
    return requireClient().fetchFeed({
      kind: "card",
      ...(limit ? { limit } : {}),
    });
  },

  report(
    type: InAppEventType,
    message: Pick<InAppMessage, "id">
  ): Promise<boolean> {
    return requireClient().report(type, message.id);
  },

  /** Reports the click and opens the button's URL. */
  async handleButtonPress(
    button: InAppButton,
    message: Pick<InAppMessage, "id">
  ): Promise<void> {
    if (button.action === "dismiss") {
      await requireClient().report("dismissed", message.id);
      return;
    }
    await requireClient().report("clicked", message.id);
    if (button.url) await openUrl(button.url);
  },

  /** Subscribe to identify/reset, e.g. to refresh a cards screen. */
  addListener(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
