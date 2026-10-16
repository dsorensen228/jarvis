import {
  createShoppingList,
  deleteShoppingList,
  getShoppingLists,
  updateShoppingList,
  type ShoppingList,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';

export function ShoppingTab() {
  const { colors } = useTheme();
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [addingToList, setAddingToList] = useState<string | null>(null);
  const [newItemText, setNewItemText] = useState('');
  const [sharingListId, setSharingListId] = useState<string | null>(null);
  const [shareUserId, setShareUserId] = useState('');
  const addItemInputRef = useRef<TextInput>(null);
  const blurHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getShoppingLists();
      setLists(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load lists');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAddList = async () => {
    if (!newListName.trim()) return;
    try {
      const created = await createShoppingList({ name: newListName.trim() });
      setLists((prev) => [created, ...prev]);
      setNewListName('');
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to add list');
    }
  };

  const handleAddItem = async (listId: string) => {
    if (!newItemText.trim()) return;
    const text = newItemText.trim();
    setNewItemText('');
    if (blurHideTimeoutRef.current) {
      clearTimeout(blurHideTimeoutRef.current);
      blurHideTimeoutRef.current = null;
    }
    try {
      const updated = await updateShoppingList(listId, { add_items: [text] });
      setLists((prev) => prev.map((l) => (l.id === listId ? updated : l)));
      addItemInputRef.current?.focus();
    } catch (e) {
      setNewItemText(text);
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to add item');
    }
  };

  const handleToggleItem = async (listId: string, itemId: string) => {
    try {
      const updated = await updateShoppingList(listId, {
        toggle_item_ids: [itemId],
      });
      setLists((prev) => prev.map((l) => (l.id === listId ? updated : l)));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to toggle');
    }
  };

  const handleShare = async (listId: string) => {
    const userId = shareUserId.trim();
    if (!userId) return;
    try {
      await updateShoppingList(listId, { share_with_user_id: userId });
      setShareUserId('');
      setSharingListId(null);
      load();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to share');
    }
  };

  const handleDeleteList = async (list: ShoppingList) => {
    try {
      await deleteShoppingList(list.id);
      setLists((prev) => prev.filter((l) => l.id !== list.id));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const dynamicStyles = {
    container: { backgroundColor: colors.background },
    form: { borderBottomColor: colors.border },
    input: { backgroundColor: colors.surface, color: colors.text },
    btn: { backgroundColor: colors.accent },
    listHeader: { backgroundColor: colors.surface, borderBottomColor: colors.border },
    listName: { color: colors.text },
    itemRow: { borderBottomColor: colors.border },
    itemText: { color: colors.text },
    itemTextDone: { color: colors.textMuted },
    itemInput: { backgroundColor: colors.background, color: colors.text },
  };

  if (loading) {
    return (
      <View style={[styles.container, dynamicStyles.container, styles.loading]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, dynamicStyles.container]}>
      <View style={[styles.form, dynamicStyles.form]}>
        <TextInput
          style={[styles.input, dynamicStyles.input]}
          placeholder="New list name..."
          placeholderTextColor={colors.textMuted}
          value={newListName}
          onChangeText={setNewListName}
          onSubmitEditing={handleAddList}
        />
        <TouchableOpacity
          style={[styles.btn, dynamicStyles.btn]}
          onPress={handleAddList}
        >
          <Text style={styles.btnText}>Add List</Text>
        </TouchableOpacity>
      </View>
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
      {lists.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textMuted }]}>
          No shopping lists
        </Text>
      ) : (
        lists.map((list) => (
          <View key={list.id} style={styles.list}>
            <View
              style={[styles.listHeader, dynamicStyles.listHeader]}
            >
              <Text style={[styles.listName, dynamicStyles.listName]}>
                {list.name}
              </Text>
              <View style={styles.listActions}>
                <TouchableOpacity
                  onPress={() =>
                    setAddingToList(addingToList === list.id ? null : list.id)
                  }
                >
                  <Ionicons
                    name="add-circle-outline"
                    size={24}
                    color={colors.accent}
                  />
                </TouchableOpacity>
                {!list.is_shared_with_me && (
                  <>
                    <TouchableOpacity
                      onPress={() =>
                        setSharingListId(
                          sharingListId === list.id ? null : list.id
                        )
                      }
                    >
                      <Ionicons
                        name="person-add-outline"
                        size={22}
                        color={colors.accent}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDeleteList(list)}>
                      <Ionicons
                        name="trash-outline"
                        size={22}
                        color={colors.error}
                      />
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
            {sharingListId === list.id && !list.is_shared_with_me && (
              <View
                style={[
                  styles.itemRow,
                  dynamicStyles.itemRow,
                  { paddingLeft: 16 },
                ]}
              >
                <TextInput
                  style={[styles.itemInput, dynamicStyles.itemInput]}
                  placeholder="User ID to share with..."
                  placeholderTextColor={colors.textMuted}
                  value={shareUserId}
                  onChangeText={setShareUserId}
                  onSubmitEditing={() => handleShare(list.id)}
                />
                <TouchableOpacity
                  style={[styles.btn, dynamicStyles.btn]}
                  onPress={() => handleShare(list.id)}
                >
                  <Text style={styles.btnText}>Share</Text>
                </TouchableOpacity>
              </View>
            )}
            {addingToList === list.id && (
              <View
                style={[styles.itemRow, dynamicStyles.itemRow]}
              >
                <TextInput
                  ref={addItemInputRef}
                  style={[styles.itemInput, dynamicStyles.itemInput]}
                  placeholder="Item name (Enter to add)..."
                  placeholderTextColor={colors.textMuted}
                  value={newItemText}
                  onChangeText={setNewItemText}
                  onSubmitEditing={() => handleAddItem(list.id)}
                  onBlur={() => {
                    blurHideTimeoutRef.current = setTimeout(
                      () => setAddingToList(null),
                      150
                    );
                  }}
                  onFocus={() => {
                    if (blurHideTimeoutRef.current) {
                      clearTimeout(blurHideTimeoutRef.current);
                      blurHideTimeoutRef.current = null;
                    }
                  }}
                  autoFocus
                  returnKeyType="done"
                />
              </View>
            )}
            {list.items.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.itemRow, dynamicStyles.itemRow]}
                onPress={() => handleToggleItem(list.id, item.id)}
              >
                <Ionicons
                  name={item.checked ? 'checkbox' : 'square-outline'}
                  size={20}
                  color={item.checked ? colors.accent : colors.textMuted}
                />
                <Text
                  style={[
                    styles.itemText,
                    dynamicStyles.itemText,
                    item.checked && dynamicStyles.itemTextDone,
                    item.checked && styles.itemTextDone,
                  ]}
                >
                  {item.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  form: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
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
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  list: { marginBottom: 16 },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minWidth: 0,
    padding: 16,
    borderBottomWidth: 1,
  },
  listName: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600' },
  listActions: { flexDirection: 'row', gap: 8 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 16,
    paddingLeft: 32,
    borderBottomWidth: 1,
    gap: 8,
  },
  itemText: { flex: 1, minWidth: 0, fontSize: 15 },
  itemTextDone: { textDecorationLine: 'line-through' },
  itemInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    fontSize: 14,
  },
  error: { padding: 16, fontSize: 14 },
  empty: { padding: 24, textAlign: 'center', fontSize: 15 },
  loading: { justifyContent: 'center', alignItems: 'center' },
});
