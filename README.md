# Mirror

[![CircleCI](https://circleci.com/gh/defcron/mirror.svg?style=svg)](https://circleci.com/gh/defcron/mirror) [![GitHub Actions CI](https://github.com/defcron/mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/defcron/mirror/actions/workflows/ci.yml) [![Coverage](https://codecov.io/github/defcron/mirror/branch/main/graph/badge.svg)](https://app.codecov.io/github/defcron/mirror) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.nvmrc)

Mirror is a self-hosted ChatGPT client and OpenAI-compatible API. Its web interface serves the official ChatGPT application through a local proxy, so conversations and Custom GPTs use your ChatGPT account without an OpenAI API key or browser automation. Mirror also provides a Playground, conversion tools for four file formats, and a REST/SSE API.

> **Unofficial project:** Mirror relies on ChatGPT's private web protocol, which may change without notice. This fork includes a draft Cloudflare Worker deployment restricted to one configured ChatGPT owner. See [PROTOCOL.md](PROTOCOL.md) for implementation details and known limitations.

For the Worker, start with [Cloudflare Worker setup](#deploy-as-a-cloudflare-worker) and [Worker recovery](WORKER-RECOVERY.md). The Docker and Node instructions below describe local installations.

## Local quick start (Docker)

You need Docker and an active ChatGPT account in your browser.

1. Copy your session token from [ChatGPT's session page](https://chatgpt.com/api/auth/session) while signed in.
2. Configure and start Mirror:

   ```sh
   cp .env.example .env
   docker compose up --build
   ```

3. Open [http://127.0.0.1:8799](http://127.0.0.1:8799). Select **Mirror controls** in the ChatGPT sidebar, paste the token, and choose **Save & reload**.

By default, Mirror keeps credentials in this browser's local storage. It tries the Bearer value as a ChatGPT accessToken first; only after an upstream authentication denial does it exchange a sessionToken. If ChatGPT rotates the session token during that exchange, Mirror returns the new value to the browser. Request-supplied tokens are not persisted by the Worker; optional configured credentials are stored as Worker secrets. Native previews, media and downloads use host-only Secure, SameSite=Strict browser-session cookies across the Mirror origin. The Worker accepts these credentials only for owner-checked GET/HEAD requests; writes still require explicit authentication. Large credentials are split into cookie chunks. Cookies remain JavaScript-readable to synchronize native-request refreshes with local storage; no server credential database is added.

External links and direct conversation URLs open the public reconnect form at the requested address. Standard `/c/<id>`, nested GPT/project `/g/g-<slug>/c/<id>`, and project landing paths keep their path, query, and fragment through reconnect. Protected documents still require the configured owner; API and cross-site mutation checks are unchanged. The form does not accept an external return destination or follow credential-bearing redirects.

The Worker verifies its configured owner before accepting a refreshed credential. Streaming routes settle refresh before sending SSE headers; later authentication failures end the request without refreshing or replaying it. The reconnect page retains an owner-verified refresh if loading the document fails, and only clears saved credentials after an explicit credential rejection or owner mismatch. Transport failures, upstream challenges, and malformed session responses do not mean the credential is invalid.

API clients must retain `x-mirror-access-token` and `x-mirror-session-token` response headers and send their current values on later requests. Headers alone do not make a fixed API key survive ChatGPT credential rotation. Mirror does not currently provide persistent refresh credentials behind a stable, revocable client key.


## ChatGPT features

Mirror proxies the official ChatGPT interface rather than rebuilding it. ChatGPT account features such as conversation history, Custom GPTs, branching, editing, regeneration, uploads, generated images, Markdown, and KaTeX remain available through the proxy.

Mirror adds **Decoder challenges** to the controls panel. Create a challenge in LoaF, PngSpeak, gptgif, or gptgif v4, then ask GPT to decode the artifact. You can insert the prompt into the composer, copy it, or download it with the artifact. Optional downloadable kits include one file and prompt per format. After GPT replies, Mirror can check its answer against a temporary server-side key. Keys expire after 24 hours, a server restart, or a session change; Mirror retains at most 64 active challenges and allows 20 generations per minute. See the API docs for the complete challenge routes and limits.

## Playground and conversion API

Open **API tester** in Mirror controls or visit [http://127.0.0.1:8799/mirror/playground](http://127.0.0.1:8799/mirror/playground). The Playground exercises `/v1/chat/completions` and `/v1/responses` without a separate client. Chat mode supports text and file/image attachments; Responses mode currently accepts text only. Conversation history can be continued through Mirror's conversation ID.

The conversion API exposes LoaF, PngSpeak, gptgif, and gptgif v4 under `/api/convert/*`. It accepts JSON with base64 payloads by default, or raw bytes through `raw_in`, `raw_out`, and `raw` query options. The original gptgif format requires a calibrated cluster map to decode. The API reference at `/mirror/api-docs` is generated from the running server and includes current request schemas and responses.

## OpenAI-compatible API

Set an OpenAI SDK's base URL to `http://127.0.0.1:8799/v1`. For example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8799/v1",
    api_key="your-chatgpt-session-token",
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

Mirror provides `GET /v1/models` and `POST /v1/chat/completions` (streaming and non-streaming). The supported request fields and known differences from OpenAI are documented in [COMPATIBILITY.md](COMPATIBILITY.md). Mirror does not call `api.openai.com`; `OPENAI_API_KEY` is an optional alias for a configured ChatGPT credential.

Programmatic clients can pass a ChatGPT accessToken or sessionToken as the Bearer credential, for example as the OpenAI SDK's `api_key`. Mirror sends the session token as ChatGPT's `__Secure-next-auth.session-token` cookie on upstream API calls and tries the accessToken as Bearer authentication first. Clients may send their session token separately in `x-mirror-session-token`; a rotated session token is returned in the response header with the same name. Configured tokens are selected in this order: `MIRROR_API_KEY`, entries in `MIRROR_API_KEYS`, then `OPENAI_API_KEY`. When the inbound Bearer matches a configured token, the first configured token supplies the upstream authentication cookie and access-token fallback. These settings must contain ChatGPT credentials, not an unrelated generated key. Unmatched client-held credentials authenticate independently and must still resolve to the configured owner on Workers. Native browser navigation can establish a same-origin control cookie in Node installations; Worker reads require an owner-verified request credential or native-read cookie; writes require explicit request authentication. Node retains its existing control-cookie and exact asset-route behavior.

To configure an upstream credential, set a ChatGPT session token in `.env` as `MIRROR_API_KEY`, or supply it as a Worker secret.

## Run without Docker

For development, use Node.js 24:

```sh
nvm use
npm ci
npm run dev
```

This starts the server on `127.0.0.1:8787` and the web development server on port `5173`. A direct `npm start` runs the production server on `HOST:PORT` (defaults `127.0.0.1:8787`).

## Deploy as a Cloudflare Worker

The draft Worker build serves Mirror's HTTP routes and browser assets for one configured ChatGPT owner. The `MIRROR` binding stores that installation's data in one SQLite-backed `MirrorStorage` Durable Object. WebSocket upgrades return HTTP 501. This is not a multi-user hosting model.

Configure `MIRROR_STORE_KEY` and `MIRROR_OWNER_ACCOUNT_ID` as Worker secrets; startup requires both. The key must decode to 32 bytes from base64 or be 64 hex characters. Despite the retained secret name, set the owner value to the top-level `id` (for example, `user-…`) from the owner's authenticated ChatGPT `/backend-api/me` response with `object: "user"`. This is the user principal, not a Sites account-user ID, email, organization, or workspace routing ID. Keep the key and credentials out of logs and issues. Preserve the exact key for recovery: changing it does not re-encrypt existing metadata or sealed asset tickets.

ChatGPT upstream traffic uses the `WARP` Workers VPC Network binding (`cf1:network`), including session exchanges, backend requests, uploads, downloads, and their response streams. This routes Worker egress through the account's Cloudflare Mesh/Gateway network and its existing policies. It does not run a WARP client inside the Worker or change the public browser-to-Worker entry point. Gateway connection failures are reported rather than retried over ordinary Worker egress. Configure the account's Zero Trust network and Gateway policies to allow the required destinations; the binding does not guarantee ChatGPT authentication acceptance. Node deployments continue using their normal fetch transport.

```sh
npm ci
npm run typecheck
npm run test:worker
npm run coverage
```

These checks use synthetic upstream fixtures. Before production rollout, complete the [Worker recovery readiness and live acceptance requirements](WORKER-RECOVERY.md). The deployment commands are:

```sh
npm run build:worker
npx wrangler secret put MIRROR_STORE_KEY
npx wrangler secret put MIRROR_OWNER_ACCOUNT_ID
npx wrangler deploy
```

Paste a securely generated key when Wrangler prompts. `MIRROR_API_KEY`, `MIRROR_API_KEYS`, and `OPENAI_API_KEY` are optional Worker secrets for configured upstream ChatGPT credentials. Protected requests are checked against ChatGPT's `/me` endpoint and must resolve to the configured owner; an unavailable identity check fails closed, including for stored-history routes. Browser bootstrap, static assets, and `/api/health` are public. Changing the owner secret is not a data migration; review existing data ownership before any owner change.

For development with real configured bindings, add the required secrets to `.dev.vars` and run `npm run dev:worker`. The checked-in Wrangler configuration marks `WARP` as a remote binding, so this command is distinct from the isolated synthetic `test:worker` acceptance harness.

`GET /api/health` reports local database liveness. A successful response does not prove upstream connectivity. Owner-authenticated `GET /api/diagnostics` reports the persisted `storage.schemaVersion`; Worker version 1 is stored in `mirror_schema`, separately from Wrangler's namespace migration tag. Egress reports `mode: "warp-vpc"`, `verified: false`, and `checkedAt: null` until a real check is implemented. Model discovery and generation require separate live acceptance evidence. See [WORKER-RECOVERY.md](WORKER-RECOVERY.md) for migration failure handling, restart behavior, and the current production restore gap.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIRROR_PORT` | `8799` | Host port for Docker Compose. |
| `HOST` | `127.0.0.1` | Bind address for a direct, non-Compose run. |
| `PORT` | `8787` | Port for a direct, non-Compose run. |
| `MIRROR_WEB_ORIGIN` | `http://localhost:5173` | Web origin used for development CORS. |
| `MIRROR_DATA_DIR` | `.data` (Node only) | Node filesystem directory for the SQLite database and generated key; does not select Durable Object storage. |
| `MIRROR_STORE_KEY` | generated on Node; required on Workers | 32-byte key (base64 or hex) for encrypted session metadata and sealed asset tickets; does not encrypt transcripts. |
| `MIRROR_OWNER_ACCOUNT_ID` | required on Workers | Sole allowed ChatGPT user principal (`id` in authenticated `/me` with `object: "user"`); distinct from workspace routing IDs. |
| `MIRROR_API_KEY` | unset | First-preference ChatGPT token, forwarded as the upstream authentication cookie for matching configured clients. |
| `MIRROR_API_KEYS` | unset | Comma-separated accepted tokens; first entry supplies the upstream cookie when `MIRROR_API_KEY` is unset. |
| `OPENAI_API_KEY` | unset | Last-preference ChatGPT token for the upstream cookie; this is not an OpenAI platform API key. |

Compose uses `MIRROR_PORT`; direct runs use `HOST` and `PORT`. Worker bindings and secrets are configured with Wrangler.


Production updates on `codex/worker-reliability` are deployed by the GitHub Actions
`CI` workflow after its build, coverage, browser, workerd, and container checks pass.
The browser and workerd acceptance tests use the retained Worker bundle that the
deploy job uploads with `--no-bundle`; the artifact records its commit SHA and file
hashes. A production concurrency group serializes uploads, and stale branch runs
skip deployment. Do not manually deploy while this workflow owns production.

Actions are enabled for this fork. The existing
organization secret `CLOUDFLARE_API_TOKEN` is available to this public repository;
its access to the existing Worker is checked by the deployment job. A replacement
token should have Editor access limited to this Worker; do not copy a local OAuth login into CI. The
account and target branch are explicit in `.github/workflows/ci.yml`. A README
clarification on that branch is a useful push-trigger check: verify the `CI` run
reaches `deploy` and retain its deployment receipt. Missing credentials or disabled
fork workflows must be resolved before pushing a production change.

Deployment is currently paused at an explicit CI gate because the existing token
was rejected when binding `WARP`. After confirming that this exact token has
`Connectivity Directory Bind` for account `711ab96baee8597bf61ed973363715d6`, set
the repository Actions variable `MIRROR_VPC_BIND_CONFIRMED` to `true` and rerun the
failed deployment job. Its retained artifact must still match the deployment
branch head. The build, test, artifact-integrity, and binding-preservation checks
remain required; do not remove `WARP` or use ordinary Worker egress to bypass a
permission failure. An unset or false variable stops the job before deployment
credentials are used. Pushes from a GitHub account with an unverified email are
rejected by Actions before jobs start; verify that account's email before using it
to trigger CI.

## Security and data

Node installations bind to loopback by default and normally reject non-loopback hosts. The draft Worker instead serves its configured public HTTPS endpoint and checks protected requests against its single configured ChatGPT owner. Public bootstrap, assets, and local health do not grant access to protected history or generation. Neither deployment mode provides multi-user tenant isolation.

The browser stores the accessToken and, when available, the sessionToken in local storage for the Mirror origin. Same-origin API calls use the current stored credentials; a different API origin uses the separately supplied key rather than the Mirror browser credentials. Host-only Secure, SameSite=Strict session cookies support owner-checked Worker GET/HEAD requests, including native Spaces/Library images and downloads. These cookies are JavaScript-readable and carry the browser-held credentials; they are not accepted for state-changing requests or cross-site reads. Clearing the playground credential removes both the native-read cookies and the legacy `/api/asset-content` cookie. Authenticated fetches reject redirects; XHR uses only the standard Authorization header, which browsers strip across origins. Native cookies are never forwarded to third-party hosts. The legacy exact asset-route cookie remains for Node compatibility. The Worker handles request-supplied tokens in memory and does not persist them in its database. Optional configured credentials persist as Worker secrets. Startup removes older stored session/access credentials while retaining valid account metadata. Device metadata may be stored before an explicit session save.

`MIRROR_STORE_KEY` encrypts the session metadata setting and seals asset tickets. Conversation text, instructions, events, and most other settings are not encrypted by the application, whether stored in the Node database or the Durable Object. Node request logs redact credential and cookie headers; the Worker's Fastify request logger is disabled. Treat diagnostics, exports, and any platform logs as sensitive.

Worker persistence survives object restarts, but Mirror has no Durable Object backup/restore CLI or operator endpoint. Local workerd tests and Node restore drills do not prove production point-in-time recovery. Follow [WORKER-RECOVERY.md](WORKER-RECOVERY.md) for the remaining platform recovery rehearsal and key-retention requirements.

For **Node filesystem installations only**, backups may contain plaintext conversations and instructions, plus the generated master key. Protect the complete backup and retain a supplied `MIRROR_STORE_KEY` separately. Example maintenance commands:

```sh
npm run storage -- backup /absolute/path/to/backup
# Stop Mirror before restoring or pruning.
MIRROR_DATA_DIR=/absolute/path/to/new-data npm run storage -- restore /absolute/path/to/backup --offline
npm run storage -- prune 90 --offline
```

The Node restore command does not overwrite an existing database. Pruning deletes local conversations older than the selected age; it does not affect ChatGPT history or revoke credentials. See [RELEASE-RECOVERY.md](RELEASE-RECOVERY.md) for Node schema compatibility and filesystem restore procedures.

## Development and tests

```sh
npm run typecheck
npm test
npm run coverage
npm run build
npm run test:e2e
npm run manifest -- --check
```

`npm run coverage` requires 100% statements, branches, functions, and lines in every application source file and writes `coverage/lcov.info`. GitHub Actions uploads that report to Codecov after the coverage gate passes; the badge above displays the measured line coverage from the uploaded test report. To enable uploads, connect the public repository to Codecov and add its repository upload token as the `CODECOV_TOKEN` GitHub Actions secret. Public open-source projects can use Codecov's free plan. Tests use isolated storage and synthetic upstream responses; they do not validate compatibility with a live ChatGPT account. Browser smoke tests run separately through Playwright. Every test must be inside a named `test.describe(...)` suite; `npm run test:suites` checks this rule.

Regenerate `SHA256-MANIFEST.json` after changing tracked source or configuration:

```sh
npm run manifest
```

## API overview

Mirror provides local control routes, conversion routes, decoder-challenge routes, and the OpenAI-compatible API. The generated OpenAPI document is available at `/mirror/openapi` (JSON) and `/mirror/openapi?format=yaml` (YAML); browse it at `/mirror/api-docs`.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Public local database liveness and configured, unverified egress |
| `GET /api/diagnostics` | Owner-authenticated Worker diagnostics, including persisted storage schema version |
| `POST /api/session` | Verify the browser-supplied ChatGPT session token and save non-secret account metadata |
| `GET` / `DELETE /api/session` | Inspect or clear saved account metadata |
| `/api/conversations/*` | Create, list, load, branch, stop, and delete conversations |
| `POST /api/files` | Upload an attachment |
| `/api/convert/*` | Encode, decode, verify, and calibrate supported formats |
| `/api/decoder-challenges/*` | Generate and check decoder challenges and downloadable kits |
| `GET /v1/models` | List available models in OpenAI-compatible form |
| `POST /v1/chat/completions` | Create streaming or non-streaming completions |

## Project notes

- [PROTOCOL.md](PROTOCOL.md): ChatGPT protocol implementation, known gaps, and open questions.
- [COMPATIBILITY.md](COMPATIBILITY.md): OpenAI API compatibility details.
- [WORKER-RECOVERY.md](WORKER-RECOVERY.md): Worker migrations, recovery readiness, and local-versus-live acceptance limits.
- [TODO.md](TODO.md): issue-level project backlog.
- [NEXT-STEPS.md](NEXT-STEPS.md): repository audit roadmap.
