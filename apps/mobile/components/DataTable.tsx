import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#000000',
  },
  scroll: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    minWidth: 0,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#241935',
    alignItems: 'center',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  cell: {
    flex: 1,
    minWidth: 0,
    color: '#e4ddea',
    fontSize: 15,
  } as TextStyle,
  cellMuted: {
    color: '#9f93b1',
    fontSize: 13,
  } as TextStyle,
  headerRow: {
    backgroundColor: '#110b18',
    paddingVertical: 10,
  },
  headerCell: {
    color: '#9f93b1',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  } as TextStyle,
  empty: {
    padding: 24,
    color: '#7f748f',
    textAlign: 'center',
    fontSize: 15,
  } as TextStyle,
});

interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => React.ReactNode;
  style?: TextStyle;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string;
  emptyMessage?: string;
  style?: ViewStyle;
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  emptyMessage = 'No items',
  style,
}: DataTableProps<T>) {
  if (data.length === 0) {
    return (
      <View style={[styles.container, style]}>
        <Text style={styles.empty}>{emptyMessage}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, styles.scroll, style]}>
      <View style={[styles.row, styles.headerRow]}>
        {columns.map((col) => (
          <Text key={col.key} style={[styles.cell, styles.headerCell]}>
            {col.header}
          </Text>
        ))}
      </View>
      {data.map((item, i) => (
        <View
          key={keyExtractor(item)}
          style={[styles.row, i === data.length - 1 && styles.rowLast]}
        >
          {columns.map((col) => (
            <View key={col.key} style={{ flex: 1, minWidth: 0 }}>
              {col.render(item)}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
