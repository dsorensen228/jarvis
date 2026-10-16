import {
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { agentAvatars } from '@/lib/avatars';
import { BrandAvatarImage } from './BrandAvatarImage';
import { useTheme } from '../contexts/ThemeContext';

type HeaderProps = {
  onJarvisPress?: () => void;
};

export function Header({ onJarvisPress }: HeaderProps) {
  const { colors } = useTheme();
  const androidTopInset =
    Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;

  return (
    <View
      style={[
        styles.header,
        { borderBottomColor: colors.border, paddingTop: 12 + androidTopInset },
      ]}
    >
      <View style={styles.leftSection}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          accessibilityHint="Opens the navigation drawer"
          onPress={onJarvisPress}
          hitSlop={10}
          style={styles.jarvisButton}
        >
          <BrandAvatarImage
            source={agentAvatars.jarvis}
            size={40}
            resizeMode="cover"
          />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          Jarvis
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  leftSection: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  jarvisButton: {
    borderRadius: 20,
  },
  title: {
    flexShrink: 1,
    fontSize: 20,
    fontWeight: '600',
  },
});
