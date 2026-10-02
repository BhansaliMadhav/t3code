import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShells } from "./state/entities";

/** The orchestrator chat to reopen: the most recently updated one that isn't archived. */
export function latestOrchestratorThread<
  T extends Pick<EnvironmentThreadShell, "orchestration" | "archivedAt" | "updatedAt">,
>(threads: ReadonlyArray<T>): T | null {
  let latest: T | null = null;
  for (const thread of threads) {
    if (thread.orchestration?.role !== "orchestrator" || thread.archivedAt !== null) continue;
    if (latest === null || thread.updatedAt > latest.updatedAt) latest = thread;
  }
  return latest;
}

/** For "Go to orchestrator" entry points, which act on the current shell list once. */
export function readLatestOrchestratorThreadRef(): ScopedThreadRef | null {
  const thread = latestOrchestratorThread(readThreadShells());
  return thread ? scopeThreadRef(thread.environmentId, thread.id) : null;
}
