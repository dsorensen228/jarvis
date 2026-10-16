import {
  createConversation,
  fetchMessageTtsWav,
  listJarvisProjects,
  patchConversation,
  postMessage,
  uploadJarvisAsset,
  type Conversation,
  type JarvisProject,
  type Message,
  type MessageAttachmentRef,
} from '@/lib/api-client';
import {
  agentAvatars,
  getAgentAvatarSource,
  userDefaultAvatar,
} from '@/lib/avatars';
import { Ionicons } from '@expo/vector-icons';
import { Audio as ExpoAudio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-native-markdown-display';
import {
  Image,
  ImageSourcePropType,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { BrandAvatarImage } from '../BrandAvatarImage';
import { useAuth } from '../../contexts/AuthContext';
import { useConversation } from '../../contexts/ConversationContext';
import { useTheme } from '../../contexts/ThemeContext';

import { getApiBaseUrl } from '@/lib/runtimePublicEnv';

function MessageAvatar({
  source,
  icon,
  size = 28,
  useBrandBackdrop = false,
}: {
  source?: ImageSourcePropType | null;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  size?: number;
  /** Transparent default logo: black circle behind the image in light mode. */
  useBrandBackdrop?: boolean;
}) {
  if (source) {
    if (useBrandBackdrop) {
      return <BrandAvatarImage source={source} size={size} resizeMode="cover" />;
    }
    return (
      <Image
        source={source}
        style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
        resizeMode="cover"
      />
    );
  }
  if (icon) {
    return (
      <View
        style={[
          styles.avatarPlaceholder,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <Ionicons name={icon} size={size * 0.6} color="#888" />
      </View>
    );
  }
  return null;
}

function SystemMessageView({
  msg,
  colors,
  avatar,
  speaker,
}: {
  msg: Message;
  colors: ReturnType<typeof useTheme>['colors'];
  avatar: React.ReactNode;
  speaker: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasAdditional = !!msg.additional_info;

  return (
    <View style={[styles.messageRowInner, styles.systemRowInner]}>
      {avatar}
      <View
        style={[
          styles.messageBubble,
          styles.assistantBubble,
          styles.systemBubble,
          {
            backgroundColor: colors.surfaceAgentMessage,
            borderColor: colors.border,
          },
        ]}
      >
        <Markdown
          style={{
            body: {
              color: colors.text,
              fontSize: 15,
              lineHeight: 22,
            },
            paragraph: { marginVertical: 6 },
            heading1: { color: colors.text },
            heading2: { color: colors.text },
            link: { color: colors.accent },
          }}
        >
          {msg.content}
        </Markdown>
        {speaker}
        {hasAdditional && (
          <>
            <Pressable
              style={styles.expandableHeader}
              onPress={() => setExpanded((e) => !e)}
            >
              <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.accent} />
              <Text style={[styles.expandableToggle, { color: colors.accent }]}>
                {expanded ? 'Hide details' : 'Show details'}
              </Text>
            </Pressable>
            {expanded && (
              <Markdown
                style={{
                  body: {
                    color: colors.textMuted,
                    fontSize: 14,
                    lineHeight: 20,
                  },
                  paragraph: { marginVertical: 6 },
                  heading1: { color: colors.textMuted },
                  heading2: { color: colors.textMuted },
                  link: { color: colors.accent },
                }}
              >
                {msg.additional_info}
              </Markdown>
            )}
          </>
        )}
      </View>
    </View>
  );
}

export function ChatTab() {
  const { user, accessToken } = useAuth();
  const { colors } = useTheme();
  const {
    currentConversation,
    setCurrentConversation,
    conversations,
    setConversations,
    messages,
    setMessages,
    loadingConvs,
    showConvModal,
    setShowConvModal,
    error,
    setError,
    handleSelectConversation,
    handleNewConversation,
  } = useConversation();

  const [projects, setProjects] = useState<JarvisProject[]>([]);
  const [projectModal, setProjectModal] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachmentRef[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);

  const userAvatarSource = user?.avatar_url
    ? { uri: `${getApiBaseUrl()}${user.avatar_url}` }
    : userDefaultAvatar;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  /** Muted intermediate stream: routing hints + non-final model phases (merge/judge/primary, etc.) */
  const [thinkingStream, setThinkingStream] = useState('');
  /** Final Jarvis reply stream (voice_rewrite phase only; markdown) */
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const voiceRewriteStartedRef = useRef(false);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const [ttsLoading, setTtsLoading] = useState<Record<string, boolean>>({});
  const [ttsPlayingId, setTtsPlayingId] = useState<string | null>(null);
  const nativeSoundRef = useRef<ExpoAudio.Sound | null>(null);
  const webAudioRef = useRef<any>(null);
  const { width } = useWindowDimensions();
  const desktopThread = width >= 1024;
  const visibleMessages = messages.filter((message) => {
    const content = (message.content || '').trim().toLowerCase();
    if (content === 'voice chat stopped' || content === 'voice chat started (real-time)') {
      return false;
    }
    return message.role !== 'system';
  });

  const stopTtsPlayback = async () => {
    try {
      if (Platform.OS === 'web') {
        if (webAudioRef.current) {
          webAudioRef.current.pause();
          webAudioRef.current.currentTime = 0;
          webAudioRef.current = null;
        }
      } else if (nativeSoundRef.current) {
        const sound = nativeSoundRef.current;
        nativeSoundRef.current = null;
        await sound.stopAsync().catch(() => {});
        await sound.unloadAsync().catch(() => {});
      }
    } finally {
      setTtsPlayingId(null);
    }
  };

  const playMessageTts = async (msg: Message) => {
    if (!msg.id) return;
    const mid = msg.id;
    if (ttsLoading[mid]) return;
    if (ttsPlayingId === mid) {
      await stopTtsPlayback();
      return;
    }
    setTtsLoading((prev) => ({ ...prev, [mid]: true }));
    try {
      await stopTtsPlayback();
      const buf = await fetchMessageTtsWav(msg.content);
      if (Platform.OS === 'web') {
        const blob = new Blob([buf], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new globalThis.Audio(url);
        webAudioRef.current = audio;
        setTtsPlayingId(mid);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setTtsPlayingId((curr) => (curr === mid ? null : curr));
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setTtsPlayingId((curr) => (curr === mid ? null : curr));
        };
        await audio.play();
      } else {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        const base64 = globalThis.btoa(binary);
        const path = `${FileSystem.cacheDirectory}tts-${mid}-${Date.now()}.wav`;
        await FileSystem.writeAsStringAsync(path, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const { sound } = await ExpoAudio.Sound.createAsync({ uri: path });
        nativeSoundRef.current = sound;
        setTtsPlayingId(mid);
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync().catch(() => {});
            FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
            nativeSoundRef.current = null;
            setTtsPlayingId((curr) => (curr === mid ? null : curr));
          }
        });
        await sound.playAsync();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to play message audio');
      setTtsPlayingId((curr) => (curr === mid ? null : curr));
    } finally {
      setTtsLoading((prev) => ({ ...prev, [mid]: false }));
    }
  };

  const renderSpeakerButton = (msg: Message) => {
    if (!msg.id) return null;
    const busy = !!ttsLoading[msg.id];
    const playing = ttsPlayingId === msg.id;
    return (
      <TouchableOpacity
        style={styles.ttsButton}
        onPress={() => {
          void playMessageTts(msg);
        }}
        disabled={busy}
      >
        <Ionicons
          name={playing ? 'stop-circle-outline' : 'volume-high-outline'}
          size={18}
          color={colors.accent}
        />
      </TouchableOpacity>
    );
  };

  useEffect(() => {
    if (!accessToken) return;
    listJarvisProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [accessToken]);


  useEffect(() => {
    return () => {
      void stopTtsPlayback();
    };
  }, []);

  const pickAttachment = async () => {
    let conv = currentConversation;
    if (!conv) {
      try {
        conv = await createConversation();
        setConversations((prev) => [conv!, ...prev]);
        setCurrentConversation(conv);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create conversation');
        return;
      }
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library permission required');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setAttachBusy(true);
    setError(null);
    try {
      const uri = asset.uri;
      const name = uri.split('/').pop() || 'image.jpg';
      const res = await fetch(uri);
      const blob = await res.blob();
      const mime = asset.mimeType || blob.type || 'image/jpeg';
      const uploaded = (await uploadJarvisAsset(
        blob,
        name,
        conv.id,
        mime,
        conv.active_project_id ?? undefined
      )) as { id?: string };
      const id = uploaded.id as string;
      if (id) {
        setPendingAttachments((prev) => [...prev, { asset_id: id, mime_type: mime }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setAttachBusy(false);
    }
  };

  const applyActiveProject = async (projectId: string | null) => {
    let conv = currentConversation;
    if (!conv) {
      try {
        conv = await createConversation();
        setConversations((prev) => [conv!, ...prev]);
        setCurrentConversation(conv);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create conversation');
        return;
      }
    }
    try {
      const updated = await patchConversation(conv.id, { active_project_id: projectId });
      setCurrentConversation(updated);
      setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set project');
    }
    setProjectModal(false);
  };

  const handleSend = async () => {
    const text = input.trim();
    const hasAtt = pendingAttachments.length > 0;
    if ((!text && !hasAtt) || loading || typing || !!streamingAnswer || !!thinkingStream) return;

    const conv = currentConversation;
    const outgoing = text || (hasAtt ? '(attachment)' : '');
    const attachments = hasAtt ? pendingAttachments : undefined;

    setInput('');
    setPendingAttachments([]);
    setError(null);
    setTyping(true);
    setThinkingStream('');
    setStreamingAnswer('');
    voiceRewriteStartedRef.current = false;

    const optimisticUserMsg: Message = {
      role: 'user',
      content: outgoing,
      created_at: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);


    setLoading(true);
    try {
      const res = await postMessage(conv?.id, outgoing, attachments);
      if (res.conversation_id && user) {
        const now = new Date().toISOString();
        const newConv: Conversation = {
          id: res.conversation_id,
          user_id: user.id,
          created_at: now,
          updated_at: now,
          message_count: res.user_message && res.assistant_message ? 2 : 1,
          active_project_id: conv?.active_project_id ?? null,
        };
        setCurrentConversation((c) => c ?? newConv);
        setConversations((prev) => {
          if (prev.some((x) => x.id === newConv.id)) {
            return prev.map((c) => (c.id === newConv.id ? { ...c, ...newConv } : c));
          }
          return [newConv, ...prev];
        });
      }
      const user_message = res.user_message;
      const assistant_message = res.assistant_message;
      setMessages((prev) => {
        const withoutOpt = user_message ? prev.filter(
          (m) =>
            !(
              m.role === 'user' &&
              m.content === outgoing &&
              !m.id &&
              (attachments?.length || 0) === (m.attachments?.length || 0)
            )
        ) : prev;
        const next = [...withoutOpt];
        if (user_message) next.push(user_message);
        if (assistant_message) next.push(assistant_message);
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setLoading(false);
      setTyping(false);
    }
  };

  const dynamicStyles = {
    container: { backgroundColor: colors.background },
    convButton: { backgroundColor: colors.surface },
    convButtonText: { color: colors.text },
    userBubble: { backgroundColor: colors.accent },
    assistantBubble: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
    },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
    },
    btn: { backgroundColor: colors.accent },
    emptyText: { color: colors.textMuted },
    modalContent: { backgroundColor: colors.surface },
    modalTitle: { color: colors.text },
    convItem: { borderBottomColor: colors.border },
    convItemText: { color: colors.text },
  };

  if (loadingConvs && conversations.length === 0) {
    return (
      <View style={[styles.container, dynamicStyles.container, styles.loading]}>
        <Text style={dynamicStyles.emptyText}>Loading...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, dynamicStyles.container]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={[styles.chatColumn, desktopThread && styles.chatColumnDesktop]}>
        <View style={[styles.headerRow, { borderBottomColor: colors.border }]}>
          <TouchableOpacity
            style={[styles.convButton, dynamicStyles.convButton]}
            onPress={() => setShowConvModal(true)}
          >
            <Ionicons name="chatbubbles-outline" size={20} color={colors.accent} />
            <Text style={[styles.convButtonText, dynamicStyles.convButtonText]} numberOfLines={1}>
              {currentConversation
                ? currentConversation.title?.trim() ||
                  `Conversation (${messages.length} msgs)`
                : 'New conversation'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.projectButton, dynamicStyles.convButton]}
            onPress={() => setProjectModal(true)}
          >
            <Ionicons name="briefcase-outline" size={18} color={colors.accent} />
            <Text
              style={[styles.convButtonText, dynamicStyles.convButtonText]}
              numberOfLines={1}
            >
              {currentConversation?.active_project_id
                ? projects.find((p) => p.id === currentConversation.active_project_id)?.title ||
                  'Project'
                : 'Project'}
            </Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={projectModal}
          transparent
          animationType="fade"
          onRequestClose={() => setProjectModal(false)}
        >
          <TouchableOpacity
            style={styles.projectModalBackdrop}
            activeOpacity={1}
            onPress={() => setProjectModal(false)}
          >
            <View style={[styles.projectModalInner, { backgroundColor: colors.surface }]}>
              <Text style={[styles.projectModalTitle, { color: colors.text }]}>Active project</Text>
              <TouchableOpacity
                style={[styles.projectRow, { borderColor: colors.border }]}
                onPress={() => void applyActiveProject(null)}
              >
                <Text style={{ color: colors.text }}>None</Text>
              </TouchableOpacity>
              {projects.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.projectRow, { borderColor: colors.border }]}
                  onPress={() => void applyActiveProject(p.id)}
                >
                  <Text style={{ color: colors.text }}>{p.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>

        <Modal
          visible={showConvModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowConvModal(false)}
        >
          <TouchableOpacity
            style={styles.convModalBackdrop}
            activeOpacity={1}
            onPress={() => setShowConvModal(false)}
          >
            <View style={[styles.convModalInner, dynamicStyles.modalContent]}>
              <Text style={[styles.modalTitle, dynamicStyles.modalTitle]}>Conversations</Text>
              <TouchableOpacity
                style={[styles.newConvBtn, dynamicStyles.btn]}
                onPress={handleNewConversation}
              >
                <Text style={styles.btnText}>New conversation</Text>
              </TouchableOpacity>
              <ScrollView
                style={styles.convModalScroll}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
              >
                {conversations.map((c) => {
                  const primary =
                    (c.title && c.title.trim()) ||
                    (c.summary && c.summary.trim().split('\n')[0]) ||
                    null;
                  const secondary = `${c.message_count ?? 0} messages • ${new Date(
                    c.updated_at
                  ).toLocaleDateString()}`;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={[styles.convItem, dynamicStyles.convItem]}
                      onPress={() => handleSelectConversation(c)}
                    >
                      <Text style={dynamicStyles.convItemText} numberOfLines={primary ? 2 : 1}>
                        {primary || secondary}
                      </Text>
                      {primary ? (
                        <Text
                          style={[styles.convItemMeta, { color: colors.textMuted }]}
                          numberOfLines={1}
                        >
                          {secondary}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>

        <ScrollView
          ref={scrollRef}
          style={styles.messages}
          contentContainerStyle={
            visibleMessages.length || streamingAnswer || thinkingStream || typing
              ? {}
              : styles.empty
          }
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          {visibleMessages.length === 0 && !streamingAnswer && !thinkingStream && !typing ? (
            <View style={styles.emptyContent}>
              <Text style={[styles.emptyText, dynamicStyles.emptyText]}>
                {currentConversation
                  ? 'No messages yet. Ask Jarvis anything.'
                  : 'Select a conversation or send a message to start.'}
              </Text>
              <Text style={[styles.emptyHint, dynamicStyles.emptyText]}>
                Ask about tasks, lights, email, or research — Jarvis routes to the
                right agent.
              </Text>
            </View>
          ) : (
            <>
              {visibleMessages.map((m, i) => {
                if (m.role === 'user') {
                  return (
                    <View key={m.id || `msg-${i}`} style={[styles.messageRow, styles.userRow]}>
                      <View
                        style={[
                          styles.messageBubble,
                          styles.userBubble,
                          dynamicStyles.userBubble,
                        ]}
                      >
                        <Text style={[styles.messageText, { color: '#fff' }]}>
                          {m.content}
                        </Text>
                      </View>
                      <MessageAvatar
                        source={userAvatarSource}
                        size={28}
                        useBrandBackdrop={!user?.avatar_url}
                      />
                    </View>
                  );
                }
                return (
                  <View key={m.id || `msg-${i}`} style={styles.assistantMarkdownRow}>
                    <Markdown
                      style={{
                        body: {
                          color: colors.text,
                          fontSize: 15,
                          lineHeight: 22,
                        },
                        paragraph: { marginVertical: 6 },
                        heading1: { color: colors.text },
                        heading2: { color: colors.text },
                        link: { color: colors.accent },
                      }}
                    >
                      {m.content}
                    </Markdown>
                    {m.sources && m.sources.length > 0 ? (
                      <View style={{ marginTop: 8, marginBottom: 4 }}>
                        <Text style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>
                          Sources
                        </Text>
                        {m.sources.map((s, j) => (
                          <Pressable
                            key={`${s.url}-${j}`}
                            onPress={() => {
                              void Linking.openURL(s.url);
                            }}
                          >
                            <Text
                              style={{ fontSize: 13, color: colors.accent, marginBottom: 4 }}
                              numberOfLines={2}
                            >
                              {(s.title && s.title.trim()) || s.url}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                    <View style={styles.assistantSpeakerRow}>{renderSpeakerButton(m)}</View>
                  </View>
                );
              })}

              {typing && !thinkingStream && !streamingAnswer && (
                <View style={styles.assistantMarkdownRow}>
                  <Text style={[styles.thinkingText, { color: colors.textMuted }]}>
                    Jarvis is thinking...
                  </Text>
                </View>
              )}

              {!!thinkingStream && (
                <View style={styles.assistantMarkdownRow} accessibilityLiveRegion="polite">
                  <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{thinkingStream}</Text>
                </View>
              )}

              {!!streamingAnswer && (
                <View style={styles.assistantMarkdownRow}>
                  <Markdown
                    style={{
                      body: {
                        color: colors.text,
                        fontSize: 15,
                        lineHeight: 22,
                      },
                      paragraph: { marginVertical: 6 },
                      heading1: { color: colors.text },
                      heading2: { color: colors.text },
                      link: { color: colors.accent },
                    }}
                  >
                    {streamingAnswer}
                  </Markdown>
                </View>
              )}
            </>
          )}
        </ScrollView>
        {error && (
          <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
        )}
        <View style={[styles.form, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={() => void pickAttachment()}
            disabled={
              attachBusy ||
              loading ||
              !!streamingAnswer ||
              !!thinkingStream ||
              typing
            }
          >
            <Ionicons
              name="attach-outline"
              size={24}
              color={attachBusy ? colors.textMuted : colors.accent}
            />
          </TouchableOpacity>
          <TextInput
            style={[styles.input, dynamicStyles.input]}
            placeholder="Message Jarvis..."
            placeholderTextColor={colors.textMuted}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={handleSend}
            editable={
              !loading && !streamingAnswer && !thinkingStream && !typing
            }
          />
          <TouchableOpacity
            style={[
              styles.btn,
              dynamicStyles.btn,
              (loading ||
                !!streamingAnswer ||
                !!thinkingStream ||
                typing) &&
                styles.btnDisabled,
            ]}
            onPress={handleSend}
            disabled={
              loading ||
              !!streamingAnswer ||
              !!thinkingStream ||
              typing
            }
          >
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
        {pendingAttachments.length > 0 ? (
          <Text style={[styles.attachHint, { color: colors.textMuted }]}>
            {pendingAttachments.length} attachment(s) will be sent with your message
          </Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  chatColumn: {
    flex: 1,
    width: '100%',
    minWidth: 0,
    alignSelf: 'center',
  },
  chatColumnDesktop: {
    maxWidth: 880,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  projectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 160,
    minWidth: 0,
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  projectModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  projectModalInner: {
    borderRadius: 12,
    padding: 16,
    maxHeight: 400,
  },
  projectModalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 12 },
  projectRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  attachHint: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 12 },
  convButton: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  convButtonText: { fontSize: 14, flexShrink: 1 },
  messages: { flex: 1, padding: 16 },
  messageRow: { marginBottom: 12 },
  messageRowInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  systemRowInner: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    gap: 8,
    alignSelf: 'flex-end',
  },
  assistantRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    alignSelf: 'flex-start',
  },
  assistantMarkdownRow: {
    alignSelf: 'stretch',
    marginBottom: 12,
    maxWidth: '100%',
  },
  reasoningText: {
    fontSize: 14,
    lineHeight: 20,
    fontStyle: 'italic',
    opacity: 0.72,
  },
  /** Intermediate / non-final model output (ChatGPT-style muted stream) */
  thinkingText: {
    fontSize: 13,
    lineHeight: 19,
    opacity: 0.55,
  },
  assistantSpeakerRow: {
    alignSelf: 'flex-end',
    marginTop: 4,
  },
  avatar: {},
  avatarPlaceholder: {
    backgroundColor: 'rgba(128,128,128,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 12,
  },
  userBubble: { alignSelf: 'flex-end' },
  assistantBubble: {
    alignSelf: 'flex-start',
    borderWidth: 1,
  },
  systemBubble: {
    flex: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
  messageText: { fontSize: 15 },
  expandableHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  expandableToggle: { fontSize: 13 },
  expandableContent: { marginTop: 6, fontSize: 14 },
  ttsButton: { alignSelf: 'flex-end', marginTop: 6, padding: 2 },
  form: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    width: '100%',
    padding: 16,
    gap: 8,
    borderTopWidth: 1,
  },
  attachBtn: {
    flexShrink: 0,
    padding: 4,
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 15,
  },
  btn: {
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  error: { padding: 16, fontSize: 14, textAlign: 'center' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  emptyContent: { alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  emptyHint: { fontSize: 13, textAlign: 'center', opacity: 0.8 },
  loading: { justifyContent: 'center', alignItems: 'center' },
  convModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 24,
  },
  convModalInner: {
    borderRadius: 12,
    padding: 16,
    maxHeight: 400,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 880,
  },
  convModalScroll: {
    flexGrow: 0,
    maxHeight: 280,
  },
  modalTitle: { fontSize: 17, fontWeight: '600', marginBottom: 12 },
  newConvBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  convItem: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
  },
  convItemText: { fontSize: 15 },
  convItemMeta: { fontSize: 12, marginTop: 4 },
});
