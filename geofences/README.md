# Sequenzy geofencing for React Native

Reports when the signed-in contact enters or leaves your
[Sequenzy geofences](https://docs.sequenzy.com/concepts/geofences), so visits
can start sequences and build segments. Region monitoring is native (Core
Location on iOS, Google Play services on Android) and keeps working while the
app is in the background or not running.

This is an [Expo module](https://docs.expo.dev/modules/overview/): it needs a
development build (`npx expo run:ios`), not Expo Go. Bare React Native apps
need `expo` installed (`npx install-expo-modules`).

## Install

```sh
npx expo install @sequenzy/react-native @sequenzy/react-native-geofences
```

```json
{
  "expo": {
    "plugins": [
      [
        "@sequenzy/react-native-geofences",
        {
          "whenInUsePermission": "Shows offers for stores near you.",
          "alwaysPermission": "Tells you about offers when you arrive at a store, even when the app is closed."
        }
      ]
    ]
  }
}
```

The config plugin adds the iOS location usage strings. On Android the module
declares fine, coarse and background location; Google Play asks apps that use
background location for a declaration.

## Use

```ts
import { Sequenzy } from "@sequenzy/react-native";
import { SequenzyGeofences } from "@sequenzy/react-native-geofences";

Sequenzy.configure({ ... });
void SequenzyGeofences.start(); // every launch, after configure

// Once the user agreed to location-based messages:
await SequenzyGeofences.requestAuthorization(); // "While using", then "Always"
await SequenzyGeofences.enable();

await SequenzyGeofences.disable(); // the user withdrew consent
const status = await SequenzyGeofences.status();
```

Only identified contacts are tracked: nothing is watched or sent until
`Sequenzy.identify` succeeds, and `Sequenzy.reset` stops it. Geofencing needs
"Always" access with precise location. The module registers the nearest
geofences (19 on iOS, 49 on Android; lower with `enable({ maxRegions })` when
the app watches regions of its own) plus one region around the device, and
fetches the next ones when the device leaves it.

Native code reports transitions itself while JavaScript is not running, with
the identity token the module last handed it. Configure an
`identityTokenProvider`: tokens that expire within three days, or that the
server rejects, are replaced through it. A visit recorded without a
connection is sent with the next visit, or when the app starts or opens,
within 24 hours.

Apps that monitor regions themselves can skip this module and call
`Sequenzy.fetchNearbyGeofences` and `Sequenzy.trackGeofenceTransition` from
`@sequenzy/react-native`.

## Links

- [Geofences guide](https://docs.sequenzy.com/concepts/geofences)
- [Mobile SDKs guide](https://docs.sequenzy.com/concepts/mobile-sdks)
