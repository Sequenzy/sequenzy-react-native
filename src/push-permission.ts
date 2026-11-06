import type { PushPermissionStatus } from "./types";

/**
 * The shape of expo-notifications' `NotificationPermissionsStatus`, typed
 * here so the SDK does not depend on Expo.
 */
export interface ExpoNotificationPermissions {
  status?: string;
  granted?: boolean;
  /** iOS: `IosAuthorizationStatus` (0 not determined ... 4 ephemeral). */
  ios?: { status?: number | null } | null;
}

const IOS_STATUSES: Record<number, PushPermissionStatus> = {
  0: "not_determined",
  1: "denied",
  2: "granted",
  3: "provisional",
  4: "ephemeral",
};

/**
 * Converts expo-notifications' `getPermissionsAsync()` /
 * `requestPermissionsAsync()` result into a Sequenzy permission:
 *
 * ```ts
 * pushPermission: {
 *   getStatus: async () => pushPermissionFromExpo(await Notifications.getPermissionsAsync()),
 *   request: async () => pushPermissionFromExpo(await Notifications.requestPermissionsAsync()),
 * }
 * ```
 */
export function pushPermissionFromExpo(
  permissions: ExpoNotificationPermissions
): PushPermissionStatus {
  const iosStatus = permissions.ios?.status;
  if (typeof iosStatus === "number" && iosStatus in IOS_STATUSES) {
    return IOS_STATUSES[iosStatus] ?? "not_determined";
  }
  if (permissions.granted === true || permissions.status === "granted") {
    return "granted";
  }
  return permissions.status === "denied" ? "denied" : "not_determined";
}
