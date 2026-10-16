import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';

export function SettingsScreen({ title, onBack, children, action, footer }: {
  title: string; onBack?: () => void; children: React.ReactNode; action?: React.ReactNode; footer?: React.ReactNode;
}) {
  const { colors } = useTheme();
  useEffect(() => {
    if (!onBack) return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => listener.remove();
  }, [onBack]);
  return <KeyboardAvoidingView style={[s.screen, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={[s.header, { borderBottomColor: colors.border }]}>
      {onBack && <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={s.back}>
        <Ionicons name="arrow-back" size={22} color={colors.text} />
      </Pressable>}
      <Text accessibilityRole="header" style={[s.title, { color: colors.text }]}>{title}</Text>
      {action}
    </View>
    <ScrollView key={title} style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {children}
    </ScrollView>
    {footer && <View style={[s.footer, { borderTopColor: colors.border }]}>{footer}</View>}
  </KeyboardAvoidingView>;
}

export function SettingsRow({ icon, label, description, value, onPress, accessibilityLabel }: {
  icon?: React.ComponentProps<typeof Ionicons>['name']; label: string; description?: string; value?: string; onPress?: () => void; accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const content = <>
    {icon && <Ionicons name={icon} size={21} color={colors.textMuted} style={s.rowIcon} />}
    <View style={s.rowBody}>
      <Text style={[s.label, { color: colors.text }]}>{label}</Text>
      {value && <Text style={[s.detail, { color: colors.textMuted }]}>{value}</Text>}
      {description && <Text style={[s.detail, { color: colors.textMuted }]}>{description}</Text>}
    </View>
    {onPress && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />}
  </>;
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress} style={({ pressed }) => [s.row, { borderBottomColor: colors.border, opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable>
    : <View style={[s.row, { borderBottomColor: colors.border }]}>{content}</View>;
}

export function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return <View style={s.group}>
    {title && <Text accessibilityRole="header" style={[s.groupTitle, { color: colors.textMuted }]}>{title}</Text>}
    {children}
  </View>;
}

export function SettingsButton({ label, onPress, loading, disabled, variant = 'primary' }: {
  label: string; onPress: () => void; loading?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger';
}) {
  const { colors } = useTheme();
  const color = variant === 'primary' ? '#fff' : variant === 'danger' ? colors.error : colors.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress}
    style={({ pressed }) => [s.button, { backgroundColor: variant === 'primary' ? colors.accent : colors.background, borderColor: variant === 'primary' ? colors.accent : colors.border, opacity: disabled || loading || pressed ? 0.6 : 1 }]}>
    {loading && <ActivityIndicator size="small" color={color} />}
    <Text style={[s.buttonText, { color }]}>{label}</Text>
  </Pressable>;
}

export function SettingsNotice({ message, tone = 'error' }: { message: string; tone?: 'error' | 'info' }) {
  const { colors } = useTheme();
  return <Text accessibilityRole={tone === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[s.notice, { color: tone === 'error' ? colors.error : colors.textMuted }]}>{message}</Text>;
}

const s = StyleSheet.create({
  screen: { flex: 1, minWidth: 0, width: '100%', maxWidth: 760, alignSelf: 'center' },
  header: { minHeight: 64, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 44, minHeight: 44, marginLeft: -8, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { flex: 1, minWidth: 0, fontSize: 22, lineHeight: 28, fontWeight: '600' },
  scroll: { flex: 1, minWidth: 0 },
  content: { padding: 16, paddingBottom: 32, gap: 24 },
  footer: { padding: 16, gap: 10, borderTopWidth: StyleSheet.hairlineWidth },
  group: { gap: 0 },
  groupTitle: { fontSize: 13, fontWeight: '600', marginBottom: 8 },
  row: { minHeight: 64, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', gap: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  rowIcon: { flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 5 },
  label: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  detail: { fontSize: 14, lineHeight: 20, flexShrink: 1 },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { fontSize: 15, lineHeight: 21, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  notice: { fontSize: 14, lineHeight: 21 },
});
