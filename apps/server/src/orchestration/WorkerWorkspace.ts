/**
 * WorkerWorkspace - git worktrees for orchestrator worker threads.
 *
 * A single-repo worker gets one worktree in the default worktrees folder and
 * behaves like any worktree thread. A multi-repo worker gets a plain folder
 * holding one worktree per repo; the thread runs in that folder with no
 * branch, so the per-thread worktree and pull request machinery skips it.
 *
 * @module WorkerWorkspace
 */
import {
  CommandId,
  type ProjectId,
  type ThreadId,
  type ThreadOrchestrationWorkerRepo,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class WorkerWorkspaceRepoError extends Schema.TaggedError<WorkerWorkspaceRepoError>()(
  "WorkerWorkspaceRepoError",
  {
    projectId: Schema.String,
    reason: Schema.Literals(["not-found", "not-a-git-repository", "duplicate", "not-a-checkout"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `Project ${this.projectId} was not found.`;
      case "not-a-git-repository":
        return `Project ${this.projectId} is not a git repository, so it cannot get a worktree.`;
      case "duplicate":
        return `Project ${this.projectId} is listed more than once.`;
      case "not-a-checkout":
        return `That folder is neither project ${this.projectId}'s checkout nor a git worktree of its repository.`;
    }
  }
}

export class WorkerWorkspaceCreateError extends Schema.TaggedError<WorkerWorkspaceCreateError>()(
  "WorkerWorkspaceCreateError",
  { projectId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not create a worktree for project ${this.projectId}.`;
  }
}

export class WorkerWorkspaceNotWorkerError extends Schema.TaggedError<WorkerWorkspaceNotWorkerError>()(
  "WorkerWorkspaceNotWorkerError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not an orchestrator worker.`;
  }
}

export class WorkerWorkspaceNotOwnedError extends Schema.TaggedError<WorkerWorkspaceNotOwnedError>()(
  "WorkerWorkspaceNotOwnedError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Worker ${this.threadId} runs in an existing checkout that T3 Code did not create, so it is never removed.`;
  }
}

export class WorkerWorkspaceRemoveError extends Schema.TaggedError<WorkerWorkspaceRemoveError>()(
  "WorkerWorkspaceRemoveError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not remove the workspace of thread ${this.threadId}.`;
  }
}

export class WorkerWorkspaceUnsafePathError extends Schema.TaggedError<WorkerWorkspaceUnsafePathError>()(
  "WorkerWorkspaceUnsafePathError",
  { threadId: Schema.String, path: Schema.String },
) {
  override get message(): string {
    return `Refusing to remove ${this.path}: it is not inside T3 Code's worktrees or workspaces folder.`;
  }
}

export interface WorkerWorkspaceLayout {
  /** The first repo's project; the worker thread lives there. */
  readonly projectId: ProjectId;
  /** The single repo's branch, or null for a multi-repo workspace or a project checkout. */
  readonly branch: string | null;
  /**
   * The worker's cwd: the single worktree, or the multi-repo workspace folder.
   * Null when it runs in the project checkout, like any local thread.
   */
  readonly worktreePath: string | null;
  readonly workspacePath: string | null;
  /** "existing" when the worker borrows a checkout; such layouts are never removed. */
  readonly workspace: "created" | "existing";
  readonly repos: ReadonlyArray<ThreadOrchestrationWorkerRepo>;
}

export class WorkerWorkspace extends Context.Service<
  WorkerWorkspace,
  {
    /** Create one worktree per repo, rolling back what was created if any repo fails. */
    readonly create: (input: {
      readonly threadId: ThreadId;
      readonly repos: ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly baseBranch?: string | undefined;
      }>;
    }) => Effect.Effect<
      WorkerWorkspaceLayout,
      WorkerWorkspaceRepoError | WorkerWorkspaceCreateError
    >;
    /**
     * Point a worker at a project's own checkout (no `path`) or at an existing
     * git worktree of that project's repository. Creates nothing.
     */
    readonly useExisting: (input: {
      readonly projectId: ProjectId;
      readonly path?: string | undefined;
    }) => Effect.Effect<
      WorkerWorkspaceLayout,
      WorkerWorkspaceRepoError | WorkerWorkspaceCreateError
    >;
    /** Best-effort removal of a layout whose worker thread was never created. */
    readonly discard: (
      layout: Pick<WorkerWorkspaceLayout, "workspacePath" | "repos" | "workspace">,
    ) => Effect.Effect<void>;
    /**
     * Remove a worker's worktrees (keeping their branches) and its workspace
     * folder, then clear the thread's worktree path. A no-op once removed.
     * Refuses any path outside the folders this service creates in.
     */
    readonly remove: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly removedWorktrees: ReadonlyArray<string> },
      | WorkerWorkspaceNotWorkerError
      | WorkerWorkspaceNotOwnedError
      | WorkerWorkspaceRemoveError
      | WorkerWorkspaceUnsafePathError
    >;
    /** Remove the worktrees of a worker that was already deleted, from its last orchestration record. */
    readonly removeLayout: (
      threadId: ThreadId,
      layout: Pick<WorkerWorkspaceLayout, "workspacePath" | "repos">,
    ) => Effect.Effect<
      { readonly removedWorktrees: ReadonlyArray<string> },
      WorkerWorkspaceRemoveError | WorkerWorkspaceUnsafePathError
    >;
  }
>()("t3/orchestration/WorkerWorkspace") {}

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const workspacesDir = path.join(config.baseDir, "workspaces");

  /** Strictly inside `root`, never `root` itself, after resolving "..". */
  const isInside = (root: string, candidate: string) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const isManagedWorktree = (repo: ThreadOrchestrationWorkerRepo) =>
    path.resolve(repo.worktreePath) !== path.resolve(repo.repoRoot) &&
    (isInside(config.worktreesDir, repo.worktreePath) ||
      isInside(workspacesDir, repo.worktreePath));
  /** The first path this service would not have created, if any. */
  const unsafePathOf = (layout: Pick<WorkerWorkspaceLayout, "workspacePath" | "repos">) =>
    layout.repos.find((repo) => !isManagedWorktree(repo))?.worktreePath ??
    (layout.workspacePath !== null && !isInside(workspacesDir, layout.workspacePath)
      ? layout.workspacePath
      : undefined);

  const randomBranch = crypto.randomBytes(4).pipe(
    Effect.orDie,
    Effect.map((bytes) => buildTemporaryWorktreeBranchName(() => bytesToHex(bytes))),
  );

  const removeWorktrees = (repos: ReadonlyArray<ThreadOrchestrationWorkerRepo>) =>
    Effect.forEach(
      repos,
      (repo) =>
        git
          .removeWorktree({ cwd: repo.repoRoot, path: repo.worktreePath, force: true })
          .pipe(Effect.as(repo.worktreePath)),
      { concurrency: 1 },
    );

  const discard: WorkerWorkspace["Service"]["discard"] = (layout) =>
    Effect.gen(function* () {
      if (layout.workspace === "existing" || unsafePathOf(layout) !== undefined) return;
      yield* removeWorktrees(layout.repos).pipe(Effect.ignore);
      if (layout.workspacePath !== null) {
        yield* fileSystem
          .remove(layout.workspacePath, { recursive: true, force: true })
          .pipe(Effect.ignore);
      }
    });

  const create: WorkerWorkspace["Service"]["create"] = Effect.fn("WorkerWorkspace.create")(
    function* (input) {
      const seen = new Set<string>();
      const projects = yield* Effect.forEach(input.repos, (repo) =>
        Effect.gen(function* () {
          if (seen.has(repo.projectId)) {
            return yield* new WorkerWorkspaceRepoError({
              projectId: repo.projectId,
              reason: "duplicate",
            });
          }
          seen.add(repo.projectId);
          const project = yield* snapshots.getProjectShellById(repo.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) => new WorkerWorkspaceCreateError({ projectId: repo.projectId, cause }),
            ),
          );
          if (project === undefined) {
            return yield* new WorkerWorkspaceRepoError({
              projectId: repo.projectId,
              reason: "not-found",
            });
          }
          const isRepository = yield* git
            .isRepository(project.workspaceRoot)
            .pipe(Effect.orElseSucceed(() => false));
          if (!isRepository) {
            return yield* new WorkerWorkspaceRepoError({
              projectId: repo.projectId,
              reason: "not-a-git-repository",
            });
          }
          return { project, baseBranch: repo.baseBranch };
        }),
      );
      const first = projects[0];
      if (first === undefined) {
        return yield* new WorkerWorkspaceCreateError({
          projectId: "",
          cause: new Error("A worker needs at least one repo."),
        });
      }

      const multiRepo = projects.length > 1;
      // The full thread id, so two workers can never share (or adopt) a folder.
      const workspacePath = multiRepo
        ? path.join(workspacesDir, input.threadId.replace(/[^a-zA-Z0-9_-]/g, "_"))
        : null;
      const created = yield* Ref.make<ReadonlyArray<ThreadOrchestrationWorkerRepo>>([]);
      const createdFolder = yield* Ref.make(false);
      const usedNames = new Set<string>();

      const build = Effect.gen(function* () {
        if (workspacePath !== null) {
          yield* fileSystem
            .makeDirectory(workspacesDir, { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) => new WorkerWorkspaceCreateError({ projectId: first.project.id, cause }),
              ),
            );
          // Not recursive: fails if the folder already exists, so the worker
          // never takes over (and later deletes) a folder it did not create.
          yield* fileSystem
            .makeDirectory(workspacePath)
            .pipe(
              Effect.mapError(
                (cause) => new WorkerWorkspaceCreateError({ projectId: first.project.id, cause }),
              ),
            );
          yield* Ref.set(createdFolder, true);
        }
        for (const { project, baseBranch } of projects) {
          const branch = yield* randomBranch;
          let worktreeTarget: string | null = null;
          if (workspacePath !== null) {
            const baseName = path.basename(project.workspaceRoot);
            let name = baseName;
            for (let suffix = 2; usedNames.has(name); suffix++) name = `${baseName}-${suffix}`;
            usedNames.add(name);
            worktreeTarget = path.join(workspacePath, name);
          }
          const result = yield* git
            .createWorktree({
              cwd: project.workspaceRoot,
              refName: baseBranch ?? "HEAD",
              newRefName: branch,
              path: worktreeTarget,
            })
            .pipe(
              Effect.mapError(
                (cause) => new WorkerWorkspaceCreateError({ projectId: project.id, cause }),
              ),
            );
          yield* Ref.update(created, (repos) => [
            ...repos,
            {
              projectId: project.id,
              repoRoot: project.workspaceRoot,
              worktreePath: result.worktree.path,
              branch: result.worktree.refName,
            },
          ]);
        }
        return yield* Ref.get(created);
      });

      const repos = yield* build.pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const repos = yield* Ref.get(created);
            const ownsFolder = yield* Ref.get(createdFolder);
            yield* discard({
              workspacePath: ownsFolder ? workspacePath : null,
              repos,
              workspace: "created",
            });
          }),
        ),
      );
      const only = repos.length === 1 ? repos[0] : undefined;
      return {
        projectId: first.project.id,
        branch: only?.branch ?? null,
        worktreePath: only?.worktreePath ?? workspacePath!,
        workspacePath,
        repos,
        workspace: "created",
      } satisfies WorkerWorkspaceLayout;
    },
  );

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /** `git worktree list --porcelain` as path → branch (null when detached). */
  const listWorktrees = (repoRoot: string) =>
    vcs
      .execute({
        operation: "WorkerWorkspace.listWorktrees",
        cwd: repoRoot,
        args: ["worktree", "list", "--porcelain"],
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.map((result) => {
          const entries = new Map<string, string | null>();
          for (const block of result.stdout.split(/\n\n+/)) {
            const lines = block.split("\n");
            const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
            if (!worktree) continue;
            const branch = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
            entries.set(worktree, branch?.replace(/^refs\/heads\//, "") ?? null);
          }
          return entries;
        }),
      );

  const useExisting: WorkerWorkspace["Service"]["useExisting"] = Effect.fn(
    "WorkerWorkspace.useExisting",
  )(function* (input) {
    const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(
        (cause) => new WorkerWorkspaceCreateError({ projectId: input.projectId, cause }),
      ),
    );
    if (project === undefined) {
      return yield* new WorkerWorkspaceRepoError({
        projectId: input.projectId,
        reason: "not-found",
      });
    }
    const repoError = (reason: "not-a-git-repository" | "not-a-checkout") =>
      new WorkerWorkspaceRepoError({ projectId: input.projectId, reason });
    if (!(yield* git.isRepository(project.workspaceRoot).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* repoError("not-a-git-repository");
    }
    const worktrees = yield* listWorktrees(project.workspaceRoot).pipe(
      Effect.mapError(
        (cause) => new WorkerWorkspaceCreateError({ projectId: input.projectId, cause }),
      ),
    );
    const projectRoot = yield* realPath(project.workspaceRoot);
    const target = input.path === undefined ? projectRoot : yield* realPath(input.path);
    let match: { readonly path: string; readonly branch: string | null } | undefined;
    for (const [worktreePath, branch] of worktrees) {
      if ((yield* realPath(worktreePath)) === target) match = { path: worktreePath, branch };
    }
    // The project checkout may itself be a linked worktree, so it is accepted by path.
    if (match === undefined && target !== projectRoot) return yield* repoError("not-a-checkout");
    const inCheckout = target === projectRoot;
    const branch = match?.branch ?? null;
    return {
      projectId: project.id,
      // A worker in the project checkout behaves like any local thread.
      branch: inCheckout ? null : branch,
      worktreePath: inCheckout ? null : (match?.path ?? target),
      workspacePath: null,
      repos: [
        {
          projectId: project.id,
          repoRoot: project.workspaceRoot,
          worktreePath: inCheckout ? project.workspaceRoot : (match?.path ?? target),
          branch: branch ?? "HEAD",
        },
      ],
      workspace: "existing",
    } satisfies WorkerWorkspaceLayout;
  });

  const removeLayout: WorkerWorkspace["Service"]["removeLayout"] = Effect.fn(
    "WorkerWorkspace.removeLayout",
  )(function* (threadId, layout) {
    const unsafe = unsafePathOf(layout);
    if (unsafe !== undefined) {
      return yield* new WorkerWorkspaceUnsafePathError({ threadId, path: unsafe });
    }
    const existing = yield* Effect.filter(layout.repos, (repo) =>
      fileSystem.exists(repo.worktreePath).pipe(Effect.orElseSucceed(() => false)),
    );
    const removedWorktrees = yield* removeWorktrees(existing).pipe(
      Effect.mapError((cause) => new WorkerWorkspaceRemoveError({ threadId, cause })),
    );
    if (layout.workspacePath !== null) {
      yield* fileSystem
        .remove(layout.workspacePath, { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => new WorkerWorkspaceRemoveError({ threadId, cause })));
    }
    return { removedWorktrees };
  });

  const remove: WorkerWorkspace["Service"]["remove"] = Effect.fn("WorkerWorkspace.remove")(
    function* (threadId) {
      const thread = Option.getOrUndefined(
        yield* snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.mapError((cause) => new WorkerWorkspaceRemoveError({ threadId, cause }))),
      );
      const orchestration = thread?.orchestration;
      if (thread === undefined || orchestration?.role !== "worker") {
        return yield* new WorkerWorkspaceNotWorkerError({ threadId });
      }
      if (orchestration.workspace === "existing") {
        return yield* new WorkerWorkspaceNotOwnedError({ threadId });
      }
      if (thread.worktreePath === null) return { removedWorktrees: [] };
      const removed = yield* removeLayout(threadId, orchestration);
      // The thread must stop pointing at folders that no longer exist.
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:worker-workspace-removed:${threadId}:${uuid}`),
          threadId,
          worktreePath: null,
          branch: null,
        })
        .pipe(Effect.mapError((cause) => new WorkerWorkspaceRemoveError({ threadId, cause })));
      return removed;
    },
  );

  return WorkerWorkspace.of({ create, useExisting, discard, remove, removeLayout });
});

export const layer = Layer.effect(WorkerWorkspace, make);
