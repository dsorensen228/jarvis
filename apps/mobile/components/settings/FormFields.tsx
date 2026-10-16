import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type FieldColors = { surface: string; text: string; textMuted: string; border: string };

export function Field({ label, value, onChangeText, placeholder, colors, keyboardType, secureTextEntry, multiline, minHeight, disabled = false }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  colors: FieldColors;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad' | 'url';
  secureTextEntry?: boolean;
  multiline?: boolean;
  minHeight?: number;
  disabled?: boolean;
}) {
  return <View style={styles.field}>
    <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText}
      placeholder={placeholder} placeholderTextColor={colors.textMuted} keyboardType={keyboardType}
      secureTextEntry={secureTextEntry} multiline={multiline} editable={!disabled}
      textAlignVertical={multiline ? 'top' : 'center'} autoCapitalize="none" autoCorrect={false}
      style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, minHeight: minHeight ?? 48, opacity: disabled ? 0.6 : 1 }]} />
  </View>;
}

export function PickerField({ label, value, placeholder, options, onSelect, colors, disabled = false }: {
  label: string;
  value: string;
  placeholder: string;
  options: { label: string; value: string }[];
  onSelect: (value: string) => void;
  colors: FieldColors & { accent: string };
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const selected = options.find(option => option.value === value);
  return <>
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ expanded: open, disabled }} aria-expanded={open} disabled={disabled}
        onPress={() => setOpen(true)} style={[styles.pickerButton, { backgroundColor: colors.surface, borderColor: colors.border, opacity: disabled ? 0.6 : 1 }]}>
        <Text style={[styles.pickerText, { color: selected || value ? colors.text : colors.textMuted }]}>{selected?.label ?? (value || placeholder)}</Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={[styles.overlay, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <Pressable accessibilityLabel={`Close ${label} choices`} onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={[styles.picker, { backgroundColor: colors.surface, borderColor: colors.border, maxHeight: Math.max(100, height - insets.top - insets.bottom - 24) }]}>
          <View style={[styles.pickerHeader, { borderBottomColor: colors.border }]}>
            <Text accessibilityRole="header" style={[styles.pickerTitle, { color: colors.text }]}>{label}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Close ${label} choices`} onPress={() => setOpen(false)} style={styles.close}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
            {options.map(option => <Pressable key={option.value} accessibilityRole="radio"
              accessibilityLabel={option.label} accessibilityState={{ checked: option.value === value }} aria-checked={option.value === value}
              onPress={() => { onSelect(option.value); setOpen(false); }}
              style={[styles.option, { borderBottomColor: colors.border }]}>
              <Text style={[styles.optionText, { color: colors.text }]}>{option.label}</Text>
              {option.value === value && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>)}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  field: { gap: 8, minWidth: 0, width: '100%' },
  label: { fontSize: 14, fontWeight: '600', lineHeight: 20 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, lineHeight: 22, minWidth: 0, width: '100%' },
  pickerButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, minWidth: 0 },
  pickerText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22 },
  overlay: { flex: 1, backgroundColor: '#00000099', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  picker: { width: '100%', maxWidth: 520, borderRadius: 12, borderWidth: 1, overflow: 'hidden', flexShrink: 1 },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  pickerTitle: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 24, fontWeight: '600', paddingVertical: 14 },
  close: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 15, minHeight: 50, borderBottomWidth: StyleSheet.hairlineWidth },
  optionText: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22 },
});
