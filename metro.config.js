const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite needs .wasm treated as a static asset, not parsed as JS.
config.resolver.assetExts.push('wasm');

// On web, replace AccessHandlePoolVFS with a patched version that skips pool
// files whose sync access handles are held by an orphaned Fast Refresh worker,
// instead of throwing and crashing the entire SQLite initialisation.
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === 'web' &&
    moduleName === './wa-sqlite/AccessHandlePoolVFS' &&
    context.originModulePath.includes('expo-sqlite')
  ) {
    return {
      filePath: path.resolve(__dirname, 'patches/AccessHandlePoolVFS.js'),
      type: 'sourceFile',
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
