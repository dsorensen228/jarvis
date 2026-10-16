import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const styles = StyleSheet.create({
  field: { gap: 8 },
  fieldLabel: { fontSize: 14, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
  },
  pickerButton: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  pickerText: { fontSize: 15 },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  pickerModal: {
    width: '100%',
    maxWidth: 560,
    borderRadius: 20,
    overflow: 'hidden',
  },
  pickerOption: {
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  pickerOptionText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  colors,
  keyboardType,
  secureTextEntry,
  multiline,
  minHeight,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  colors: { surface: string; text: string; textMuted: string; border: string };
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  secureTextEntry?: boolean;
  multiline?: boolean;
  minHeight?: number;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.text }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          styles.input,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
            color: colors.text,
            ...(minHeight != null ? { minHeight } : {}),
          },
        ]}
      />
    </View>
  );
}

export function PickerField({
  label,
  value,
  placeholder,
  options,
  onSelect,
  colors,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: { label: string; value: string }[];
  onSelect: (value: string) => void;
  colors: { surface: string; text: string; textMuted: string; border: string; accent: string };
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <>
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.text }]}>{label}</Text>
        <TouchableOpacity
          style={[
            styles.pickerButton,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
          onPress={() => setOpen(true)}
        >
          <Text
            style={[
              styles.pickerText,
              { color: selected ? colors.text : colors.textMuted },
            ]}
          >
            {selected?.label ?? placeholder}
          </Text>
          <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setOpen(false)}>
          <Pressable
            style={[styles.pickerModal, { backgroundColor: colors.surface }]}
            onPress={(event) => event.stopPropagation()}
          >
            {options.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={styles.pickerOption}
                onPress={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
              >
                <Text
                  style={[
                    styles.pickerOptionText,
                    {
                      color: option.value === value ? colors.accent : colors.text,
                    },
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
