import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { type Conversation } from "@/lib/api-client";
import { IconButton } from "./ChatPrimitives";
import { conversationTitle, useChatTheme } from "./chatTheme";

export function ConversationList({
  conversations,
  selectedId,
  loading,
  disabled,
  onSelect,
  onManage,
  onClear,
}: {
  conversations: Conversation[];
  selectedId?: string;
  loading: boolean;
  disabled?: boolean;
  onSelect: (conversation: Conversation) => void;
  onManage: (conversation: Conversation) => void;
  onClear: () => void;
}) {
  const t = useChatTheme();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => conversations.filter((conversation) =>
    `${conversation.title || ""} ${conversation.summary || ""}`
      .toLowerCase().includes(query.trim().toLowerCase()),
  ), [conversations, query]);
  return (
    <View style={s.root}>
      <View style={[s.search, { borderColor: t.line }]}>
        <Ionicons name="search-outline" size={16} color={t.muted} />
        <TextInput
          accessibilityLabel="Search conversations"
          placeholder="Search conversations"
          placeholderTextColor={t.muted}
          value={query}
          onChangeText={setQuery}
          style={[s.searchInput, { color: t.ink }]}
        />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        {loading && !conversations.length ? (
          <ActivityIndicator color={t.purple} style={{ margin: 28 }} />
        ) : !filtered.length ? (
          <Text style={[s.empty, { color: t.muted }]}>
            {query ? "No matching conversations." : "No conversations yet."}
          </Text>
        ) : (
          filtered.map((conv) => (
            <View
              key={conv.id}
              style={[
                s.item,
                {
                  backgroundColor:
                    selectedId === conv.id ? t.inset : "transparent",
                },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open conversation: ${conversationTitle(conv.title)}`}
                accessibilityState={{
                  selected: selectedId === conv.id,
                  disabled: !!disabled,
                }}
                disabled={disabled}
                onPress={() => onSelect(conv)}
                style={s.select}
              >
                <Text
                  style={[
                    s.title,
                    { color: selectedId === conv.id ? t.purple : t.ink },
                  ]}
                  numberOfLines={1}
                >
                  {conversationTitle(conv.title)}
                </Text>
                {selectedId === conv.id && (
                  <Ionicons name="checkmark" size={16} color={t.muted} />
                )}
              </Pressable>
              <IconButton
                icon="ellipsis-horizontal"
                label={`Manage ${conversationTitle(conv.title)}`}
                onPress={() => onManage(conv)}
                disabled={disabled}
              />
            </View>
          ))
        )}
      </ScrollView>
      {!!conversations.length && (
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={onClear}
          style={[s.clear, { borderTopColor: t.line }]}
        >
          <Ionicons name="trash-outline" size={14} color={t.muted} />
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Clear conversation history
          </Text>
        </Pressable>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  root: { flexShrink: 1, minHeight: 0 },
  search: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 6,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    fontSize: 12,
    outlineWidth: 0,
  } as any,
  item: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 10,
    marginBottom: 3,
    paddingRight: 2,
  },
  select: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", padding: 10, minHeight: 44, gap: 8 },
  title: { flex: 1, fontSize: 13, lineHeight: 18 },
  empty: { padding: 18, fontSize: 13, lineHeight: 21 },
  clear: {
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
  },
});
