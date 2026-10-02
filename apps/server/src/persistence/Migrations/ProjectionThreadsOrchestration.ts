/**
 * Adds projection_threads.orchestration_json for orchestrator chats. Not a
 * numbered migration (see runMigrations), so it must stay idempotent.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "orchestration_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN orchestration_json TEXT
    `;
  }
});
