import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ConnectionProvider } from "../src/connection/ConnectionProvider";

export default function RootLayout() {
  return (
    <ConnectionProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
    </ConnectionProvider>
  );
}
