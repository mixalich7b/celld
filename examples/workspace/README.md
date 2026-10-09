# Versioned workspace files

One `workspaceId` maps to one `Workspace` Durable Object via `getByName()`.
The first request activates the object and creates its SQLite schema. All
files and their complete version history live in that object's database.
Filenames are literal logical keys, not paths on the host filesystem.

Versions are **per file**, not per workspace. A missing file has version `0`.
Each accepted write appends a row at the next version, even if its content is
unchanged. A synchronous SQLite transaction compares the supplied version
and inserts the new row without an intervening `await`. An outdated version
returns HTTP 409 and adds no row. Different filenames advance independently.
A failed first write may create an empty workspace, but creates no file.

## Run and deploy

Install `celld` and put `esbuild` on `PATH`, then run from this directory:

```sh
celld dev .
```

The local address is `http://127.0.0.1:9876`. To publish to an existing fleet,
use the same bucket and prefix as its nodes, with your storage credentials:

```sh
celld deploy . --bucket s3://my-cells-bucket
```

Add `--endpoint URL --region REGION` for an S3-compatible provider when needed.
Nodes adopt the deployment automatically (the default poll interval is 30 s).
Keep the Worker name and DO class name stable: changing them changes the
object identity and reaches different databases.

## HTTP API

Create a file (and its workspace on first use):

```sh
curl -i -X PUT http://127.0.0.1:9876/files \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"demo","filename":"src/main.js","content":"console.log(1);","currentVersion":0}'
```

HTTP 200:

```json
{"workspaceId":"demo","filename":"src/main.js","version":1}
```

Update using the version returned by the last read or write:

```sh
curl -i -X PUT http://127.0.0.1:9876/files \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"demo","filename":"src/main.js","content":"console.log(2);","currentVersion":1}'
```

This returns version `2`. Repeat the same request and it returns HTTP 409:

```json
{"error":"version_conflict","workspaceId":"demo","filename":"src/main.js","currentVersion":2}
```

Read the latest version, or a specific historical version:

```sh
curl 'http://127.0.0.1:9876/files?workspaceId=demo&filename=src%2Fmain.js'
curl 'http://127.0.0.1:9876/files?workspaceId=demo&filename=src%2Fmain.js&version=1'
```

A successful read returns `workspaceId`, `filename`, `version`, and `content`.
A missing file or version returns 404. Malformed input returns 400. Empty
content is allowed. `currentVersion` must be a nonnegative safe JavaScript
integer smaller than `Number.MAX_SAFE_INTEGER`.

When two requests use the same expected version, exactly one can commit; the
other gets 409. Read the latest content and resolve the conflict before retrying.
If a response is lost after a commit, repeating that write also returns 409;
this example has no request-id deduplication.

## Storage and scope

There is one SQLite database per workspace. celld persists it to S3 through
its native LTX replication under the cell's storage prefix; it does **not**
maintain a single downloadable `workspace.sqlite` object in S3. A requirement
for exactly one S3 object per workspace needs a separate snapshot/export
design. Do not upload a SQLite file over celld's live replication objects.

The runtime's output gate waits for durability before returning a successful
write response. On a single node this waits for object storage; a fleet may
acknowledge after follower disks hold the write and upload to S3 afterwards.

This example retains every full version and has no authentication or access
control. Add workspace authorization before forwarding public requests.

## Tests

With Node.js 22.13+ (no npm dependencies):

```sh
npm test
```

The tests run the actual Worker handlers and SQL against Node's SQLite,
adapting the Durable Object host API. They cover concurrent CAS, retained
history, reactivation, workspace isolation, independent file versions, and
invalid inputs. They do not exercise celld's network routing, output gate,
S3 replication, or recovery after node failure.
