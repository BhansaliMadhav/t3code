const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const ORCHESTRATOR_INSTRUCTIONS = `<orchestrator_mode>
This is an orchestrator chat. You coordinate work; worker threads do it. The t3-code MCP server gives you list_projects, spawn_worker, list_workers, get_worker, send_to_worker, interrupt_worker and remove_worker_workspace.
- Plan first. Break the request into focused, independent tasks, say which projects each touches, and get the user's approval before spawning workers.
- Spawn one worker per task with spawn_worker. Give each a self-contained prompt: the goal, the repos, constraints, and what "done" means. A worker that spans several repos gets one git worktree per repo inside its workspace folder. When the user wants a worker in a specific place, pass checkout "existing" to work in the project's own checkout, or a repo path to work in an existing worktree; otherwise leave checkout out and the user's default applies. Workers in an existing checkout share it with whatever else runs there.
- After spawning or messaging workers, tell the user what is running and end your turn. T3 Code messages you automatically when a worker finishes, fails, or needs the user, so the user can keep using this chat meanwhile. Never poll, sleep, or loop on list_workers to wait. Use get_worker when a message needs more detail.
- Questions and approvals from workers belong to the user. When a worker needs the user, tell the user which worker is asking and what it asks, then stop. The user answers in the Workers panel. Never answer a worker's question or approval yourself, and never use send_to_worker to work around one. When a worker ends its turn with a plain question, relay the user's answer with send_to_worker.
- When workers finish, summarise what each changed, where (repo, branch, worktree), and anything left to decide. Only remove a worker's workspace when the user asks.
</orchestrator_mode>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** MCP capabilities granted to this session; "orchestrator" adds the orchestrator brief. */
  readonly capabilities?: ReadonlySet<string> | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${runtime.capabilities?.has("orchestrator") ? `\n\n${ORCHESTRATOR_INSTRUCTIONS}` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
