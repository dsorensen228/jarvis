import type {
  ChatPostResponse,
  ChatStreamEvent,
  Conversation,
  Message,
} from "./types";

export interface ChatStreamRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
  transport: "fetch" | "xhr";
  timeoutMs?: number;
}

export function normalizeChatMessage(row: Record<string, any>): Message {
  const metadata = row.metadata ?? {};
  return {
    ...row,
    additional_info: metadata.additional_info ?? row.additional_info,
    source_agent: metadata.source_agent ?? row.source_agent,
    attachments: metadata.attachments ?? row.attachments,
    sources: metadata.sources ?? row.sources,
    tool_calls: metadata.tool_calls ?? row.tool_calls,
  } as Message;
}

export function normalizeChatConversation(
  row: Record<string, any>,
): Conversation {
  return {
    ...row,
    user_id: String(row.user_id || row.owner_id || ""),
    active_project_id: row.project_id == null ? null : String(row.project_id),
    messages: Array.isArray(row.messages)
      ? row.messages.map(normalizeChatMessage)
      : undefined,
  } as Conversation;
}

function abortError(): Error {
  const error = new Error("The response was stopped.");
  error.name = "AbortError";
  return error;
}

export class ChatStreamHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // A proxy can return plain text instead of the API's JSON error body.
    }
    super(`API ${status}: ${detail || "Unable to start the response"}`);
    this.name = "ChatStreamHttpError";
    this.status = status;
  }
}

const KNOWN_EVENTS = new Set([
  "conversation.updated",
  "message.created",
  "response.status",
  "response.text.delta",
  "response.reasoning.delta",
  "tool.started",
  "tool.finished",
  "response.done",
  "error",
]);

function decodeEvent(type: string, raw: string): ChatStreamEvent | null {
  // Ignore heartbeats and future optional event types without discarding known events.
  if (!KNOWN_EVENTS.has(type)) return null;
  let data: Record<string, any>;
  try {
    data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error();
  } catch {
    throw new Error("The server sent an invalid chat event. Please try again.");
  }
  switch (type) {
    case "conversation.updated":
      return { type, data: normalizeChatConversation(data) };
    case "message.created":
      return { type, data: normalizeChatMessage(data) };
    case "response.text.delta":
    case "response.reasoning.delta":
      if (typeof data.text !== "string")
        throw new Error("The server sent an invalid text update.");
      return { type, data: { text: data.text } };
    case "response.done":
      if (typeof data.conversation_id !== "string")
        throw new Error("The response has no conversation.");
      return {
        type,
        data: {
          conversation_id: data.conversation_id,
          message_id: data.message_id,
          conversation: data.conversation
            ? normalizeChatConversation(data.conversation)
            : undefined,
        },
      };
    case "error":
      return {
        type,
        data: {
          detail: String(data.detail || "Unable to complete the response."),
        },
      };
    case "tool.started":
    case "tool.finished":
      return {
        type,
        data: {
          id: String(data.id),
          name: String(data.name),
          status:
            data.status ?? (type === "tool.started" ? "running" : "completed"),
          arguments: data.arguments,
          result: data.result,
          duration_ms: data.duration_ms,
        },
      };
    case "response.status":
      return {
        type,
        data: { status: data.status, label: String(data.label || "Thinking") },
      };
    default:
      return null;
  }
}

/** Line-oriented parsing also handles CRLF split across network chunks. */
function eventParser(onEvent: (event: ChatStreamEvent) => void) {
  let line = "";
  let previousWasCR = false;
  let firstChunk = true;
  let eventType = "";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      const event = decodeEvent(eventType || "message", data.join("\n"));
      if (event) onEvent(event);
    }
    eventType = "";
    data = [];
  };
  const consumeLine = () => {
    if (!line) dispatch();
    else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventType = value;
      if (field === "data") data.push(value);
    }
    line = "";
  };
  return {
    push(chunk: string) {
      if (firstChunk && chunk.length) {
        chunk = chunk.replace(/^\uFEFF/, "");
        firstChunk = false;
      }
      for (const char of chunk) {
        if (char === "\n" && previousWasCR) {
          previousWasCR = false;
          continue;
        }
        previousWasCR = char === "\r";
        if (char === "\r" || char === "\n") consumeLine();
        else line += char;
      }
    },
    finish() {
      if (line) consumeLine();
      dispatch();
    },
  };
}

async function fetchStream(
  request: ChatStreamRequest,
  signal: AbortSignal,
  push: (text: string) => void,
) {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
  });
  if (!response.ok)
    throw new ChatStreamHttpError(response.status, await response.text());
  // A non-streaming fetch implementation may still consume this same response safely.
  // Never issue a second POST: the first request may already have saved a user turn.
  if (!response.body?.getReader) {
    push(await response.text());
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      push(decoder.decode(value, { stream: true }));
    }
    push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function xhrStream(
  request: ChatStreamRequest,
  signal: AbortSignal,
  push: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let offset = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      xhr.onprogress =
        xhr.onreadystatechange =
        xhr.onload =
        xhr.onerror =
        xhr.onabort =
          null;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      finish(abortError());
      xhr.abort();
    };
    const consume = () => {
      if (settled || xhr.status < 200 || xhr.status >= 300) return;
      try {
        const chunk = xhr.responseText.slice(offset);
        offset = xhr.responseText.length;
        if (chunk) push(chunk);
      } catch (error) {
        finish(error);
        xhr.abort();
      }
    };
    xhr.open("POST", request.url, true);
    xhr.responseType = "text";
    for (const [name, value] of Object.entries(request.headers))
      xhr.setRequestHeader(name, value);
    // Native fetch buffers the body. RN's XHR exposes cumulative responseText on progress.
    xhr.onprogress = consume;
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 3) consume();
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new ChatStreamHttpError(xhr.status, xhr.responseText));
        return;
      }
      consume();
      finish();
    };
    xhr.onerror = () => finish(new Error("Connection lost. Please try again."));
    xhr.onabort = () => finish(abortError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else xhr.send(request.body);
  });
}

/** One transport request, with no replay or blocking-chat fallback after a partial response. */
export async function requestChatStream(
  request: ChatStreamRequest,
): Promise<ChatPostResponse> {
  if (request.signal?.aborted) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? 600_000);
  let completed = false;
  const result: ChatPostResponse = { response: "" };
  const parser = eventParser((event) => {
    if (controller.signal.aborted) throw abortError();
    switch (event.type) {
      case "conversation.updated":
        result.conversation = event.data;
        result.conversation_id = event.data.id;
        break;
      case "message.created":
        if (event.data.conversation_id)
          result.conversation_id = event.data.conversation_id;
        if (event.data.role === "user") result.user_message = event.data;
        if (event.data.role === "assistant") {
          result.message = result.assistant_message = event.data;
          result.response = event.data.content;
        }
        break;
      case "response.text.delta":
        result.response += event.data.text;
        break;
      case "response.done":
        completed = true;
        result.conversation_id = event.data.conversation_id;
        if (event.data.conversation)
          result.conversation = event.data.conversation;
        break;
    }
    request.onEvent(event);
    if (event.type === "error") throw new Error(event.data.detail);
  });
  try {
    if (request.transport === "xhr")
      await xhrStream(request, controller.signal, parser.push);
    else await fetchStream(request, controller.signal, parser.push);
    if (controller.signal.aborted) throw abortError();
    parser.finish();
    if (!completed)
      throw new Error(
        "The response ended before it finished. Please try again.",
      );
    return result;
  } catch (error) {
    if (timedOut) throw new Error("The response timed out. Please try again.");
    if (controller.signal.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}
