import {
  createTodo,
  deleteTodo,
  getTodos,
  updateTodo,
  type Todo,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { DataTable } from '../DataTable';
import { useTheme } from '../../contexts/ThemeContext';

export function TodosTab() {
  const { colors } = useTheme();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getTodos();
      setTodos(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load todos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!title.trim()) return;
    try {
      const created = await createTodo({
        title: title.trim(),
        category: category.trim() || undefined,
      });
      setTodos((prev) => [created, ...prev]);
      setTitle('');
      setCategory('');
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to add');
    }
  };

  const handleToggle = async (todo: Todo) => {
    try {
      const updated = await updateTodo(todo.id, { completed: !todo.completed });
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? updated : t)));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to update');
    }
  };

  const handleDelete = async (todo: Todo) => {
    try {
      await deleteTodo(todo.id);
      setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const dynamicStyles = {
    container: { backgroundColor: colors.background },
    form: { borderBottomColor: colors.border },
    input: { backgroundColor: colors.surface, color: colors.text },
    btn: { backgroundColor: colors.accent },
  };

  if (loading) {
    return (
      <View style={[styles.container, dynamicStyles.container, styles.loading]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.container, dynamicStyles.container]}>
      <View style={[styles.form, dynamicStyles.form]}>
        <TextInput
          style={[styles.input, styles.inputMain, dynamicStyles.input]}
          placeholder="Add todo..."
          placeholderTextColor={colors.textMuted}
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={handleAdd}
        />
        <TextInput
          style={[styles.input, styles.inputCat, dynamicStyles.input]}
          placeholder="Category"
          placeholderTextColor={colors.textMuted}
          value={category}
          onChangeText={setCategory}
        />
        <TouchableOpacity
          style={[styles.btn, dynamicStyles.btn]}
          onPress={handleAdd}
        >
          <Text style={styles.btnText}>Add</Text>
        </TouchableOpacity>
      </View>
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
      <DataTable<Todo>
        data={todos}
        keyExtractor={(t) => t.id}
        emptyMessage="No todos"
        style={{ backgroundColor: colors.background }}
        columns={[
          {
            key: 'check',
            header: '',
            render: (t) => (
              <TouchableOpacity
                onPress={() => handleToggle(t)}
                style={styles.iconBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name={t.completed ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={t.completed ? colors.accent : colors.textMuted}
                />
              </TouchableOpacity>
            ),
          },
          {
            key: 'title',
            header: 'Title',
            render: (t) => (
              <Text
                style={[
                  styles.cell,
                  { color: colors.text },
                  t.completed && { color: colors.textMuted, textDecorationLine: 'line-through' },
                ]}
              >
                {t.title}
              </Text>
            ),
          },
          {
            key: 'category',
            header: 'Category',
            render: (t) =>
              t.category ? (
                <Text style={[styles.cellCat, { color: colors.textMuted }]}>
                  ({t.category})
                </Text>
              ) : null,
          },
          {
            key: 'del',
            header: '',
            render: (t) => (
              <TouchableOpacity
                onPress={() => handleDelete(t)}
                style={styles.iconBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              </TouchableOpacity>
            ),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  form: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    minWidth: 0,
    padding: 16,
    gap: 8,
    borderBottomWidth: 1,
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    fontSize: 15,
  },
  inputMain: { flex: 1, minWidth: 0, flexBasis: 120 },
  inputCat: { width: 100, minWidth: 72, flexShrink: 1 },
  btn: {
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: 'center',
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  cell: { fontSize: 15 },
  cellCat: { fontSize: 13 },
  iconBtn: { padding: 4 },
  error: { padding: 16, fontSize: 14 },
  loading: { justifyContent: 'center', alignItems: 'center' },
});
