import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";
import { GlassSurface } from "./GlassSurface";

const PRESS_SCALE = 1.12;
const PRESS_IN_SPRING = { damping: 12, stiffness: 340 };
const PRESS_OUT_SPRING = { damping: 15, stiffness: 320 };

type Props = {
  label: string;
  symbol: SymbolViewProps["name"];
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

export function GlassButton({ label, symbol, onPress, disabled, selected, size = 46, style, children }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const setPressed = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.spring(scale, {
      toValue: pressed ? PRESS_SCALE : 1,
      useNativeDriver: true,
      ...(pressed ? PRESS_IN_SPRING : PRESS_OUT_SPRING),
    }).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <GlassSurface
        isInteractive
        tintColor={selected ? "rgba(80,145,255,0.32)" : "rgba(20,25,34,0.44)"}
        style={[styles.button, { width: size, height: size, borderRadius: size / 2 }, style]}
        fallbackStyle={[styles.fallback, selected && styles.selected]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={disabled}
          onPress={onPress}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={[styles.fill, disabled && styles.disabledContent]}
        >
          {children || <SymbolView name={symbol} size={20} weight="semibold" tintColor={colors.text} />}
        </Pressable>
      </GlassSurface>
    </Animated.View>
  );
}

export function GlassPill({ label, symbol, onPress, selected, style }: Omit<Props, "size">) {
  const scale = useRef(new Animated.Value(1)).current;
  const setPressed = (pressed: boolean) => {
    scale.stopAnimation();
    Animated.spring(scale, {
      toValue: pressed ? PRESS_SCALE : 1,
      useNativeDriver: true,
      ...(pressed ? PRESS_IN_SPRING : PRESS_OUT_SPRING),
    }).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <GlassSurface
        isInteractive
        tintColor={selected ? "rgba(80,145,255,0.32)" : "rgba(20,25,34,0.44)"}
        style={[styles.pill, style]}
        fallbackStyle={[styles.fallback, selected && styles.selected]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={styles.pillContent}
        >
          <SymbolView name={symbol} size={16} weight="semibold" tintColor={colors.text} />
          <Text style={styles.pillText}>{label}</Text>
        </Pressable>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  fill: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center" },
  fallback: { backgroundColor: "rgba(32,38,49,0.94)", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderStrong },
  selected: { backgroundColor: "rgba(58,116,213,0.38)" },
  disabledContent: { opacity: 0.38 },
  pill: { height: 44, borderRadius: 22, overflow: "hidden" },
  pillContent: { flex: 1, paddingHorizontal: 16, flexDirection: "row", gap: 8, alignItems: "center" },
  pillText: { color: colors.text, fontWeight: "600", fontSize: 15 },
});
