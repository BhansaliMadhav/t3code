import {
  McpCapabilityUnavailableError,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkerWorkspace from "../../../orchestration/WorkerWorkspace.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  GitWorkflowService.GitWorkflowService,
  WorkerWorkspace.WorkerWorkspace,
  ServerSettings.ServerSettingsService,
];

const ORCHESTRATOR_ONLY = "Only available in orchestrator chats.";

export class OrchestratorThreadNotFoundError extends Schema.TaggedError<OrchestratorThreadNotFoundError>()(
  "OrchestratorThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class OrchestratorNotYourWorkerError extends Schema.TaggedError<OrchestratorNotYourWorkerError>()(
  "OrchestratorNotYourWorkerError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not a worker of this orchestrator. Use list_workers to see yours.`;
  }
}

export class OrchestratorWorkerBusyError extends Schema.TaggedError<OrchestratorWorkerBusyError>()(
  "OrchestratorWorkerBusyError",
  { threadId: Schema.String, status: Schema.String },
) {
  override get message(): string {
    return this.status === "needs_user"
      ? `Worker ${this.threadId} is waiting on the user. Tell the user what it asks and let them answer it.`
      : `Worker ${this.threadId} is still running. End your turn; T3 Code messages you when it finishes. Or interrupt_worker first.`;
  }
}

export class OrchestratorModelRequiredError extends Schema.TaggedError<OrchestratorModelRequiredError>()(
  "OrchestratorModelRequiredError",
  {},
) {
  override get message(): string {
    return "Pass model together with providerInstanceId when choosing another provider.";
  }
}

export class OrchestratorWorkspaceError extends Schema.TaggedError<OrchestratorWorkspaceError>()(
  "OrchestratorWorkspaceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class OrchestratorFailedError extends Schema.TaggedError<OrchestratorFailedError>()(
  "OrchestratorFailedError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

const OrchestratorToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorThreadNotFoundError,
  OrchestratorNotYourWorkerError,
  OrchestratorWorkerBusyError,
  OrchestratorModelRequiredError,
  OrchestratorWorkspaceError,
  OrchestratorFailedError,
]);

export const WorkerStatus = Schema.Literals(["running", "needs_user", "idle", "error"]).annotate({
  description:
    "running: working on a turn. needs_user: waiting on the user to answer a question or approval. idle: finished its last turn. error: its last turn or session failed.",
});
export type WorkerStatus = typeof WorkerStatus.Type;

const WorkerRepo = Schema.Struct({
  projectId: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.String,
});

export const WorkerSummary = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  status: WorkerStatus,
  worktreePath: Schema.NullOr(Schema.String).annotate({
    description:
      "The worker's working directory: its worktree, or the folder holding one worktree per repo.",
  }),
  repos: Schema.Array(WorkerRepo),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  existingCheckout: Schema.Boolean.annotate({
    description:
      "True when the worker works in an existing checkout or worktree. Its workspace is never removed.",
  }),
});
export type WorkerSummary = typeof WorkerSummary.Type;

const ListProjectsTool = Tool.make("list_projects", {
  description: `List the projects in this T3 Code environment with their ids and folders. Workers can target any project that is a git repository. ${ORCHESTRATOR_ONLY}`,
  success: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        projectId: Schema.String,
        title: Schema.String,
        workspaceRoot: Schema.String,
        isGitRepository: Schema.Boolean,
      }),
    ),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SpawnWorkerInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({ description: "Short title for the worker thread." }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The worker's first message. Make it self-contained: goal, repos, constraints, and what done means.",
  }),
  repos: Schema.NonEmptyArray(
    Schema.Struct({
      projectId: ProjectId.annotate({ description: "A project id from list_projects." }),
      baseBranch: Schema.optional(
        TrimmedNonEmptyString.check(
          // A leading dash would reach git as an option rather than a ref.
          Schema.makeFilter((value) => !value.startsWith("-") || "must not start with '-'"),
        ).annotate({
          description:
            "Branch to start a new worktree from. Defaults to the project's current checkout.",
        }),
      ),
      path: Schema.optional(
        TrimmedNonEmptyString.annotate({
          description:
            'Run in this existing folder instead of a new worktree: the project\'s checkout or an existing git worktree of its repository. Implies checkout "existing".',
        }),
      ),
    }),
  ).annotate({
    description:
      "Repos the worker changes. With new worktrees, each gets its own git worktree on a new branch, and several repos share a folder holding one worktree per repo. An existing checkout takes exactly one repo.",
  }),
  checkout: Schema.optional(
    Schema.Literals(["new-worktree", "existing"]).annotate({
      description:
        "new-worktree: fresh worktrees on new branches. existing: work directly in the project's checkout, or in repos[0].path. Omit to use the user's default; set it only when the user asked for one.",
    }),
  ),
  providerInstanceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Provider instance for the worker. Defaults to this chat's provider.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model for the worker. Defaults to this chat's.",
    }),
  ),
});

const SpawnWorkerTool = Tool.make("spawn_worker", {
  description: `Start a worker thread, in fresh git worktrees or an existing checkout, and send it its first message. The user sees it nested under this chat. You are messaged automatically when it finishes, fails, or needs the user, so end your turn instead of waiting. ${ORCHESTRATOR_ONLY}`,
  parameters: SpawnWorkerInput,
  success: WorkerSummary,
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListWorkersTool = Tool.make("list_workers", {
  description: `List this chat's workers with their status. ${ORCHESTRATOR_ONLY}`,
  success: Schema.Struct({ workers: Schema.Array(WorkerSummary) }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "List workers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorkerTarget = Schema.Struct({
  threadId: ThreadId.annotate({ description: "A worker id from spawn_worker or list_workers." }),
});

export const PendingWorkerRequest = Schema.Struct({
  kind: Schema.Literals(["question", "approval"]),
  detail: Schema.String,
});
export type PendingWorkerRequest = typeof PendingWorkerRequest.Type;

const GetWorkerTool = Tool.make("get_worker", {
  description: `Read a worker's status, the end of its latest reply, and anything it is waiting on the user for. ${ORCHESTRATOR_ONLY}`,
  parameters: Schema.Struct({
    ...WorkerTarget.fields,
    maxChars: Schema.optional(
      PositiveInt.annotate({
        description: "Keep at most this many characters from the end of the reply. Default 4000.",
      }),
    ),
  }),
  success: Schema.Struct({
    worker: WorkerSummary,
    latestReply: Schema.NullOr(Schema.String),
    replyTruncated: Schema.Boolean,
    pendingRequests: Schema.Array(PendingWorkerRequest).annotate({
      description: "Questions and approvals for the user. Relay them; never answer them yourself.",
    }),
  }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get worker")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SendToWorkerTool = Tool.make("send_to_worker", {
  description: `Send an idle worker a follow-up message, starting a new turn. Fails while it runs or waits on the user. You are messaged automatically when the turn ends. ${ORCHESTRATOR_ONLY}`,
  parameters: Schema.Struct({ ...WorkerTarget.fields, message: TrimmedNonEmptyString }),
  success: WorkerSummary,
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send to worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const InterruptWorkerTool = Tool.make("interrupt_worker", {
  description: `Stop a worker's running turn. ${ORCHESTRATOR_ONLY}`,
  parameters: WorkerTarget,
  success: WorkerSummary,
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt worker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RemoveWorkerWorkspaceTool = Tool.make("remove_worker_workspace", {
  description: `Delete a worker's worktrees and workspace folder. Uncommitted changes in them are lost; branches are kept. Refuses workers in an existing checkout. Only do this when the user asks. ${ORCHESTRATOR_ONLY}`,
  parameters: WorkerTarget,
  success: Schema.Struct({ removedWorktrees: Schema.Array(Schema.String) }),
  failure: OrchestratorToolError,
  dependencies,
})
  .annotate(Tool.Title, "Remove worker workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const OrchestratorToolkit = Toolkit.make(
  ListProjectsTool,
  SpawnWorkerTool,
  ListWorkersTool,
  GetWorkerTool,
  SendToWorkerTool,
  InterruptWorkerTool,
  RemoveWorkerWorkspaceTool,
);

/**
 * The MCP server lists every toolkit to every session. Adapters that can hide
 * tools per session use this to keep the orchestrator tools out of normal
 * chats' and workers' tool lists.
 */
export const ORCHESTRATOR_TOOL_NAMES: ReadonlyArray<string> = Object.keys(
  OrchestratorToolkit.tools,
);
