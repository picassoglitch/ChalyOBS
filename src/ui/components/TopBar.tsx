import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { t } from "@/i18n";
import { BridgeColors, Mono } from "../theme/colors";

interface Props {
  title?: string;
  subtitle?: string;
  /** Right-edge settings tap; rendered as a ⚙ icon button. Hide by omitting. */
  onSettings?: () => void;
  /** Single-letter glyph in the gradient square. Defaults to N (Chalyb). */
  glyph?: string;
}

export function TopBar({
  title = t("topBar.title"),
  subtitle = t("topBar.subtitle"),
  onSettings,
  glyph = "NSO",
}: Props) {
  return (
    <View style={styles.row}>
      <LinearGradient
        colors={[BridgeColors.Primary, BridgeColors.Magenta]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.glyph}
      >
        <Text style={styles.glyphText}>{glyph}</Text>
      </LinearGradient>
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      {onSettings && (
        <Pressable onPress={onSettings} style={styles.settingsBtn}>
          <Text style={styles.settingsTxt}>⚙</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 48,
  },
  glyph: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  glyphText: {
    color: "#000",
    fontWeight: "900",
    fontFamily: Mono.fontFamily,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  title: {
    color: BridgeColors.TextPrimary,
    fontWeight: "900",
    fontFamily: Mono.fontFamily,
    fontSize: 14,
    letterSpacing: 1.5,
  },
  subtitle: {
    color: BridgeColors.TextTertiary,
    fontFamily: Mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.2,
  },
  settingsBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: BridgeColors.Surface,
    borderWidth: 1,
    borderColor: BridgeColors.PrimarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  settingsTxt: {
    color: BridgeColors.Primary,
    fontSize: 18,
  },
});
