import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useChatTheme, type ChatTheme, humanizeTool } from "./chatTheme";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  active,
  size = 19,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  size?: number;
}) {
  const t = useChatTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        s.iconButton,
        {
          opacity: disabled ? 0.35 : 1,
          backgroundColor:
            active || pressed || hovered ? t.inset : "transparent",
        },
      ]}
    >
      <Ionicons name={icon} color={active ? t.purple : t.muted} size={size} />
    </Pressable>
  );
}
export function Sheet({
  visible,
  onClose,
  title,
  children,
  wide = false,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const t = useChatTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={s.backdrop}>
        <Pressable
          accessibilityLabel="Close dialog"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            {
              backgroundColor: t.panel,
              borderColor: t.line,
              maxWidth: wide ? 640 : 470,
              maxHeight: Math.max(120, height - insets.top - insets.bottom - 40),
            },
          ]}
        >
          <View style={s.sheetHead}>
            <Text
              accessibilityRole="header"
              style={[s.sheetTitle, { color: t.ink }]}
            >
              {title}
            </Text>
            <IconButton icon="close" label="Close dialog" onPress={onClose} />
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}
export function JarvisMark({
  large = false,
  active = false,
}: {
  large?: boolean;
  active?: boolean;
}) {
  const t = useChatTheme();
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    if (!active) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [active, pulse]);
  return (
    <View
      accessible={false}
      style={[
        s.mark,
        {
          width: large ? 36 : 22,
          height: large ? 36 : 22,
        },
      ]}
    >
      <Animated.View style={{ opacity: active ? pulse : 1 }}>
        <Ionicons name="sparkles" size={large ? 28 : 15} color={t.ink} />
      </Animated.View>
    </View>
  );
}
export interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  result?: unknown;
  duration_ms?: number;
}
export function ActivityTrace({
  tools,
  busy,
  startedAt,
  phase,
}: {
  tools: ToolActivity[];
  busy?: boolean;
  startedAt?: number;
  phase?: string;
}) {
  const t = useChatTheme();
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy || startedAt == null) {
      setElapsed(0);
      return;
    }
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [busy, startedAt]);
  useEffect(() => {
    setExpanded(false);
  }, [startedAt]);
  useEffect(() => {
    if (!tools.length) setExpanded(false);
  }, [tools.length]);
  if (!busy && !tools.length) return null;
  const running = tools.filter((tool) => tool.status === "running");
  const failed = tools.some((tool) => tool.status === "failed");
  const interrupted = tools.some((tool) => tool.status === "interrupted");
  const status = busy
    ? running.length
      ? humanizeTool(running[running.length - 1].name)
      : phase || "Thinking"
    : `${tools.length} tool${tools.length === 1 ? "" : "s"} used`;
  const label = `${status}${failed ? " · error" : ""}${interrupted ? " · interrupted" : ""}`;
  const header = (
    <>
      {busy ? (
        <ActivityIndicator accessible={false} size="small" color={t.muted} />
      ) : failed || interrupted ? (
        <Ionicons
          name={failed ? "alert-circle-outline" : "pause-circle-outline"}
          color={failed ? t.error : t.muted}
          size={15}
        />
      ) : null}
      <Text
        accessibilityLiveRegion="polite"
        style={[s.traceLabel, { color: failed ? t.error : t.muted }]}
      >
        {label}
        {busy ? "…" : ""}
      </Text>
      {busy && startedAt != null && (
        <Text style={[s.timer, { color: t.muted }]}>{elapsed}s</Text>
      )}
      {!!tools.length && (
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          color={t.muted}
          size={12}
        />
      )}
    </>
  );
  return (
    <View style={s.trace}>
      {tools.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}. ${expanded ? "Hide" : "Show"} activity`}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          onPress={() => setExpanded((value) => !value)}
          hitSlop={4}
          style={s.traceHeader}
        >
          {header}
        </Pressable>
      ) : (
        <View style={s.traceHeader}>{header}</View>
      )}
      {expanded && !!tools.length && (
        <View style={s.traceBody}>
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} theme={t} />
          ))}
        </View>
      )}
    </View>
  );
}
function ToolRow({ tool, theme: t }: { tool: ToolActivity; theme: ChatTheme }) {
  const [open, setOpen] = useState(false);
  const raw =
    tool.result == null
      ? ""
      : typeof tool.result === "string"
        ? tool.result
        : JSON.stringify(tool.result, null, 2);
  const duration =
    tool.duration_ms == null
      ? ""
      : `${(tool.duration_ms / 1000).toFixed(1)}s`;
  const detail =
    tool.status === "completed" && duration
      ? duration
      : `${tool.status}${duration ? ` · ${duration}` : ""}`;
  const row = (
    <>
      <Ionicons
        name={
          tool.status === "running"
            ? "ellipse-outline"
            : tool.status === "failed"
              ? "alert-circle-outline"
              : tool.status === "interrupted"
                ? "pause-outline"
                : "checkmark"
        }
        color={tool.status === "failed" ? t.error : t.muted}
        size={14}
      />
      <Text style={{ flex: 1, fontSize: 12, color: t.muted }}>
        {humanizeTool(tool.name)}
      </Text>
      <Text
        style={{
          fontSize: 11,
          color: tool.status === "failed" ? t.error : t.muted,
        }}
      >
        {detail}
      </Text>
      {raw ? (
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={12}
          color={t.muted}
        />
      ) : null}
    </>
  );
  return (
    <View style={{ gap: 7 }}>
      {raw ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${humanizeTool(tool.name)} ${tool.status}. ${open ? "Hide" : "Show"} result`}
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          onPress={() => setOpen((value) => !value)}
          hitSlop={6}
          style={s.toolRow}
        >
          {row}
        </Pressable>
      ) : (
        <View style={s.toolRow}>{row}</View>
      )}
      {open && raw ? (
        <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
          <Text
            selectable
            style={{ color: t.muted, fontSize: 11, lineHeight: 17 }}
          >
            {raw.slice(0, 16000)}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "#00000088",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  sheet: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 22,
    padding: 20,
    gap: 16,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sheetTitle: { fontSize: 20, fontWeight: "600", letterSpacing: -0.4 },
  mark: { alignItems: "center", justifyContent: "center" },
  trace: {
    marginBottom: 8,
  },
  traceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    minHeight: 36,
    paddingVertical: 7,
  },
  traceLabel: { flexShrink: 1, fontSize: 12, lineHeight: 18 },
  timer: { fontSize: 12, fontVariant: ["tabular-nums"] },
  traceBody: { paddingLeft: 4, paddingTop: 3, paddingBottom: 8, gap: 8 },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 32 },
});
