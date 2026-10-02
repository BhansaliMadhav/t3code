# Orchestrator chats

An orchestrator chat plans a piece of work with you, then starts worker
threads to do it. Each worker gets its own git worktree on a new branch, and a
worker can change several repositories at once. You follow the workers from
the orchestrator chat and answer their questions yourself.

## Start one

Switch the composer's **Normal** control to **Orchestrator** before sending
the first message of a new chat. The mode is fixed once the chat exists. To
start every new chat as an orchestrator, set **Settings → General → Default
chat mode** to **Orchestrator**; the app then also opens your latest
orchestrator chat when it starts. You can also use **New orchestrator chat**
and **Go to orchestrator** in the command palette.

An orchestrator chat lives in the project you started it from, but it can
start workers in any project in the environment that is a git repository.

## Where workers run

By default each worker gets fresh worktrees on new branches. To have a worker
work in the project's own checkout, or in a worktree you already have, tell
the orchestrator, for example "run this worker in the project checkout" or
"use the worktree at ~/code/app-feature". The folder must be the project's
checkout or a git worktree of that project's repository. To make the project
checkout the default, set **Settings → General → Where workers run** to
**Project checkout**.

A worker in an existing checkout shares it with you and any other worker
there, and T3 Code never deletes it. Keep workers that edit the same files out
of the same folder.

## Follow and answer workers

Workers appear indented under their orchestrator in the sidebar. The
orchestrator row shows how many workers are waiting on you. The **Workers**
panel on the right lists each worker with its status, repositories, and
branches. Expand a worker to see the end of its latest reply and, for
workers spanning several repositories, the changes in each one.

You don't have to wait on the orchestrator while workers run. Once it starts
them it ends its turn, and the chat is yours again. When a worker finishes,
fails, or needs you, T3 Code posts an automatic update in the orchestrator
chat and the orchestrator picks it up from there. If the orchestrator is busy
at that moment, the update waits until it is done, and several updates arrive
together.

When a worker asks a question or needs an approval, answer it right in the
Workers panel, or open the worker. The orchestrator tells you which worker is
asking but never answers for you. If a worker ends its turn with a question in
its reply, tell the orchestrator your answer and it passes it on.

## Clean up

Workers keep their worktrees until you remove them. Choose **Remove workspace**
on a worker in the Workers panel to delete its worktrees. Uncommitted changes
in them are lost; the branches stay, so committed work remains in each
repository. Archived workers that still have a workspace are listed under
**Archived workers** in the panel. Deleting a worker that spans several
repositories asks whether to remove its worktrees too.

## Limits

- A worker that spans several repositories runs in a folder holding one
  worktree per repository, so its turns have no diffs in the chat. Use the
  Workers panel or a terminal to review its changes.
- Workers do not run project setup scripts.
- OpenCode workers in a sandboxed permission mode may be unable to commit,
  because the repository's git data lives outside the worktree.
- The mobile app shows workers as ordinary threads.
