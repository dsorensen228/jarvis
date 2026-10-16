import {
  createConversation,
  getConversation,
  getConversations,
  type Conversation,
  type Message,
} from '@/lib/api-client';
import { usePathname } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { useAuth } from './AuthContext';

interface ConversationContextValue {
  currentConversation: Conversation | null;
  setCurrentConversation: Dispatch<SetStateAction<Conversation | null>>;
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  loadingConvs: boolean;
  showConvModal: boolean;
  setShowConvModal: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
  loadConversations: () => Promise<void>;
  loadConversation: (conv: Conversation | null) => Promise<void>;
  handleSelectConversation: (conv: Conversation) => void;
  handleNewConversation: () => void;
  openConversationById: (conversationId: string) => Promise<void>;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const { accessToken, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  const prevTokenRef = useRef<string | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentConversation, setCurrentConversation] =
    useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [showConvModal, setShowConvModal] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);

  const setError = useCallback((value: string | null) => {
    if (errorTimeoutRef.current) {
      clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }

    setErrorState(value);

    if (!value) {
      return;
    }

    errorTimeoutRef.current = setTimeout(() => {
      setErrorState(null);
      errorTimeoutRef.current = null;
    }, 10000);
  }, []);

  useEffect(() => {
    if (accessToken && !prevTokenRef.current) {
      setCurrentConversation(null);
      setMessages([]);
    }
    prevTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    setError(null);
  }, [pathname, setError]);

  useEffect(() => {
    return () => {
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const loadConversations = useCallback(async () => {
    if (!accessToken) {
      setLoadingConvs(false);
      return;
    }
    const timeoutMs = 20000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      setError(null);
      setLoadingConvs(true);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('Timed out loading conversations'));
        }, timeoutMs);
      });

      const list = await Promise.race([getConversations(), timeoutPromise]);
      setConversations(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load conversations');
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      setLoadingConvs(false);
    }
  }, [accessToken]);

  const loadConversation = useCallback(async (conv: Conversation | null) => {
    setError(null);
    if (!conv) {
      setMessages([]);
      setCurrentConversation(null);
      return;
    }
    try {
      const full = await getConversation(conv.id);
      setCurrentConversation(full);
      setMessages(full.messages ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load conversation');
    }
  }, []);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!accessToken) {
      setLoadingConvs(false);
      setConversations([]);
      return;
    }
    loadConversations();
  }, [authLoading, accessToken, loadConversations]);

  useEffect(() => {
    if (showConvModal && accessToken && !authLoading) {
      loadConversations();
    }
  }, [showConvModal, accessToken, authLoading, loadConversations]);

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setShowConvModal(false);
      loadConversation(conv);
    },
    [loadConversation]
  );

  const handleNewConversation = useCallback(() => {
    setError(null);
    setCurrentConversation(null);
    setMessages([]);
    setShowConvModal(false);
  }, [setError]);

  const openConversationById = useCallback(
    async (conversationId: string) => {
      setError(null);
      try {
        const full = await getConversation(conversationId);
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === full.id);
          if (idx === -1) {
            return [full, ...prev];
          }
          const next = [...prev];
          next[idx] = full;
          return next;
        });
        setCurrentConversation(full);
        setMessages(full.messages ?? []);
        setShowConvModal(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load conversation');
      }
    },
    [setError]
  );

  const value: ConversationContextValue = {
    currentConversation,
    setCurrentConversation,
    conversations,
    setConversations,
    messages,
    setMessages,
    loadingConvs,
    showConvModal,
    setShowConvModal,
    error,
    setError,
    loadConversations,
    loadConversation,
    handleSelectConversation,
    handleNewConversation,
    openConversationById,
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversation() {
  const ctx = useContext(ConversationContext);
  if (!ctx) throw new Error('useConversation must be used within ConversationProvider');
  return ctx;
}
