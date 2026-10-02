import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkerWorkspace from "../../../orchestration/WorkerWorkspace.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  isWorkerOf,
  pendingWorkerRequests,
  REQUEST_ACTIVITY_KINDS,
  summarizeWorker,
  workerStatusOf,
  workspaceRemoved,
} from "../../../orchestration/workerStatus.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  OrchestratorFailedError,
  OrchestratorModelRequiredError,
  OrchestratorNotYourWorkerError,
  OrchestratorThreadNotFoundError,
  OrchestratorToolkit,
  OrchestratorWorkerBusyError,
  OrchestratorWorkspaceError,
} from "./tools.ts";

const DEFAULT_REPLY_CHARS = 4000;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const workspaces = yield* WorkerWorkspace.WorkerWorkspace;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    Effect.map(uuid, (id) => CommandId.make(`server:mcp-orchestrator-${tag}:${id}`));
  const failed = (operation: string) => (cause: unknown) =>
    new OrchestratorFailedError({ operation, cause });

  const readShell = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.mapError(failed("read the thread")),
      Effect.flatMap((shell) =>
        Option.isSome(shell)
          ? Effect.succeed(shell.value)
          : Effect.fail(new OrchestratorThreadNotFoundError({ threadId })),
      ),
    );

  const listWorkers = (parentThreadId: ThreadId) =>
    snapshots.getShellSnapshot().pipe(
      Effect.mapError(failed("list workers")),
      Effect.map((snapshot) => snapshot.threads.filter(isWorkerOf(parentThreadId))),
    );

  const requireOrchestrator = McpInvocationContext.requireMcpCapability("orchestrator");

  const requireWorker = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const scope = yield* requireOrchestrator;
      const shell = yield* readShell(threadId);
      if (!isWorkerOf(scope.threadId)(shell)) {
        return yield* new OrchestratorNotYourWorkerError({ threadId });
      }
      return shell;
    });

  const startTurn = (shell: OrchestrationThreadShell, text: string) =>
    Effect.gen(function* () {
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("turn"),
          threadId: shell.id,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(failed("start the worker's turn")));
      return summarizeWorker(yield* readShell(shell.id));
    });

  return OrchestratorToolkit.of({
    list_projects: () =>
      Effect.gen(function* () {
        yield* requireOrchestrator;
        const projects = yield* snapshots
          .getProjectShells()
          .pipe(Effect.mapError(failed("list projects")));
        return {
          projects: yield* Effect.forEach(
            projects,
            (project) =>
              git.isRepository(project.workspaceRoot).pipe(
                Effect.orElseSucceed(() => false),
                Effect.map((isGitRepository) => ({
                  projectId: project.id,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  isGitRepository,
                })),
              ),
            { concurrency: 4 },
          ),
        };
      }),

    spawn_worker: (input) =>
      Effect.gen(function* () {
        const scope = yield* requireOrchestrator;
        const orchestrator = yield* readShell(scope.threadId);
        const base = orchestrator.modelSelection;
        let modelSelection: ModelSelection = base;
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== base.instanceId
        ) {
          if (input.model === undefined) return yield* new OrchestratorModelRequiredError({});
          modelSelection = {
            instanceId: ProviderInstanceId.make(input.providerInstanceId),
            model: input.model,
          };
        } else if (input.model !== undefined && input.model !== base.model) {
          modelSelection = { instanceId: base.instanceId, model: input.model };
        }

        const threadId = ThreadId.make(yield* uuid);
        const explicitPath = input.repos.find((repo) => repo.path !== undefined)?.path;
        if (input.checkout === "new-worktree" && explicitPath !== undefined) {
          return yield* new OrchestratorWorkspaceError({
            detail: 'A repo path means an existing checkout; drop it or use checkout "existing".',
          });
        }
        const settingsDefault = yield* settings.getSettings.pipe(
          Effect.map((current) => current.workerCheckoutDefault),
          Effect.orElseSucceed(() => "new-worktree" as const),
        );
        // The user's default only applies where it can: one checkout holds one repo.
        const useExisting =
          input.checkout === "existing" ||
          explicitPath !== undefined ||
          (input.checkout === undefined &&
            settingsDefault === "project-checkout" &&
            input.repos.length === 1);
        if (useExisting && input.repos.length > 1) {
          return yield* new OrchestratorWorkspaceError({
            detail:
              "An existing checkout holds one repo. Spawn one worker per repo, or use new worktrees.",
          });
        }
        const layout = yield* (
          useExisting
            ? workspaces.useExisting({
                projectId: input.repos[0].projectId,
                path: input.repos[0].path,
              })
            : workspaces.create({ threadId, repos: input.repos })
        ).pipe(
          Effect.mapError((error) => new OrchestratorWorkspaceError({ detail: error.message })),
        );
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: yield* commandId("spawn"),
            threadId,
            projectId: layout.projectId,
            title: input.title,
            modelSelection,
            runtimeMode: orchestrator.runtimeMode,
            // Workers do the work; plan mode would only plan it.
            interactionMode: "default",
            branch: layout.branch,
            worktreePath: layout.worktreePath,
            createdAt: yield* nowIso,
            orchestration: {
              role: "worker",
              parentThreadId: scope.threadId,
              workspacePath: layout.workspacePath,
              repos: layout.repos,
              workspace: layout.workspace,
            },
          })
          .pipe(
            Effect.mapError(failed("create the worker thread")),
            Effect.tapError(() => workspaces.discard(layout)),
          );
        // The worker exists from here on. Failing the first message as a plain
        // error would invite the agent to spawn a duplicate, so name the worker.
        return yield* startTurn(yield* readShell(threadId), input.prompt).pipe(
          Effect.catchTag("OrchestratorFailedError", (error) =>
            Effect.logWarning("spawn_worker could not start the worker's first turn", error).pipe(
              Effect.andThen(
                new OrchestratorWorkspaceError({
                  detail: `Worker ${threadId} was created but its first message failed; use send_to_worker with threadId ${threadId} to retry. Do not spawn it again.`,
                }),
              ),
            ),
          ),
        );
      }),

    list_workers: () =>
      Effect.gen(function* () {
        const scope = yield* requireOrchestrator;
        const workers = yield* listWorkers(scope.threadId);
        return { workers: workers.map(summarizeWorker) };
      }),

    get_worker: (input) =>
      Effect.gen(function* () {
        const shell = yield* requireWorker(input.threadId);
        const detail = yield* snapshots
          .getThreadDetailById(shell.id, { activityKinds: REQUEST_ACTIVITY_KINDS })
          .pipe(Effect.mapError(failed("read the worker")));
        const thread = Option.getOrUndefined(detail);
        const reply = thread?.messages.findLast((message) => message.role === "assistant")?.text;
        const maxChars = input.maxChars ?? DEFAULT_REPLY_CHARS;
        const needsUser = shell.hasPendingUserInput || shell.hasPendingApprovals;
        return {
          worker: summarizeWorker(shell),
          latestReply: reply === undefined ? null : reply.slice(-maxChars),
          replyTruncated: reply !== undefined && reply.length > maxChars,
          pendingRequests: needsUser && thread ? pendingWorkerRequests(thread.activities) : [],
        };
      }),

    send_to_worker: (input) =>
      Effect.gen(function* () {
        const shell = yield* requireWorker(input.threadId);
        if (workspaceRemoved(shell)) {
          return yield* new OrchestratorWorkspaceError({
            detail: `Worker ${shell.id}'s workspace was removed, so it cannot take more work. Spawn a new worker instead.`,
          });
        }
        const status = workerStatusOf(shell);
        if (status === "running" || status === "needs_user") {
          return yield* new OrchestratorWorkerBusyError({ threadId: shell.id, status });
        }
        return yield* startTurn(shell, input.message);
      }),

    interrupt_worker: (input) =>
      Effect.gen(function* () {
        const shell = yield* requireWorker(input.threadId);
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: yield* commandId("interrupt"),
            threadId: shell.id,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.mapError(failed("interrupt the worker")));
        return summarizeWorker(yield* readShell(shell.id));
      }),

    remove_worker_workspace: (input) =>
      Effect.gen(function* () {
        const shell = yield* requireWorker(input.threadId);
        return yield* workspaces
          .remove(shell.id)
          .pipe(
            Effect.mapError((error) => new OrchestratorWorkspaceError({ detail: error.message })),
          );
      }),
  });
});

export const OrchestratorToolkitHandlersLive = OrchestratorToolkit.toLayer(make);
