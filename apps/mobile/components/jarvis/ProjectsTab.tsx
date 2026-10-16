import {
  createJarvisProject,
  createProjectFolder,
  deleteProjectNode,
  getJarvisProject,
  getProjectTree,
  listJarvisProjects,
  renameProjectNode,
  uploadProjectFiles,
  type JarvisProject,
  type JarvisProjectNode,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';

function depthOf(n: JarvisProjectNode, nodes: JarvisProjectNode[]): number {
  let d = 0;
  let pid: string | null | undefined = n.parent_id;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  while (pid) {
    d += 1;
    pid = byId.get(pid)?.parent_id ?? null;
  }
  return d;
}

async function pickFilesForProjectUpload(): Promise<{ blob: Blob; filename: string }[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.length) return [];
  const out: { blob: Blob; filename: string }[] = [];
  for (const a of result.assets) {
    const fn = a.name || 'file';
    if (a.file) {
      out.push({ blob: a.file, filename: fn });
    } else {
      const res = await fetch(a.uri);
      const blob = await res.blob();
      out.push({ blob, filename: fn });
    }
  }
  return out;
}

function TreeRows({
  projectId,
  nodes,
  colors,
  onReload,
  onUploadTo,
  uploadBusy,
}: {
  projectId: string;
  nodes: JarvisProjectNode[];
  colors: ReturnType<typeof useTheme>['colors'];
  onReload: () => Promise<void>;
  onUploadTo: (parentId: string | null) => Promise<void>;
  uploadBusy: boolean;
}) {
  const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<{
    kind: 'rename' | 'subfolder' | 'root';
    nodeId: string;
    initial: string;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const folderById = useMemo(() => {
    const m = new Map<string, JarvisProjectNode>();
    for (const n of nodes) {
      if (n.type === 'folder') m.set(n.id, n);
    }
    return m;
  }, [nodes]);

  const sorted = [...nodes].sort((a, b) => {
    const ds = depthOf(a, nodes) - depthOf(b, nodes);
    if (ds !== 0) return ds;
    return (a.name || '').localeCompare(b.name || '');
  });

  const closeMenu = () => setMenuFolderId(null);

  const submitNameModal = async () => {
    if (!nameModal) return;
    const name = nameDraft.trim();
    if (!name) return;
    setActionBusy(true);
    try {
      if (nameModal.kind === 'rename') {
        await renameProjectNode(projectId, nameModal.nodeId, { name });
      } else if (nameModal.kind === 'root') {
        await createProjectFolder(projectId, { name, parent_id: null });
      } else {
        await createProjectFolder(projectId, { name, parent_id: nameModal.nodeId });
      }
      setNameModal(null);
      await onReload();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Request failed');
    } finally {
      setActionBusy(false);
    }
  };

  const confirmDeleteFolder = (folderId: string, folderName: string) => {
    Alert.alert(
      'Delete folder',
      `Delete "${folderName}" and everything inside it? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setActionBusy(true);
              try {
                await deleteProjectNode(projectId, folderId);
                closeMenu();
                await onReload();
              } catch (e) {
                Alert.alert('Error', e instanceof Error ? e.message : 'Delete failed');
              } finally {
                setActionBusy(false);
              }
            })();
          },
        },
      ]
    );
  };

  const menuFolder = menuFolderId ? folderById.get(menuFolderId) : undefined;

  return (
    <>
      <View style={styles.filesHeaderRow}>
        <Text style={[styles.treeLabel, { color: colors.text }]}>Files</Text>
        <View style={styles.filesHeaderActions}>
          <TouchableOpacity
            style={[styles.uploadBtn, { borderColor: colors.border }]}
            onPress={() => {
              setNameModal({ kind: 'root', nodeId: '', initial: '' });
              setNameDraft('');
            }}
            disabled={actionBusy}
          >
            <Ionicons name="folder-open-outline" size={18} color={colors.accent} />
            <Text style={[styles.uploadBtnText, { color: colors.accent }]}>New folder</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.uploadBtn, { borderColor: colors.border, opacity: uploadBusy ? 0.7 : 1 }]}
            onPress={() => void onUploadTo(null)}
            disabled={uploadBusy}
          >
            {uploadBusy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Ionicons name="cloud-upload-outline" size={18} color={colors.accent} />
            )}
            <Text style={[styles.uploadBtnText, { color: colors.accent }]}>Upload files</Text>
          </TouchableOpacity>
        </View>
      </View>

      {sorted.map((n) => {
        const d = depthOf(n, nodes);
        const isFolder = n.type === 'folder';
        return (
          <View key={n.id} style={[styles.treeRow, { paddingLeft: 8 + d * 14 }]}>
            <Ionicons
              name={isFolder ? 'folder-outline' : 'document-text-outline'}
              size={16}
              color={colors.textMuted}
            />
            <Text style={[styles.treeName, { color: colors.text }]} numberOfLines={1}>
              {n.name}
            </Text>
            {n.type === 'asset' && n.asset_id ? (
              <Text style={[styles.treeMeta, { color: colors.textMuted }]}>(asset)</Text>
            ) : null}
            {isFolder ? (
              <TouchableOpacity
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => setMenuFolderId(n.id)}
                style={styles.folderMenuHit}
              >
                <Ionicons name="ellipsis-vertical" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}

      <Modal transparent visible={!!menuFolderId && !!menuFolder} animationType="fade">
        <Pressable style={styles.modalBackdrop} onPress={closeMenu}>
          <Pressable
            style={[styles.menuCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.menuTitle, { color: colors.text }]} numberOfLines={1}>
              {menuFolder?.name}
            </Text>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                const id = menuFolderId!;
                closeMenu();
                void onUploadTo(id);
              }}
              disabled={uploadBusy}
            >
              <Ionicons name="cloud-upload-outline" size={20} color={colors.accent} />
              <Text style={[styles.menuRowText, { color: colors.text }]}>Upload files here</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                if (!menuFolderId) return;
                setNameModal({ kind: 'subfolder', nodeId: menuFolderId, initial: '' });
                setNameDraft('');
                closeMenu();
              }}
            >
              <Ionicons name="folder-open-outline" size={20} color={colors.accent} />
              <Text style={[styles.menuRowText, { color: colors.text }]}>New folder inside…</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                if (!menuFolder) return;
                setNameModal({ kind: 'rename', nodeId: menuFolder.id, initial: menuFolder.name });
                setNameDraft(menuFolder.name);
                closeMenu();
              }}
            >
              <Ionicons name="create-outline" size={20} color={colors.accent} />
              <Text style={[styles.menuRowText, { color: colors.text }]}>Rename</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={() => {
                if (!menuFolder) return;
                const id = menuFolder.id;
                const nm = menuFolder.name;
                closeMenu();
                confirmDeleteFolder(id, nm);
              }}
            >
              <Ionicons name="trash-outline" size={20} color="#c44" />
              <Text style={[styles.menuRowText, { color: '#c44' }]}>Delete folder & contents</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal transparent visible={!!nameModal} animationType="fade">
        <Pressable style={styles.modalBackdrop} onPress={() => !actionBusy && setNameModal(null)}>
          <Pressable
            style={[styles.nameModalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.menuTitle, { color: colors.text }]}>
              {nameModal?.kind === 'rename' ? 'Rename folder' : 'New folder'}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  color: colors.text,
                  backgroundColor: colors.background,
                },
              ]}
              placeholder="Folder name"
              placeholderTextColor={colors.textMuted}
              value={nameDraft}
              onChangeText={setNameDraft}
              autoFocus
              editable={!actionBusy}
            />
            <View style={styles.nameModalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: colors.border }]}
                onPress={() => setNameModal(null)}
                disabled={actionBusy}
              >
                <Text style={{ color: colors.textMuted }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.accent }]}
                onPress={() => void submitNameModal()}
                disabled={actionBusy || !nameDraft.trim()}
              >
                {actionBusy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function ProjectsTab() {
  const { colors } = useTheme();
  const [projects, setProjects] = useState<JarvisProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JarvisProject | null>(null);
  const [tree, setTree] = useState<JarvisProjectNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listJarvisProjects();
      setProjects(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reloadTree = useCallback(async () => {
    if (!expandedId) return;
    setTreeLoading(true);
    try {
      const [p, t] = await Promise.all([getJarvisProject(expandedId), getProjectTree(expandedId)]);
      setDetail(p);
      setTree(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh files');
    } finally {
      setTreeLoading(false);
    }
  }, [expandedId]);

  const handleUploadTo = useCallback(
    async (parentId: string | null) => {
      if (!expandedId) return;
      const files = await pickFilesForProjectUpload();
      if (!files.length) return;
      setUploadBusy(true);
      setError(null);
      try {
        const res = await uploadProjectFiles(expandedId, files, parentId ?? undefined);
        if (!res.ok && res.errors.length) {
          setError(`Some uploads failed: ${res.errors.join(', ')}`);
        }
        await reloadTree();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setUploadBusy(false);
      }
    },
    [expandedId, reloadTree]
  );

  const onCreateProject = async () => {
    const title = newProjectName.trim();
    if (!title || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createJarvisProject({
        title,
        description_md: newProjectDescription.trim(),
      });
      setProjects((prev) => [created, ...prev]);
      setExpandedId(created.id);
      setDetail(created);
      setTree([]);
      setNewProjectName('');
      setNewProjectDescription('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      setTree([]);
      return;
    }
    setExpandedId(id);
    setTreeLoading(true);
    try {
      const [p, t] = await Promise.all([getJarvisProject(id), getProjectTree(id)]);
      setDetail(p);
      setTree(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load project');
    } finally {
      setTreeLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.text }]}>Projects</Text>
      {error ? <Text style={[styles.err, { color: colors.accent }]}>{error}</Text> : null}
      {projects.length === 0 ? (
        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Ask Jarvis to create a project, or use the API. Projects hold assets in a folder tree.
        </Text>
      ) : null}
      <View style={[styles.createCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text style={[styles.createTitle, { color: colors.text }]}>Create project</Text>
        <TextInput
          style={[
            styles.input,
            {
              borderColor: colors.border,
              color: colors.text,
              backgroundColor: colors.background,
            },
          ]}
          placeholder="Project name"
          placeholderTextColor={colors.textMuted}
          value={newProjectName}
          onChangeText={setNewProjectName}
        />
        <TextInput
          style={[
            styles.input,
            styles.multilineInput,
            {
              borderColor: colors.border,
              color: colors.text,
              backgroundColor: colors.background,
            },
          ]}
          placeholder="Project description"
          placeholderTextColor={colors.textMuted}
          value={newProjectDescription}
          onChangeText={setNewProjectDescription}
          multiline
          textAlignVertical="top"
        />
        <TouchableOpacity
          onPress={() => void onCreateProject()}
          style={[
            styles.createButton,
            { backgroundColor: colors.accent, opacity: !newProjectName.trim() || creating ? 0.7 : 1 },
          ]}
          disabled={!newProjectName.trim() || creating}
        >
          <Text style={styles.createButtonText}>{creating ? 'Creating...' : 'Create project'}</Text>
        </TouchableOpacity>
      </View>
      {projects.map((p) => (
        <View key={p.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <TouchableOpacity onPress={() => void toggle(p.id)} style={styles.cardHeader}>
            <Ionicons name="briefcase-outline" size={22} color={colors.accent} />
            <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={2}>
              {p.title}
            </Text>
            <Ionicons
              name={expandedId === p.id ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={colors.textMuted}
            />
          </TouchableOpacity>
          {p.summary ? (
            <Text style={[styles.summary, { color: colors.textMuted }]} numberOfLines={3}>
              {p.summary}
            </Text>
          ) : null}
          {expandedId === p.id && (
            <View style={styles.detail}>
              {treeLoading ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <>
                  {detail?.description_md ? (
                    <>
                      <Text style={[styles.mdHint, { color: colors.textMuted }]}>Description</Text>
                      <Text style={[styles.mdBody, { color: colors.text }]}>{detail.description_md}</Text>
                    </>
                  ) : null}
                  {detail?.status_md ? (
                    <>
                      <Text style={[styles.mdHint, { color: colors.textMuted }]}>Status</Text>
                      <Text style={[styles.mdBody, { color: colors.text }]}>{detail.status_md}</Text>
                    </>
                  ) : null}
                  <TreeRows
                    projectId={p.id}
                    nodes={tree}
                    colors={colors}
                    onReload={reloadTree}
                    onUploadTo={handleUploadTo}
                    uploadBusy={uploadBusy}
                  />
                </>
              )}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, padding: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  err: { marginBottom: 8 },
  hint: { marginBottom: 16, lineHeight: 20 },
  createCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  createTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  multilineInput: {
    minHeight: 88,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600' },
  summary: { marginTop: 8, fontSize: 14, lineHeight: 20 },
  detail: { marginTop: 12 },
  mdHint: { fontSize: 12, marginBottom: 4, marginTop: 4 },
  mdBody: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  treeLabel: { fontWeight: '600' },
  filesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 4,
    gap: 8,
    flexWrap: 'wrap',
  },
  filesHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  uploadBtnText: { fontSize: 14, fontWeight: '600' },
  treeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  treeName: { flex: 1, minWidth: 0, fontSize: 14 },
  folderMenuHit: { padding: 4 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  menuCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    maxWidth: 400,
    alignSelf: 'center',
    width: '100%',
  },
  menuTitle: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  menuRowText: { fontSize: 16, flex: 1 },
  nameModalCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    maxWidth: 400,
    alignSelf: 'center',
    width: '100%',
  },
  nameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 12,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 88,
    alignItems: 'center',
  },
  modalBtnPrimaryText: { color: '#fff', fontWeight: '600' },
  createButton: {
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  treeMeta: { fontSize: 12 },
});
