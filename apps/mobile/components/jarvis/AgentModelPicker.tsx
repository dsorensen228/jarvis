import React from 'react';
import type { CodeTaskModel } from '../../lib/api-client';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';

export const AGENT_MODELS = [
  { id: 'gpt-5.6-terra', label: 'Terra' },
  { id: 'gpt-6-sol', label: 'Sol' },
  { id: 'gpt-6-astra', label: 'Astra' },
] as const;

export function agentModelLabel(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  return AGENT_MODELS.find((model) => model.id === modelId)?.label ?? modelId;
}

export function AgentModelPicker({ value, onChange, disabled = false }: {
  value: CodeTaskModel;
  onChange: (model: CodeTaskModel) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.container}>
      <Text style={[styles.hint, { color: colors.textMuted }]}>Agent model</Text>
      <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Agent model">
        {AGENT_MODELS.map((option) => {
          const active = value === option.id;
          return (
            <TouchableOpacity
              key={option.id}
              accessibilityRole="radio"
              aria-checked={active}
              accessibilityState={{ checked: active, selected: active, disabled }}
              style={[
                styles.chip,
                { borderColor: active ? colors.accent : colors.border },
                active && { backgroundColor: `${colors.accent}22` },
              ]}
              disabled={disabled}
              onPress={() => onChange(option.id)}
            >
              <Text style={[styles.chipText, { color: active ? colors.accent : colors.textMuted }]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 10 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  hint: { fontSize: 12, textAlign: 'center' },
  chip: { flex: 1, minWidth: 76, minHeight: 42, borderWidth: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 8 },
  chipText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
});
