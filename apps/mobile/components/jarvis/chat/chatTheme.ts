import { useTheme } from "../../../contexts/ThemeContext";

export function useChatTheme() {
  const { colorScheme, colors } = useTheme();
  const dark = colorScheme === "dark";
  return {
    ...colors,
    dark,
    canvas: colors.background,
    panel: dark ? "#000000" : "#ffffff",
    inset: dark ? "#141414" : "#f0edf5",
    line: dark ? "#303030" : "#e5e0ec",
    ink: dark ? "#f2f2f2" : "#231d30",
    muted: dark ? "#a3a3a3" : "#786d85",
    purple: dark ? "#b69cff" : "#7145db",
    green: dark ? "#93d6b5" : "#27845c",
  };
}
export type ChatTheme = ReturnType<typeof useChatTheme>;
export function humanizeTool(name: string) {
  return name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
export function conversationTitle(title?: string | null) {
  return title?.trim() || "New conversation";
}
