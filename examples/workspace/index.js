function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

async function parseInput(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/files") return json({ error: "not_found" }, 404);
  if (request.method !== "PUT" && request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET, PUT" } });
  }
  let input;
  if (request.method === "PUT") {
    try {
      input = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!input || typeof input.content !== "string" ||
      !Number.isSafeInteger(input.currentVersion) || input.currentVersion < 0 ||
      input.currentVersion >= Number.MAX_SAFE_INTEGER) {
      return json({ error: "invalid_input" }, 400);
    }
  } else {
    input = {
      workspaceId: url.searchParams.get("workspaceId"),
      filename: url.searchParams.get("filename"),
    };
    if (url.searchParams.has("version")) {
      const version = url.searchParams.get("version");
      if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) {
        return json({ error: "invalid_version" }, 400);
      }
      input.version = Number(version);
    }
  }
  if (!nonempty(input.workspaceId) || !nonempty(input.filename)) {
    return json({ error: "workspaceId_and_filename_required" }, 400);
  }
  return input;
}

export class Workspace {
  constructor(state) {
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS file_versions (
        filename TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        content TEXT NOT NULL,
        PRIMARY KEY (filename, version)
      )
    `);
  }

  async fetch(request) {
    const input = await parseInput(request);
    if (input instanceof Response) return input;
    const { workspaceId, filename } = input;

    if (request.method === "GET") {
      const row = input.version === undefined
        ? this.sql.exec(
          "SELECT version, content FROM file_versions WHERE filename = ? ORDER BY version DESC LIMIT 1",
          filename,
        ).toArray()[0]
        : this.sql.exec(
          "SELECT version, content FROM file_versions WHERE filename = ? AND version = ?",
          filename, input.version,
        ).toArray()[0];
      return row
        ? json({ workspaceId, filename, ...row })
        : json({ error: "not_found" }, 404);
    }

    // No await between comparison and insert. transactionSync also rolls back
    // the write on failure. Every request for this workspace reaches this DO.
    const result = this.storage.transactionSync(() => {
      const latest = this.sql.exec(
        "SELECT version FROM file_versions WHERE filename = ? ORDER BY version DESC LIMIT 1",
        filename,
      ).toArray()[0];
      const currentVersion = latest?.version ?? 0;
      if (input.currentVersion !== currentVersion) {
        return { error: "version_conflict", workspaceId, filename, currentVersion };
      }
      const version = currentVersion + 1;
      this.sql.exec(
        "INSERT INTO file_versions (filename, version, content) VALUES (?, ?, ?)",
        filename, version, input.content,
      ).toArray();
      return { workspaceId, filename, version };
    });
    // celld's output gate holds the response until the write is durable.
    return json(result, result.error ? 409 : 200);
  }
}

export default {
  async fetch(request, env) {
    // Validate before creating a DO; leave the forwarded body readable.
    const input = await parseInput(request.clone());
    if (input instanceof Response) return input;
    return env.WORKSPACES.getByName(input.workspaceId).fetch(request);
  },
};
