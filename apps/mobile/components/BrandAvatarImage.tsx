import {
  Image,
  type ImageResizeMode,
  type ImageSourcePropType,
  View,
} from 'react-native';

import { useTheme } from '../contexts/ThemeContext';

type BrandAvatarImageProps = {
  source: ImageSourcePropType;
  size: number;
  /** Inner image as a fraction of `size` when using a black circular backdrop (light mode). */
  imageScale?: number;
  resizeMode?: ImageResizeMode;
};

/**
 * Renders brand / Jarvis artwork that assumes a dark fade. In light mode the image
 * sits on a black circle so transparent PNGs stay legible on pale surfaces.
 */
export function BrandAvatarImage({
  source,
  size,
  imageScale = 0.88,
  resizeMode = 'cover',
}: BrandAvatarImageProps) {
  const { colorScheme } = useTheme();
  const inner = Math.max(1, Math.round(size * imageScale));

  if (colorScheme === 'light') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: '#000000',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Image
          source={source}
          style={{
            width: inner,
            height: inner,
            borderRadius: inner / 2,
          }}
          resizeMode={resizeMode}
        />
      </View>
    );
  }

  return (
    <Image
      source={source}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
      }}
      resizeMode={resizeMode}
    />
  );
}
