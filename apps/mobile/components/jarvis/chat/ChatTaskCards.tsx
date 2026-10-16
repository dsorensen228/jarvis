import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  cancelCodeTask,
  cancelResearchTask,
  getCodeTask,
  getResearchTask,
  getCodeTaskOutput,
  getResearchTaskOutput,
  getResearchReport,
  type CodeTask,
  type CodeTaskOutput,
  type ResearchTask,
} from "@/lib/api-client";
import { isTaskAtLeastAsNew, mergeOutput, taskResult } from "@/lib/codeTaskState";
import { ResearchReportView } from "../ResearchReportView";
import { Sheet, type ToolActivity } from "./ChatPrimitives";
import { useChatTheme } from "./chatTheme";

type TaskRef = { kind: "research" | "code"; task: ResearchTask | CodeTask };
const activeStatuses = new Set([
  "pending",
  "queued",
  "running",
  "cancel_requested",
]);
function getTasks(tools: ToolActivity[]): TaskRef[] {
  const unique = new Map<string, TaskRef>();
  for (const tool of tools) {
    if (
      !/^(create|get|list|cancel|follow_up)_(research|code)_tasks?$/.test(
        tool.name,
      ) ||
      !tool.result
    )
      continue;
    const kind = tool.name.includes("research") ? "research" : "code";
    const result = tool.result as any;
    const tasks = Array.isArray(result)
      ? result
      : Array.isArray(result.items)
        ? result.items
        : [result];
    for (const task of tasks)
      if (typeof task?.id === "string" && typeof task?.status === "string")
        unique.set(`${kind}:${task.id}`, { kind, task });
  }
  return [...unique.values()];
}
export function ChatTaskCards({ tools }: { tools: ToolActivity[] }) {
  const tasks = useMemo(() => getTasks(tools), [tools]);
  return (
    <View style={{ gap: tasks.length ? 10 : 0 }}>
      {tasks.map((item) => (
        <TaskCard key={`${item.kind}:${item.task.id}`} initial={item} />
      ))}
    </View>
  );
}
function TaskCard({ initial }: { initial: TaskRef }) {
  const t = useChatTheme();
  const { height } = useWindowDimensions();
  const [task, setTask] = useState(initial.task);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [output, setOutput] = useState<CodeTaskOutput[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportAttempt, setReportAttempt] = useState(0);
  const kind = initial.kind;
  const active = activeStatuses.has(task.status);
  const result = taskResult(task);
  const update = (next: typeof task) =>
    setTask((previous) =>
      isTaskAtLeastAsNew(next, previous) ? next : previous,
    );
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!alive) return;
      if (AppState.currentState === "background") {
        timer = setTimeout(refresh, 5000);
        return;
      }
      try {
        const next =
          kind === "research"
            ? await getResearchTask(initial.task.id)
            : await getCodeTask(initial.task.id);
        if (!alive) return;
        update(next);
        setError(null);
        if (activeStatuses.has(next.status)) timer = setTimeout(refresh, 4000);
      } catch (failure) {
        if (alive) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not refresh task.",
          );
          timer = setTimeout(refresh, 15000);
        }
      }
    };
    void refresh();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [initial.task.id, kind]);
  useEffect(() => {
    if (!expanded) return;
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOutput([]);
    setTruncated(false);
    const refresh = async () => {
      try {
        const page =
          kind === "research"
            ? await getResearchTaskOutput(task.id, after)
            : await getCodeTaskOutput(task.id, after);
        if (stopped || page.task.id !== task.id) return;
        after = Math.max(after, page.next_after);
        update(page.task);
        setError(null);
        setOutput((previous) => mergeOutput(previous, page.items));
        setTruncated((previous) => previous || page.truncated);
        if (page.has_more || activeStatuses.has(page.task.status))
          timer = setTimeout(refresh, page.has_more ? 50 : 2000);
      } catch (failure) {
        if (!stopped) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load task activity.",
          );
          timer = setTimeout(refresh, 6000);
        }
      }
    };
    void refresh();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [expanded, task.id, kind]);
  useEffect(() => {
    if (!reportOpen) return;
    let alive = true;
    setReportHtml(null);
    setReportError(null);
    getResearchReport(task.id)
      .then((report) => {
        if (!alive) return;
        if (report.task_id !== task.id || !report.html.trim())
          throw new Error("Report is not available yet.");
        setReportHtml(report.html);
      })
      .catch((failure) => {
        if (alive)
          setReportError(
            failure instanceof Error
              ? failure.message
              : "Could not open report.",
          );
      });
    return () => {
      alive = false;
    };
  }, [reportOpen, task.id, reportAttempt]);
  const cancel = async () => {
    setCancelling(true);
    try {
      update(
        kind === "research"
          ? await cancelResearchTask(task.id)
          : await cancelCodeTask(task.id),
      );
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to cancel task.",
      );
    } finally {
      setCancelling(false);
    }
  };
  const status =
    task.status === "success"
      ? "Complete"
      : task.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const statusColor =
    task.status === "failed"
      ? t.error
      : active
        ? t.purple
        : task.status === "cancelled"
          ? t.muted
          : t.green;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${kind === "research" ? "Research" : "Code Factory"} task: ${task.prompt}. ${status}`}
        onPress={() => setExpanded(true)}
        style={[s.card, { backgroundColor: t.panel, borderColor: t.line }]}
      >
        <View style={[s.icon, { backgroundColor: t.inset }]}>
          <Ionicons
            name={
              kind === "research" ? "telescope-outline" : "code-slash-outline"
            }
            size={21}
            color={t.purple}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={s.row}>
            <Text style={[s.kind, { color: t.muted }]}>
              {kind === "research" ? "RESEARCH" : "CODE FACTORY"}
            </Text>
            {active && <ActivityIndicator size={11} color={t.purple} />}
            <Text style={{ color: statusColor, fontSize: 10 }}>{status}</Text>
          </View>
          <Text
            numberOfLines={2}
            style={{ color: t.ink, fontSize: 13, lineHeight: 19 }}
          >
            {task.prompt}
          </Text>
          {error && (
            <Text numberOfLines={1} style={{ color: t.error, fontSize: 10 }}>
              Status unavailable · tap for details
            </Text>
          )}
        </View>
        <Ionicons name="chevron-forward" size={15} color={t.muted} />
      </Pressable>
      <Sheet
        visible={expanded}
        onClose={() => setExpanded(false)}
        title={kind === "research" ? "Research task" : "Code Factory task"}
        wide
      >
        <ScrollView contentContainerStyle={{ gap: 16 }}>
          <Text
            selectable
            style={{
              color: t.ink,
              fontSize: 17,
              fontWeight: "500",
              lineHeight: 25,
            }}
          >
            {task.prompt}
          </Text>
          <View style={s.row}>
            <View style={[s.badge, { backgroundColor: t.inset }]}>
              <Text style={{ color: statusColor, fontSize: 12 }}>{status}</Text>
            </View>
            <Text style={{ color: t.muted, fontSize: 11 }}>{task.model}</Text>
            {active && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel task"
                disabled={cancelling || task.status === "cancel_requested"}
                onPress={() => {
                  void cancel();
                }}
                style={[s.badge, { backgroundColor: t.inset }]}
              >
                <Text style={{ color: t.error, fontSize: 12 }}>
                  {cancelling ? "Cancelling…" : "Cancel task"}
                </Text>
              </Pressable>
            )}
          </View>
          {(error || task.error) && (
            <Text
              selectable
              style={{ color: t.error, fontSize: 12, lineHeight: 19 }}
            >
              {error || task.error}
            </Text>
          )}
          {kind === "research" && (task as ResearchTask).report_available && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open research report"
              onPress={() => {
                setExpanded(false);
                setReportOpen(true);
              }}
              style={[s.reportButton, { backgroundColor: t.accent }]}
            >
              <Ionicons name="document-text-outline" color="#fff" size={18} />
              <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                Open report
              </Text>
            </Pressable>
          )}
          {!!task.changed_paths?.length && (
            <View style={{ gap: 5 }}>
              <Text style={{ color: t.muted, fontSize: 11 }}>
                CHANGED FILES
              </Text>
              {task.changed_paths.map((path) => (
                <Text
                  selectable
                  key={path}
                  style={{ color: t.ink, fontSize: 12 }}
                >
                  {path}
                </Text>
              ))}
            </View>
          )}
          {!!result && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: t.muted, fontSize: 11 }}>RESULT</Text>
              <Text
                selectable
                style={{ color: t.ink, fontSize: 13, lineHeight: 21 }}
              >
                {result}
              </Text>
            </View>
          )}
          {truncated && (
            <Text style={{ color: t.muted, fontSize: 11 }}>
              Showing recent activity.
            </Text>
          )}
          {output.length ? (
            output.map((item) => (
              <View
                key={item.seq}
                style={[s.output, { backgroundColor: t.inset }]}
              >
                <Text
                  style={{
                    color: t.muted,
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                  }}
                >
                  {item.kind}
                </Text>
                <Text
                  selectable
                  style={{
                    color: item.kind === "error" ? t.error : t.ink,
                    fontSize: 12,
                    lineHeight: 19,
                  }}
                >
                  {item.text}
                </Text>
              </View>
            ))
          ) : task.stdout ? (
            <Text
              selectable
              style={{ color: t.ink, fontSize: 12, lineHeight: 19 }}
            >
              {task.stdout.slice(-20000)}
            </Text>
          ) : active ? (
            <ActivityIndicator color={t.purple} style={{ margin: 12 }} />
          ) : null}
        </ScrollView>
      </Sheet>
      <Sheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Research report"
        wide
      >
        <View style={{ height: Math.min(height * 0.7, 760), flexShrink: 1, minHeight: 0 }}>
          {reportError ? (
            <View style={{ gap: 16, padding: 20 }}>
              <Text style={{ color: t.error }}>{reportError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setReportAttempt((previous) => previous + 1)}
              >
                <Text style={{ color: t.purple }}>Try again</Text>
              </Pressable>
            </View>
          ) : reportHtml ? (
            <ResearchReportView html={reportHtml} />
          ) : (
            <ActivityIndicator color={t.purple} style={{ margin: 35 }} />
          )}
        </View>
      </Sheet>
    </>
  );
}
const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  kind: { fontSize: 9, letterSpacing: 1.4, marginRight: 4 },
  badge: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8 },
  reportButton: {
    borderRadius: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  output: { padding: 12, borderRadius: 10, gap: 8 },
});
