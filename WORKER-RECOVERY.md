# Cloudflare Worker storage recovery

Use this guide for `mirror-worker` and its SQLite-backed `MirrorStorage`
Durable Object. The Node filesystem commands in `scripts/storage.mjs` and
`storage:drill` do not back up or restore this database. This repository has
no operator endpoint or CLI for Durable Object recovery. Production recovery
requires an authorized operator and a separately reviewed recovery mechanism.

## Record the installation before an upgrade

Keep the previous and candidate source revisions, lockfile, Worker deployment
version, compatibility date/flags, target account/environment, and Durable
Object namespace identity. The `MIRROR` binding routes to `MirrorStorage` using
the name `mirror-single-account`. Preserve that binding, namespace, class, and
object identity: changing them can select an empty database instead of
recovering the existing one. Wrangler's `v1` class migration provisions the
SQLite namespace; it is separate from the application schema version.

Retain the exact `MIRROR_STORE_KEY` in secure secret storage outside the
database. Retain the owner account configuration and required bindings too.
The key decrypts persisted account metadata; the database cannot recreate a
lost key. Transcript text is not encrypted by this application. Do not put
keys, tokens, or database contents into logs or issue reports. Request-held
ChatGPT credentials are not a database recovery mechanism: clients must
authenticate again after recovery.

When authorized diagnostics are available, record `storage.schemaVersion`
and `storage.healthy`. The top-level `schemaVersion` describes the diagnostics
response format. `/api/health` checks local database liveness. Egress fields
`mode: "warp-vpc"`, `verified: false`, and `checkedAt: null` describe the configured
transport, without asserting WARP or ChatGPT connectivity. Protected diagnostics
require a successful owner identity check, so an upstream authentication or
network failure can make diagnostics unavailable even when storage is intact.

## Application migrations and restart behavior

The current application schema is version **1**. Worker startup reads its
version from `mirror_schema` (`id = 1`), not `PRAGMA user_version`. A historical
Worker database without that row is treated as version 0. The shared baseline
preserves existing data and adds missing `attachments_json`, `is_private`, and
`is_branch` columns. Supported schema inspection uses `PRAGMA table_info`.

All pending migrations and their version advances run synchronously inside
`ctx.storage.transactionSync()`. A thrown migration error rolls back that
transaction, including creation of the version table. The constructor fails
instead of serving an incompletely migrated store. Retrying initialization
can succeed after the cause is fixed; repeated startup at the current version
does not replay migrations. An unsupported newer, negative, or fractional
version is refused. Do not lower or delete the version marker to bypass this
check. Append future migrations in `apps/server/src/schema.ts`.

After migration, startup marks persisted `streaming` messages as `interrupted`
and removes old saved session/access credentials. It preserves valid account
metadata; unreadable session metadata is discarded. These cleanup operations
follow the schema transaction. Startup does not resume an upstream generation,
nor does it advance a conversation's saved continuation pointer just because
an answer was interrupted. Inspect the transcript before retrying an operation
that may have reached the upstream service.

## Respond to a failed upgrade

1. Stop client traffic through the installation's existing operational control
   and retain the failing deployment revision and sanitized error. Mirror has
   no built-in maintenance mode. Avoid new writes while choosing a recovery
   point. Preserve the existing namespace and its data.
2. Classify the failure. Missing bindings/secrets and upstream identity failures
   are configuration or connectivity problems; a data restore is not their
   default remedy. For a migration exception, retain the failing schema/version
   evidence and fix the migration cause without bypassing its version check.
3. Select a compatible code revision. A code rollback does not undo committed
   data changes. Older code without version checks may accept incompatible
   storage; compatibility must be established before it handles requests.
4. If database contents must be restored, use the platform recovery route below
   only after confirming the exact object, target time, expected data loss, and
   matching encryption key. There is no supported app command to substitute.
5. After recovery, confirm schema version and local health, expected settings,
   transcript content, and continuation identifiers. Authenticate as the owner
   and separately perform authorized model discovery and a disposable generation
   through the actual WARP binding before restoring normal traffic. A local
   synthetic test does not establish those production results.

## Platform recovery capability and current gap

Cloudflare documents point-in-time recovery (PITR) for SQLite-backed Durable
Objects within the previous 30 days. It restores the object's whole SQL/KV
database. The API obtains a bookmark with `getCurrentBookmark()` or
`getBookmarkForTime()`, schedules it with `onNextSessionRestoreBookmark()`, and
applies it on the next object restart. Keep the returned undo bookmark when
using that procedure. PITR is unavailable in local development.
See [Cloudflare's storage and PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).

Mirror does not expose those methods, capture bookmarks automatically, or
provide a tested production restore workflow. Do not add a public restore
route, delete the namespace, invoke `deleteAll()`, or reset a schema marker as
an incident shortcut. Before production rollout, an authorized operator must
establish and rehearse a restricted platform recovery mechanism in a disposable
deployed environment, including restoration with the matching key and recovery
from a constructor that cannot complete its migration. A successful local
restart or Node backup drill does not close this gap.

## Local evidence and its limits

Run the candidate's `npm run typecheck`, `npm run test:worker`, and
`npm run coverage` with Node 24 and locked dependencies. Keep the command output
with the exact revision. Keep the existing per-file 100% coverage threshold.

The production-entrypoint workerd tests cover owner rejection, settings and
schema version across a full local runtime restart, and stored JSON/SSE
transcripts. Native migration fixtures separately exercise the production
migrator against actual Durable Object SQL. Adapter tests cover credential
cleanup and interrupted-message recovery using synthetic Node SQLite storage;
they do not alone prove a deployed Durable Object restart. Local tests use no
production credentials or bindings and do not prove PITR, deployed WARP routing,
or live upstream continuation. Record each of those acceptance results separately.
