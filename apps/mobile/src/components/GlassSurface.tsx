import type { ReactNode } from "react";
import { View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

type Props = Omit<ViewProps, "style"> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  fallbackStyle?: StyleProp<ViewStyle>;
  tintColor?: string;
  isInteractive?: boolean;
};

export function GlassSurface({ children, style, fallbackStyle, tintColor, isInteractive = false, ...viewProps }: Props) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={tintColor}
        isInteractive={isInteractive}
        style={style}
        {...viewProps}
      >
        {children}
      </GlassView>
    );
  }
  return <View style={[style, fallbackStyle]} {...viewProps}>{children}</View>;
}
