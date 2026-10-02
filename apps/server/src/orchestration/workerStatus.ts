/**
 * workerStatus - how orchestrator workers look from their thread shells.
 *
 * Shared by the orchestrator MCP toolkit and the WorkerNudgeReactor so the
 * status an agent reads from list_workers is the status it gets nudged about.
 *
 * @module workerStatus
 */
import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/**
 * running: working on a turn. needs_user: waiting on the user to answer a
 * question or approval. idle: finished its last turn. error: its last turn or
 * session failed.
 */
export type WorkerStatus = "running" | "needs_user" | "idle" | "error";

export interface WorkerSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status: WorkerStatus;
  readonly worktreePath: string | null;
  readonly repos: ReadonlyArray<{
    readonly projectId: string;
    readonly worktreePath: string;
    readonly branch: string;
  }>;
  readonly lastError: string | null;
  readonly updatedAt: string;
  /** True when it works in an existing checkout rather than worktrees made for it. */
  readonly existingCheckout: boolean;
}

export interface PendingWorkerRequest {
  readonly kind: "question" | "approval";
  readonly detail: string;
}

/** Activity kinds that open or close a request for the user. */
export const REQUEST_ACTIVITY_KINDS: ReadonlyArray<string> = [
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
];

/**
 * A worker's status from its shell. Between dispatching a turn and the
 * session reporting "running" the shell still looks idle, so a user message
 * newer than the latest turn counts as running, unless the session was
 * interrupted or stopped after that message (the turn never started).
 */
export function workerStatusOf(shell: OrchestrationThreadShell): WorkerStatus {
  if (shell.hasPendingUserInput || shell.hasPendingApprovals) return "needs_user";
  const session = shell.session;
  if (session?.status === "running" || session?.status === "starting") return "running";
  const latestTurn = shell.latestTurn;
  if (latestTurn?.state === "running") return "running";
  const sentAt = shell.latestUserMessageAt;
  const settledAfterMessage = session !== null && (sentAt === null || session.updatedAt >= sentAt);
  if (session?.status === "error" && settledAfterMessage) return "error";
  const turnAt = latestTurn ? (latestTurn.completedAt ?? latestTurn.requestedAt) : null;
  const messageAfterTurn = sentAt !== null && (turnAt === null || sentAt > turnAt);
  // "ready" is not enough here: a fresh session reports ready before its
  // first turn starts. Only an interrupt or stop proves the turn never will.
  const abandoned =
    settledAfterMessage && (session?.status === "interrupted" || session?.status === "stopped");
  if (messageAfterTurn && !abandoned) return "running";
  return latestTurn?.state === "error" ? "error" : "idle";
}

export function summarizeWorker(shell: OrchestrationThreadShell): WorkerSummary {
  const orchestration = shell.orchestration?.role === "worker" ? shell.orchestration : null;
  const existing = orchestration?.workspace === "existing";
  return {
    threadId: shell.id,
    title: shell.title,
    status: workerStatusOf(shell),
    // A worker in the project checkout has no worktree path of its own.
    worktreePath:
      shell.worktreePath ?? (existing ? (orchestration.repos[0]?.worktreePath ?? null) : null),
    repos: (orchestration?.repos ?? []).map((repo) => ({
      projectId: repo.projectId,
      worktreePath: repo.worktreePath,
      branch: repo.branch,
    })),
    lastError: shell.session?.lastError ?? null,
    updatedAt: shell.updatedAt,
    existingCheckout: existing,
  };
}

/** A worker whose created workspace was removed; borrowed checkouts never are. */
export const workspaceRemoved = (shell: OrchestrationThreadShell) =>
  shell.orchestration?.role === "worker" &&
  shell.orchestration.workspace !== "existing" &&
  shell.worktreePath === null;

export const isWorkerOf = (parentThreadId: ThreadId) => (shell: OrchestrationThreadShell) =>
  shell.orchestration?.role === "worker" && shell.orchestration.parentThreadId === parentThreadId;

/** Open questions and approvals, oldest first, as text the orchestrator can relay. */
export function pendingWorkerRequests(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PendingWorkerRequest> {
  const requestIdOf = (activity: OrchestrationThreadActivity) =>
    Predicate.isObject(activity.payload) && typeof activity.payload.requestId === "string"
      ? activity.payload.requestId
      : null;
  const closed = new Set(
    activities
      .filter((activity) => activity.kind.endsWith(".resolved"))
      .map(requestIdOf)
      .filter(Predicate.isNotNull),
  );
  return activities.flatMap((activity): ReadonlyArray<PendingWorkerRequest> => {
    const requestId = requestIdOf(activity);
    if (requestId === null || closed.has(requestId)) return [];
    const payload = activity.payload as Record<string, unknown>;
    if (activity.kind === "user-input.requested" && Array.isArray(payload.questions)) {
      const detail = payload.questions
        .filter(Predicate.isObject)
        .map((question) => {
          const options = Array.isArray(question.options)
            ? question.options
                .filter(Predicate.isObject)
                .map((option) => String(option.label ?? ""))
                .filter((label) => label.length > 0)
            : [];
          const text = String(question.question ?? question.header ?? "");
          return options.length > 0 ? `${text} (options: ${options.join(" / ")})` : text;
        })
        .join("\n");
      return [{ kind: "question", detail }];
    }
    if (activity.kind === "approval.requested") {
      const detail =
        typeof payload.detail === "string" && payload.detail ? payload.detail : activity.summary;
      return [{ kind: "approval", detail }];
    }
    return [];
  });
}

/** The thread an event belongs to when it can change a worker's status. */
export function statusEventThreadId(event: OrchestrationEvent): ThreadId | null {
  if (event.type === "thread.session-set") return event.payload.threadId;
  if (
    event.type === "thread.activity-appended" &&
    REQUEST_ACTIVITY_KINDS.includes(event.payload.activity.kind)
  ) {
    return event.payload.threadId;
  }
  return null;
}
