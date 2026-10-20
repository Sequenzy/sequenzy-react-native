// Resolves @sequenzy/react-native to the SDK sources one folder up, with a
// single copy of react and react-native from this example's node_modules.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sdk = path.resolve(__dirname, "..");

config.watchFolders = [path.join(sdk, "src")];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;
config.resolver.extraNodeModules = {
  "@sequenzy/react-native": path.join(sdk, "src"),
};

module.exports = config;
