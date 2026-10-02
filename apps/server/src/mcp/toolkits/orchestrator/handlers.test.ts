import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkerWorkspace from "../../../orchestration/WorkerWorkspace.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { workerStatusOf } from "../../../orchestration/workerStatus.ts";
import { OrchestratorToolkitHandlersLive } from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:05:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const ORCHESTRATOR_ID = ThreadId.make("orchestrator-1");
const WORKER_ID = ThreadId.make("worker-1");
const OTHER_WORKER_ID = ThreadId.make("worker-of-someone-else");

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++uuidCounter % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ORCHESTRATOR_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function session(status: OrchestrationSession["status"], updatedAt = NOW): OrchestrationSession {
  return {
    threadId: WORKER_ID,
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
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
    worktreePath: null,
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

const workerOf = (parentThreadId: ThreadId) =>
  ({
    role: "worker",
    parentThreadId,
    workspacePath: null,
    repos: [{ projectId: PROJECT_ID, repoRoot: "/repo", worktreePath: "/wt/w", branch: "t3/w" }],
  }) as const;

const makeHarness = Effect.fn("makeOrchestratorToolkitHarness")(function* (
  initialShells: ReadonlyArray<OrchestrationThreadShell> = [],
  options: {
    readonly failTurnStart?: boolean;
    readonly workerCheckoutDefault?: "new-worktree" | "project-checkout";
  } = {},
) {
  const shells = yield* Ref.make(
    new Map<ThreadId, OrchestrationThreadShell>(
      [
        makeShell(ORCHESTRATOR_ID, { orchestration: { role: "orchestrator" } }),
        makeShell(OTHER_WORKER_ID, { orchestration: workerOf(ThreadId.make("other")) }),
        ...initialShells,
      ].map((shell) => [shell.id, shell]),
    ),
  );
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.turn.start" && options.failTurnStart) {
        return yield* Effect.fail(new Error("provider unavailable") as never);
      }
      if (command.type === "thread.create") {
        yield* Ref.update(shells, (current) =>
          new Map(current).set(
            command.threadId,
            makeShell(command.threadId, {
              title: command.title,
              ...(command.orchestration ? { orchestration: command.orchestration } : {}),
              worktreePath: command.worktreePath,
            }),
          ),
        );
      }
      return { sequence: 1 };
    });

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
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch,
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(WorkerWorkspace.WorkerWorkspace)({
      create: () =>
        Effect.succeed({
          projectId: PROJECT_ID,
          branch: "t3/w",
          worktreePath: "/wt/w",
          workspacePath: null,
          repos: workerOf(ORCHESTRATOR_ID).repos,
          workspace: "created",
        }),
      useExisting: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          branch: input.path === undefined ? null : "feature/x",
          worktreePath: input.path ?? null,
          workspacePath: null,
          repos: [
            {
              projectId: input.projectId,
              repoRoot: "/repo",
              worktreePath: input.path ?? "/repo",
              branch: "feature/x",
            },
          ],
          workspace: "existing",
        }),
      discard: () => Effect.void,
    }),
    ServerSettings.layerTest({
      workerCheckoutDefault: options.workerCheckoutDefault ?? "new-worktree",
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* OrchestratorToolkit.pipe(
    Effect.provide(OrchestratorToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof OrchestratorToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestrator"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof OrchestratorToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { call, commands };
});

describe("orchestrator toolkit handlers", () => {
  it.effect("refuses a credential without the orchestrator capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("list_workers", {}, ["pull-requests"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "orchestrator",
      });
    }),
  );

  it.effect("refuses to drive a worker that belongs to another orchestrator", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("send_to_worker", { threadId: OTHER_WORKER_ID, message: "hi" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorNotYourWorkerError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("spawn_worker creates a worker thread under this chat, then starts its turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const worker = yield* harness.call("spawn_worker", {
        title: "Fix the bug",
        prompt: "Fix it",
        repos: [{ projectId: PROJECT_ID }],
      });
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(commands[0]).toMatchObject({
        title: "Fix the bug",
        branch: "t3/w",
        worktreePath: "/wt/w",
        runtimeMode: "approval-required",
        modelSelection: { instanceId: "claude", model: "opus" },
        orchestration: { role: "worker", parentThreadId: ORCHESTRATOR_ID },
      });
      expect(commands[1]).toMatchObject({
        threadId: commands[0]!.type === "thread.create" ? commands[0]!.threadId : null,
        message: { text: "Fix it" },
      });
      expect(worker).toMatchObject({ title: "Fix the bug", worktreePath: "/wt/w" });
    }),
  );

  it.effect("send_to_worker refuses a worker that is waiting on the user", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        makeShell(WORKER_ID, {
          orchestration: workerOf(ORCHESTRATOR_ID),
          worktreePath: "/wt/w",
          hasPendingUserInput: true,
        }),
      ]);
      const error = yield* harness
        .call("send_to_worker", { threadId: WORKER_ID, message: "answer" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestratorWorkerBusyError", status: "needs_user" });
    }),
  );

  it.effect("send_to_worker refuses a worker whose workspace was removed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        makeShell(WORKER_ID, { orchestration: workerOf(ORCHESTRATOR_ID), worktreePath: null }),
      ]);
      const error = yield* harness
        .call("send_to_worker", { threadId: WORKER_ID, message: "more" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorWorkspaceError");
      expect(error.message).toContain("workspace was removed");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("spawn_worker can run a worker in the project checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const worker = yield* harness.call("spawn_worker", {
        title: "Here",
        prompt: "Work here",
        repos: [{ projectId: PROJECT_ID }],
        checkout: "existing",
      });
      const [create] = yield* Ref.get(harness.commands);
      expect(create).toMatchObject({
        type: "thread.create",
        worktreePath: null,
        branch: null,
        orchestration: { role: "worker", workspace: "existing" },
      });
      expect(worker).toMatchObject({ existingCheckout: true, worktreePath: "/repo" });
    }),
  );

  it.effect("spawn_worker follows the user's default, and a repo path picks a worktree", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], { workerCheckoutDefault: "project-checkout" });
      yield* harness.call("spawn_worker", {
        title: "Default",
        prompt: "Go",
        repos: [{ projectId: PROJECT_ID }],
      });
      yield* harness.call("spawn_worker", {
        title: "Explicit",
        prompt: "Go",
        repos: [{ projectId: PROJECT_ID }],
        checkout: "new-worktree",
      });
      const creates = (yield* Ref.get(harness.commands)).filter(
        (command) => command.type === "thread.create",
      );
      expect(creates.map((command) => command.orchestration)).toMatchObject([
        { workspace: "existing" },
        { workspace: "created" },
      ]);

      const fromPath = yield* harness.call("spawn_worker", {
        title: "Path",
        prompt: "Go",
        repos: [{ projectId: PROJECT_ID, path: "/wt/existing" }],
      });
      expect(fromPath).toMatchObject({ existingCheckout: true, worktreePath: "/wt/existing" });
    }),
  );

  it.effect("spawn_worker refuses an existing checkout for several repos", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("spawn_worker", {
          title: "Two",
          prompt: "Go",
          repos: [{ projectId: PROJECT_ID }, { projectId: ProjectId.make("project-2") }],
          checkout: "existing",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorWorkspaceError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("send_to_worker reaches a worker in the project checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        makeShell(WORKER_ID, {
          orchestration: { ...workerOf(ORCHESTRATOR_ID), workspace: "existing" },
          worktreePath: null,
        }),
      ]);
      yield* harness.call("send_to_worker", { threadId: WORKER_ID, message: "more" });
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("spawn_worker names the created worker when its first message fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([], { failTurnStart: true });
      const error = yield* harness
        .call("spawn_worker", {
          title: "Fix",
          prompt: "Fix it",
          repos: [{ projectId: PROJECT_ID }],
        })
        .pipe(Effect.flip);
      const commands = yield* Ref.get(harness.commands);
      const created = commands[0];
      expect(created?.type).toBe("thread.create");
      expect(error._tag).toBe("OrchestratorWorkspaceError");
      expect(error.message).toContain(
        `Worker ${created?.type === "thread.create" ? created.threadId : ""} was created`,
      );
      expect(error.message).toContain("send_to_worker");
    }),
  );
});

describe("workerStatusOf", () => {
  it("treats a sent message the session has not picked up yet as running", () => {
    expect(
      workerStatusOf(
        makeShell(WORKER_ID, {
          session: session("ready", NOW),
          latestUserMessageAt: LATER,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: null,
          },
        }),
      ),
    ).toBe("running");
  });

  it("reports a session error that came after the last message", () => {
    expect(
      workerStatusOf(
        makeShell(WORKER_ID, { session: session("error", LATER), latestUserMessageAt: NOW }),
      ),
    ).toBe("error");
  });

  it("does not stay running when the session was interrupted before the turn started", () => {
    expect(
      workerStatusOf(
        makeShell(WORKER_ID, {
          session: session("interrupted", LATER),
          latestUserMessageAt: NOW,
        }),
      ),
    ).toBe("idle");
  });

  it("keeps a fresh session that is ready but has not started the turn as running", () => {
    expect(
      workerStatusOf(
        makeShell(WORKER_ID, { session: session("ready", LATER), latestUserMessageAt: NOW }),
      ),
    ).toBe("running");
  });
});
