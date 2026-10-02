/**
 * WorkerNudgeReactor - tells orchestrator chats when their workers stop.
 *
 * When a worker finishes, fails, or starts waiting on the user, the reactor
 * starts a turn in its orchestrator chat describing that. An orchestrator that
 * is busy (running or itself waiting on the user) keeps the news until it is
 * idle, and everything that piled up arrives as one turn. This is what lets
 * the orchestrator end its turn after spawning workers instead of blocking.
 *
 * Only orchestrator threads are ever nudged, so nudges cannot loop.
 *
 * @module WorkerNudgeReactor
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  pendingWorkerRequests,
  REQUEST_ACTIVITY_KINDS,
  statusEventThreadId,
  workerStatusOf,
  type WorkerStatus,
} from "./workerStatus.ts";

export class WorkerNudgeReactor extends Context.Service<
  WorkerNudgeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every event at or before `sequence` has been handled. */
    readonly drainThrough: (sequence: number) => Effect.Effect<void>;
  }
>()("t3/orchestration/WorkerNudgeReactor") {}

const REPLY_CHARS = 2000;

/** One worker's line in a nudge, or null when it is running again and has no news. */
const describeWorker = Effect.fn("WorkerNudgeReactor.describeWorker")(function* (
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
  shell: OrchestrationThreadShell,
) {
  const status = workerStatusOf(shell);
  if (status === "running") return null;
  const head = `- "${shell.title}" (${shell.id})`;
  const detail = yield* snapshots
    .getThreadDetailById(shell.id, { activityKinds: REQUEST_ACTIVITY_KINDS })
    .pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  if (status === "needs_user") {
    const requests = detail ? pendingWorkerRequests(detail.activities) : [];
    const asks = requests.map((request) => `  ${request.kind}: ${request.detail}`).join("\n");
    return `${head} needs the user.${asks ? `\n${asks}` : ""}`;
  }
  const reply = detail?.messages.findLast((message) => message.role === "assistant")?.text;
  const tail =
    reply === undefined
      ? ""
      : `\n  Latest reply${reply.length > REPLY_CHARS ? " (end)" : ""}:\n${reply.slice(-REPLY_CHARS)}`;
  if (status === "error") {
    const error = shell.session?.lastError;
    return `${head} failed${error ? `: ${error}` : "."}${tail}`;
  }
  return `${head} finished.${tail}`;
});

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  // Both maps are only touched from the single worker fiber. They live in
  // memory: transitions that happen while the server is down are not replayed.
  const lastStatus = new Map<ThreadId, WorkerStatus>();
  const pending = new Map<ThreadId, Set<ThreadId>>();

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const flush = Effect.fn("WorkerNudgeReactor.flush")(function* (orchestratorId: ThreadId) {
    const workerIds = pending.get(orchestratorId);
    if (workerIds === undefined || workerIds.size === 0) return;
    const orchestrator = yield* readShell(orchestratorId);
    if (orchestrator === undefined || orchestrator.archivedAt !== null) {
      pending.delete(orchestratorId);
      return;
    }
    const orchestratorStatus = workerStatusOf(orchestrator);
    if (orchestratorStatus === "running" || orchestratorStatus === "needs_user") return;
    pending.delete(orchestratorId);

    const lines: Array<string> = [];
    for (const workerId of workerIds) {
      const worker = yield* readShell(workerId);
      if (worker === undefined) continue;
      const line = yield* describeWorker(snapshots, worker);
      if (line !== null) lines.push(line);
    }
    if (lines.length === 0) return;

    const text = [
      "[Worker update from T3 Code — automatic message, not typed by the user]",
      ...lines,
      "Use get_worker for details. Questions and approvals are the user's to answer.",
    ].join("\n");
    const id = yield* uuid;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:worker-nudge:${orchestratorId}:${id}`),
      threadId: orchestratorId,
      message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
      runtimeMode: orchestrator.runtimeMode,
      interactionMode: orchestrator.interactionMode,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const process = Effect.fn("WorkerNudgeReactor.process")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.deleted") {
      lastStatus.delete(event.payload.threadId);
      pending.delete(event.payload.threadId);
      return;
    }
    const threadId = statusEventThreadId(event);
    if (threadId === null) return;
    const shell = yield* readShell(threadId);
    const orchestration = shell?.orchestration;
    if (shell === undefined || !orchestration) return;
    if (orchestration.role === "orchestrator") {
      yield* flush(shell.id);
      return;
    }
    const status = workerStatusOf(shell);
    const previous = lastStatus.get(shell.id);
    lastStatus.set(shell.id, status);
    if (status === "running" || status === previous) return;
    const workers = pending.get(orchestration.parentThreadId) ?? new Set<ThreadId>();
    workers.add(shell.id);
    pending.set(orchestration.parentThreadId, workers);
    yield* flush(orchestration.parentThreadId);
  });

  const processSafely = (event: OrchestrationEvent) =>
    process(event).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("worker nudge reactor failed to process event", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  // Seed with every worker's current status so a restart does not re-announce
  // states the orchestrator already heard about.
  const seed = snapshots.getShellSnapshot().pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        for (const shell of snapshot.threads) {
          if (shell.orchestration?.role === "worker" && !lastStatus.has(shell.id)) {
            lastStatus.set(shell.id, workerStatusOf(shell));
          }
        }
      }),
    ),
    Effect.ignore,
  );

  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start = Effect.fn("WorkerNudgeReactor.start")(function* () {
    // Seed before forking: a worker that changes after this point must still
    // count as a change once its event arrives.
    yield* seed;
    yield* forkParked(
      Stream.runForEach(
        engine.streamDomainEvents.pipe(
          // Events that landed before the subscription are not replayed, so
          // start the watermark at the current head instead of zero.
          Stream.onStart(engine.latestSequence.pipe(Effect.flatMap(noteSeen))),
        ),
        (event) => worker.enqueue(event).pipe(Effect.andThen(noteSeen(event.sequence))),
      ),
    );
  });

  const drainThrough = Effect.fn("WorkerNudgeReactor.drainThrough")(function* (sequence: number) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= sequence),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return WorkerNudgeReactor.of({ start, drainThrough });
});

export const layer = Layer.effect(WorkerNudgeReactor, make);
