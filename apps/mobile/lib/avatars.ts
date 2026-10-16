/**
 * Avatar and hero image sources for agents and user.
 * Use with require() for React Native Image source.
 */

export type AgentId = 'jarvis';

export const agentAvatars: Record<AgentId, ReturnType<typeof require>> = {
  jarvis: require('../assets/jarvis.png'),
};

export const agentHeroImages: Record<AgentId, ReturnType<typeof require>> = {
  jarvis: require('../assets/jarvis.png'),
};

export const userDefaultAvatar = require('../assets/logo.png');

export function getAgentAvatarSource(
  sourceAgent: string | undefined
): ReturnType<typeof require> | null {
  if (!sourceAgent) return null;
  const agent = agentAvatars[sourceAgent as AgentId];
  return agent ?? null;
}
