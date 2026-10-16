/**
 * Jarvis identity and mission.
 * Synced with content/identity.json - update both when changing.
 */

export const mission_tagline =
  'Your personally-hosted AI assistant. Direct control over your data.';

export const mission_full =
  "AI is changing everything about technology. But right now it's being used heavily to gather information about users, with unsettling privacy implications. Jarvis empowers you to create, host, and expand your own low-cost AI tools — paying only for direct model access and infrastructure (often in free tier). This is the future of computing: no more software-as-a-service. Computing as a service, reasoning as a service, software engineering as a service. Bespoke software by and for users, with direct control over their own data.";

export const mission_future =
  'Eventually moving towards self-hosted and self-trained Llama models.';

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

export const agents: AgentInfo[] = [
  {
    id: 'jarvis',
    name: 'Jarvis',
    description:
      'Your assistant for chat, smart home, Gmail, timers, todos, shopping lists, and in-depth research reports.',
  },
];
