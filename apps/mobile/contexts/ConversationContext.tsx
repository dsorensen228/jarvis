import {
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
  loadingMessages: boolean;
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
  const { accessToken, user, isLoading: authLoading } = useAuth();
  const pathname = usePathname();
  // Token refresh keeps the same account; signing out or switching accounts invalidates loads.
  const sessionKey = accessToken ? user?.id ?? accessToken : null;
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;
  const previousSessionRef = useRef(sessionKey);
  const mountedRef = useRef(true);
  const listRequestRef = useRef(0);
  const messageRequestRef = useRef(0);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentConversation, setCurrentConversationState] =
    useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
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

  const setCurrentConversation: Dispatch<SetStateAction<Conversation | null>> = useCallback((update) => {
    // An explicit selection from a stream/new-chat action supersedes an in-flight history load.
    messageRequestRef.current += 1;
    setLoadingMessages(false);
    setCurrentConversationState(update);
  }, []);

  useEffect(() => {
    if (previousSessionRef.current !== sessionKey) {
      listRequestRef.current += 1;
      messageRequestRef.current += 1;
      setCurrentConversationState(null);
      setConversations([]);
      setMessages([]);
      setLoadingMessages(false);
      setShowConvModal(false);
      setError(null);
    }
    previousSessionRef.current = sessionKey;
  }, [sessionKey, setError]);

  useEffect(() => {
    setError(null);
  }, [pathname, setError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      messageRequestRef.current += 1;
      if (errorTimeoutRef.current) {
        clearTimeout(errorTimeoutRef.current);
      }
    };
  }, []);

  const loadConversations = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    const isCurrent = () => mountedRef.current && requestId === listRequestRef.current && sessionRef.current === sessionKey;
    if (!sessionKey) {
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
      if (isCurrent()) setConversations(list);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : 'Failed to load conversations');
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (isCurrent()) setLoadingConvs(false);
    }
  }, [sessionKey, setError]);

  const loadConversationById = useCallback(async (id: string | null, summary: Conversation | null = null) => {
    const requestId = ++messageRequestRef.current;
    const isCurrent = () => mountedRef.current && requestId === messageRequestRef.current && sessionRef.current === sessionKey;
    setError(null);
    setCurrentConversationState(summary);
    setMessages([]);
    setLoadingMessages(Boolean(id && sessionKey));
    if (!id || !sessionKey) return;
    try {
      const full = await getConversation(id);
      if (!isCurrent()) return;
      setCurrentConversationState(full);
      setMessages(full.messages ?? []);
      setConversations((prev) => {
        const index = prev.findIndex((conversation) => conversation.id === full.id);
        if (index === -1) return [full, ...prev];
        return prev.map((conversation) => conversation.id === full.id ? full : conversation);
      });
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : 'Failed to load conversation');
    } finally {
      if (isCurrent()) setLoadingMessages(false);
    }
  }, [sessionKey, setError]);

  const loadConversation = useCallback(async (conv: Conversation | null) => {
    await loadConversationById(conv?.id ?? null, conv);
  }, [loadConversationById]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!sessionKey) {
      setLoadingConvs(false);
      setConversations([]);
      return;
    }
    loadConversations();
  }, [authLoading, sessionKey, loadConversations]);

  useEffect(() => {
    if (showConvModal && sessionKey && !authLoading) {
      loadConversations();
    }
  }, [showConvModal, sessionKey, authLoading, loadConversations]);

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
  }, [setError, setCurrentConversation]);

  const openConversationById = useCallback(
    async (conversationId: string) => {
      setShowConvModal(false);
      await loadConversationById(conversationId);
    },
    [loadConversationById]
  );

  const value: ConversationContextValue = {
    currentConversation,
    setCurrentConversation,
    conversations: conversations.filter((conversation) => conversation.source !== 'voice'),
    setConversations,
    messages,
    setMessages,
    loadingConvs,
    loadingMessages,
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
