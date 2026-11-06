// Resolves @sequenzy/react-native and the geofence module to the sources one
// folder up, with a single copy of react and react-native from this example's
// node_modules.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sdk = path.resolve(__dirname, "..");

config.watchFolders = [path.join(sdk, "src"), path.join(sdk, "geofences")];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  "@sequenzy/react-native": path.join(sdk, "src"),
  "@sequenzy/react-native-geofences": path.join(sdk, "geofences/src"),
};

module.exports = config;
