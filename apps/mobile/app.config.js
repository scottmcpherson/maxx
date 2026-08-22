const primary = process.env.MAXX_DEV_PRIMARY !== "0";
const instanceID = process.env.MAXX_DEV_INSTANCE_ID || "wprimary";
const label = process.env.MAXX_DEV_LABEL || "main";
const name = primary ? "Maxx Mobile" : `Maxx Mobile - ${label}`;
const slug = primary ? "maxx-mobile" : `maxx-mobile-${instanceID}`;
const scheme = primary ? "maxx-mobile" : `maxx-mobile-${instanceID}`;
const bundleIdentifier = primary ? "com.maxx.mobile" : `com.maxx.mobile.dev.${instanceID}`;

module.exports = {
  expo: {
    name,
    slug,
    version: "0.1.0",
    orientation: "portrait",
    scheme,
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      bundleIdentifier,
      supportsTablet: true,
      infoPlist: {
        NSLocalNetworkUsageDescription: `${name} connects securely to Maxx on your computer through Tailscale.`,
        NSCameraUsageDescription: `Allow ${name} to scan pairing codes and attach photos.`,
        NSPhotoLibraryUsageDescription: `Allow ${name} to attach photos to chats.`,
        NSMicrophoneUsageDescription: `Allow ${name} to dictate messages.`,
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      },
    },
    plugins: [
      "expo-router",
      [
        "expo-camera",
        {
          cameraPermission: `Allow ${name} to scan pairing codes and attach photos.`,
          barcodeScannerEnabled: true,
          recordAudioAndroid: false,
        },
      ],
      [
        "expo-audio",
        {
          microphonePermission: `Allow ${name} to dictate messages.`,
          enableBackgroundRecording: false,
          enableBackgroundPlayback: false,
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission: `Allow ${name} to attach photos to chats.`,
          cameraPermission: `Allow ${name} to take photos for chats.`,
          microphonePermission: false,
        },
      ],
      "expo-secure-store",
    ],
    experiments: { typedRoutes: true, reactCompiler: true },
    android: { package: bundleIdentifier },
  },
};
