import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Image } from 'react-native';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { BrandAvatarImage } from './BrandAvatarImage';

import { getApiBaseUrl } from '@/lib/runtimePublicEnv';

interface AvatarMenuProps {
  defaultAvatarSource?: number;
  onSettings?: () => void;
  placement?: 'header' | 'drawer';
}

export function AvatarMenu({
  defaultAvatarSource,
  onSettings,
  placement = 'header',
}: AvatarMenuProps) {
  const { user, signOut } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  const avatarUri = user?.avatar_url
    ? `${getApiBaseUrl()}${user.avatar_url}`
    : null;

  const handleLogout = () => {
    setVisible(false);
    signOut();
    router.replace('/login');
  };

  const handleSettings = () => {
    setVisible(false);
    if (onSettings) {
      onSettings();
      return;
    }
    router.push('/settings');
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => setVisible(true)}
        style={styles.avatarWrap}
      >
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatar} />
        ) : (
          <BrandAvatarImage
            source={defaultAvatarSource ?? require('../assets/logo.png')}
            size={40}
            resizeMode="cover"
          />
        )}
      </TouchableOpacity>

      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <Pressable
          style={[
            styles.overlay,
            placement === 'drawer' ? styles.overlayDrawer : styles.overlayHeader,
          ]}
          onPress={() => setVisible(false)}
        >
          <Pressable
            style={[styles.menu, { backgroundColor: colors.surface }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={[styles.userRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.userLabel, { color: colors.textMuted }]}>
                Logged in as
              </Text>
              <Text
                style={[styles.userName, { color: colors.text }]}
                numberOfLines={1}
              >
                {user?.name || user?.email || 'User'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.item}
              onPress={handleSettings}
            >
              <Ionicons name="settings-outline" size={20} color={colors.text} />
              <Text style={[styles.itemText, { color: colors.text }]}>
                Settings
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.item}
              onPress={handleLogout}
            >
              <Ionicons name="log-out-outline" size={20} color={colors.error} />
              <Text style={[styles.itemText, { color: colors.error }]}>
                Logout
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  avatarWrap: {
    borderRadius: 20,
    overflow: 'hidden',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  overlayHeader: {
    justifyContent: 'flex-start',
    paddingTop: 60,
    paddingRight: 16,
    alignItems: 'flex-end',
  },
  overlayDrawer: {
    justifyContent: 'flex-end',
    paddingLeft: 20,
    paddingBottom: 88,
    alignItems: 'flex-start',
  },
  menu: {
    borderRadius: 8,
    minWidth: 0,
    maxWidth: '92%',
    width: 220,
    overflow: 'hidden',
  },
  userRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  userLabel: {
    fontSize: 12,
    marginBottom: 2,
  },
  userName: {
    fontSize: 15,
    fontWeight: '600',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  itemText: {
    fontSize: 15,
  },
});
