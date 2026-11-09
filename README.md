# Sequenzy for React Native

The official React Native SDK for [Sequenzy](https://sequenzy.com), the email
marketing platform for SaaS. Identify contacts, track events, register push tokens and show in-app
messages and content cards from React Native and Expo apps. Plain TypeScript:
works in Expo Go, no native build. Events from your app start the same
sequences as your emails, and push and in-app messages are steps in them.
Full guide: [Mobile SDKs](https://docs.sequenzy.com/concepts/mobile-sdks).

## Install

```bash
npx expo install @sequenzy/react-native @react-native-async-storage/async-storage expo-application
```

Without AsyncStorage the SDK keeps its state in memory and logs a warning.

## Use

```tsx
import { InAppCard, pushPermissionFromExpo, Sequenzy, SequenzyInAppHost, useInAppCards } from "@sequenzy/react-native";
import * as Notifications from "expo-notifications";
import * as Application from "expo-application";
import { Platform } from "react-native";

Sequenzy.configure({
  publicKey: "seq_pk_...", // key with your app IDs under Allowed app IDs
  // Optional: lets Sequenzy see who allows notifications and show push
  // primers (in-app messages that ask). With expo-notifications:
  pushPermission: {
    getStatus: async () => pushPermissionFromExpo(await Notifications.getPermissionsAsync()),
    request: async () => pushPermissionFromExpo(await Notifications.requestPermissionsAsync()),
  },
  companyId: "your-company-id",
  appId: Application.applicationId!,
  platform: Platform.OS === "ios" ? "ios" : "android",
  identityTokenProvider: (email) => myBackend.sequenzyToken(email),
});

export default function App() {
  return (
    <>
      <Navigation />
      <SequenzyInAppHost /> {/* shows in-app messages over the app */}
    </>
  );
}

await Sequenzy.identify(user.email); // after sign-in; resolves false for an invalid email
await Sequenzy.identifyUser(user.id); // or by your user ID, for users without an email
Sequenzy.track("workout_completed", { minutes: 30 });
// The native token: Expo getDevicePushTokenAsync(), or with React Native
// Firebase messaging().getAPNSToken() on iOS and getToken() on Android.
await Sequenzy.setPushToken(nativeApnsOrFcmToken);
await Sequenzy.handleNotificationResponse(notificationData); // on tap
await Sequenzy.reset(); // on sign-out

function Inbox() {
  const { cards, dismiss, markRead } = useInAppCards();
  return cards.map((card) => <InAppCard key={card.id} card={card} onDismiss={dismiss} />);
}
```

iOS Live Activities need Swift for the widget and ActivityKit. Forward the
tokens your native module receives so your backend can start, update and end
activities through Sequenzy:

```ts
await Sequenzy.registerLiveActivityToken({ kind: "push_to_start", activityType: "DeliveryAttributes", token });
await Sequenzy.registerLiveActivityToken({ kind: "update", activityType: "DeliveryAttributes", activityId: "order-1234", token });
await Sequenzy.liveActivityEnded(token); // when the activity ends or is dismissed
```

On sign-out, end your running activities in native code before
`Sequenzy.reset()`, so the next person never sees them.

Android Live Updates take the same backend calls. The SDK keeps their state
and tokens; your notification library (for example Notifee) draws them:

```ts
await Sequenzy.observeLiveUpdates("DeliveryAttributes"); // at launch, on Android
// in messaging().onMessage and setBackgroundMessageHandler:
// canShow: false when notifications are off or you don't draw this type
const decision = await Sequenzy.handleLiveUpdate(remoteMessage.data, { canShow: true });
if (decision?.action === "show") {
  // post or update the notification for decision.activity.activityId:
  // ongoing until decision.activity.isEnded, removed at decision.dismissAtMs
}
await Sequenzy.liveUpdateDismissed(activityId); // Notifee's DISMISSED event
```

`startLiveUpdate`, `updateLiveUpdate` and `endLiveUpdate` change one from the
app, and `onLiveUpdatesRemoved` in the config lists the notifications to
cancel after sign-out. On Hermes, install `react-native-get-random-values` so
Live Update tokens come from a secure random source.

Device registrations report the timezone `Intl` gives, so push campaigns can
deliver in each contact's local time. Pass `device: { timezone }` to override
it, or `timezone: null` to send none.

`SequenzyInAppHost` takes `shouldShow`, `onOpenUrl`, `refreshIntervalMs` and
`fonts` (map brand font names to fonts your app bundles; on the web the CSS
stack is used as is).

## Placements

Show in-app content inline, in a slot of your own layout, for a
[placement](https://docs.sequenzy.com/concepts/in-app-placements) defined in Sequenzy. Nothing renders while
the contact has nothing to show, so the slot collapses.

```tsx
import { SequenzyPlacement, usePlacement } from "@sequenzy/react-native";

<SequenzyPlacement placementId="home_hero" />

// Or draw it yourself:
const { item, logDisplayed, dismiss } = usePlacement("home_hero");
```

## Geofencing

[`@sequenzy/react-native-geofences`](./geofences), an Expo module, watches
your [geofences](https://docs.sequenzy.com/concepts/geofences) natively on iOS
and Android and reports visits of the signed-in contact, also while the app is
not running:

```ts
await SequenzyGeofences.start(); // after Sequenzy.configure
await SequenzyGeofences.requestAuthorization();
await SequenzyGeofences.enable();
```

Apps that monitor regions themselves call `Sequenzy.fetchNearbyGeofences` and
`Sequenzy.trackGeofenceTransition` instead.

## Custom HTML messages

[Custom HTML in-app messages](https://docs.sequenzy.com/concepts/in-app-html-messages) (surveys, Braze-style custom HTML) need
`react-native-webview`. Install it and pass its `WebView`:

```tsx
import { WebView } from "react-native-webview";

<SequenzyInAppHost webView={WebView} />;
```

Without `webView`, HTML messages stay in the feed for an app version that can
show them. The web view runs incognito with shared and third-party cookies
off; links open through `onOpenUrl`.

## Develop

```bash
bun install && bun run typecheck && bun test
cd example && bun install && bunx expo start --web
```

Tests run against `../contract/fixtures`. This repository is updated from Sequenzy's SDK
sources with every release.

## Links

- [Sequenzy](https://sequenzy.com): email marketing, push, SMS and in-app
  messages for SaaS, with automated sequences and AI-written emails.
- [Mobile SDK guide](https://docs.sequenzy.com/concepts/mobile-sdks)
- [Push notifications](https://docs.sequenzy.com/concepts/push-notifications)
  and [in-app messages](https://docs.sequenzy.com/concepts/in-app-messages)
- [Pricing](https://sequenzy.com/pricing)
- Other Sequenzy SDKs: [iOS](https://github.com/Sequenzy/sequenzy-swift), [Android](https://github.com/Sequenzy/sequenzy-android), [Flutter](https://github.com/Sequenzy/sequenzy-flutter)

## Users without an email

For users who sign in without an email (a hidden Apple address, phone login),
mint the identity token for your user ID as `externalId` and call
`identifyUser` with the same ID (and the email, when you minted with it). Set
`userIdentityTokenProvider` to renew these tokens. See
[Users without an email](https://docs.sequenzy.com/concepts/mobile-sdks#users-without-an-email).
