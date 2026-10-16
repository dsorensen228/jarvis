import { useNotificationTaskFocus } from '../../hooks/useNotificationTaskFocus';
import { cancelCodeTask, createCodeTask, getCodeTask, followUpCodeTask, type CodeTask, type CodeTaskModel } from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Modal, Platform,
  ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity,
  useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CODING_TASK_MODAL_BACKDROP_PADDING, codingTaskSheetMaxHeight } from '../../lib/codingTaskModalLayout';
import { ACTIVE_TASK_STATUSES as ACTIVE, TASK_FILTERS, taskResult, taskStatusLabel, taskTiming } from '../../lib/codeTaskState';
import { useCodeTaskFeed } from '../../hooks/useCodeTaskFeed';
import { useTheme } from '../../contexts/ThemeContext';
import { AGENT_MODELS, AgentModelPicker, agentModelLabel as modelLabel } from './AgentModelPicker';

const DRAFT_KEY = 'code-factory-prompt-draft';
function statusColor(status: CodeTask['status']): string {
  if (status === 'success') return '#39b978';
  if (status === 'failed') return '#e45d6b';
  if (status === 'cancelled' || status === 'cancel_requested') return '#85818b';
  return '#ad62dc';
}

export function CodingTasksTab({ focusTaskId, onFocusConsumed }: { focusTaskId?: string | null; onFocusConsumed?: () => void } = {}) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const narrow = width < 420;
  const topInset = Math.max(insets.top, Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0);
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'android' ? 24 : 0);
  const sheetMaxHeight = codingTaskSheetMaxHeight(height, { padding: CODING_TASK_MODAL_BACKDROP_PADDING, topInset, bottomInset });
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    if (Platform.OS !== 'web') return () => subscription.remove();
    const change = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => { subscription.remove(); document.removeEventListener('visibilitychange', change); };
  }, []);
  const feed = useCodeTaskFeed(foreground, Platform.OS === 'web');
  const notificationError = useNotificationTaskFocus(focusTaskId, getCodeTask, feed.open, onFocusConsumed);
  const selected = feed.selected;
  const [createOpen, setCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const draftEdited = useRef(false);
  const [model, setModel] = useState<CodeTaskModel>('gpt-6-sol');
  const [followUpParent, setFollowUpParent] = useState<CodeTask | null>(null);
  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [followOutput, setFollowOutput] = useState(true);
  const activityRef = useRef<ScrollView>(null);
  const actionBusy = useRef(false);

  useEffect(() => {
    void AsyncStorage.getItem(DRAFT_KEY).then((value) => { if (value && !draftEdited.current) setPrompt(value); }).catch(() => undefined).finally(() => setDraftReady(true));
  }, []);
  useEffect(() => {
    if (!draftReady) return;
    const timer = setTimeout(() => { void AsyncStorage.setItem(DRAFT_KEY, prompt).catch(() => undefined); }, 350);
    return () => clearTimeout(timer);
  }, [prompt, draftReady]);
  useEffect(() => { setShowLogs(false); setFollowOutput(true); setActionError(null); }, [selected?.id]);

  const textStyle = { color: colors.text };
  const mutedStyle = { color: colors.textMuted };
  const composerPrompt = followUpParent ? followUpPrompt : prompt;
  const openNew = () => { setFollowUpParent(null); setActionError(null); setCreateOpen(true); };
  const create = async () => {
    const cleanPrompt = composerPrompt.trim();
    if (!cleanPrompt || actionBusy.current) return;
    actionBusy.current = true; setSubmitting(true); setActionError(null);
    try {
      const task = followUpParent ? await followUpCodeTask(followUpParent.id, cleanPrompt) : await createCodeTask({ prompt: cleanPrompt, model });
      if (followUpParent) setFollowUpPrompt(''); else { draftEdited.current = true; setPrompt(''); await AsyncStorage.removeItem(DRAFT_KEY).catch(() => undefined); }
      setCreateOpen(false); setFollowUpParent(null); feed.updateTask(task); feed.open(task); void feed.refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not create task'); }
    finally { actionBusy.current = false; setSubmitting(false); }
  };
  const cancel = async () => {
    if (!selected || actionBusy.current) return;
    actionBusy.current = true; setCancelling(true); setActionError(null);
    try { feed.updateTask(await cancelCodeTask(selected.id)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not cancel task'); }
    finally { actionBusy.current = false; setCancelling(false); }
  };
  const reuse = () => {
    if (!selected) return;
    draftEdited.current = true; setPrompt(selected.prompt);
    if (AGENT_MODELS.some((option) => option.id === selected.model)) setModel(selected.model as CodeTaskModel);
    feed.close(); openNew();
  };
  const followUp = () => {
    if (!selected) return;
    setFollowUpParent(selected); setFollowUpPrompt(''); setActionError(null); feed.close(); setCreateOpen(true);
  };
  const badge = (task: CodeTask) => <View style={[styles.status, { backgroundColor: `${statusColor(task.status)}24` }]}><View style={[styles.statusDot, { backgroundColor: statusColor(task.status) }]} /><Text style={[styles.statusText, { color: statusColor(task.status) }]}>{taskStatusLabel(task.status)}</Text></View>;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerTitles}><Text style={[styles.title, narrow && styles.titleNarrow, textStyle]} numberOfLines={1}>Code Factory</Text><Text style={[styles.subtitle, mutedStyle]}>From request to result</Text></View>
        <View style={styles.headerActions}>
          <TouchableOpacity style={[styles.iconButton, { borderColor: colors.border }]} disabled={feed.refreshing} onPress={() => void feed.refresh()} accessibilityLabel="Refresh tasks">{feed.refreshing ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="refresh" size={20} color={colors.textMuted} />}</TouchableOpacity>
          <TouchableOpacity style={[styles.newButton, narrow && styles.newButtonNarrow, { backgroundColor: colors.accent }]} onPress={openNew} accessibilityLabel="New task"><Ionicons name="add" size={21} color="#fff" />{!narrow && <Text style={styles.newButtonText}>New task</Text>}</TouchableOpacity>
        </View>
      </View>
      <View style={styles.filters} accessibilityRole="tablist">
        {TASK_FILTERS.map((filter) => <TouchableOpacity key={filter.id} accessibilityRole="tab" accessibilityState={{ selected: feed.view === filter.id }} onPress={() => feed.setView(filter.id)} style={[styles.filter, { backgroundColor: feed.view === filter.id ? `${colors.accent}22` : colors.surface, borderColor: feed.view === filter.id ? colors.accent : colors.border }]}><Text style={{ color: feed.view === filter.id ? colors.accent : colors.textMuted, fontWeight: '700' }}>{filter.label}</Text></TouchableOpacity>)}
      </View>
      {notificationError && <View style={styles.notice}><Text accessibilityRole="alert" style={{ color: colors.error }}>{notificationError}</Text></View>}
      {feed.error ? <View style={styles.notice}><Text style={{ color: colors.error }}>{feed.error}</Text><TouchableOpacity onPress={() => void feed.refresh()}><Text style={{ color: colors.accent }}>Retry connection</Text></TouchableOpacity></View> : null}
      {feed.loading ? <View style={styles.center}><ActivityIndicator color={colors.accent} size="large" /></View> : <FlatList
        style={styles.fill} contentContainerStyle={styles.list} data={feed.tasks} keyExtractor={(task) => task.id}
        refreshing={feed.refreshing} onRefresh={() => void feed.refresh()} onEndReachedThreshold={0.6} onEndReached={() => { if (!feed.error) void feed.loadMore(); }}
        ListEmptyComponent={feed.error ? null : <View style={styles.empty}><Ionicons name="code-slash-outline" size={36} color={colors.accent} /><Text style={[styles.modalTitle, textStyle]}>{feed.view === 'active' ? 'Nothing running' : feed.view === 'history' ? 'A fresh start' : 'What should we build?'}</Text><Text style={[styles.modalHint, mutedStyle]}>{feed.view === 'active' ? 'New tasks and queued follow-ups appear here.' : feed.view === 'history' ? 'Completed, cancelled, and failed tasks will appear here.' : 'Describe a change, then follow the work as it happens.'}</Text></View>}
        ListFooterComponent={<View style={styles.listFooter}>{feed.loadingMore ? <ActivityIndicator color={colors.accent} /> : feed.hasMore ? <TouchableOpacity style={[styles.modalButton, { borderColor: colors.border }]} onPress={() => void feed.loadMore()}><Text style={{ color: colors.accent }}>Load older tasks</Text></TouchableOpacity> : feed.tasks.length ? <Text style={mutedStyle}>You’re all caught up</Text> : null}</View>}
        renderItem={({ item: task }) => <TouchableOpacity style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => feed.open(task)} activeOpacity={0.82} accessibilityLabel={`${taskStatusLabel(task.status)}: ${task.prompt}`}>
          <View style={styles.cardTop}>{badge(task)}<Text style={[styles.date, mutedStyle]}>{modelLabel(task.model)}{task.parent_task_id ? ' · Follow-up' : ''}</Text></View>
          <Text style={[styles.prompt, textStyle]} numberOfLines={3}>{task.prompt}</Text>
          <View style={styles.cardTop}><Text style={[styles.date, mutedStyle]}>{new Date(task.created_at).toLocaleString()}</Text>{task.output_seq ? <Text style={[styles.date, mutedStyle]}>{task.output_seq} updates</Text> : null}</View>
        </TouchableOpacity>}
      />}

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => !submitting && setCreateOpen(false)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !submitting && setCreateOpen(false)} />
          <View style={[styles.modal, styles.sheetModal, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: sheetMaxHeight }]}>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.createContent} keyboardShouldPersistTaps="handled">
              <Text style={[styles.modalTitle, textStyle]}>{followUpParent ? 'Queue a follow-up' : 'New coding task'}</Text>
              <Text style={[styles.modalHint, mutedStyle]}>{followUpParent ? 'Creates a separate task with the original request and its latest saved outcome. It does not interrupt the running task.' : 'Describe the change and how you’ll know it works. Your draft is saved on this device.'}</Text>
              {followUpParent && <Text numberOfLines={2} style={[styles.modalHint, mutedStyle]}>Following: {followUpParent.prompt}</Text>}
              <TextInput style={[styles.promptInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]} multiline autoFocus placeholder={followUpParent ? 'What should happen next?' : 'Describe the change you want…'} placeholderTextColor={colors.textMuted} value={composerPrompt} onChangeText={(value) => { if (followUpParent) setFollowUpPrompt(value); else { draftEdited.current = true; setPrompt(value); } }} editable={!submitting} textAlignVertical="top" accessibilityLabel={followUpParent ? 'Follow-up instructions' : 'Task instructions'} />
              {!followUpParent && <AgentModelPicker value={model} onChange={setModel} disabled={submitting} />}
              {actionError && <Text accessibilityRole="alert" style={{ color: colors.error }}>{actionError}</Text>}
            </ScrollView>
            <View style={styles.modalActions}><TouchableOpacity style={[styles.modalButton, { borderColor: colors.border }]} disabled={submitting} onPress={() => setCreateOpen(false)}><Text style={mutedStyle}>Close</Text></TouchableOpacity><TouchableOpacity style={[styles.modalButton, { backgroundColor: colors.accent, opacity: composerPrompt.trim() && !submitting ? 1 : 0.5 }]} disabled={!composerPrompt.trim() || submitting} onPress={() => void create()}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{followUpParent ? 'Queue follow-up' : 'Create task'}</Text>}</TouchableOpacity></View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={selected != null} transparent animationType="fade" onRequestClose={feed.close}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={feed.close} />
          <View style={[styles.modal, styles.sheetModal, styles.detailSheet, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: sheetMaxHeight, height: sheetMaxHeight }]}>
            {selected && <>
              <View style={styles.cardTop}><View style={styles.detailBadges}>{badge(selected)}{modelLabel(selected.model) && <View style={[styles.modelTag, { borderColor: colors.border }]}><Text style={[styles.modelTagText, mutedStyle]}>{modelLabel(selected.model)}</Text></View>}</View><TouchableOpacity onPress={feed.close} style={styles.closeButton} accessibilityLabel="Close task details"><Ionicons name="close" size={24} color={colors.textMuted} /></TouchableOpacity></View>
              <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detailContent}>
                <Text selectable style={[styles.detailPrompt, textStyle]}>{selected.prompt}</Text>
                <Text style={[styles.date, mutedStyle]}>{new Date(selected.created_at).toLocaleString()} · {taskTiming(selected)}</Text>
                {selected.parent_task_id && <Text style={[styles.modalHint, mutedStyle]}>Follow-up task · {selected.parent_task_id.slice(0, 8)}</Text>}
                {selected.error && <Text selectable style={{ color: colors.error }}>{selected.error}</Text>}
                {taskResult(selected) && <><Text style={[styles.sectionTitle, textStyle]}>Result</Text><View style={[styles.output, { backgroundColor: colors.background }]}><Text selectable style={[styles.resultText, textStyle]}>{taskResult(selected)}</Text></View></>}
                <View style={styles.cardTop}><Text style={[styles.sectionTitle, textStyle]}>Activity</Text><Text accessibilityLiveRegion="polite" style={[styles.date, { color: feed.connection === 'reconnecting' ? colors.error : colors.textMuted }]}>{({ connecting: 'Connecting…', live: 'Live updates', reconnecting: 'Reconnecting…', complete: 'Up to date' })[feed.connection]}</Text></View>
                {feed.truncated || feed.output.length >= 500 ? <Text style={[styles.date, mutedStyle]}>Showing recent activity. Full available logs are below.</Text> : null}
                <ScrollView ref={activityRef} nestedScrollEnabled style={[styles.activity, { backgroundColor: colors.background }]} contentContainerStyle={styles.activityContent}
                  onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; setFollowOutput(contentSize.height - contentOffset.y - layoutMeasurement.height < 60); }} scrollEventThrottle={100}
                  onContentSizeChange={() => { if (followOutput) activityRef.current?.scrollToEnd({ animated: false }); }}>
                  {feed.output.length ? feed.output.map((item) => <View key={item.seq} style={[styles.activityItem, { borderLeftColor: item.kind === 'error' ? colors.error : item.kind === 'assistant' ? colors.accent : colors.border }]}><Text style={[styles.date, mutedStyle]}>{item.kind === 'assistant' ? 'Agent' : item.kind} · {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text><Text selectable style={[item.kind === 'assistant' ? styles.resultText : styles.outputText, { color: item.kind === 'error' ? colors.error : colors.text }]}>{item.text}</Text></View>) : <Text style={[styles.modalHint, mutedStyle]}>{ACTIVE.has(selected.status) ? 'Waiting for the first update. You can close this view; the task will keep working.' : 'No recorded activity for this task.'}</Text>}
                </ScrollView>
                {!followOutput && <TouchableOpacity style={styles.jumpButton} onPress={() => { setFollowOutput(true); activityRef.current?.scrollToEnd({ animated: true }); }}><Text style={{ color: colors.accent }}>↓ Jump to latest</Text></TouchableOpacity>}
                {(selected.stdout || selected.stderr) && <><TouchableOpacity style={styles.logsToggle} onPress={() => setShowLogs(!showLogs)} accessibilityState={{ expanded: showLogs }}><Ionicons name={showLogs ? 'chevron-down' : 'chevron-forward'} size={18} color={colors.textMuted} /><Text style={mutedStyle}>Raw logs</Text></TouchableOpacity>{showLogs && <View style={[styles.output, { backgroundColor: colors.background }]}><Text selectable style={[styles.outputText, textStyle]}>{[selected.stdout, selected.stderr].filter(Boolean).join('\n\n')}</Text></View>}</>}
                {selected.changed_paths?.length ? <View><Text style={[styles.sectionTitle, textStyle]}>Changed files · {selected.changed_paths.length}</Text>{selected.changed_paths.map((path) => <Text key={path} selectable style={[styles.paths, mutedStyle]}>{path}</Text>)}</View> : null}
                {actionError && <Text accessibilityRole="alert" style={{ color: colors.error }}>{actionError}</Text>}
              </ScrollView>
              <View style={styles.detailFooter}>
                <View style={styles.modalActions}><TouchableOpacity style={[styles.modalButton, { borderColor: colors.border }]} disabled={cancelling} onPress={reuse}><Text style={mutedStyle}>Reuse prompt</Text></TouchableOpacity><TouchableOpacity style={[styles.modalButton, { backgroundColor: colors.accent }]} disabled={cancelling} onPress={followUp}><Text style={styles.primaryText}>Follow up</Text></TouchableOpacity></View>
                {ACTIVE.has(selected.status) && selected.status !== 'cancel_requested' && <TouchableOpacity style={[styles.cancelButton, { borderColor: colors.error }]} disabled={cancelling} onPress={() => void cancel()}><Text style={{ color: colors.error }}>{cancelling ? 'Requesting cancellation…' : 'Cancel task'}</Text></TouchableOpacity>}
              </View>
            </>}
          </View>
        </View>
      </Modal>
    </View>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  fill: { flex: 1, minWidth: 0 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitles: { flexShrink: 1, minWidth: 0 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  titleNarrow: { fontSize: 20 },
  subtitle: { fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  iconButton: { width: 44, height: 44, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  newButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 5 },
  newButtonNarrow: { width: 44, paddingHorizontal: 0, justifyContent: 'center' },
  newButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  error: { textAlign: 'center' },
  list: { padding: 14, paddingBottom: 28, gap: 12 },
  card: { borderWidth: 1, borderRadius: 17, padding: 16, gap: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, flexShrink: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  prompt: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  date: { fontSize: 11 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: CODING_TASK_MODAL_BACKDROP_PADDING,
  },
  modal: { width: '100%', maxWidth: 640, borderRadius: 22, borderWidth: 1, padding: 16, gap: 14 },
  /** Pixel-bounded sheet: shrink to content, never exceed window after safe-area + padding. */
  sheetModal: { flexShrink: 1, minHeight: 0, overflow: 'hidden' },
  /** Detail sheet uses a definite height so the body ScrollView can scroll. */
  detailSheet: { flexDirection: 'column' },
  sheetScroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  detailScroll: { flex: 1, minHeight: 0 },
  createContent: { gap: 14, paddingBottom: 4 },
  modalTitle: { fontSize: 21, fontWeight: '800' },
  modalHint: { fontSize: 13, lineHeight: 19 },
  promptInput: { minHeight: 150, maxHeight: 300, borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 21 },
  detailBadges: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
  modelTag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  modelTagText: { fontSize: 11, fontWeight: '700' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, flexShrink: 0 },
  modalButton: { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  primaryText: { color: '#fff', fontWeight: '700' },
  detailContent: { gap: 12, paddingBottom: 4 },
  detailPrompt: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  output: { borderRadius: 13, padding: 13 },
  outputText: { fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo' },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 },
  filter: { flex: 1, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  notice: { padding: 14, gap: 8 },
  empty: { alignItems: 'center', paddingVertical: 44, gap: 12 },
  listFooter: { paddingVertical: 16, alignItems: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  resultText: { fontSize: 14, lineHeight: 21 },
  activity: { maxHeight: 320, borderRadius: 13 },
  activityContent: { padding: 13, gap: 16 },
  activityItem: { borderLeftWidth: 2, paddingLeft: 10, gap: 5 },
  jumpButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  logsToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  closeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  detailFooter: { gap: 8 },
  cancelButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  paths: { fontSize: 11, lineHeight: 16 },
});
