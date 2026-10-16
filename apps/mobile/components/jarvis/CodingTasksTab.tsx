import {
  cancelCodeTask,
  createCodeTask,
  getCodeTask,
  getCodeTasks,
  type CodeTask,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CODING_TASK_MODAL_BACKDROP_PADDING,
  codingTaskSheetMaxHeight,
} from '../../lib/codingTaskModalLayout';
import { useTheme } from '../../contexts/ThemeContext';

const ACTIVE = new Set(['pending', 'queued', 'running', 'cancel_requested']);

const AGENT_MODELS = [
  { id: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol' },
  { id: 'claude-opus-5-thinking-high', label: 'Opus 5' },
  { id: 'claude-fable-5-thinking-high', label: 'Fable 5' },
] as const;

function modelLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  return AGENT_MODELS.find((model) => model.id === modelId)?.label ?? modelId;
}

/** Galaxy Z Fold cover screens are ~340dp wide, so labels collapse to icons below this. */
const NARROW_WIDTH = 420;

function outputFor(task: CodeTask): string {
  if (task.agent_output != null) {
    if (typeof task.agent_output === 'string') return task.agent_output;
    if (typeof task.agent_output === 'object') {
      const result = (task.agent_output as { result?: unknown }).result;
      if (typeof result === 'string') return result;
    }
    return JSON.stringify(task.agent_output, null, 2);
  }
  return task.error || task.stdout || task.stderr || 'No output yet.';
}

function statusColor(status: CodeTask['status']): string {
  if (status === 'success') return '#39b978';
  if (status === 'failed') return '#e45d6b';
  if (status === 'cancelled' || status === 'cancel_requested') return '#85818b';
  return '#ad62dc';
}

export function CodingTasksTab() {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const narrow = width < NARROW_WIDTH;
  const topInset = Math.max(insets.top, Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0);
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'android' ? 24 : 0);
  const sheetMaxHeight = codingTaskSheetMaxHeight(height, {
    padding: CODING_TASK_MODAL_BACKDROP_PADDING,
    topInset,
    bottomInset,
  });
  const [tasks, setTasks] = useState<CodeTask[]>([]);
  const [selected, setSelected] = useState<CodeTask | null>(null);
  const selectedRef = useRef<CodeTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(async () => {
    try {
      const rows = await getCodeTasks();
      setTasks(rows);
      const current = selectedRef.current;
      if (current) {
        const next = rows.find((task) => task.id === current.id);
        if (next) setSelected(next);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load coding tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks]
  );

  const create = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setSubmitting(true);
    try {
      const task = await createCodeTask({ prompt: cleanPrompt, model });
      setPrompt('');
      setModel(null);
      setCreateOpen(false);
      setSelected(task);
      await load();
    } catch (err) {
      Alert.alert('Could not create task', err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  const open = async (task: CodeTask) => {
    setSelected(task);
    try {
      setSelected(await getCodeTask(task.id));
    } catch {
      // Keep the list snapshot visible if the detail refresh is briefly unavailable.
    }
  };

  const cancel = async () => {
    if (!selected) return;
    try {
      setSelected(await cancelCodeTask(selected.id));
      await load();
    } catch (err) {
      Alert.alert('Could not cancel task', err instanceof Error ? err.message : 'Request failed');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerTitles}>
          <Text style={[styles.title, narrow && styles.titleNarrow, { color: colors.text }]} numberOfLines={1}>
            Code Factory
          </Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]} numberOfLines={1}>
            Manual agentic coding tasks
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.iconButton, { borderColor: colors.border }]}
            onPress={() => void load()}
            accessibilityLabel="Refresh tasks"
          >
            <Ionicons name="refresh" size={20} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.newButton,
              narrow && styles.newButtonNarrow,
              { backgroundColor: colors.accent },
            ]}
            onPress={() => { setModel(null); setCreateOpen(true); }}
            accessibilityLabel="New task"
          >
            <Ionicons name="add" size={21} color="#fff" />
            {narrow ? null : <Text style={styles.newButtonText}>New task</Text>}
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} size="large" /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
          <TouchableOpacity onPress={() => void load()}><Text style={{ color: colors.accent }}>Try again</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={styles.fill} contentContainerStyle={styles.list}>
          {sorted.length === 0 ? <Text style={{ color: colors.textMuted }}>No coding tasks yet.</Text> : null}
          {sorted.map((task) => (
            <TouchableOpacity
              key={task.id}
              style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={() => void open(task)}
              activeOpacity={0.82}
            >
              <View style={styles.cardTop}>
                <View style={[styles.status, { backgroundColor: `${statusColor(task.status)}24` }]}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor(task.status) }]} />
                  <Text style={[styles.statusText, { color: statusColor(task.status) }]}>{task.status.replace('_', ' ')}</Text>
                </View>
              </View>
              <Text style={[styles.prompt, { color: colors.text }]} numberOfLines={3}>{task.prompt}</Text>
              <Text style={[styles.date, { color: colors.textMuted }]}>{new Date(task.created_at).toLocaleString()}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => !submitting && setCreateOpen(false)}>
        <KeyboardAvoidingView
          style={styles.backdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => !submitting && setCreateOpen(false)}
          />
          <View
            style={[
              styles.modal,
              styles.sheetModal,
              { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: sheetMaxHeight },
            ]}
          >
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.createContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.modalTitle, { color: colors.text }]}>New coding task</Text>
              <Text style={[styles.modalHint, { color: colors.textMuted }]}>Be specific. Code Factory will plan, test, deploy, and report its result.</Text>
              <TextInput
                style={[
                  styles.promptInput,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.text },
                ]}
                multiline
                autoFocus
                placeholder="Describe the change you want…"
                placeholderTextColor={colors.textMuted}
                value={prompt}
                onChangeText={setPrompt}
                editable={!submitting}
                textAlignVertical="top"
              />
              <Text style={[styles.modelHint, { color: colors.textMuted }]}>Model override · Auto when none is selected</Text>
              <View style={styles.modelRow} accessibilityRole="radiogroup" accessibilityLabel="Agent model override">
                {AGENT_MODELS.map((option) => {
                  const active = model === option.id;
                  return (
                    <TouchableOpacity
                      key={option.id}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      style={[
                        styles.modelChip,
                        { borderColor: active ? colors.accent : colors.border },
                        active && { backgroundColor: `${colors.accent}22` },
                      ]}
                      disabled={submitting}
                      onPress={() => setModel((current) => current === option.id ? null : option.id)}
                    >
                      <Text style={[styles.modelChipText, { color: active ? colors.accent : colors.textMuted }]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.modalButton, { borderColor: colors.border }]} disabled={submitting} onPress={() => setCreateOpen(false)}>
                <Text style={{ color: colors.textMuted }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, { backgroundColor: colors.accent, opacity: prompt.trim() && !submitting ? 1 : 0.5 }]} disabled={!prompt.trim() || submitting} onPress={() => void create()}>
                {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Create task</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={selected != null} transparent animationType="fade" onRequestClose={() => setSelected(null)}>
        <View style={styles.backdrop}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setSelected(null)}
          />
          <View
            style={[
              styles.modal,
              styles.sheetModal,
              styles.detailSheet,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                maxHeight: sheetMaxHeight,
                height: sheetMaxHeight,
              },
            ]}
          >
            {selected ? (
              <>
                <View style={styles.cardTop}>
                  <View style={styles.detailBadges}>
                    <View style={[styles.status, { backgroundColor: `${statusColor(selected.status)}24` }]}>
                      <View style={[styles.statusDot, { backgroundColor: statusColor(selected.status) }]} />
                      <Text style={[styles.statusText, { color: statusColor(selected.status) }]}>{selected.status.replace('_', ' ')}</Text>
                    </View>
                    {modelLabel(selected.model) ? (
                      <View style={[styles.modelTag, { borderColor: colors.border }]}>
                        <Text style={[styles.modelTagText, { color: colors.textMuted }]}>{modelLabel(selected.model)}</Text>
                      </View>
                    ) : null}
                  </View>
                  <TouchableOpacity
                    onPress={() => setSelected(null)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    accessibilityLabel="Close task details"
                  >
                    <Ionicons name="close" size={24} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={styles.detailScroll}
                  contentContainerStyle={styles.detailContent}
                  showsVerticalScrollIndicator
                >
                  <Text style={[styles.detailPrompt, { color: colors.text }]}>{selected.prompt}</Text>
                  <View style={[styles.output, { backgroundColor: colors.background }]}>
                    <Text selectable style={[styles.outputText, { color: colors.text }]}>
                      {outputFor(selected)}
                    </Text>
                  </View>
                  {selected.changed_paths?.length ? (
                    <Text style={[styles.paths, { color: colors.textMuted }]}>
                      Changed: {selected.changed_paths.join(', ')}
                    </Text>
                  ) : null}
                </ScrollView>
                <View style={styles.modalActions}>
                  {ACTIVE.has(selected.status) && selected.status !== 'cancel_requested' ? (
                    <TouchableOpacity style={[styles.modalButton, { borderColor: colors.error }]} onPress={() => void cancel()}>
                      <Text style={{ color: colors.error }}>Cancel task</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity style={[styles.modalButton, { backgroundColor: colors.accent }]} onPress={() => setSelected(null)}>
                    <Text style={styles.primaryText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
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
  modelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modelHint: { fontSize: 12, textAlign: 'center' },
  modelChip: { flexGrow: 1, flexBasis: '30%', minHeight: 42, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  modelChipText: { fontSize: 13, fontWeight: '700' },
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
  paths: { fontSize: 11, lineHeight: 16 },
});
