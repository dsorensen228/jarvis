import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { Linking, Platform } from 'react-native';

import { useConversation } from '@/contexts/ConversationContext';
import { ensureGmailUrgentNotificationSetup } from '@/lib/gmailUrgentNotifications';
import { navigateHomeToChat } from '@/lib/homeNavigationBridge';

function readData(
  response: Notifications.NotificationResponse | null | undefined
): Record<string, string> | null {
  if (!response) {
    return null;
  }
  const raw = response.notification.request.content.data as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v != null) {
      o[k] = String(v);
    }
  }
  return o;
}

async function openGmailInbox() {
  const tryOpen = async (url: string) => {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  };

  if (await tryOpen('googlegmail://')) {
    return;
  }
  await tryOpen('https://mail.google.com/mail/');
}

/**
 * Registers Android urgent-email channel + notification category, and routes
 * push taps (conversation open / Open Gmail action).
 */
export function GmailNotificationBridge() {
  const { openConversationById } = useConversation();
  const coldStartSeen = useRef<Set<string>>(new Set());

  const handleResponse = useCallback(
    async (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) {
        return;
      }

      const data = readData(response);
      const action = response.actionIdentifier;

      if (action === 'open_gmail') {
        await openGmailInbox();
        return;
      }

      const convId = data?.conversation_id;
      if (
        convId &&
        (action === Notifications.DEFAULT_ACTION_IDENTIFIER ||
          data?.type === 'urgent_gmail' ||
          data?.type === 'system_message')
      ) {
        navigateHomeToChat();
        await openConversationById(convId);
      }
    },
    [openConversationById]
  );

  useEffect(() => {
    void ensureGmailUrgentNotificationSetup();
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      void handleResponse(r);
    });
    return () => sub.remove();
  }, [handleResponse]);

  const last = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (Platform.OS === 'web' || !last) {
      return;
    }
    const nid = last.notification.request.identifier;
    if (coldStartSeen.current.has(nid)) {
      return;
    }
    coldStartSeen.current.add(nid);
    void handleResponse(last);
  }, [last, handleResponse]);

  return null;
}
