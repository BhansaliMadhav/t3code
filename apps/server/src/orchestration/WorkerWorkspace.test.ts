// @effect-diagnostics nodeBuiltinImport:off - Fixtures are real git repos built with synchronous git calls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadOrchestration,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as WorkerWorkspace from "./WorkerWorkspace.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const WORKER_ID = ThreadId.make("worker-thread-0001");

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function makeRepo(root: string, name: string): string {
  const repo = NodePath.join(root, name);
  NodeFS.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), name);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function project(id: string, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workerShell(
  orchestration: ThreadOrchestration,
  worktreePath: string | null = "/set",
): OrchestrationThreadShell {
  return {
    id: WORKER_ID,
    projectId: ProjectId.make("a"),
    title: "Worker",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    orchestration,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const gitFailure = (operation: string, cwd: string, cause: unknown) =>
  new GitCommandError({ operation, command: "git", cwd, detail: String(cause), cause });

/** Real git behind the workflow methods the service uses; default worktrees land in `<baseDir>/worktrees`. */
const gitWorkflowLayer = (baseDir: string) =>
  Layer.mock(GitWorkflowService.GitWorkflowService)({
    isRepository: (cwd) => Effect.sync(() => NodeFS.existsSync(NodePath.join(cwd, ".git"))),
    createWorktree: (input) =>
      Effect.try({
        try: () => {
          const path = input.path ?? NodePath.join(baseDir, "worktrees", input.newRefName!);
          git(input.cwd, "worktree", "add", "-b", input.newRefName!, path, input.refName);
          return { worktree: { path, refName: input.newRefName! } };
        },
        catch: (cause) => gitFailure("createWorktree", input.cwd, cause),
      }),
    removeWorktree: (input) =>
      Effect.try({
        try: () => void git(input.cwd, "worktree", "remove", "--force", input.path),
        catch: (cause) => gitFailure("removeWorktree", input.cwd, cause),
      }),
  });

let counter = 0;
const countingCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++counter),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeLayer(input: {
  readonly baseDir: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly thread?: OrchestrationThreadShell;
  readonly dispatched?: Array<OrchestrationCommand>;
  readonly git?: Layer.Layer<GitWorkflowService.GitWorkflowService>;
}) {
  return WorkerWorkspace.layer.pipe(
    Layer.provide(input.git ?? gitWorkflowLayer(input.baseDir)),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: (request) =>
          Effect.try({
            try: () => ({
              exitCode: 0 as never,
              stdout: git(request.cwd, ...request.args),
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
            catch: (cause) => gitFailure(request.operation, request.cwd, cause),
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            input.dispatched?.push(command);
            return { sequence: 1 };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        getThreadShellById: () => Effect.succeed(Option.fromNullishOr(input.thread)),
      }),
    ),
    Layer.provide(Layer.succeed(Crypto.Crypto, countingCrypto)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), input.baseDir)),
    Layer.provide(NodeServices.layer),
  );
}

const worktreeList = (repo: string) => git(repo, "worktree", "list", "--porcelain");

describe("WorkerWorkspace", () => {
  it.effect("a single repo gets one branch worktree that the thread runs in", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
    const repoA = makeRepo(root, "alpha");
    return Effect.gen(function* () {
      const service = yield* WorkerWorkspace.WorkerWorkspace;
      const layout = yield* service.create({
        threadId: WORKER_ID,
        repos: [{ projectId: ProjectId.make("a") }],
      });
      assert.equal(layout.workspacePath, null);
      assert.equal(layout.repos.length, 1);
      assert.equal(layout.worktreePath, layout.repos[0]!.worktreePath);
      assert.equal(layout.branch, layout.repos[0]!.branch);
      assert.ok(worktreeList(repoA).includes(layout.worktreePath!));
    }).pipe(Effect.provide(makeLayer({ baseDir: root, projects: [project("a", repoA)] })));
  });

  it.effect("several repos share a branchless workspace folder and are removed together", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
    const repoA = makeRepo(root, "alpha");
    const repoB = makeRepo(NodePath.join(root, "nested"), "alpha");
    const projects = [project("a", repoA), project("b", repoB)];
    return Effect.gen(function* () {
      const created = yield* Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        return yield* service.create({
          threadId: WORKER_ID,
          repos: [{ projectId: ProjectId.make("a") }, { projectId: ProjectId.make("b") }],
        });
      }).pipe(Effect.provide(makeLayer({ baseDir: root, projects })));

      assert.equal(created.branch, null);
      assert.equal(created.worktreePath, NodePath.join(root, "workspaces", "worker-thread-0001"));
      assert.deepEqual(
        created.repos.map((repo) => repo.worktreePath),
        [
          NodePath.join(created.worktreePath!, "alpha"),
          NodePath.join(created.worktreePath!, "alpha-2"),
        ],
      );
      assert.ok(worktreeList(repoA).includes(created.repos[0]!.worktreePath));
      assert.ok(worktreeList(repoB).includes(created.repos[1]!.worktreePath));

      const thread = workerShell({
        role: "worker",
        parentThreadId: ThreadId.make("orchestrator"),
        workspacePath: created.workspacePath,
        repos: created.repos,
      });
      const dispatched: Array<OrchestrationCommand> = [];
      const removed = yield* Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        return yield* service.remove(WORKER_ID);
      }).pipe(Effect.provide(makeLayer({ baseDir: root, projects, thread, dispatched })));

      assert.equal(removed.removedWorktrees.length, 2);
      // The thread stops pointing at the deleted folders.
      assert.deepInclude(dispatched[0], {
        type: "thread.meta.update",
        threadId: WORKER_ID,
        worktreePath: null,
        branch: null,
      });
      assert.isFalse(NodeFS.existsSync(created.worktreePath!));
      assert.isFalse(worktreeList(repoA).includes(created.repos[0]!.worktreePath));
      // Branches keep the worker's commits after the worktree is gone.
      assert.ok(git(repoA, "branch", "--list", created.repos[0]!.branch).trim().length > 0);
    });
  });

  it.effect("rolls back the first worktree when the second repo fails", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
    const repoA = makeRepo(root, "alpha");
    const repoB = makeRepo(root, "beta");
    return Effect.gen(function* () {
      const service = yield* WorkerWorkspace.WorkerWorkspace;
      const result = yield* Effect.result(
        service.create({
          threadId: WORKER_ID,
          repos: [
            { projectId: ProjectId.make("a") },
            { projectId: ProjectId.make("b"), baseBranch: "no-such-branch" },
          ],
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(worktreeList(repoA).match(/^worktree /gm)?.length, 1);
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "workspaces", "worker-thread-0001")));
    }).pipe(
      Effect.provide(
        makeLayer({ baseDir: root, projects: [project("a", repoA), project("b", repoB)] }),
      ),
    );
  });

  it.effect("refuses a folder that is not a git repository before creating anything", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
    const plain = NodePath.join(root, "plain");
    NodeFS.mkdirSync(plain);
    return Effect.gen(function* () {
      const service = yield* WorkerWorkspace.WorkerWorkspace;
      const error = yield* Effect.flip(
        service.create({ threadId: WORKER_ID, repos: [{ projectId: ProjectId.make("p") }] }),
      );
      assert.equal(error._tag, "WorkerWorkspaceRepoError");
    }).pipe(Effect.provide(makeLayer({ baseDir: root, projects: [project("p", plain)] })));
  });

  describe("remove", () => {
    const orchestrator = ThreadId.make("orchestrator");

    it.effect("refuses a thread that is not a worker", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const error = yield* Effect.flip(service.remove(WORKER_ID));
        assert.equal(error._tag, "WorkerWorkspaceNotWorkerError");
      }).pipe(
        Effect.provide(
          makeLayer({ baseDir: root, projects: [], thread: workerShell({ role: "orchestrator" }) }),
        ),
      );
    });

    it.effect("refuses paths outside the folders it creates in, and deletes nothing", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const victim = NodePath.join(root, "precious");
      NodeFS.mkdirSync(victim);
      const repo = makeRepo(root, "alpha");
      const forged = [
        { workspacePath: victim, repos: [] },
        {
          workspacePath: null,
          repos: [
            { projectId: ProjectId.make("a"), repoRoot: repo, worktreePath: victim, branch: "x" },
          ],
        },
        {
          workspacePath: NodePath.join(root, "workspaces", "..", "precious"),
          repos: [],
        },
        {
          workspacePath: null,
          repos: [
            {
              projectId: ProjectId.make("a"),
              repoRoot: NodePath.join(root, "worktrees", "repo"),
              worktreePath: NodePath.join(root, "worktrees", "repo"),
              branch: "x",
            },
          ],
        },
      ];
      return Effect.forEach(forged, (layout) =>
        Effect.gen(function* () {
          const service = yield* WorkerWorkspace.WorkerWorkspace;
          const error = yield* Effect.flip(service.remove(WORKER_ID));
          assert.equal(error._tag, "WorkerWorkspaceUnsafePathError");
          assert.ok(NodeFS.existsSync(victim));
        }).pipe(
          Effect.provide(
            makeLayer({
              baseDir: root,
              projects: [],
              thread: workerShell({ role: "worker", parentThreadId: orchestrator, ...layout }),
            }),
          ),
        ),
      );
    });

    it.effect("is a no-op once the workspace was removed", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const removed = yield* service.remove(WORKER_ID);
        assert.deepEqual(removed.removedWorktrees, []);
        assert.deepEqual(dispatched, []);
      }).pipe(
        Effect.provide(
          makeLayer({
            baseDir: root,
            projects: [],
            dispatched,
            thread: workerShell(
              {
                role: "worker",
                parentThreadId: orchestrator,
                workspacePath: NodePath.join(root, "workspaces", "gone"),
                repos: [],
              },
              null,
            ),
          }),
        ),
      );
    });

    it.effect("reports a git failure and leaves the thread pointing at its workspace", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const worktree = NodePath.join(root, "worktrees", "alpha");
      NodeFS.mkdirSync(worktree, { recursive: true });
      const dispatched: Array<OrchestrationCommand> = [];
      const failingGit = Layer.mock(GitWorkflowService.GitWorkflowService)({
        removeWorktree: (input) =>
          Effect.fail(gitFailure("removeWorktree", input.cwd, "worktree is locked")),
      });
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const error = yield* Effect.flip(service.remove(WORKER_ID));
        assert.equal(error._tag, "WorkerWorkspaceRemoveError");
        assert.deepEqual(dispatched, []);
      }).pipe(
        Effect.provide(
          makeLayer({
            baseDir: root,
            projects: [],
            dispatched,
            git: failingGit,
            thread: workerShell({
              role: "worker",
              parentThreadId: orchestrator,
              workspacePath: null,
              repos: [
                {
                  projectId: ProjectId.make("a"),
                  repoRoot: NodePath.join(root, "alpha"),
                  worktreePath: worktree,
                  branch: "x",
                },
              ],
            }),
          }),
        ),
      );
    });
  });

  it.effect("never adopts an existing workspace folder", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
    const repoA = makeRepo(root, "alpha");
    const repoB = makeRepo(root, "beta");
    const existing = NodePath.join(root, "workspaces", "worker-thread-0001");
    NodeFS.mkdirSync(existing, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(existing, "keep.txt"), "someone else's");
    return Effect.gen(function* () {
      const service = yield* WorkerWorkspace.WorkerWorkspace;
      const result = yield* Effect.result(
        service.create({
          threadId: WORKER_ID,
          repos: [{ projectId: ProjectId.make("a") }, { projectId: ProjectId.make("b") }],
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.ok(NodeFS.existsSync(NodePath.join(existing, "keep.txt")));
    }).pipe(
      Effect.provide(
        makeLayer({ baseDir: root, projects: [project("a", repoA), project("b", repoB)] }),
      ),
    );
  });

  describe("useExisting", () => {
    it.effect("runs in the project checkout like a local thread", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const repo = makeRepo(root, "alpha");
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const layout = yield* service.useExisting({ projectId: ProjectId.make("a") });
        assert.equal(layout.workspace, "existing");
        assert.equal(layout.worktreePath, null);
        assert.equal(layout.branch, null);
        assert.equal(layout.repos[0]?.worktreePath, repo);
        // Nothing was created.
        assert.equal(worktreeList(repo).match(/^worktree /gm)?.length, 1);
      }).pipe(Effect.provide(makeLayer({ baseDir: root, projects: [project("a", repo)] })));
    });

    it.effect("runs in an existing worktree of the project's repo, on its branch", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const repo = makeRepo(root, "alpha");
      const worktree = NodePath.join(root, "by-hand");
      git(repo, "worktree", "add", "-q", "-b", "feature/x", worktree);
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const layout = yield* service.useExisting({
          projectId: ProjectId.make("a"),
          path: worktree,
        });
        assert.equal(layout.workspace, "existing");
        assert.equal(NodeFS.realpathSync(layout.worktreePath!), NodeFS.realpathSync(worktree));
        assert.equal(layout.branch, "feature/x");
      }).pipe(Effect.provide(makeLayer({ baseDir: root, projects: [project("a", repo)] })));
    });

    it.effect("refuses a folder that is not a checkout of the project's repo", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const repo = makeRepo(root, "alpha");
      const otherRepo = makeRepo(root, "beta");
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const error = yield* Effect.flip(
          service.useExisting({ projectId: ProjectId.make("a"), path: otherRepo }),
        );
        assert.equal(error._tag, "WorkerWorkspaceRepoError");
        assert.include(error.message, "neither");
      }).pipe(Effect.provide(makeLayer({ baseDir: root, projects: [project("a", repo)] })));
    });

    it.effect("never removes a borrowed checkout", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worker-ws-"));
      const worktree = NodePath.join(root, "worktrees", "theirs");
      NodeFS.mkdirSync(worktree, { recursive: true });
      return Effect.gen(function* () {
        const service = yield* WorkerWorkspace.WorkerWorkspace;
        const error = yield* Effect.flip(service.remove(WORKER_ID));
        assert.equal(error._tag, "WorkerWorkspaceNotOwnedError");
        assert.ok(NodeFS.existsSync(worktree));
      }).pipe(
        Effect.provide(
          makeLayer({
            baseDir: root,
            projects: [],
            thread: workerShell(
              {
                role: "worker",
                parentThreadId: ThreadId.make("orchestrator"),
                workspacePath: null,
                workspace: "existing",
                repos: [
                  {
                    projectId: ProjectId.make("a"),
                    repoRoot: NodePath.join(root, "alpha"),
                    worktreePath: worktree,
                    branch: "x",
                  },
                ],
              },
              worktree,
            ),
          }),
        ),
      );
    });
  });
});
