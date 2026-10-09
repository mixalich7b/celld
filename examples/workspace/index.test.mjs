import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker, { Workspace } from "./index.js";

// Exercise the actual Worker and SQL against SQLite. Only the DO host API
// is adapted; this does not simulate celld replication or its output gate.
function fleet(t) {
  const databases = new Map();
  const instances = new Map();
  const env = {
    WORKSPACES: {
      getByName(name) {
        if (!databases.has(name)) databases.set(name, new DatabaseSync(":memory:"));
        if (!instances.has(name)) {
          const db = databases.get(name);
          const storage = {
            sql: {
              exec(query, ...bindings) {
                const rows = db.prepare(query).all(...bindings);
                return { toArray: () => rows };
              },
            },
            transactionSync(callback) {
              db.exec("BEGIN");
              try {
                const result = callback();
                db.exec("COMMIT");
                return result;
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            },
          };
          instances.set(name, new Workspace({ storage }));
        }
        return instances.get(name);
      },
    },
  };
  t.after(() => { for (const db of databases.values()) db.close(); });
  return {
    databases,
    instances,
    request: (request) => worker.fetch(request, env),
    write: (input) => worker.fetch(new Request("http://example/files", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }), env),
    read: (workspaceId, filename, version) => {
      const query = new URLSearchParams({ workspaceId, filename });
      if (version !== undefined) query.set("version", String(version));
      return worker.fetch(new Request(`http://example/files?${query}`), env);
    },
  };
}

const initial = {
  workspaceId: "project-a", filename: "src/main.js", content: "first", currentVersion: 0,
};

test("creates a workspace lazily and retains old file versions across reactivation", async (t) => {
  const app = fleet(t);
  assert.equal(app.databases.size, 0);
  const created = await app.write(initial);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).version, 1);
  const updated = await app.write({ ...initial, content: "second", currentVersion: 1 });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).version, 2);
  app.instances.clear();
  assert.equal((await (await app.read("project-a", "src/main.js")).json()).content, "second");
  assert.equal((await (await app.read("project-a", "src/main.js", 1)).json()).content, "first");
});

test("concurrent creates and updates each have exactly one winner and preserve history", async (t) => {
  const app = fleet(t);
  for (const currentVersion of [0, 1]) {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, n) =>
      app.write({ ...initial, currentVersion, content: `round-${currentVersion}-${n}` })));
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal(responses.filter((r) => r.status === 409).length, 11);
    for (const response of responses.filter((r) => r.status === 409)) {
      assert.equal((await response.json()).currentVersion, currentVersion + 1);
    }
  }
  const rows = app.databases.get("project-a").prepare(
    "SELECT version FROM file_versions ORDER BY version",
  ).all();
  assert.deepEqual(rows.map((row) => row.version), [1, 2]);
});

test("a failed CAS cannot create a version, including for a missing file", async (t) => {
  const app = fleet(t);
  const missing = await app.write({ ...initial, currentVersion: 5 });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).currentVersion, 0);
  assert.equal((await app.read("project-a", "src/main.js")).status, 404);
  await app.write(initial);
  assert.equal((await app.write({ ...initial, content: "loser" })).status, 409);
  assert.equal((await (await app.read("project-a", "src/main.js")).json()).content, "first");
});

test("workspaces are isolated and filenames have independent version counters", async (t) => {
  const app = fleet(t);
  for (const input of [initial, { ...initial, filename: "other.txt", content: "" },
    { ...initial, workspaceId: "project-b", content: "different" }]) {
    assert.equal((await (await app.write(input)).json()).version, 1);
  }
  assert.equal(app.databases.size, 2);
  assert.equal((await (await app.read("project-a", "other.txt")).json()).content, "");
  assert.equal((await (await app.read("project-b", "src/main.js")).json()).content, "different");
  assert.equal((await app.read("project-a", "src/main.js", 2)).status, 404);
});

test("rejects invalid input before activating a workspace", async (t) => {
  const app = fleet(t);
  for (const input of [null, [], { ...initial, workspaceId: "" },
    { ...initial, filename: "" }, { ...initial, content: 1 },
    { ...initial, currentVersion: -1 }, { ...initial, currentVersion: 1.5 },
    { ...initial, currentVersion: "0" }, { ...initial, currentVersion: Number.MAX_SAFE_INTEGER }]) {
    assert.equal((await app.write(input)).status, 400);
  }
  assert.equal((await app.request(new Request("http://example/files", {
    method: "PUT", body: "{",
  }))).status, 400);
  assert.equal((await app.read("project-a", "x", "bad")).status, 400);
  assert.equal((await app.request(new Request("http://example/unknown"))).status, 404);
  assert.equal((await app.request(new Request("http://example/files", { method: "DELETE" }))).status, 405);
  assert.equal(app.databases.size, 0);
});
