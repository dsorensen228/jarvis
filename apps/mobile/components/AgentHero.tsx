import { agentHeroImages, type AgentId } from '@/lib/avatars';
import { Image, StyleSheet, View } from 'react-native';

interface AgentHeroProps {
  agentId: AgentId;
}

export function AgentHero({ agentId }: AgentHeroProps) {
  const source = agentHeroImages[agentId];
  return (
    <View style={styles.wrap}>
      <Image
        source={source}
        style={styles.image}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    aspectRatio: 2,
    maxHeight: 245,
  },
  image: {
    width: '100%',
    height: '100%',
  },
});
