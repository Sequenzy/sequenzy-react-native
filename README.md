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
import { InAppCard, Sequenzy, SequenzyInAppHost, useInAppCards } from "@sequenzy/react-native";
import * as Application from "expo-application";
import { Platform } from "react-native";

Sequenzy.configure({
  publicKey: "seq_pk_...", // key with your app IDs under Allowed app IDs
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

`SequenzyInAppHost` takes `shouldShow`, `onOpenUrl`, `refreshIntervalMs` and
`fonts` (map brand font names to fonts your app bundles; on the web the CSS
stack is used as is).

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
