/**
 * Workers right-panel surface: an orchestrator chat's worker threads.
 *
 * Rows read thread shells only. A worker's detail (its latest reply and the
 * questions it is waiting on) is subscribed lazily: while it needs the user,
 * or while its row is expanded. Questions and approvals are answered here with
 * the same commands the worker's own composer uses, against the worker's id.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ApprovalRequestId,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
  ScopedThreadRef,
  ThreadOrchestrationWorkerRepo,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SquareIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useThread, useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { buildThreadRouteParams } from "../threadRoutes";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

const SNIPPET_CHARS = 600;

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

function formatElapsed(fromIso: string, toIso: string | null): string {
  const start = Date.parse(fromIso);
  const end = toIso ? Date.parse(toIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function repoLabel(repo: ThreadOrchestrationWorkerRepo): string {
  const name = repo.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? repo.repoRoot;
  return `${name} · ${repo.branch}`;
}

const isWorkerOf = (threadRef: ScopedThreadRef) => (shell: OrchestrationThreadShell) =>
  shell.orchestration?.role === "worker" &&
  shell.orchestration.parentThreadId === threadRef.threadId;

export function WorkersPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shells = useThreadShells();
  const [showArchived, setShowArchived] = useState(false);
  const workers = useMemo(
    () =>
      shells
        .filter(
          (shell) =>
            shell.environmentId === threadRef.environmentId &&
            shell.archivedAt === null &&
            isWorkerOf(threadRef)(shell),
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [shells, threadRef],
  );
  const archivedToggle = (
    <Button size="xs" variant="ghost-muted" onClick={() => setShowArchived((value) => !value)}>
      {showArchived ? <ChevronDownIcon /> : <ChevronRightIcon />}
      Archived workers
    </Button>
  );

  if (workers.length === 0 && !showArchived) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <WorkflowIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No workers yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Ask this chat to plan the work. Once you approve, it starts worker threads in their own
          worktrees and they show up here.
        </p>
        {archivedToggle}
      </div>
    );
  }

  const waiting = workers.filter(
    (worker) => worker.hasPendingUserInput || worker.hasPendingApprovals,
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          {workers.map((worker) => (
            <WorkerRow key={worker.id} worker={worker} />
          ))}
          <div>{archivedToggle}</div>
          {showArchived ? <ArchivedWorkers threadRef={threadRef} /> : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
        <span>
          {workers.length} worker{workers.length === 1 ? "" : "s"}
        </span>
        {waiting.length > 0 ? (
          <span className="font-medium text-info-foreground">{waiting.length} waiting on you</span>
        ) : null}
      </footer>
    </div>
  );
}

/**
 * Archived workers that still hold a workspace, so it stays removable after
 * archiving. Loaded only while the section is open.
 */
function ArchivedWorkers({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentIds = useMemo(() => [threadRef.environmentId], [threadRef.environmentId]);
  const { snapshots, isLoading } = useArchivedThreadSnapshots(environmentIds);
  const archived = useMemo(
    () =>
      snapshots.flatMap((entry) =>
        entry.snapshot.threads
          .filter(
            (shell) =>
              isWorkerOf(threadRef)(shell) &&
              shell.worktreePath !== null &&
              shell.orchestration?.role === "worker" &&
              shell.orchestration.workspace !== "existing",
          )
          .map((shell): EnvironmentThreadShell => ({
            ...shell,
            environmentId: entry.environmentId,
          })),
      ),
    [snapshots, threadRef],
  );
  if (archived.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">
        {isLoading ? "Loading…" : "No archived workers with a workspace."}
      </p>
    );
  }
  return archived.map((worker) => <WorkerRow key={worker.id} worker={worker} />);
}

function WorkerRow({ worker }: { worker: EnvironmentThreadShell }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const removeWorkspace = useAtomCommand(threadEnvironment.removeWorkerWorkspace, {
    reportFailure: false,
  });
  const ref = useMemo(
    () => scopeThreadRef(worker.environmentId, worker.id),
    [worker.environmentId, worker.id],
  );
  const orchestration = worker.orchestration?.role === "worker" ? worker.orchestration : null;
  // Borrowed checkouts are never removed. A removed workspace leaves the repo
  // list behind, but its folders are gone.
  const existingCheckout = orchestration?.workspace === "existing";
  const repos =
    orchestration && (existingCheckout || worker.worktreePath !== null) ? orchestration.repos : [];
  const needsUser = worker.hasPendingUserInput || worker.hasPendingApprovals;
  const running = worker.session?.status === "running" || worker.session?.status === "starting";
  const pill = resolveThreadStatusPill({ thread: worker });
  const failed = worker.session?.status === "error" || worker.latestTurn?.state === "error";
  const label = pill?.label ?? (failed ? "Failed" : worker.latestTurn ? "Done" : "Idle");
  const dotClass =
    pill?.dotClass ??
    (failed ? "bg-destructive" : worker.latestTurn ? "bg-success" : "bg-muted-foreground/50");
  const elapsed = formatElapsed(worker.createdAt, running ? null : worker.updatedAt);

  const open = useCallback(() => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  }, [navigate, ref]);
  const interrupt = useCallback(async () => {
    const result = await interruptTurn({
      environmentId: worker.environmentId,
      input: { threadId: worker.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Couldn't stop the worker", squashAtomCommandFailure(result));
    }
  }, [interruptTurn, worker.environmentId, worker.id]);
  const remove = useCallback(async () => {
    const message = [
      `Delete the worktrees of "${worker.title}"?`,
      ...repos.map((repo) => repo.worktreePath),
      "",
      "Uncommitted changes in them are lost. Branches are kept.",
    ].join("\n");
    const api = readLocalApi();
    const confirmed = api ? await api.dialogs.confirm(message) : window.confirm(message);
    if (!confirmed) return;
    const result = await removeWorkspace({
      environmentId: worker.environmentId,
      input: { threadId: worker.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Couldn't remove the workspace", squashAtomCommandFailure(result));
    }
    // Archived rows come from a fetched snapshot, not the live shell stream.
    if (worker.archivedAt !== null) refreshArchivedThreadsForEnvironment(worker.environmentId);
  }, [removeWorkspace, repos, worker.archivedAt, worker.environmentId, worker.id, worker.title]);

  return (
    <section className="rounded-md border border-border/60 bg-card/30">
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide worker details" : "Show worker details"}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex shrink-0 items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </button>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
        <button
          type="button"
          onClick={open}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {worker.title}
        </button>
        <span className={cn("shrink-0 text-xs", pill?.colorClass ?? "text-muted-foreground")}>
          {label}
        </span>
        {elapsed ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{elapsed}</span>
        ) : null}
      </div>
      {repos.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1.5 pl-7 font-mono text-2xs text-muted-foreground">
          {repos.map((repo) => (
            <span key={repo.worktreePath} className="truncate">
              {repoLabel(repo)}
            </span>
          ))}
        </div>
      ) : null}
      {needsUser || expanded ? (
        <WorkerDetail threadRef={ref} worker={worker} repos={repos} expanded={expanded} />
      ) : null}
      <div className="flex items-center gap-1 border-t border-border/40 px-1.5 py-1">
        <Button size="xs" variant="ghost-muted" onClick={open}>
          <ArrowUpRightIcon />
          Open
        </Button>
        {running ? (
          <Button size="xs" variant="ghost-muted" onClick={() => void interrupt()}>
            <SquareIcon />
            Stop
          </Button>
        ) : null}
        {existingCheckout ? (
          <span className="ml-auto px-1.5 text-2xs text-muted-foreground">Existing checkout</span>
        ) : repos.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            className="ml-auto"
            onClick={() => void remove()}
          >
            <Trash2Icon />
            Remove workspace
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function WorkerDetail(props: {
  threadRef: ScopedThreadRef;
  worker: EnvironmentThreadShell;
  repos: ReadonlyArray<ThreadOrchestrationWorkerRepo>;
  expanded: boolean;
}) {
  const thread = useThread(props.threadRef);
  const pending = useMemo(
    () => (thread ? derivePendingRequests(thread.activities) : null),
    [thread],
  );
  const reply = useMemo(() => {
    const text = thread?.messages.findLast((message) => message.role === "assistant")?.text;
    if (!text) return null;
    return text.length > SNIPPET_CHARS ? `…${text.slice(-SNIPPET_CHARS)}` : text;
  }, [thread]);

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 pl-7">
      {pending && pending.approvals[0] ? (
        <WorkerApproval
          threadRef={props.threadRef}
          approval={pending.approvals[0]}
          pendingCount={pending.approvals.length}
        />
      ) : null}
      {pending && pending.userInputs.length > 0 ? (
        <WorkerQuestion
          key={pending.userInputs[0]!.requestId}
          threadRef={props.threadRef}
          pendingUserInputs={pending.userInputs}
        />
      ) : null}
      {props.expanded ? (
        <>
          {reply ? (
            <p className="line-clamp-6 whitespace-pre-wrap text-xs text-foreground/80">{reply}</p>
          ) : (
            <p className="text-xs text-muted-foreground">No reply yet.</p>
          )}
          {props.repos.length > 1
            ? props.repos.map((repo) => (
                <WorkerRepoChanges
                  key={repo.worktreePath}
                  environmentId={props.worker.environmentId}
                  repo={repo}
                />
              ))
            : null}
        </>
      ) : null}
    </div>
  );
}

/** Multi-repo workers have no per-turn diffs, so each repo's working tree is summarized here. */
function WorkerRepoChanges(props: {
  environmentId: EnvironmentThreadShell["environmentId"];
  repo: ThreadOrchestrationWorkerRepo;
}) {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: props.environmentId,
      input: { cwd: props.repo.worktreePath },
    }),
  );
  const tree = status.data?.workingTree;
  return (
    <div className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
      <span className="min-w-0 truncate">{repoLabel(props.repo)}</span>
      {tree ? (
        tree.files.length === 0 ? (
          <span className="ml-auto shrink-0">clean</span>
        ) : (
          <span className="ml-auto shrink-0 tabular-nums">
            {tree.files.length} file{tree.files.length === 1 ? "" : "s"}{" "}
            <span className="text-success">+{tree.insertions}</span>{" "}
            <span className="text-destructive">−{tree.deletions}</span>
          </span>
        )
      ) : null}
    </div>
  );
}

function WorkerApproval(props: {
  threadRef: ScopedThreadRef;
  approval: NonNullable<ReturnType<typeof derivePendingRequests>["approvals"][number]>;
  pendingCount: number;
}) {
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const onRespond = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      setResponding(true);
      const result = await respond({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, requestId, decision },
      });
      setResponding(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Couldn't send the approval", squashAtomCommandFailure(result));
      }
      return result;
    },
    [props.threadRef, respond],
  );
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/60 p-2">
      <ComposerPendingApprovalPanel approval={props.approval} pendingCount={props.pendingCount} />
      <div className="flex flex-wrap items-center justify-end gap-1">
        <ComposerPendingApprovalActions
          requestId={props.approval.requestId}
          isResponding={responding}
          options={props.approval.options}
          onRespondToApproval={onRespond}
        />
      </div>
    </div>
  );
}

function WorkerQuestion(props: {
  threadRef: ScopedThreadRef;
  pendingUserInputs: ReturnType<typeof derivePendingRequests>["userInputs"];
}) {
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const prompt = props.pendingUserInputs[0]!;
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [respondingIds, setRespondingIds] = useState<ApprovalRequestId[]>([]);
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;

  const submit = useCallback(async () => {
    const finalAnswers = buildPendingUserInputAnswers(prompt.questions, answers);
    if (finalAnswers === null) return;
    setRespondingIds((ids) => [...ids, prompt.requestId]);
    const result = await respond({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        requestId: prompt.requestId,
        answers: finalAnswers,
      },
    });
    setRespondingIds((ids) => ids.filter((id) => id !== prompt.requestId));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Couldn't send the answer", squashAtomCommandFailure(result));
    }
  }, [answers, prompt, props.threadRef, respond]);

  const advance = useCallback(() => {
    if (!progress.canAdvance) return;
    if (progress.isLastQuestion) void submit();
    else setQuestionIndex(progress.questionIndex + 1);
  }, [progress.canAdvance, progress.isLastQuestion, progress.questionIndex, submit]);

  const toggleOption = useCallback(
    (questionId: string, optionValue: string) => {
      const question = prompt.questions.find((entry) => entry.id === questionId);
      if (!question) return;
      setAnswers((current) => ({
        ...current,
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          current[questionId],
          optionValue,
        ),
      }));
    },
    [prompt.questions],
  );

  const onDismiss = useCallback(
    async (requestId: ApprovalRequestId) => {
      const result = await dismiss({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, requestId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Couldn't dismiss the question", squashAtomCommandFailure(result));
      }
    },
    [dismiss, props.threadRef],
  );

  const responding = respondingIds.includes(prompt.requestId);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/60 p-1">
      <ComposerPendingUserInputPanel
        pendingUserInputs={[...props.pendingUserInputs]}
        respondingRequestIds={respondingIds}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={toggleOption}
        onAdvance={advance}
        onDismiss={(requestId) => void onDismiss(requestId)}
      />
      <form
        className="flex items-center gap-1 px-1 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          advance();
        }}
      >
        {activeQuestion && activeQuestion.allowCustomAnswer !== false ? (
          <Input
            size="sm"
            placeholder="Type an answer…"
            aria-label="Answer"
            value={progress.customAnswer}
            disabled={responding}
            onChange={(event) => {
              const value = event.target.value;
              setAnswers((current) => ({
                ...current,
                [activeQuestion.id]: setPendingUserInputCustomAnswer(
                  current[activeQuestion.id],
                  value,
                ),
              }));
            }}
          />
        ) : (
          <span className="flex-1" />
        )}
        <Button type="submit" size="xs" disabled={!progress.canAdvance || responding}>
          {progress.isLastQuestion ? "Send" : "Next"}
        </Button>
      </form>
    </div>
  );
}
