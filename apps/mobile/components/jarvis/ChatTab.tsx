import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import {
  createConversation,
  deleteConversation,
  deleteAllConversations,
  listJarvisProjects,
  patchConversation,
  uploadJarvisAsset,
  type Conversation,
  type JarvisProject,
  type MessageAttachmentRef,
} from "@/lib/api-client";
import { useConversation } from "../../contexts/ConversationContext";
import { useAuth } from "../../contexts/AuthContext";
import {
  ActivityTrace,
  IconButton,
  JarvisMark,
  Sheet,
} from "./chat/ChatPrimitives";
import { ConversationList } from "./chat/ConversationList";
import { ChatMarkdown, ChatMessage } from "./chat/ChatMessage";
import { conversationTitle, useChatTheme } from "./chat/chatTheme";
import { useChatStream } from "./chat/useChatStream";
import { useChatAudio } from "./chat/useChatAudio";
import { ChatTaskCards } from "./chat/ChatTaskCards";

type PendingAttachment = MessageAttachmentRef & { filename: string };
export function ChatTab() {
  const t = useChatTheme();
  const { width, height } = useWindowDimensions();
  const compact = width < 700;
  const { accessToken } = useAuth();
  const c = useConversation();
  const stream = useChatStream();
  const audio = useChatAudio(c.setError);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projects, setProjects] = useState<JarvisProject[]>([]);
  const [managed, setManaged] = useState<Conversation | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [clearAll, setClearAll] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 56 });
  const menuTop = Math.min(menuPosition.top, Math.max(12, height - 180));
  const conversationPicker = useRef<View>(null);
  const nearBottom = useRef(true);
  const lastScrollOffset = useRef(0);
  const userScrolling = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const composer = useRef<TextInput>(null);
  const mounted = useRef(true);
  const disabled = stream.busy || uploading || mutating || c.loadingMessages;
  const visibleMessages = c.messages.filter((m) => m.role !== "system");
  const project = projects.find(
    (p) => p.id === c.currentConversation?.active_project_id,
  );
  useEffect(() => {
    c.setShowConvModal(false);
  }, [width]);
  const openConversations = () => {
    if (disabled) return;
    conversationPicker.current?.measureInWindow((x, y, _width, triggerHeight) => {
      setMenuPosition({
        left: Math.max(12, Math.min(x, width - Math.min(380, width - 24) - 12)),
        top: y + triggerHeight + 6,
      });
      c.setShowConvModal(true);
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (accessToken)
      listJarvisProjects()
        .then(setProjects)
        .catch(() => {});
  }, [accessToken]);
  useEffect(() => {
    if (!uploading) setAttachments([]);
    void audio.stop();
    nearBottom.current = true;
    setAtBottom(true);
  }, [c.currentConversation?.id]);
  const scrollToEnd = () => {
    nearBottom.current = true;
    setAtBottom(true);
    scroll.current?.scrollToEnd({ animated: true });
  };
  const draft = (text: string) => {
    setInput(text);
    composer.current?.focus();
  };
  const send = async () => {
    if (disabled || (!input.trim() && !attachments.length)) return;
    const text = input.trim() || "Please review the attached file.";
    const files = attachments;
    setInput("");
    setAttachments([]);
    nearBottom.current = true;
    setAtBottom(true);
    const accepted = await stream.send({
      text,
      attachments: files.length ? files : undefined,
    });
    if (!accepted && mounted.current) {
      setInput((previous) => previous || text);
      setAttachments(files);
    }
  };
  const newConversation = () => {
    if (disabled) return;
    c.handleNewConversation();
    setInput("");
    setAttachments([]);
    stream.reset();
    composer.current?.focus();
  };
  const selectConversation = (conversation: Conversation) => {
    if (disabled) return;
    setInput("");
    setAttachments([]);
    stream.reset();
    c.handleSelectConversation(conversation);
  };
  const ensureConversation = async () => {
    if (c.currentConversation) return c.currentConversation;
    const conversation = await createConversation();
    c.setCurrentConversation(conversation);
    c.setConversations((previous) => [conversation, ...previous]);
    return conversation;
  };
  const attach = async () => {
    if (disabled) return;
    setUploading(true);
    c.setError(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: "*/*",
      });
      if (picked.canceled || !picked.assets.length) return;
      const files = picked.assets.slice(0, 6 - attachments.length);
      if (files.some((file) => (file.size || 0) > 20 * 1024 * 1024)) {
        throw new Error("Files must be smaller than 20 MB.");
      }
      const conversation = await ensureConversation();
      for (const file of files) {
        const mime = file.mimeType || "application/octet-stream";
        const payload =
          Platform.OS === "web"
            ? file.file || (await (await fetch(file.uri)).blob())
            : { uri: file.uri, name: file.name, type: mime };
        const asset = await uploadJarvisAsset(
          payload,
          file.name,
          conversation.id,
          mime,
          conversation.active_project_id,
        );
        if (asset.id && mounted.current)
          setAttachments((previous) => [
            ...previous,
            {
              asset_id: String(asset.id),
              mime_type: mime,
              filename: file.name,
            },
          ]);
      }
    } catch (error) {
      c.setError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      if (mounted.current) setUploading(false);
    }
  };
  const applyProject = async (id: string | null) => {
    if (disabled) return;
    setMutating(true);
    c.setError(null);
    try {
      const conversation = await ensureConversation();
      const updated = await patchConversation(conversation.id, {
        active_project_id: id,
      });
      c.setCurrentConversation(updated);
      c.setConversations((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      setProjectOpen(false);
    } catch (error) {
      c.setError(
        error instanceof Error ? error.message : "Unable to set project.",
      );
    } finally {
      setMutating(false);
    }
  };
  const rename = async () => {
    if (!managed || !name.trim() || mutating) return;
    setMutating(true);
    c.setError(null);
    try {
      const updated = await patchConversation(managed.id, {
        title: name.trim(),
      });
      c.setConversations((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (c.currentConversation?.id === updated.id)
        c.setCurrentConversation(updated);
      setManaged(null);
    } catch (error) {
      c.setError(error instanceof Error ? error.message : "Rename failed.");
    } finally {
      setMutating(false);
    }
  };
  const remove = async (all = false) => {
    if (mutating || stream.busy) return;
    setMutating(true);
    c.setError(null);
    try {
      if (all) {
        await deleteAllConversations();
        c.setConversations([]);
        c.handleNewConversation();
        setInput("");
        stream.reset();
      } else if (managed) {
        await deleteConversation(managed.id);
        c.setConversations((previous) =>
          previous.filter((item) => item.id !== managed.id),
        );
        if (c.currentConversation?.id === managed.id) {
          c.handleNewConversation();
          setInput("");
          stream.reset();
        }
      }
      setManaged(null);
      setClearAll(false);
      setConfirmDelete(false);
    } catch (error) {
      c.setError(
        error instanceof Error
          ? error.message
          : "Unable to delete conversation.",
      );
    } finally {
      setMutating(false);
    }
  };
  const history = (
    <ConversationList
      conversations={c.conversations}
      selectedId={c.currentConversation?.id}
      loading={c.loadingConvs}
      disabled={disabled}
      onSelect={selectConversation}
      onManage={(conversation) => {
        c.setShowConvModal(false);
        setManaged(conversation);
        setName(conversationTitle(conversation.title));
        setConfirmDelete(false);
      }}
      onClear={() => {
        c.setShowConvModal(false);
        setClearAll(true);
      }}
    />
  );
  return (
    <KeyboardAvoidingView
      style={[s.root, { backgroundColor: t.canvas }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={s.main}>
        <View
          style={[
            s.header,
            compact && { paddingHorizontal: 12 },
          ]}
        >
          <Pressable
            ref={conversationPicker}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Choose conversation"
            aria-expanded={c.showConvModal}
            accessibilityState={{ expanded: c.showConvModal, disabled }}
            onPress={openConversations}
            style={s.headerTitle}
          >
            <Text numberOfLines={1} style={[s.title, { color: t.ink }]}>
              {conversationTitle(c.currentConversation?.title)}
            </Text>
            <Ionicons name="chevron-down" size={15} color={t.muted} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <IconButton
            icon="create-outline"
            label="Start new conversation"
            onPress={newConversation}
            disabled={disabled}
          />
        </View>
        <View style={s.thread}>
          <ScrollView
            ref={scroll}
            style={s.scroll}
            contentContainerStyle={[
              s.scrollContent,
              compact && { paddingHorizontal: 18 },
              !visibleMessages.length && {
                flexGrow: 1,
                justifyContent: "center",
              },
            ]}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={100}
            onScrollBeginDrag={() => { userScrolling.current = true; }}
            onScrollEndDrag={() => { userScrolling.current = false; }}
            onMomentumScrollBegin={() => { userScrolling.current = true; }}
            onMomentumScrollEnd={() => { userScrolling.current = false; }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                event.nativeEvent;
              const near =
                contentSize.height -
                  contentOffset.y -
                  layoutMeasurement.height <
                100;
              // Content growth and keyboard resizing can make the viewport
              // temporarily non-bottom without the user scrolling away.
              // Only an upward scroll opts out of following new text.
              if (near) nearBottom.current = true;
              else if (
                (Platform.OS === "web" || userScrolling.current) &&
                contentOffset.y < lastScrollOffset.current - 2
              ) nearBottom.current = false;
              lastScrollOffset.current = contentOffset.y;
              setAtBottom(nearBottom.current);
            }}
            onLayout={() => {
              if (nearBottom.current)
                scroll.current?.scrollToEnd({ animated: false });
            }}
            onContentSizeChange={() => {
              if (!visibleMessages.length && !stream.busy)
                scroll.current?.scrollTo({ y: 0, animated: false });
              else if (nearBottom.current)
                scroll.current?.scrollToEnd({ animated: false });
            }}
          >
            <View style={s.readingColumn}>
              {c.loadingMessages ? (
                <View style={s.loading}>
                  <ActivityIndicator color={t.purple} />
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    Loading conversation
                  </Text>
                </View>
              ) : !visibleMessages.length && !stream.busy ? (
                null
              ) : (
                <>
                  {visibleMessages.map((message, index) => (
                    <React.Fragment key={message.id || `message-${index}`}>
                      <ChatMessage
                        message={message}
                        onReuse={draft}
                        onSpeak={(message) => {
                          void audio.speak(message);
                        }}
                        speaking={
                          audio.playing === (message.id || message.created_at)
                        }
                        speakLoading={
                          audio.loading === (message.id || message.created_at)
                        }
                      />
                      {message.role === "assistant" && (
                        <ChatTaskCards
                          tools={(message as any).tool_calls || []}
                        />
                      )}
                    </React.Fragment>
                  ))}
                  {(stream.busy ||
                    stream.answer ||
                    stream.tools.length > 0) && (
                    <View style={s.live}>
                      <View style={s.liveAuthor}>
                        <JarvisMark active={stream.busy} />
                        <Text
                          style={{
                            color: t.ink,
                            fontWeight: "600",
                            fontSize: 13,
                          }}
                        >
                          Jarvis
                        </Text>
                      </View>
                      <ActivityTrace
                        tools={stream.tools}
                        busy={stream.busy}
                        phase={stream.phase}
                        startedAt={stream.startedAt}
                      />
                      {stream.answer ? (
                        <ChatMarkdown content={stream.answer} />
                      ) : null}
                      <ChatTaskCards tools={stream.tools} />
                    </View>
                  )}
                </>
              )}
            </View>
          </ScrollView>
          {!atBottom && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Jump to latest message"
              onPress={scrollToEnd}
              style={[
                s.jump,
                { backgroundColor: t.panel, borderColor: t.line },
              ]}
            >
              <Ionicons name="arrow-down" size={15} color={t.purple} />
              <Text style={{ color: t.ink, fontSize: 12 }}>Latest</Text>
            </Pressable>
          )}
        </View>
        <View
          style={[
            s.composerWrap,
            compact && { paddingHorizontal: 12, paddingBottom: 10 },
          ]}
        >
          <View style={s.readingColumn}>
            {(c.error || stream.notice) && (
              <View
                accessibilityLiveRegion="polite"
                style={[
                  s.notice,
                  {
                    backgroundColor: t.inset,
                    borderColor: c.error ? t.error : t.line,
                  },
                ]}
              >
                <Ionicons
                  name={
                    c.error
                      ? "alert-circle-outline"
                      : "information-circle-outline"
                  }
                  size={17}
                  color={c.error ? t.error : t.muted}
                />
                <Text
                  selectable
                  style={{
                    flex: 1,
                    color: c.error ? t.error : t.muted,
                    fontSize: 12,
                    lineHeight: 18,
                  }}
                >
                  {c.error || stream.notice}
                </Text>
                <IconButton
                  icon="close"
                  label="Dismiss notice"
                  onPress={() => {
                    c.setError(null);
                    stream.clearNotice();
                  }}
                />
              </View>
            )}
            <View
              style={[
                s.composer,
                { backgroundColor: t.panel, borderColor: t.line },
              ]}
            >
              {attachments.length > 0 && (
                <ScrollView horizontal contentContainerStyle={s.attachments}>
                  {attachments.map((file, i) => (
                    <View
                      key={`${file.asset_id}-${i}`}
                      style={[s.attachment, { backgroundColor: t.inset }]}
                    >
                      <Ionicons
                        name="document-text-outline"
                        size={14}
                        color={t.purple}
                      />
                      <Text
                        numberOfLines={1}
                        style={{ color: t.ink, fontSize: 11, maxWidth: 140 }}
                      >
                        {file.filename}
                      </Text>
                      <IconButton
                        icon="close"
                        size={13}
                        label={`Remove ${file.filename}`}
                        onPress={() =>
                          setAttachments((previous) =>
                            previous.filter((_, index) => index !== i),
                          )
                        }
                        disabled={stream.busy}
                      />
                    </View>
                  ))}
                </ScrollView>
              )}
              <View style={s.composerToolbar}>
                {uploading ? (
                  <ActivityIndicator size="small" color={t.purple} style={{ margin: 8 }} />
                ) : (
                  <IconButton
                    icon="add"
                    label="Attach files"
                    onPress={() => { void attach(); }}
                    disabled={disabled || attachments.length >= 6}
                  />
                )}
                <TextInput
                  ref={composer}
                  accessibilityLabel="Message Jarvis"
                  style={[s.input, { color: t.ink }]}
                  placeholder="Message Jarvis…"
                  placeholderTextColor={t.muted}
                  value={input}
                  onChangeText={setInput}
                  multiline
                  numberOfLines={1}
                  textAlignVertical="top"
                  maxLength={30000}
                  editable={!mutating}
                  onKeyPress={(event) => {
                    const native = event.nativeEvent as any;
                    if (
                      Platform.OS === "web" &&
                      native.key === "Enter" &&
                      !native.shiftKey &&
                      !native.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    stream.busy ? "Stop response" : "Send message"
                  }
                  disabled={
                    !stream.busy &&
                    (disabled || (!input.trim() && !attachments.length))
                  }
                  onPress={() => {
                    if (stream.busy) stream.stop();
                    else void send();
                  }}
                  style={({ pressed }) => [
                    s.send,
                    {
                      backgroundColor: stream.busy ? t.inset : t.purple,
                      opacity: pressed
                        ? 0.7
                        : !stream.busy &&
                            (disabled || (!input.trim() && !attachments.length))
                          ? 0.35
                          : 1,
                    },
                  ]}
                >
                  <Ionicons
                    name={stream.busy ? "stop" : "arrow-up"}
                    size={stream.busy ? 17 : 22}
                    color={
                      stream.busy ? t.purple : t.dark ? "#211635" : "#ffffff"
                    }
                  />
                </Pressable>
              </View>
            </View>
            {(attachments.length > 0 || project) && <View style={s.composerFooter}>
              <Text style={{ color: t.muted, fontSize: 10 }}>
                {attachments.length
                  ? "Images and text files supported. PDFs are stored only."
                  : project
                    ? `Using ${project.title}`
                    : ""}
              </Text>
            </View>}
          </View>
        </View>
      </View>
      <Modal
        visible={c.showConvModal}
        transparent
        animationType="fade"
        onRequestClose={() => c.setShowConvModal(false)}
      >
        <View style={{ flex: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close conversations"
            onPress={() => c.setShowConvModal(false)}
            style={StyleSheet.absoluteFill}
          />
          <View
            accessibilityViewIsModal
            style={[
              s.conversationMenu,
              {
                backgroundColor: t.panel,
                borderColor: t.line,
                left: menuPosition.left,
                top: menuTop,
                width: Math.min(380, width - 24),
                maxHeight: Math.max(0, Math.min(460, height - menuTop - 16)),
              },
            ]}
          >
            {history}
          </View>
        </View>
      </Modal>
      <Sheet
        visible={projectOpen}
        onClose={() => setProjectOpen(false)}
        title="Project context"
      >
        {c.error && (
          <Text style={{ color: t.error, fontSize: 12 }}>{c.error}</Text>
        )}
        <ScrollView keyboardShouldPersistTaps="handled">
          {[{ id: "", title: "No project" }, ...projects].map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              disabled={mutating}
              onPress={() => {
                void applyProject(item.id || null);
              }}
              style={[s.projectRow, { borderBottomColor: t.line }]}
            >
              <Ionicons
                name={item.id ? "briefcase-outline" : "remove-circle-outline"}
                color={t.purple}
                size={18}
              />
              <Text style={{ color: t.ink, flex: 1 }}>{item.title}</Text>
              {(c.currentConversation?.active_project_id || "") === item.id && (
                <Ionicons name="checkmark" color={t.purple} size={18} />
              )}
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
      <Sheet
        visible={!!managed}
        onClose={() => {
          if (!mutating) setManaged(null);
        }}
        title={confirmDelete ? "Delete conversation?" : "Conversation"}
      >
        {c.error && (
          <Text style={{ color: t.error, fontSize: 12 }}>{c.error}</Text>
        )}
        {confirmDelete ? (
          <>
            <Text style={{ color: t.muted, lineHeight: 21 }}>
              “{conversationTitle(managed?.title)}” and its messages will be
              permanently deleted.
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={mutating}
              onPress={() => {
                void remove();
              }}
              style={[s.action, { backgroundColor: t.error }]}
            >
              <Text style={s.actionText}>
                {mutating ? "Deleting…" : "Delete conversation"}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              accessibilityLabel="Conversation name"
              style={[
                s.nameInput,
                { color: t.ink, borderColor: t.line, backgroundColor: t.inset },
              ]}
              value={name}
              onChangeText={setName}
              maxLength={300}
              onSubmitEditing={() => {
                void rename();
              }}
            />
            <Pressable
              accessibilityRole="button"
              disabled={mutating || !name.trim()}
              onPress={() => {
                void rename();
              }}
              style={[s.action, { backgroundColor: t.accent }]}
            >
              <Text style={s.actionText}>
                {mutating ? "Saving…" : "Save name"}
              </Text>
            </Pressable>
            {managed?.id === c.currentConversation?.id && <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose project context"
              disabled={mutating}
              onPress={() => {
                setManaged(null);
                setProjectOpen(true);
              }}
              style={s.deleteButton}
            >
              <Text style={{ color: t.muted, fontSize: 13 }}>
                Project: {project?.title || "None"}
              </Text>
            </Pressable>}
            <Pressable
              accessibilityRole="button"
              disabled={mutating}
              onPress={() => setConfirmDelete(true)}
              style={s.deleteButton}
            >
              <Ionicons name="trash-outline" color={t.error} size={16} />
              <Text style={{ color: t.error, fontSize: 13 }}>
                Delete conversation
              </Text>
            </Pressable>
          </>
        )}
      </Sheet>
      <Sheet
        visible={clearAll}
        onClose={() => {
          if (!mutating) setClearAll(false);
        }}
        title="Clear history?"
      >
        {c.error && (
          <Text style={{ color: t.error, fontSize: 12 }}>{c.error}</Text>
        )}
        <Text style={{ color: t.muted, lineHeight: 21 }}>
          Permanently delete all {c.conversations.length} conversations and
          their messages?
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={mutating}
          onPress={() => {
            void remove(true);
          }}
          style={[s.action, { backgroundColor: t.error }]}
        >
          <Text style={s.actionText}>
            {mutating ? "Clearing…" : "Clear all conversations"}
          </Text>
        </Pressable>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, minHeight: 0, width: "100%" },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  conversationMenu: { position: "absolute", borderWidth: 1, borderRadius: 12, padding: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 25,
    paddingVertical: 8,
  },
  headerTitle: { flexShrink: 1, minWidth: 0, maxWidth: 380, flexDirection: "row", alignItems: "center", gap: 9, minHeight: 40 },
  title: { fontSize: 14, fontWeight: "500", flexShrink: 1 },
  thread: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 34,
    paddingTop: 9,
    paddingBottom: 25,
    alignItems: "center",
  },
  readingColumn: { maxWidth: 790, width: "100%", alignSelf: "center" },
  loading: { padding: 45, alignItems: "center", gap: 14 },
  live: { paddingVertical: 18 },
  liveAuthor: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 15,
  },
  jump: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  composerWrap: { paddingHorizontal: 30, paddingBottom: 15, paddingTop: 3 },
  composer: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 7,
  },
  input: {
    fontSize: 15,
    lineHeight: 23,
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    maxHeight: 190,
    padding: 9,
    paddingBottom: 10,
    outlineWidth: 0,
  } as any,
  composerToolbar: { flexDirection: "row", alignItems: "flex-end", gap: 3 },
  send: {
    width: 37,
    height: 37,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 2,
    marginBottom: 2,
  },
  composerFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 9,
    paddingHorizontal: 4,
    gap: 10,
    minHeight: 20,
  },
  attachments: { gap: 7, padding: 4 },
  attachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 9,
    borderRadius: 9,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 5,
    paddingLeft: 12,
    paddingRight: 3,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 12,
  },
  projectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 17,
    borderBottomWidth: 1,
  },
  nameInput: { borderWidth: 1, borderRadius: 12, padding: 13, fontSize: 15 },
  action: { padding: 14, borderRadius: 11, alignItems: "center" },
  actionText: { color: "#ffffff", fontWeight: "600", fontSize: 14 },
  deleteButton: {
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    padding: 10,
  },
});
