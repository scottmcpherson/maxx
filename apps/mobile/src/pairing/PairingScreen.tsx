import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import { useConnection } from "../connection/ConnectionProvider";
import { parsePairingPayload, type MaxxMobilePairingPayload } from "../connection/pairingPayload";
import { GlassPill } from "../components/GlassButton";
import { colors, spacing } from "../theme";

export function PairingScreen() {
  const { pair, pairManually, state, reconnect, forget } = useConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [candidate, setCandidate] = useState<MaxxMobilePairingPayload | null>(null);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const disconnected = state.status === "disconnected" ? state : null;

  const scan = (data: string) => {
    if (candidate || busy) return;
    const result = parsePairingPayload(data);
    if (!result.ok) {
      setError(result.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setError("");
    setCandidate(result.payload);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const connect = async () => {
    if (!candidate) return;
    setBusy(true);
    try {
      await pair(candidate);
    } catch (cause) {
      setCandidate(null);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const connectManual = async () => {
    setBusy(true);
    setError("");
    try {
      await pairManually(address, code);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (disconnected) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerCard}>
          <View style={styles.logo}><SymbolView name="bolt.horizontal.circle.fill" size={50} tintColor={colors.accent} /></View>
          <Text style={styles.title}>Can’t reach {disconnected.profile.hostName}</Text>
          <Text style={styles.body}>{disconnected.error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Try again" style={styles.primary} onPress={() => void reconnect()}><Text style={styles.primaryText}>Try Again</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Pair a different Mac" onPress={() => void forget()}><Text style={styles.secondaryAction}>Pair a different Mac</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={styles.logo}><SymbolView name="bolt.horizontal.circle.fill" size={48} tintColor={colors.accent} /></View>
            <Text style={styles.eyebrow}>MAXX MOBILE</Text>
            <Text style={styles.title}>Connect to your Mac</Text>
            <Text style={styles.body}>On Maxx desktop, open Settings → Connections and generate a Mobile pairing code.</Text>
          </View>

          <View style={styles.scannerShell}>
            {permission?.granted ? (
              <>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  active={!candidate && !busy}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => scan(data)}
                />
                <View pointerEvents="none" style={styles.scanFrame}>
                  <View style={[styles.corner, styles.topLeft]} />
                  <View style={[styles.corner, styles.topRight]} />
                  <View style={[styles.corner, styles.bottomLeft]} />
                  <View style={[styles.corner, styles.bottomRight]} />
                </View>
              </>
            ) : (
              <View style={styles.cameraPrompt}>
                <SymbolView name="qrcode.viewfinder" size={60} tintColor={colors.secondary} />
                <Text style={styles.cameraTitle}>Scan the desktop QR code</Text>
                <Text style={styles.cameraBody}>Camera access is used only to read a Maxx pairing invitation.</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Allow camera" style={styles.primary} onPress={() => void requestPermission()}>
                  <Text style={styles.primaryText}>{permission?.canAskAgain === false ? "Camera unavailable" : "Allow Camera"}</Text>
                </Pressable>
              </View>
            )}
          </View>

          {candidate ? (
            <View style={styles.confirmCard}>
              <SymbolView name="desktopcomputer.and.macbook" size={28} tintColor={colors.success} />
              <View style={styles.confirmCopy}>
                <Text style={styles.confirmTitle}>{candidate.host.name}</Text>
                <Text style={styles.confirmBody}>{candidate.host.address}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Connect to this Mac" disabled={busy} style={styles.compactPrimary} onPress={() => void connect()}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Connect</Text>}
              </Pressable>
            </View>
          ) : null}

          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

          <GlassPill
            label={manual ? "Hide manual setup" : "Enter code manually"}
            symbol={manual ? "chevron.up" : "keyboard"}
            selected={manual}
            onPress={() => setManual((value) => !value)}
          />

          {manual ? (
            <View style={styles.manualCard}>
              <Text style={styles.fieldLabel}>TAILSCALE ADDRESS</Text>
              <TextInput
                accessibilityLabel="Tailscale address"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="your-mac.ts.net:7422"
                placeholderTextColor={colors.tertiary}
                style={styles.input}
                value={address}
                onChangeText={setAddress}
                returnKeyType="next"
              />
              <Text style={styles.fieldLabel}>ONE-TIME CODE</Text>
              <TextInput
                accessibilityLabel="One-time pairing code"
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="ABCD-EFGH"
                placeholderTextColor={colors.tertiary}
                style={styles.input}
                value={code}
                onChangeText={setCode}
                returnKeyType="done"
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Connect securely" disabled={busy || !address.trim() || !code.trim()} style={styles.primary} onPress={() => void connectManual()}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Connect Securely</Text>}
              </Pressable>
            </View>
          ) : null}

          <View style={styles.securityNote}>
            <SymbolView name="lock.shield.fill" size={18} tintColor={colors.success} />
            <Text style={styles.securityText}>The invitation expires after five minutes. Your permanent device credential stays in the iOS Keychain and can be revoked from Maxx desktop.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 44, alignItems: "center", gap: spacing.lg },
  header: { alignItems: "center", maxWidth: 440, gap: 8, paddingTop: 12 },
  logo: { width: 66, height: 66, borderRadius: 22, backgroundColor: "rgba(78,143,247,0.14)", alignItems: "center", justifyContent: "center", marginBottom: 4 },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: "800", letterSpacing: 2 },
  title: { color: colors.text, fontSize: 30, lineHeight: 36, fontWeight: "700", textAlign: "center" },
  body: { color: colors.secondary, fontSize: 16, lineHeight: 23, textAlign: "center", maxWidth: 360 },
  scannerShell: { width: "100%", maxWidth: 390, aspectRatio: 1.2, overflow: "hidden", borderRadius: 30, backgroundColor: colors.elevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  cameraPrompt: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 12 },
  cameraTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  cameraBody: { color: colors.secondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  scanFrame: { position: "absolute", left: "18%", top: "16%", right: "18%", bottom: "16%" },
  corner: { position: "absolute", width: 38, height: 38, borderColor: "white" },
  topLeft: { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4, borderTopLeftRadius: 12 },
  topRight: { right: 0, top: 0, borderRightWidth: 4, borderTopWidth: 4, borderTopRightRadius: 12 },
  bottomLeft: { left: 0, bottom: 0, borderLeftWidth: 4, borderBottomWidth: 4, borderBottomLeftRadius: 12 },
  bottomRight: { right: 0, bottom: 0, borderRightWidth: 4, borderBottomWidth: 4, borderBottomRightRadius: 12 },
  primary: { minHeight: 50, paddingHorizontal: 22, borderRadius: 16, backgroundColor: colors.accentStrong, alignItems: "center", justifyContent: "center", marginTop: 4 },
  compactPrimary: { minWidth: 92, height: 42, paddingHorizontal: 14, borderRadius: 14, backgroundColor: colors.accentStrong, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "white", fontWeight: "700", fontSize: 16 },
  secondaryAction: { color: colors.accent, fontSize: 16, fontWeight: "600", padding: 12 },
  confirmCard: { width: "100%", maxWidth: 390, flexDirection: "row", gap: 12, alignItems: "center", padding: 14, borderRadius: 20, backgroundColor: colors.elevatedSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  confirmCopy: { flex: 1 },
  confirmTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  confirmBody: { color: colors.secondary, fontSize: 12, marginTop: 2 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20, textAlign: "center", maxWidth: 390 },
  manualCard: { width: "100%", maxWidth: 390, padding: 18, gap: 10, borderRadius: 24, backgroundColor: colors.elevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  fieldLabel: { color: colors.tertiary, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 3 },
  input: { height: 50, borderRadius: 14, backgroundColor: colors.elevatedSoft, color: colors.text, paddingHorizontal: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong, fontSize: 16 },
  securityNote: { maxWidth: 390, flexDirection: "row", gap: 10, paddingHorizontal: 8, alignItems: "flex-start" },
  securityText: { flex: 1, color: colors.tertiary, fontSize: 12, lineHeight: 17 },
  centerCard: { flex: 1, padding: 28, alignItems: "center", justifyContent: "center", gap: 16 },
});
