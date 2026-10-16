import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

const styles = StyleSheet.create({
  section: {
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  sectionSubtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
});

export function Section({
  title,
  subtitle,
  children,
  colors,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  colors: { text: string; textMuted: string; border: string };
}) {
  return (
    <View style={[styles.section, { borderColor: colors.border }]}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.sectionSubtitle, { color: colors.textMuted }]}>
          {subtitle}
        </Text>
      ) : null}
      {children}
    </View>
  );
}
