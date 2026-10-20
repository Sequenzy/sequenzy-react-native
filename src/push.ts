import type { PushPayload } from "./types";

function read(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Finds the Sequenzy fields in a notification's data, whatever library
 * delivered it:
 *
 * - expo-notifications: `notification.request.content.data`
 * - @react-native-firebase/messaging: `remoteMessage.data`
 * - an APNs `userInfo` object with a nested `sequenzy` key
 *
 * Returns null for notifications from other senders.
 */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const nested = record["sequenzy"];
  const source =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : record;
  const pushSendId = read(source, "pushSendId");
  const deviceId = read(source, "deviceId");
  const clickToken = read(source, "clickToken");
  const eventsUrl = read(source, "eventsUrl");
  if (!pushSendId || !deviceId || !clickToken || !eventsUrl) return null;
  if (!/^https?:\/\//.test(eventsUrl)) return null;
  return {
    title: read(source, "title") ?? "",
    body: read(source, "body") ?? "",
    url: read(source, "url"),
    imageUrl: read(source, "imageUrl"),
    pushSendId,
    deviceId,
    clickToken,
    eventsUrl,
  };
}
