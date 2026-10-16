import { useNotificationTaskFocus } from '../../hooks/useNotificationTaskFocus';
import {
  cancelResearchTask, createResearchTask, getResearchTask, getResearchReport,
  type CodeTaskModel, type ResearchTask, type ResearchVerbosity,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Modal, Platform,
  ScrollView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity,
  useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';
import { useResearchTasks } from '../../hooks/useResearchTasks';
import { ACTIVE_TASK_STATUSES as ACTIVE, TASK_FILTERS, taskStatusLabel, taskTiming } from '../../lib/codeTaskState';
import { CODING_TASK_MODAL_BACKDROP_PADDING, codingTaskSheetMaxHeight } from '../../lib/codingTaskModalLayout';
import { AgentModelPicker, agentModelLabel } from './AgentModelPicker';
import { ResearchReportView } from './ResearchReportView';

const DETAIL_LEVELS: { id: ResearchVerbosity; label: string; hint: string }[] = [
  { id: 'concise', label: 'Concise', hint: 'Essential detail, full scope' },
  { id: 'standard', label: 'Standard', hint: 'Balanced explanation and context' },
  { id: 'in_depth', label: 'In-depth', hint: 'Thorough explanation and evidence' },
];
const detailLabel = (value: ResearchVerbosity) => DETAIL_LEVELS.find((item) => item.id === value)?.label ?? value;
const statusColor = (status: ResearchTask['status']) => status === 'success' ? '#39b978' : status === 'failed' ? '#e45d6b' : status === 'cancelled' || status === 'cancel_requested' ? '#85818b' : '#ad62dc';

export function ResearchTab({ focusTaskId, onFocusConsumed }: { focusTaskId?: string | null; onFocusConsumed?: () => void } = {}) {
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
  const feed = useResearchTasks(foreground);
  const notificationError = useNotificationTaskFocus(focusTaskId, getResearchTask, feed.open, onFocusConsumed);
  const selected = feed.selected;
  const [createOpen, setCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<CodeTaskModel>('gpt-6-sol');
  const [verbosity, setVerbosity] = useState<ResearchVerbosity>('standard');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reportTask, setReportTask] = useState<ResearchTask | null>(null);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const reportRequest = useRef(0);
  const actionBusy = useRef(false);
  const mounted = useRef(true);
  const activityRef = useRef<ScrollView>(null);
  const [followOutput, setFollowOutput] = useState(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reportRequest.current += 1; };
  }, []);
  useEffect(() => { setActionError(null); setFollowOutput(true); }, [selected?.id]);

  const textStyle = { color: colors.text };
  const mutedStyle = { color: colors.textMuted };
  const activeCount = useMemo(() => feed.tasks.filter((task) => ACTIVE.has(task.status)).length, [feed.tasks]);
  const closeReport = () => {
    reportRequest.current += 1;
    setReportTask(null); setReportHtml(null); setReportError(null); setReportLoading(false);
  };
  const openReport = async (task: ResearchTask) => {
    const request = ++reportRequest.current;
    feed.close();
    setReportTask(task); setReportHtml(null); setReportError(null); setReportLoading(true);
    try {
      const report = await getResearchReport(task.id);
      if (request !== reportRequest.current || !mounted.current) return;
      if (report.task_id !== task.id || !report.html.trim()) throw new Error('This report is not available yet. Please try again.');
      setReportHtml(report.html);
    } catch (cause) {
      if (request === reportRequest.current && mounted.current) setReportError(cause instanceof Error ? cause.message : 'Could not load this report');
    } finally {
      if (request === reportRequest.current && mounted.current) setReportLoading(false);
    }
  };
  const create = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 32000 || actionBusy.current) return;
    actionBusy.current = true; setSubmitting(true); setActionError(null);
    try {
      const task = await createResearchTask({ prompt: cleanPrompt, model, verbosity });
      if (!mounted.current) return;
      setPrompt(''); setCreateOpen(false); feed.updateTask(task); feed.open(task); void feed.refresh();
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Could not create research task');
    } finally {
      actionBusy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };
  const cancel = async () => {
    if (!selected || actionBusy.current) return;
    const id = selected.id;
    actionBusy.current = true; setCancelling(true); setActionError(null);
    try {
      const task = await cancelResearchTask(id);
      if (mounted.current) feed.updateTask(task);
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Could not cancel research task');
    } finally {
      actionBusy.current = false;
      if (mounted.current) setCancelling(false);
    }
  };
  const badge = (task: ResearchTask) => <View style={[styles.status, { backgroundColor: `${statusColor(task.status)}24` }]}><View style={[styles.statusDot, { backgroundColor: statusColor(task.status) }]} /><Text style={[styles.statusText, { color: statusColor(task.status) }]}>{taskStatusLabel(task.status)}</Text></View>;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerTitles}>
          <Text style={[styles.title, narrow && styles.titleNarrow, textStyle]}>Research</Text>
          <Text style={[styles.subtitle, mutedStyle]}>Research tasks and reports</Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity accessibilityRole="button" style={[styles.iconButton, { borderColor: colors.border }]} disabled={feed.refreshing} onPress={() => void feed.refresh()} accessibilityLabel="Refresh tasks">{feed.refreshing ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="refresh" size={20} color={colors.textMuted} />}</TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" style={[styles.newButton, narrow && styles.newButtonNarrow, { backgroundColor: colors.accent }]} onPress={() => { setActionError(null); setCreateOpen(true); }} accessibilityLabel="New task"><Ionicons name="add" size={21} color="#fff" />{!narrow && <Text style={styles.primaryText}>New task</Text>}</TouchableOpacity>
        </View>
      </View>
      <View style={styles.filters} accessibilityRole="tablist">
        {TASK_FILTERS.map((filter) => <TouchableOpacity key={filter.id} accessibilityRole="tab" aria-selected={feed.view === filter.id} accessibilityState={{ selected: feed.view === filter.id }} onPress={() => feed.setView(filter.id)} style={[styles.filter, { backgroundColor: feed.view === filter.id ? `${colors.accent}22` : colors.surface, borderColor: feed.view === filter.id ? colors.accent : colors.border }]}><Text style={{ color: feed.view === filter.id ? colors.accent : colors.textMuted, fontWeight: '700' }}>{filter.label}</Text></TouchableOpacity>)}
      </View>
      {activeCount > 0 && <Text style={[styles.feedHint, mutedStyle]} accessibilityLiveRegion="polite">{activeCount} {activeCount === 1 ? 'task' : 'tasks'} in progress · Reports appear when ready</Text>}
      {notificationError && <View style={styles.notice}><Text accessibilityRole="alert" style={{ color: colors.error }}>{notificationError}</Text></View>}
      {feed.error && <View style={styles.notice}><Text accessibilityRole="alert" style={{ color: colors.error }}>{feed.error}</Text><TouchableOpacity accessibilityRole="button" onPress={() => void feed.refresh()}><Text style={{ color: colors.accent }}>Retry connection</Text></TouchableOpacity></View>}
      {feed.loading ? <View style={styles.center}><ActivityIndicator color={colors.accent} size="large" /></View> : <FlatList
        style={styles.fill} contentContainerStyle={styles.list} data={feed.tasks} keyExtractor={(task) => task.id}
        refreshing={feed.refreshing} onRefresh={() => void feed.refresh()} onEndReachedThreshold={0.6} onEndReached={() => { if (!feed.error) void feed.loadMore(); }}
        ListEmptyComponent={feed.error ? null : <View style={styles.empty}>
          <View style={[styles.emptyIcon, { backgroundColor: `${colors.accent}18` }]}><Ionicons name="search-outline" size={32} color={colors.accent} /></View>
          <Text style={[styles.modalTitle, textStyle]}>{feed.view === 'active' ? 'No active research tasks' : feed.view === 'history' ? 'No completed research tasks' : 'No research tasks'}</Text>
          <Text style={[styles.emptyHint, mutedStyle]}>{feed.view === 'history' ? 'Finished tasks and their reports will appear here.' : 'Create a task to research a question and generate a report with sources.'}</Text>
        </View>}
        ListFooterComponent={<View style={styles.listFooter}>{feed.loadingMore ? <ActivityIndicator color={colors.accent} /> : feed.hasMore ? <TouchableOpacity accessibilityRole="button" style={[styles.loadMore, { borderColor: colors.border }]} onPress={() => void feed.loadMore()}><Text style={{ color: colors.accent }}>Load older tasks</Text></TouchableOpacity> : null}</View>}
        renderItem={({ item: task }) => <TouchableOpacity accessibilityRole="button" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => feed.open(task)} activeOpacity={0.82} accessibilityLabel={`${taskStatusLabel(task.status)}: ${task.prompt}`}>
          <View style={styles.cardTop}>{badge(task)}<Text style={[styles.date, mutedStyle]}>{agentModelLabel(task.model)} · {detailLabel(task.verbosity)}</Text></View>
          <Text style={[styles.prompt, textStyle]} numberOfLines={3}>{task.prompt}</Text>
          <View style={styles.cardTop}>
            <Text style={[styles.date, styles.dateShrink, mutedStyle]}>{new Date(task.created_at).toLocaleString()}</Text>
            {task.status === 'success' && task.report_available && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open report" onPress={(event) => { event.stopPropagation(); void openReport(task); }} style={[styles.openReport, { backgroundColor: `${colors.accent}18` }]}><Ionicons name="open-outline" size={20} color={colors.accent} /><Text style={[styles.openReportText, { color: colors.accent }]}>Report</Text></TouchableOpacity>}
          </View>
        </TouchableOpacity>}
      />}

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => !submitting && setCreateOpen(false)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'android' ? 'height' : 'padding'}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => !submitting && setCreateOpen(false)} />
          <View style={[styles.modal, styles.sheetModal, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: sheetMaxHeight }]}>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.createContent} keyboardShouldPersistTaps="handled">
              <Text style={[styles.modalTitle, textStyle]}>New research task</Text>
              <Text style={[styles.modalHint, mutedStyle]}>Describe what you want to understand. Include any questions, constraints, or sources that matter.</Text>
              <TextInput style={[styles.promptInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]} multiline autoFocus placeholder="What would you like to research?" placeholderTextColor={colors.textMuted} value={prompt} onChangeText={setPrompt} maxLength={32000} editable={!submitting} textAlignVertical="top" accessibilityLabel="Research prompt" />
              <AgentModelPicker value={model} onChange={setModel} disabled={submitting} />
              <Text style={[styles.sectionTitle, textStyle]}>Level of detail</Text>
              <View style={styles.depthRow} accessibilityRole="radiogroup" accessibilityLabel="Level of detail">
                {DETAIL_LEVELS.map((option) => <TouchableOpacity key={option.id} accessibilityRole="radio" aria-checked={verbosity === option.id} accessibilityLabel={option.label} accessibilityState={{ checked: verbosity === option.id, selected: verbosity === option.id, disabled: submitting }} disabled={submitting} onPress={() => setVerbosity(option.id)} style={[styles.depthChip, { borderColor: verbosity === option.id ? colors.accent : colors.border, backgroundColor: verbosity === option.id ? `${colors.accent}18` : colors.background }]}>
                  <Text style={[styles.depthLabel, { color: verbosity === option.id ? colors.accent : colors.text }]}>{option.label}</Text>
                  <Text style={[styles.depthHint, mutedStyle]}>{option.hint}</Text>
                </TouchableOpacity>)}
              </View>
              {actionError && <Text accessibilityRole="alert" style={{ color: colors.error }}>{actionError}</Text>}
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity accessibilityRole="button" style={[styles.modalButton, { borderColor: colors.border }]} disabled={submitting} onPress={() => setCreateOpen(false)}><Text style={mutedStyle}>Close</Text></TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" style={[styles.modalButton, { backgroundColor: colors.accent, opacity: prompt.trim() && !submitting ? 1 : 0.5 }]} disabled={!prompt.trim() || submitting} onPress={() => void create()}>{submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Create task</Text>}</TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={selected != null} transparent animationType="fade" onRequestClose={feed.close}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={feed.close} />
          <View style={[styles.modal, styles.sheetModal, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: sheetMaxHeight }]}>
            {selected && <>
              <View style={styles.cardTop}>{badge(selected)}<TouchableOpacity accessibilityRole="button" onPress={feed.close} style={styles.closeButton} accessibilityLabel="Close task details"><Ionicons name="close" size={24} color={colors.textMuted} /></TouchableOpacity></View>
              <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.detailContent}>
                <Text selectable style={[styles.detailPrompt, textStyle]}>{selected.prompt}</Text>
                <Text style={[styles.modalHint, mutedStyle]}>{agentModelLabel(selected.model)} · {detailLabel(selected.verbosity)}</Text>
                <Text style={[styles.date, mutedStyle]}>{new Date(selected.created_at).toLocaleString()} · {taskTiming(selected)}</Text>
                {ACTIVE.has(selected.status) && <View style={[styles.progressCard, { backgroundColor: colors.background }]}><ActivityIndicator color={colors.accent} /><Text style={[styles.progressText, mutedStyle]}>{selected.status === 'cancel_requested' ? 'Stopping this research task…' : 'Research is in progress. You can close this view and come back when the report is ready.'}</Text></View>}
                {selected.status === 'success' && selected.report_available && <View style={[styles.progressCard, { backgroundColor: `${colors.accent}12` }]}><Ionicons name="document-text-outline" size={28} color={colors.accent} /><Text style={[styles.progressText, textStyle]}>Your report is ready to read.</Text></View>}
                {selected.error && <Text selectable accessibilityRole="alert" style={{ color: colors.error }}>{selected.error}</Text>}
                <View style={styles.cardTop}><Text style={[styles.sectionTitle, textStyle]}>Activity</Text><Text accessibilityLiveRegion="polite" style={[styles.date, { color: feed.connection === 'reconnecting' ? colors.error : colors.textMuted }]}>{({ connecting: 'Connecting…', live: 'Live updates', reconnecting: 'Reconnecting…', complete: 'Up to date' })[feed.connection]}</Text></View>
                {(feed.truncated || feed.output.length >= 500) && <Text style={[styles.date, mutedStyle]}>Showing recent activity.</Text>}
                <ScrollView ref={activityRef} nestedScrollEnabled style={[styles.activity, { backgroundColor: colors.background }]} contentContainerStyle={styles.activityContent}
                  onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; setFollowOutput(contentSize.height - contentOffset.y - layoutMeasurement.height < 60); }} scrollEventThrottle={100}
                  onContentSizeChange={() => { if (followOutput) activityRef.current?.scrollToEnd({ animated: false }); }}>
                  {feed.output.length ? feed.output.map((item) => <View key={item.seq} style={[styles.activityItem, { borderLeftColor: item.kind === 'error' ? colors.error : item.kind === 'assistant' ? colors.accent : colors.border }]}><Text style={[styles.date, mutedStyle]}>{item.kind === 'assistant' ? 'Agent' : item.kind} · {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text><Text selectable style={[styles.activityText, { color: item.kind === 'error' ? colors.error : colors.text }]}>{item.text}</Text></View>) : <Text style={[styles.modalHint, mutedStyle]}>{ACTIVE.has(selected.status) ? 'Waiting for the first update…' : 'No recorded activity for this task.'}</Text>}
                </ScrollView>
                {!followOutput && <TouchableOpacity style={styles.jumpButton} onPress={() => { setFollowOutput(true); activityRef.current?.scrollToEnd({ animated: true }); }}><Text style={{ color: colors.accent }}>↓ Jump to latest</Text></TouchableOpacity>}
                {feed.detailError && <Text accessibilityRole="alert" style={{ color: colors.error }}>{feed.detailError}</Text>}
                {actionError && <Text accessibilityRole="alert" style={{ color: colors.error }}>{actionError}</Text>}
              </ScrollView>
              <View style={styles.modalActions}>
                {ACTIVE.has(selected.status) && selected.status !== 'cancel_requested' && <TouchableOpacity accessibilityRole="button" style={[styles.modalButton, { borderColor: colors.error }]} disabled={cancelling} onPress={() => void cancel()}>{cancelling ? <ActivityIndicator color={colors.error} /> : <Text style={{ color: colors.error }}>Cancel task</Text>}</TouchableOpacity>}
                {selected.status === 'success' && selected.report_available ? <TouchableOpacity accessibilityRole="button" style={[styles.modalButton, { backgroundColor: colors.accent }]} onPress={() => void openReport(selected)} accessibilityLabel="Open report"><Text style={styles.primaryText}>Open report</Text></TouchableOpacity> : <TouchableOpacity accessibilityRole="button" style={[styles.modalButton, { borderColor: colors.border }]} onPress={feed.close}><Text style={mutedStyle}>Close</Text></TouchableOpacity>}
              </View>
            </>}
          </View>
        </View>
      </Modal>

      <Modal visible={reportTask != null} transparent animationType="fade" onRequestClose={closeReport}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeReport} />
          <View style={[styles.reportModal, { height: sheetMaxHeight, backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.reportHeader, { borderBottomColor: colors.border }]}>
              <View style={styles.headerTitles}><Text style={[styles.reportTitle, textStyle]}>Research report</Text><Text numberOfLines={1} style={[styles.subtitle, mutedStyle]}>{reportTask?.prompt}</Text></View>
              <TouchableOpacity accessibilityRole="button" onPress={closeReport} style={styles.closeButton} accessibilityLabel="Close report"><Ionicons name="close" size={24} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {reportLoading ? <View style={styles.center}><ActivityIndicator color={colors.accent} size="large" /><Text style={mutedStyle}>Opening your report…</Text></View> : reportError ? <View style={styles.center}><Text accessibilityRole="alert" style={[styles.reportError, { color: colors.error }]}>{reportError}</Text><TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry report" style={[styles.loadMore, { borderColor: colors.accent }]} onPress={() => reportTask && void openReport(reportTask)}><Text style={{ color: colors.accent }}>Try again</Text></TouchableOpacity></View> : reportHtml != null && <ResearchReportView html={reportHtml} />}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  fill: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1 },
  headerTitles: { flexShrink: 1, minWidth: 0 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  titleNarrow: { fontSize: 20 },
  subtitle: { fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  iconButton: { width: 44, height: 44, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  newButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 5 },
  newButtonNarrow: { width: 44, paddingHorizontal: 0, justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 },
  filter: { flex: 1, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  feedHint: { fontSize: 12, paddingHorizontal: 16, paddingTop: 10 },
  notice: { padding: 14, gap: 8 },
  list: { padding: 14, paddingBottom: 28, gap: 12 },
  listFooter: { paddingVertical: 12, alignItems: 'center' },
  loadMore: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 18, justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: 44, paddingHorizontal: 12, gap: 16 },
  emptyIcon: { width: 68, height: 68, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  emptyHint: { fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 400 },
  card: { borderWidth: 1, borderRadius: 17, padding: 16, gap: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, flexShrink: 1 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  prompt: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  date: { fontSize: 11 },
  dateShrink: { flexShrink: 1 },
  openReport: { flexDirection: 'row', gap: 7, alignItems: 'center', minHeight: 44, paddingHorizontal: 12, borderRadius: 12 },
  openReportText: { fontSize: 13, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', alignItems: 'center', justifyContent: 'center', padding: CODING_TASK_MODAL_BACKDROP_PADDING },
  modal: { width: '100%', maxWidth: 640, borderRadius: 22, borderWidth: 1, padding: 16, gap: 14 },
  sheetModal: { flexShrink: 1, minHeight: 0, overflow: 'hidden' },
  sheetScroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  createContent: { gap: 16, paddingBottom: 4 },
  modalTitle: { fontSize: 21, fontWeight: '800', textAlign: 'center' },
  modalHint: { fontSize: 13, lineHeight: 19 },
  promptInput: { minHeight: 150, maxHeight: 300, borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 15, lineHeight: 21 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  depthRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  depthChip: { flex: 1, minWidth: 80, padding: 10, borderWidth: 1, borderRadius: 13, gap: 6 },
  depthLabel: { fontSize: 13, fontWeight: '700' },
  depthHint: { fontSize: 11, lineHeight: 16 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, flexShrink: 0 },
  modalButton: { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  detailContent: { gap: 14, paddingBottom: 4 },
  detailPrompt: { fontSize: 17, lineHeight: 25, fontWeight: '600' },
  progressCard: { borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 },
  progressText: { flex: 1, fontSize: 14, lineHeight: 21 },
  activity: { maxHeight: 320, borderRadius: 13 },
  activityContent: { padding: 13, gap: 16 },
  activityItem: { borderLeftWidth: 2, paddingLeft: 10, gap: 5 },
  activityText: { fontSize: 13, lineHeight: 20 },
  jumpButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  reportModal: { width: '100%', maxWidth: 1120, minHeight: 0, borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  reportHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 18, paddingVertical: 10, borderBottomWidth: 1, flexShrink: 0 },
  reportTitle: { fontSize: 17, fontWeight: '800' },
  reportError: { textAlign: 'center', maxWidth: 500, lineHeight: 21 },
});
