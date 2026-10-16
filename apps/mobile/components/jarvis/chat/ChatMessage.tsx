import React, { useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { type Message } from "@/lib/api-client";
import {
  ActivityTrace,
  IconButton,
  JarvisMark,
  type ToolActivity,
} from "./ChatPrimitives";
import { useChatTheme } from "./chatTheme";

export function openSafeLink(url: string) {
  if (/^https?:\/\//i.test(url)) {
    void Linking.openURL(url);
    return true;
  }
  return false;
}
function CodeBlock({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  const t = useChatTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View style={[s.code, { backgroundColor: t.inset, borderColor: t.line }]}>
      <View style={[s.codeHeader, { borderBottomColor: t.line }]}>
        <Text style={{ color: t.muted, fontSize: 11 }}>
          {language || "code"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          onPress={() => {
            void Clipboard.setStringAsync(content).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
          style={s.copyCode}
        >
          <Ionicons
            name={copied ? "checkmark" : "copy-outline"}
            size={13}
            color={t.muted}
          />
          <Text style={{ color: t.muted, fontSize: 11 }}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal contentContainerStyle={{ padding: 15 }}>
        <Text selectable style={[s.codeText, { color: t.ink }]}>
          {content.trimEnd()}
        </Text>
      </ScrollView>
    </View>
  );
}
export const ChatMarkdown = React.memo(function ChatMarkdown({ content }: { content: string }) {
  const t = useChatTheme();
  return (
    <Markdown
      onLinkPress={(url) => {
        openSafeLink(url);
        return false;
      }}
      rules={{
        fence: (node: any) => (
          <CodeBlock
            key={node.key}
            content={node.content}
            language={node.sourceInfo}
          />
        ),
        code_block: (node: any) => (
          <CodeBlock key={node.key} content={node.content} />
        ),
      }}
      style={{
        body: { color: t.ink, fontSize: 15, lineHeight: 25 },
        paragraph: { marginTop: 0, marginBottom: 14 },
        heading1: {
          color: t.ink,
          fontSize: 25,
          lineHeight: 33,
          marginTop: 15,
          marginBottom: 13,
          fontWeight: "600",
        },
        heading2: {
          color: t.ink,
          fontSize: 21,
          lineHeight: 29,
          marginTop: 13,
          marginBottom: 11,
          fontWeight: "600",
        },
        heading3: {
          color: t.ink,
          fontSize: 17,
          marginTop: 11,
          marginBottom: 9,
          fontWeight: "600",
        },
        link: { color: t.purple },
        strong: { fontWeight: "600" },
        blockquote: {
          backgroundColor: t.inset,
          borderColor: t.purple,
          borderLeftWidth: 2,
          paddingHorizontal: 14,
          paddingVertical: 10,
        },
        code_inline: {
          backgroundColor: t.inset,
          color: t.purple,
          borderColor: t.line,
          fontSize: 13,
          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
        },
        bullet_list: { marginBottom: 12 },
        ordered_list: { marginBottom: 12 },
        list_item: { marginBottom: 5 },
        hr: { backgroundColor: t.line, marginVertical: 18 },
        table: { borderColor: t.line, borderRadius: 6 },
        th: { padding: 8, backgroundColor: t.inset },
        td: { padding: 8 },
        tr: { borderColor: t.line },
      }}
    >
      {content}
    </Markdown>
  );
});
export function ChatMessage({
  message,
  onReuse,
  onSpeak,
  speaking,
  speakLoading,
}: {
  message: Message;
  onReuse: (text: string) => void;
  onSpeak: (message: Message) => void;
  speaking: boolean;
  speakLoading: boolean;
}) {
  const t = useChatTheme();
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const tools = ((message as any).tool_calls ||
    (message as any).metadata?.tool_calls ||
    []) as ToolActivity[];
  return (
    <View style={[s.message, isUser && s.userMessage]}>
      {isUser ? (
        <>
          <View
            style={[
              s.userBubble,
              { backgroundColor: t.inset, borderColor: t.line },
            ]}
          >
            <Text
              selectable
              style={{ color: t.ink, fontSize: 15, lineHeight: 24 }}
            >
              {message.content}
            </Text>
            {message.attachments?.map((a, i) => (
              <View
                style={[s.attachment, { borderColor: t.line }]}
                key={`${a.asset_id}-${i}`}
              >
                <Ionicons
                  name={
                    a.mime_type?.startsWith("image/")
                      ? "image-outline"
                      : "document-text-outline"
                  }
                  color={t.purple}
                  size={15}
                />
                <Text
                  numberOfLines={1}
                  style={{ color: t.muted, fontSize: 11, flexShrink: 1 }}
                >
                  {(a as any).filename || (a as any).title || "Attached file"}
                </Text>
              </View>
            ))}
          </View>
          <View style={s.actions}>
            <IconButton
              icon="create-outline"
              label="Reuse message in composer"
              onPress={() => onReuse(message.content)}
            />
            <Text style={[s.time, { color: t.muted }]}>
              {new Date(message.created_at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </>
      ) : (
        <>
          <View style={s.author}>
            <JarvisMark />
            <Text style={{ color: t.ink, fontSize: 13, fontWeight: "600" }}>
              Jarvis
            </Text>
          </View>
          <ActivityTrace tools={tools} />
          <ChatMarkdown content={message.content} />
          {message.sources?.length ? (
            <View style={s.sources}>
              <Text style={[s.sourceHeading, { color: t.muted }]}>SOURCES</Text>
              {message.sources.map((source, i) => (
                <Pressable
                  key={`${source.url}-${i}`}
                  accessibilityRole="link"
                  onPress={() => openSafeLink(source.url)}
                  style={[
                    s.source,
                    { backgroundColor: t.panel, borderColor: t.line },
                  ]}
                >
                  <Text style={{ color: t.purple, fontSize: 11 }}>{i + 1}</Text>
                  <Text
                    numberOfLines={1}
                    style={{ color: t.muted, fontSize: 12, flex: 1 }}
                  >
                    {source.title || source.url}
                  </Text>
                  <Ionicons
                    name="arrow-up-outline"
                    size={12}
                    color={t.muted}
                    style={{ transform: [{ rotate: "45deg" }] }}
                  />
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={s.actions}>
            <IconButton
              icon={copied ? "checkmark" : "copy-outline"}
              label={copied ? "Copied message" : "Copy message"}
              onPress={() => {
                void Clipboard.setStringAsync(message.content).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                });
              }}
            />
            <IconButton
              icon={
                speaking
                  ? "stop-circle-outline"
                  : speakLoading
                    ? "hourglass-outline"
                    : "volume-high-outline"
              }
              label={speaking ? "Stop reading" : "Read aloud"}
              onPress={() => onSpeak(message)}
              disabled={speakLoading}
              active={speaking}
            />
            <IconButton
              icon="arrow-undo-outline"
              label="Quote reply in composer"
              onPress={() =>
                onReuse(
                  `Regarding your reply:\n> ${message.content.slice(0, 1000).replace(/\n/g, "\n> ")}\n\n`,
                )
              }
            />
            <Text style={[s.time, { color: t.muted }]}>
              {new Date(message.created_at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  message: { paddingVertical: 16, width: "100%" },
  userMessage: { alignItems: "flex-end", paddingTop: 22 },
  userBubble: {
    maxWidth: "88%",
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderRadius: 19,
    borderBottomRightRadius: 5,
    gap: 8,
  },
  author: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 15,
  },
  authorLabel: { fontSize: 8, letterSpacing: 1.5, marginLeft: 4 },
  actions: { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 1 },
  time: { fontSize: 10, marginLeft: 7, marginRight: 5 },
  code: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 16,
    marginTop: 3,
  },
  codeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  copyCode: { flexDirection: "row", alignItems: "center", gap: 6, padding: 3 },
  codeText: {
    fontSize: 12,
    lineHeight: 20,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  sources: { marginTop: 3, marginBottom: 8, gap: 6 },
  sourceHeading: { fontSize: 9, letterSpacing: 1.6, marginBottom: 3 },
  source: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderWidth: 1,
    borderRadius: 9,
    maxWidth: 500,
  },
  attachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderTopWidth: 1,
    paddingTop: 9,
  },
});
