// Expo config plugin. In app.json:
//   "plugins": [["@sequenzy/react-native-geofences", {
//     "whenInUsePermission": "...", "alwaysPermission": "..." }]]
// Adds the iOS location usage strings; the Android permissions come from the
// module's manifest.
module.exports = function withSequenzyGeofences(config, options = {}) {
  // Expo's own copy, also when this package is linked from outside the app.
  const projectRoot = config._internal?.projectRoot ?? process.cwd();
  const { withInfoPlist } = require(
    require.resolve("expo/config-plugins", { paths: [projectRoot, __dirname] })
  );
  return withInfoPlist(config, (next) => {
    const plist = next.modResults;
    plist.NSLocationWhenInUseUsageDescription =
      options.whenInUsePermission ??
      plist.NSLocationWhenInUseUsageDescription ??
      "Your location is used to tell you about places nearby.";
    plist.NSLocationAlwaysAndWhenInUseUsageDescription =
      options.alwaysPermission ??
      plist.NSLocationAlwaysAndWhenInUseUsageDescription ??
      "Your location is used to tell you about places you arrive at, even when the app is closed.";
    return next;
  });
};
