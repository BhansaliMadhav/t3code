import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const ORCHESTRATOR_ID = ThreadId.make("orchestrator-1");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [],
  updatedAt: NOW,
};

const createCommand = (
  threadId: ThreadId,
  orchestration?: Extract<OrchestrationCommand, { type: "thread.create" }>["orchestration"],
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${threadId}`),
  threadId,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  ...(orchestration === undefined ? {} : { orchestration }),
});

const decideAndProject = (command: OrchestrationCommand, model: OrchestrationReadModel) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel: model });
    const [event] = Array.isArray(decided) ? decided : [decided];
    return yield* projectEvent(model, { ...event!, sequence: model.snapshotSequence + 1 });
  });

it.layer(NodeServices.layer)("thread.create orchestration", (it) => {
  it.effect("normal chats carry no orchestration role", () =>
    Effect.gen(function* () {
      const next = yield* decideAndProject(createCommand(ThreadId.make("normal")), readModel);
      expect(next.threads[0]?.orchestration ?? null).toBeNull();
    }),
  );

  it.effect("orchestrator and worker roles survive decide and project", () =>
    Effect.gen(function* () {
      const withOrchestrator = yield* decideAndProject(
        createCommand(ORCHESTRATOR_ID, { role: "orchestrator" }),
        readModel,
      );
      expect(withOrchestrator.threads[0]?.orchestration).toEqual({ role: "orchestrator" });

      const worker = {
        role: "worker" as const,
        parentThreadId: ORCHESTRATOR_ID,
        workspacePath: null,
        repos: [
          { projectId: PROJECT_ID, repoRoot: "/repo", worktreePath: "/wt/a", branch: "t3code/a" },
        ],
      };
      const withWorker = yield* decideAndProject(
        createCommand(ThreadId.make("worker-1"), worker),
        withOrchestrator,
      );
      expect(withWorker.threads.find((t) => t.id === "worker-1")?.orchestration).toEqual(worker);
    }),
  );

  it.effect("rejects a worker whose parent thread does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: createCommand(ThreadId.make("worker-1"), {
            role: "worker",
            parentThreadId: ThreadId.make("missing"),
            workspacePath: null,
            repos: [],
          }),
          readModel,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a worker whose parent is not an orchestrator", () =>
    Effect.gen(function* () {
      const withNormal = yield* decideAndProject(createCommand(ThreadId.make("normal")), readModel);
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: createCommand(ThreadId.make("worker-1"), {
            role: "worker",
            parentThreadId: ThreadId.make("normal"),
            workspacePath: null,
            repos: [],
          }),
          readModel: withNormal,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
