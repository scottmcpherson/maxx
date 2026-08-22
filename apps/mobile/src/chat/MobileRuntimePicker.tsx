import { SymbolView } from "expo-symbols";
import MaskedView from "@react-native-masked-view/masked-view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MaxxHostClient } from "../connection/MaxxHostClient";
import { colors } from "../theme";
import type {
  ChatProvider,
  ProviderModelCatalog,
  ProviderProfile,
} from "../types";
import { GlassSurface } from "../components/GlassSurface";
import { horizontalOverflow, type HorizontalOverflow } from "./horizontalOverflow";
import { MobileProviderIcon } from "./MobileProviderIcon";

export type MobileRuntimeSelection = {
  provider: ChatProvider;
  model: string;
  effort: string | null;
  speed: string | null;
};

type Props = MobileRuntimeSelection & {
  client: MaxxHostClient;
  profiles: ProviderProfile[];
  workingDirectory: string;
  disabled?: boolean;
  onChange: (selection: MobileRuntimeSelection) => void;
};

export function MobileRuntimePicker({
  client,
  provider,
  model,
  effort,
  speed,
  profiles,
  workingDirectory,
  disabled,
  onChange,
}: Props) {
  const insets = useSafeAreaInsets();
  const enabledProfiles = useMemo(
    () => profiles.filter((profile) => profile.isEnabled || profile.provider === provider),
    [profiles, provider],
  );
  const [visible, setVisible] = useState(false);
  const [draftProvider, setDraftProvider] = useState(provider);
  const [catalogs, setCatalogs] = useState<Partial<Record<ChatProvider, ProviderModelCatalog["models"]>>>({});
  const [loadingProvider, setLoadingProvider] = useState<ChatProvider | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providerOverflow, setProviderOverflow] = useState<HorizontalOverflow>({ left: false, right: false });
  const sheetTranslateY = useRef(new Animated.Value(0)).current;
  const dismissingRef = useRef(false);
  const providerRailMetricsRef = useRef({ offsetX: 0, viewportWidth: 0, contentWidth: 0 });

  const refreshProviderOverflow = useCallback(() => {
    const metrics = providerRailMetricsRef.current;
    const next = horizontalOverflow(metrics.offsetX, metrics.viewportWidth, metrics.contentWidth);
    setProviderOverflow((current) => (
      current.left === next.left && current.right === next.right ? current : next
    ));
  }, []);

  const dismissSheet = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    Animated.timing(sheetTranslateY, {
      toValue: Dimensions.get("window").height,
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setVisible(false);
      else dismissingRef.current = false;
    });
  }, [sheetTranslateY]);

  const dragResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_, gesture) => sheetTranslateY.setValue(Math.max(0, gesture.dy)),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 90 || gesture.vy > 0.8) {
        dismissSheet();
        return;
      }
      Animated.spring(sheetTranslateY, {
        toValue: 0,
        damping: 24,
        stiffness: 260,
        mass: 0.9,
        useNativeDriver: true,
      }).start();
    },
    onPanResponderTerminate: () => {
      if (dismissingRef.current) return;
      Animated.spring(sheetTranslateY, {
        toValue: 0,
        damping: 24,
        stiffness: 260,
        mass: 0.9,
        useNativeDriver: true,
      }).start();
    },
  }), [dismissSheet, sheetTranslateY]);

  const profileFor = useCallback(
    (candidate: ChatProvider) => profiles.find((profile) => profile.provider === candidate),
    [profiles],
  );

  const loadModels = useCallback(async (candidate: ChatProvider) => {
    if (catalogs[candidate]) return;
    setLoadingProvider(candidate);
    setCatalogError(null);
    try {
      const catalog = await client.request<ProviderModelCatalog>("list_provider_models", {
        provider: candidate,
        profileId: profileFor(candidate)?.id || null,
        workingDirectory,
      });
      setCatalogs((current) => ({ ...current, [candidate]: catalog.models }));
      if (catalog.error) setCatalogError(catalog.error);
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingProvider((current) => current === candidate ? null : current);
    }
  }, [catalogs, client, profileFor, workingDirectory]);

  useEffect(() => {
    if (!visible) return;
    setDraftProvider(provider);
    setCatalogError(null);
    void loadModels(provider);
  }, [loadModels, provider, visible]);

  useEffect(() => {
    if (!visible) return;
    Animated.spring(sheetTranslateY, {
      toValue: 0,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
    return () => sheetTranslateY.stopAnimation();
  }, [sheetTranslateY, visible]);

  const currentProfile = profileFor(provider);
  const draftModels = catalogs[draftProvider] || [];
  const modelOptions = draftProvider === provider && !draftModels.some((option) => option.model === model)
    ? [{ model, displayName: model }, ...draftModels]
    : draftModels;
  const triggerLabel = [currentProfile?.displayName || provider, model, effort].filter(Boolean).join(" · ");

  const chooseProvider = (nextProvider: ChatProvider) => {
    setDraftProvider(nextProvider);
    setCatalogError(null);
    void loadModels(nextProvider);
  };

  const chooseModel = (option: ProviderModelCatalog["models"][number]) => {
    const sameRuntime = draftProvider === provider && option.model === model;
    const nextEffort = sameRuntime || (!!effort && option.effortLevels?.includes(effort)) ? effort : null;
    onChange({
      provider: draftProvider,
      model: option.model,
      effort: nextEffort,
      speed: sameRuntime ? speed : null,
    });
    dismissSheet();
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Harness and model: ${triggerLabel}`}
        disabled={disabled}
        onPress={() => {
          dismissingRef.current = false;
          sheetTranslateY.stopAnimation();
          sheetTranslateY.setValue(48);
          setVisible(true);
        }}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <MobileProviderIcon provider={provider} size={16} />
        <Text numberOfLines={1} style={styles.triggerText}>{triggerLabel}</Text>
      </Pressable>

      <Modal transparent visible={visible} animationType="fade" onRequestClose={dismissSheet}>
        <View style={styles.scrim}>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss harness and model picker" style={StyleSheet.absoluteFill} onPress={dismissSheet} />
          <Animated.View style={[styles.sheetFrame, { transform: [{ translateY: sheetTranslateY }] }]}>
            <GlassSurface
              style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}
              fallbackStyle={styles.sheetFallback}
              tintColor="rgba(12,16,22,0.58)"
            >
              <View accessibilityRole="adjustable" accessibilityLabel="Drag down to dismiss" style={styles.dragArea} {...dragResponder.panHandlers}>
                <View style={styles.handle} />
              </View>

              <Text style={styles.sectionLabel}>HARNESS</Text>
              <MaskedView
                style={styles.providerRailFrame}
                maskElement={(
                  <View
                    style={[
                      styles.providerMask,
                      providerOverflow.left && providerOverflow.right
                        ? styles.providerMaskBoth
                        : providerOverflow.left
                          ? styles.providerMaskLeft
                          : providerOverflow.right
                            ? styles.providerMaskRight
                            : styles.providerMaskNone,
                    ]}
                  />
                )}
              >
                <ScrollView
                  horizontal
                  alwaysBounceVertical={false}
                  directionalLockEnabled
                  onContentSizeChange={(contentWidth) => {
                    providerRailMetricsRef.current.contentWidth = contentWidth;
                    refreshProviderOverflow();
                  }}
                  onLayout={(event) => {
                    providerRailMetricsRef.current.viewportWidth = event.nativeEvent.layout.width;
                    refreshProviderOverflow();
                  }}
                  onScroll={(event) => {
                    providerRailMetricsRef.current.offsetX = event.nativeEvent.contentOffset.x;
                    refreshProviderOverflow();
                  }}
                  scrollEventThrottle={16}
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={false}
                  style={styles.providerScroller}
                  contentContainerStyle={styles.providerRail}
                >
                  {enabledProfiles.map((profile) => {
                    const selected = profile.provider === draftProvider;
                    return (
                      <Pressable
                        key={profile.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => chooseProvider(profile.provider)}
                        style={({ pressed }) => [styles.providerChip, selected && styles.providerChipSelected, pressed && styles.pressed]}
                      >
                        <MobileProviderIcon provider={profile.provider} size={17} />
                        <Text style={[styles.providerText, selected && styles.providerTextSelected]}>{profile.displayName}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </MaskedView>

              <Text style={styles.sectionLabel}>MODEL</Text>
              <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
                {loadingProvider === draftProvider ? (
                  <View style={styles.loadingRow}><ActivityIndicator color={colors.accent} /><Text style={styles.loadingText}>Loading models…</Text></View>
                ) : null}
                {loadingProvider !== draftProvider && catalogError ? <Text style={styles.errorText}>{catalogError}</Text> : null}
                {loadingProvider !== draftProvider && !catalogError && modelOptions.length === 0 ? <Text style={styles.emptyText}>No models were reported by this harness.</Text> : null}
                {modelOptions.map((option) => {
                  const selected = draftProvider === provider && option.model === model;
                  return (
                    <Pressable
                      key={option.model}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => chooseModel(option)}
                      style={({ pressed }) => [styles.modelRow, selected && styles.modelRowSelected, pressed && styles.pressed]}
                    >
                      <View style={styles.modelCopy}>
                        <Text numberOfLines={1} style={styles.modelName}>{option.displayName || option.model}</Text>
                        {option.displayName !== option.model || option.description ? (
                          <Text numberOfLines={2} style={styles.modelMeta}>{option.description || option.model}</Text>
                        ) : null}
                      </View>
                      {selected ? <SymbolView name="checkmark" size={16} weight="bold" tintColor={colors.accent} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </GlassSurface>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { flex: 1, flexShrink: 1, minWidth: 0, height: 38, borderRadius: 19, paddingHorizontal: 9, flexDirection: "row", alignItems: "center", gap: 6 },
  triggerText: { flex: 1, minWidth: 0, color: colors.secondary, fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.58 },
  scrim: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheetFrame: { width: "100%", height: "70%", borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: "hidden" },
  sheet: { flex: 1, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 14, overflow: "hidden" },
  sheetFallback: { backgroundColor: "rgba(21,26,34,0.88)", borderWidth: StyleSheet.hairlineWidth, borderBottomWidth: 0, borderColor: colors.borderStrong },
  dragArea: { height: 34, alignItems: "center", justifyContent: "flex-start", paddingTop: 9 },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.tertiary },
  sectionLabel: { color: colors.tertiary, fontSize: 11, fontWeight: "800", letterSpacing: 1.1, marginTop: 8, marginBottom: 8, marginLeft: 5 },
  providerRailFrame: { height: 46, position: "relative", overflow: "hidden" },
  providerScroller: { flex: 1, overflow: "hidden" },
  providerRail: { height: 46, gap: 8, paddingHorizontal: 2, alignItems: "center" },
  providerMask: { flex: 1 },
  providerMaskNone: { backgroundColor: "black" },
  providerMaskLeft: { experimental_backgroundImage: "linear-gradient(to right, transparent 0%, black 10%, black 100%)" },
  providerMaskRight: { experimental_backgroundImage: "linear-gradient(to right, black 0%, black 90%, transparent 100%)" },
  providerMaskBoth: { experimental_backgroundImage: "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)" },
  providerChip: { height: 38, borderRadius: 19, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.elevatedSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  providerChipSelected: { backgroundColor: "rgba(79,143,247,0.20)", borderColor: "rgba(120,169,255,0.46)" },
  providerText: { color: colors.secondary, fontSize: 14, fontWeight: "600" },
  providerTextSelected: { color: colors.text },
  modelList: { flex: 1, minHeight: 0 },
  modelListContent: { gap: 5, paddingBottom: 8 },
  modelRow: { minHeight: 58, borderRadius: 15, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  modelRowSelected: { backgroundColor: "rgba(79,143,247,0.16)" },
  modelCopy: { flex: 1, minWidth: 0 },
  modelName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modelMeta: { color: colors.tertiary, fontSize: 11, lineHeight: 15, marginTop: 3 },
  loadingRow: { minHeight: 90, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 9 },
  loadingText: { color: colors.secondary, fontSize: 14 },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18, padding: 12 },
  emptyText: { color: colors.secondary, fontSize: 13, textAlign: "center", paddingVertical: 34 },
});
