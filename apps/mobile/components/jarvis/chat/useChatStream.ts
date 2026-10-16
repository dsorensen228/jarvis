import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConversation,
  postMessageStream,
  type Conversation,
  type Message,
  type MessageAttachmentRef,
} from "@/lib/api-client";
import { useAuth } from "../../../contexts/AuthContext";
import { useConversation } from "../../../contexts/ConversationContext";
import { type ToolActivity } from "./ChatPrimitives";

type Outgoing = { text: string; attachments?: MessageAttachmentRef[] };
type Turn = {
  controller: AbortController;
  account: string;
  conversationId: string | null;
};

export function useChatStream() {
  const context = useConversation();
  const { accessToken, user } = useAuth();
  const account = accessToken ? (user?.id ?? accessToken) : null;
  const selectedId = context.currentConversation?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [phase, setPhase] = useState("Thinking");
  const [startedAt, setStartedAt] = useState<number>();
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<Turn | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  const latest = useRef({ context, account, selectedId });
  latest.current = { context, account, selectedId };

  const owns = useCallback(
    (turn: Turn) =>
      alive.current &&
      active.current === turn &&
      latest.current.account === turn.account &&
      latest.current.selectedId === turn.conversationId,
    [],
  );
  const clear = useCallback(() => {
    setAnswer("");
    setTools([]);
    setNotice(null);
    setStartedAt(undefined);
    setPhase("Thinking");
  }, []);
  const reset = useCallback(() => {
    // The lazy-created conversation acquires its ID during this same active turn.
    if (active.current && owns(active.current)) return;
    clear();
  }, [clear, owns]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const previous = active.current;
      active.current = null;
      previous?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const turn = active.current;
    if (turn && owns(turn)) return;
    // Session refresh retains the account key. Actual navigation/account changes invalidate it.
    active.current = null;
    turn?.controller.abort();
    setBusy(false);
    clear();
  }, [account, selectedId, clear, owns]);

  const send = async ({ text, attachments }: Outgoing): Promise<boolean> => {
    const initial = latest.current;
    if (
      active.current ||
      !initial.account ||
      (!text.trim() && !attachments?.length)
    )
      return false;
    const turn: Turn = {
      controller: new AbortController(),
      account: initial.account,
      conversationId: initial.selectedId,
    };
    active.current = turn;
    let accepted = false;
    let savedUserId: string | undefined;
    let partialText = "";
    let partialTools: ToolActivity[] = [];
    let assistantReceived = false;
    let finished = false;
    const oldMessageIds = new Set(
      initial.context.messages.map((message) => message.id).filter(Boolean),
    );
    const optimisticId = `pending-${Date.now()}-${++sequence.current}`;
    const optimistic: Message = {
      id: optimisticId,
      role: "user",
      content: text,
      attachments,
      created_at: new Date().toISOString(),
    };
    setBusy(true);
    setAnswer("");
    setTools([]);
    setPhase("Connecting");
    setNotice(null);
    setStartedAt(Date.now());
    initial.context.setError(null);
    initial.context.setMessages((previous) => [...previous, optimistic]);

    const updateConversation = (conversation: Conversation) => {
      turn.conversationId = conversation.id;
      // Adopt the server-created ID before React renders or another event arrives in this chunk.
      latest.current.selectedId = conversation.id;
      latest.current.context.setCurrentConversation(conversation);
      latest.current.context.setConversations((previous) => [
        conversation,
        ...previous.filter((item) => item.id !== conversation.id),
      ]);
    };
    const appendMessage = (message: Message) => {
      latest.current.context.setMessages((previous) => [
        ...previous.filter(
          (item) =>
            item.id !== message.id &&
            !(message.role === "user" && item.id === optimisticId),
        ),
        message,
      ]);
    };

    try {
      await postMessageStream(turn.conversationId ?? undefined, text, {
        attachments,
        signal: turn.controller.signal,
        onEvent: (event) => {
          if (!owns(turn) || turn.controller.signal.aborted) return;
          switch (event.type) {
            case "conversation.updated":
              // The canonical API emits this after saving the user turn, before message.created.
              accepted = true;
              updateConversation(event.data);
              break;
            case "response.status":
              setPhase(event.data.label || "Thinking");
              break;
            case "response.reasoning.delta":
              setPhase("Thinking through your request");
              break;
            case "response.text.delta":
              partialText += event.data.text;
              setPhase("Writing response");
              setAnswer((previous) => previous + event.data.text);
              break;
            case "message.created":
              if (event.data.role === "user") {
                accepted = true;
                savedUserId = event.data.id;
              }
              if (event.data.role === "assistant") {
                assistantReceived = true;
                setAnswer("");
                setTools([]);
              }
              appendMessage(event.data);
              break;
            case "tool.started":
              partialText = "";
              partialTools = [
                ...partialTools.filter((tool) => tool.id !== event.data.id),
                { ...event.data, status: "running" },
              ];
              setAnswer("");
              setTools((previous) => [
                ...previous.filter((tool) => tool.id !== event.data.id),
                { ...event.data, status: "running" },
              ]);
              break;
            case "tool.finished":
              partialTools = partialTools.some((tool) => tool.id === event.data.id)
                ? partialTools.map((tool) =>
                    tool.id === event.data.id ? { ...tool, ...event.data } : tool,
                  )
                : [...partialTools, event.data];
              setTools((previous) =>
                previous.some((tool) => tool.id === event.data.id)
                  ? previous.map((tool) =>
                      tool.id === event.data.id
                        ? { ...tool, ...event.data }
                        : tool,
                    )
                  : [...previous, event.data],
              );
              break;
            case "response.done":
              if (event.data.conversation)
                updateConversation(event.data.conversation);
              break;
          }
        },
      });
      if (!owns(turn)) return true;
      finished = true;
      setAnswer("");
      setTools([]);
      return true;
    } catch (error) {
      // A superseded turn must never restore its draft into another conversation/account.
      if (!owns(turn)) return true;
      // message.created is the durable final answer, even if the trailing done frame is lost.
      if (assistantReceived) {
        finished = true;
        return true;
      }
      const stopped = turn.controller.signal.aborted;
      const rejected =
        error instanceof Error &&
        error.name === "ChatStreamHttpError" &&
        "status" in error &&
        [400, 401, 403, 404, 422].includes(Number(error.status));
      let checkedHistory = false;
      if (!rejected && turn.conversationId) {
        let recoveryTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          // Stop can beat the server's cancellation cleanup. Recover what is
          // already durable, but do not hold the composer behind a slow GET.
          const full = await Promise.race([
            getConversation(turn.conversationId),
            new Promise<never>((_, reject) => {
              recoveryTimeout = setTimeout(
                () => reject(new Error("History recovery timed out")),
                2000,
              );
            }),
          ]);
          if (!owns(turn)) return true;
          checkedHistory = true;
          const savedIndex = (full.messages ?? []).findIndex(
            (message) =>
              message.role === "user" &&
              (savedUserId
                ? message.id === savedUserId
                : message.content === text &&
                  !!message.id &&
                  !oldMessageIds.has(message.id)),
          );
          accepted ||= savedIndex >= 0;
          if (savedIndex >= 0) {
            updateConversation(full);
            latest.current.context.setMessages(full.messages ?? []);
            const savedAssistant = full.messages?.[savedIndex + 1];
            if (savedAssistant?.role === "assistant") {
              finished = true;
              setAnswer("");
              setTools([]);
              setNotice(null);
              return true;
            }
          }
        } catch {
          // Preserve a local snapshot below if durable cleanup is still pending.
          // Never automatically replay a POST whose delivery is uncertain.
        } finally {
          if (recoveryTimeout) clearTimeout(recoveryTimeout);
        }
      }
      if (!owns(turn)) return true;
      if (!stopped)
        latest.current.context.setError(
          error instanceof Error
            ? error.message
            : "The connection was interrupted.",
        );
      if (accepted) {
        if (partialText || partialTools.length) {
          const interruptedTools = partialTools.map((tool) =>
            tool.status === "running"
              ? { ...tool, status: "interrupted" as const }
              : tool,
          );
          const warning =
            "Response interrupted." +
            (interruptedTools.length
              ? " Tool actions may still finish. Check activity before retrying."
              : "");
          const snapshot: Message = {
            id: `interrupted-${optimisticId}`,
            conversation_id: turn.conversationId ?? undefined,
            role: "assistant",
            content: [partialText.trim(), warning].filter(Boolean).join("\n\n"),
            created_at: new Date().toISOString(),
            tool_calls: interruptedTools,
          };
          // The next send clears live state. Keep this explicitly interrupted
          // snapshot in the transcript until canonical history replaces it.
          appendMessage(snapshot);
          setAnswer("");
          setTools([]);
        }
        setNotice(
          stopped
            ? "Response stopped. Tool actions may still finish."
            : "Response interrupted. Your message was saved. Check activity before retrying.",
        );
      } else {
        latest.current.context.setMessages((previous) =>
          previous.filter((message) => message.id !== optimisticId),
        );
        setNotice(
          rejected || checkedHistory
            ? stopped
              ? "Response stopped. Your draft has been restored."
              : "Your message could not be sent. Your draft has been restored."
            : "Delivery could not be confirmed. Your draft has been restored; check your history before sending it again.",
        );
      }
      return accepted;
    } finally {
      // A late abort/reconciliation from an old turn cannot release a newer turn's controls.
      if (active.current === turn) {
        active.current = null;
        if (alive.current) {
          setBusy(false);
          if (!finished)
            setTools((previous) =>
              previous.map((tool) =>
                tool.status === "running"
                  ? { ...tool, status: "interrupted" }
                  : tool,
              ),
            );
        }
      }
    }
  };

  const stop = useCallback(() => {
    if (!active.current) return;
    active.current.controller.abort();
    setPhase("Stopping");
  }, []);
  return {
    busy,
    answer,
    tools,
    phase,
    startedAt,
    notice,
    send,
    stop,
    reset,
    clearNotice: () => setNotice(null),
  };
}
