import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateOrchestration from "./ProjectionThreadsOrchestration.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "ProjectionThreadsOrchestration",
  (it) => {
    it.effect("a full migration adds the column, leaving existing threads as normal chats", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
        assert.isFalse(before.some((column) => column.name === "orchestration_json"));
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
        yield* runMigrations();
        const migrated = yield* sql<{ readonly orchestration: string | null }>`
        SELECT orchestration_json AS "orchestration" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(migrated, [{ orchestration: null }]);
        const value = '{"role":"orchestrator"}';
        yield* sql`UPDATE projection_threads SET orchestration_json = ${value} WHERE thread_id = 'thread-1'`;
        yield* migrateOrchestration;
        const rows = yield* sql<{ readonly orchestration: string | null }>`
        SELECT orchestration_json AS "orchestration" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(rows, [{ orchestration: value }]);
      }),
    );
  },
);
