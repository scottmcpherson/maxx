import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ChatApp } from "../src/chat/ChatApp";
import { PairingScreen } from "../src/pairing/PairingScreen";
import { useConnection } from "../src/connection/ConnectionProvider";
import { colors } from "../src/theme";

export default function Index() {
  const { state, workspace } = useConnection();

  if (state.status === "loading" || state.status === "connecting") {
    return (
      <View style={styles.loading} accessibilityLabel="Connecting to Maxx">
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (state.status === "unpaired" || !workspace) return <PairingScreen />;
  return <ChatApp />;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
});
