import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as WorkerNudgeReactor from "./WorkerNudgeReactor.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:05:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const ORCHESTRATOR_ID = ThreadId.make("orchestrator-1");
const WORKER_ID = ThreadId.make("worker-1");
const SECOND_WORKER_ID = ThreadId.make("worker-2");
const PLAIN_ID = ThreadId.make("plain-1");

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++uuidCounter % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function session(
  threadId: ThreadId,
  status: OrchestrationSession["status"],
  updatedAt = NOW,
): OrchestrationSession {
  return {
    threadId,
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: status === "error" ? "provider crashed" : null,
    updatedAt,
  };
}

function makeShell(
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id,
    projectId: PROJECT_ID,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: "/wt",
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const worker = (id: ThreadId, overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeShell(id, {
    title: `Task ${id}`,
    orchestration: {
      role: "worker",
      parentThreadId: ORCHESTRATOR_ID,
      workspacePath: null,
      repos: [],
    },
    ...overrides,
  });

const orchestrator = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  makeShell(ORCHESTRATOR_ID, {
    orchestration: { role: "orchestrator" },
    session: session(ORCHESTRATOR_ID, "ready"),
    ...overrides,
  });

let sequence = 0;
function sessionSet(threadId: ThreadId): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type: "thread.session-set",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: LATER,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, session: session(threadId, "ready", LATER) },
  } as OrchestrationEvent;
}

const makeHarness = Effect.fn("makeWorkerNudgeHarness")(function* (
  initial: ReadonlyArray<OrchestrationThreadShell>,
  replies: Record<string, string> = {},
) {
  const shells = yield* Ref.make(new Map(initial.map((shell) => [shell.id, shell])));
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const events = yield* Queue.unbounded<OrchestrationEvent>();

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Ref.get(shells).pipe(Effect.map((current) => Option.fromNullishOr(current.get(threadId)))),
      getShellSnapshot: () =>
        Ref.get(shells).pipe(
          Effect.map((current) => ({
            snapshotSequence: 0,
            projects: [],
            threads: [...current.values()],
            updatedAt: NOW,
          })),
        ),
      getThreadDetailById: (threadId) =>
        Effect.succeedSome({
          messages:
            replies[threadId] === undefined ? [] : [{ role: "assistant", text: replies[threadId] }],
          activities: [
            {
              kind: "user-input.requested",
              payload: {
                requestId: "request-1",
                questions: [{ question: "Which database?", options: [{ label: "Postgres" }] }],
              },
            },
          ],
        } as never),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 0 })),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  // Built into the test's scope: the reactor's worker fiber lives as long as the test.
  const context = yield* Layer.build(WorkerNudgeReactor.layer.pipe(Layer.provide(dependencies)));
  const reactor = Context.get(context, WorkerNudgeReactor.WorkerNudgeReactor);
  yield* reactor.start();

  const update = (threadId: ThreadId, patch: Partial<OrchestrationThreadShell>) =>
    Ref.update(shells, (current) =>
      new Map(current).set(threadId, { ...current.get(threadId)!, ...patch }),
    );
  /** Applies the shell change, then delivers its session-set event and waits for the reactor. */
  const emit = (threadId: ThreadId, patch: Partial<OrchestrationThreadShell> = {}) =>
    Effect.gen(function* () {
      yield* update(threadId, patch);
      const event = sessionSet(threadId);
      yield* Queue.offer(events, event);
      yield* reactor.drainThrough(event.sequence);
    });
  const nudges = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.flatMap((command) =>
        command.type === "thread.turn.start" ? [command] : ([] as const),
      ),
    ),
  );
  return { emit, nudges };
});

const running = (id: ThreadId) => ({ session: session(id, "running", NOW) });
const finished = (id: ThreadId) => ({ session: session(id, "ready", LATER) });

describe("WorkerNudgeReactor", () => {
  it.effect("nudges an idle orchestrator once with the worker's reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([orchestrator(), worker(WORKER_ID, running(WORKER_ID))], {
        [WORKER_ID]: "Fixed the login bug on branch t3/abc.",
      });
      yield* harness.emit(WORKER_ID, finished(WORKER_ID));
      const nudges = yield* harness.nudges;
      expect(nudges).toHaveLength(1);
      expect(nudges[0]).toMatchObject({
        threadId: ORCHESTRATOR_ID,
        runtimeMode: "approval-required",
        interactionMode: "default",
      });
      expect(nudges[0]!.message.text).toContain(`"Task ${WORKER_ID}" (${WORKER_ID}) finished.`);
      expect(nudges[0]!.message.text).toContain("Fixed the login bug on branch t3/abc.");
    }).pipe(Effect.scoped),
  );

  it.effect("holds news while the orchestrator runs and combines it into one turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        orchestrator(running(ORCHESTRATOR_ID)),
        worker(WORKER_ID, running(WORKER_ID)),
        worker(SECOND_WORKER_ID, running(SECOND_WORKER_ID)),
      ]);
      yield* harness.emit(WORKER_ID, finished(WORKER_ID));
      yield* harness.emit(SECOND_WORKER_ID, {
        session: session(SECOND_WORKER_ID, "error", LATER),
      });
      expect(yield* harness.nudges).toEqual([]);

      yield* harness.emit(ORCHESTRATOR_ID, finished(ORCHESTRATOR_ID));
      const nudges = yield* harness.nudges;
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.message.text).toContain(`(${WORKER_ID}) finished.`);
      expect(nudges[0]!.message.text).toContain(`(${SECOND_WORKER_ID}) failed: provider crashed`);
    }).pipe(Effect.scoped),
  );

  it.effect("relays a worker's question when it starts waiting on the user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([orchestrator(), worker(WORKER_ID, running(WORKER_ID))]);
      yield* harness.emit(WORKER_ID, { hasPendingUserInput: true });
      const nudges = yield* harness.nudges;
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.message.text).toContain("needs the user.");
      expect(nudges[0]!.message.text).toContain("question: Which database? (options: Postgres)");
    }).pipe(Effect.scoped),
  );

  it.effect("announces a second finish after the worker ran again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([orchestrator(), worker(WORKER_ID, running(WORKER_ID))]);
      yield* harness.emit(WORKER_ID, finished(WORKER_ID));
      yield* harness.emit(WORKER_ID, running(WORKER_ID));
      yield* harness.emit(WORKER_ID, finished(WORKER_ID));
      expect(yield* harness.nudges).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("stays quiet for states present at startup and for normal threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        orchestrator(),
        worker(WORKER_ID, finished(WORKER_ID)),
        makeShell(PLAIN_ID, running(PLAIN_ID)),
      ]);
      yield* harness.emit(WORKER_ID);
      yield* harness.emit(PLAIN_ID, finished(PLAIN_ID));
      expect(yield* harness.nudges).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never nudges an archived orchestrator", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        orchestrator({ archivedAt: NOW }),
        worker(WORKER_ID, running(WORKER_ID)),
      ]);
      yield* harness.emit(WORKER_ID, finished(WORKER_ID));
      expect(yield* harness.nudges).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
