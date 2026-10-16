import {
  dismissGmailAlert,
  getGmailAlerts,
  type GmailAlert,
} from '@/lib/api-client';
import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useTheme } from '../../contexts/ThemeContext';

function formatDateLabel(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const alertDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (alertDate.getTime() === today.getTime()) return 'Today';
  if (alertDate.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function groupByDate(alerts: GmailAlert[]): Map<string, GmailAlert[]> {
  const map = new Map<string, GmailAlert[]>();
  for (const a of alerts) {
    const label = formatDateLabel(a.created_at);
    const list = map.get(label) ?? [];
    list.push(a);
    map.set(label, list);
  }
  return map;
}

export function AlertsTab() {
  const { colors } = useTheme();
  const [alerts, setAlerts] = useState<GmailAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    try {
      setError(null);
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      const data = await getGmailAlerts(false);
      setAlerts(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDismiss = async (id: string) => {
    try {
      setDismissingId(id);
      await dismissGmailAlert(id);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // ignore
    } finally {
      setDismissingId(null);
    }
  };

  const handleOpenConversation = (alert: GmailAlert) => {
    // Could navigate to conversation if we have a route
    // For now we don't have a direct link - alerts create conversations
    // The plan says "Creates new conversation" - we could open the app's conversation view
    // Leaving as no-op for now; could add navigation later
  };

  const grouped = groupByDate(alerts);
  const dynamicStyles = {
    container: { backgroundColor: colors.background },
    divider: { color: colors.textMuted },
    item: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
    },
    subject: { color: colors.text },
    snippet: { color: colors.textMuted },
    reason: { borderColor: colors.accent },
  };

  if (loading && alerts.length === 0) {
    return (
      <View style={[styles.container, dynamicStyles.container, styles.center]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, dynamicStyles.container]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => load(true)}
          tintColor={colors.accent}
        />
      }
    >
      {error && (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      )}
      {alerts.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            No actionable alerts right now.
          </Text>
        </View>
      ) : (
        Array.from(grouped.entries()).map(([label, items]) => (
          <View key={label} style={styles.group}>
            <Text style={[styles.divider, dynamicStyles.divider]}>{label}</Text>
            {items.map((alert) => (
              <View
                key={alert.id}
                style={[styles.item, dynamicStyles.item]}
              >
                <Pressable
                  onPress={() => handleOpenConversation(alert)}
                  style={styles.itemContent}
                >
                  <Text
                    style={[styles.subject, dynamicStyles.subject]}
                    numberOfLines={1}
                  >
                    {alert.subject || '(No subject)'}
                  </Text>
                  <Text
                    style={[styles.snippet, dynamicStyles.snippet]}
                    numberOfLines={2}
                  >
                    {alert.snippet}
                  </Text>
                  {alert.reason && (
                    <View style={[styles.reasonBadge, dynamicStyles.reason]}>
                      <Text
                        style={[styles.reasonText, { color: colors.accent }]}
                        numberOfLines={1}
                      >
                        {alert.reason}
                      </Text>
                    </View>
                  )}
                </Pressable>
                <TouchableOpacity
                  style={styles.dismissBtn}
                  onPress={() => handleDismiss(alert.id)}
                  disabled={dismissingId === alert.id}
                >
                  {dismissingId === alert.id ? (
                    <ActivityIndicator size="small" color={colors.textMuted} />
                  ) : (
                    <Ionicons
                      name="checkmark-done-outline"
                      size={22}
                      color={colors.textMuted}
                    />
                  )}
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0 },
  content: { padding: 16, paddingBottom: 32, minWidth: 0 },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  error: {
    fontSize: 14,
    marginBottom: 16,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  group: {
    marginBottom: 16,
  },
  divider: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginLeft: 4,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
    overflow: 'hidden',
  },
  itemContent: {
    flex: 1,
    minWidth: 0,
    padding: 14,
  },
  subject: {
    fontSize: 15,
    fontWeight: '600',
  },
  snippet: {
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  reasonBadge: {
    marginTop: 6,
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 4,
    borderWidth: 1,
  },
  reasonText: {
    fontSize: 11,
  },
  dismissBtn: {
    padding: 14,
  },
});
