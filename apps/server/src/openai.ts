import { needsRichOutput, renderRichOutput, type RichOutput } from "./rich-output.js";
import { createAssetLinks } from "./asset-content.js";
import { ResponsesBody, responsesToCompletion, createResponseWriter } from "./responses.js";
import { abortable, turnDeadline } from "./deadlines.js";
import { apiError, recordFailure, upstreamErrorMessage } from "./api-errors.js";
import "./zod-openapi-init.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ChatGptBackendClient,
  classifyProtocolFailure,
  normalizeGizmos,
  normalizeModels,
  type NormalizedConversationEvent,
  type UploadedFile,
} from "@mirror/protocol";
import {
  routeModel,
  textContent,
  buildResponseMetadata,
  imagePartsOf,
  resolveImageAttachment,
  filePartsOf,
  resolveFileAttachment,
  normalized,
  promptFor,
  instructionsHash,
  conversationalMessages,
  firstHistoryDifference,
} from "./conversation-context.js";
import { getValidCredentials } from "./auth.js";
import { runChat } from "./chat-service.js";
import {
  updateMessage,
  getSessionRevision,
  getInstructions,
  branchConversation,
  saveFile,
  assertSessionRevision,
  saveInstructions,
  fingerprintValue,
  findConversationByTranscript,
  getConversation,
  getOpenAiContext,
  getOpenAiTranscript,
  getSession,
  getImplicitConversationId,
  setImplicitConversationId,
  listMessages,
  rebaseConversationUpstream,
  replaceMessages,
  saveOpenAiContext,
  saveOpenAiTranscript,
  type StoredConversation,
} from "./store.js";

const TextPart = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict()
  .openapi({ description: "Plain text content part." });
/**
 * Official OpenAI vision content part. `url` accepts a data: URI (uploaded
 * inline, the common case for API callers) or an https URL (fetched
 * server-side and re-uploaded to ChatGPT's file service, since backend-api
 * has no concept of "point at this external URL" - every attachment has to
 * exist as an uploaded file first, see resolveImageAttachment below).
 * `detail` is accepted for OpenAI-shape compatibility but has no backend-api
 * equivalent (ChatGPT does not expose a client-selectable vision resolution
 * tier), so it's parsed and silently ignored rather than rejected.
 */
const ImageUrlPart = z
  .object({
    type: z.literal("image_url"),
    image_url: z
      .object({
        url: z.string().openapi({
          description:
            "A data: URI (uploaded inline) or an https:// URL (fetched server-side). " +
            "Mirror uploads the resolved image to ChatGPT's file service before sending " +
            "the turn - backend-api has no concept of pointing at an external URL directly.",
        }),
        detail: z
          .enum(["auto", "low", "high"])
          .optional()
          .openapi({
            description:
              "Accepted for OpenAI shape-compatibility but has no backend-api equivalent " +
              "(no client-selectable vision resolution tier exists upstream); parsed and ignored.",
          }),
      })
      .strict(),
  })
  .strict()
  .openapi({
    description:
      "Vision input content part. See COMPATIBILITY.md for how this maps onto ChatGPT's " +
      "own file-upload flow.",
  });
/**
 * Mirror's addition (not an original OpenAI vision-only field): a generic,
 * filename-bearing file attachment, mirroring the shape of the newer official
 * Chat Completions "file" content part. `file_data` accepts the same
 * data: URI / https:// URL forms as image_url.url above, and is resolved
 * the same way - uploaded to ChatGPT's file service before the turn is
 * sent (see resolveFileAttachment in conversation-context.ts). The filename
 * extension determines its MIME type and whether it uses the image upload route.
 */
const FilePart = z
  .object({
    type: z.literal("file"),
    file: z
      .object({
        file_data: z.string().openapi({
          description:
            "A data: URI (uploaded inline) or an https:// URL, containing the file's bytes. " +
            "Mirror uploads the resolved file to ChatGPT's file service before sending the turn.",
        }),
        filename: z.string().optional().openapi({
          description: "Original filename; its extension determines the server-side MIME type. Unknown or absent extensions use application/octet-stream. Defaults to attachment-<index>.",
        }),
      })
      .strict(),
  })
  .strict()
  .openapi({
    description:
      "Filename-bearing file attachment content part for images, PDFs, Markdown, text files, spreadsheets, etc. " +
      "MIME type is selected from the filename extension, without content sniffing. " +
      "See COMPATIBILITY.md.",
  });
const ContentPart = z.union([TextPart, ImageUrlPart, FilePart]).openapi({ ref: "ContentPart" });
const OpenAiMessage = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]).openapi({
      description:
        "'tool' messages are client-executed function results. See COMPATIBILITY.md for the prompt-based tool schema behavior.",
    }),
    content: z.union([z.string(), z.array(ContentPart), z.null()]),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({
      id: z.string(), type: z.literal("function"),
      function: z.object({ name: z.string(), arguments: z.string() }).strict(),
    }).strict()).optional(),
  })
  .passthrough()
  .openapi({ ref: "ChatMessage" });
const CompletionBody = z
  .object({
    model: z.string().default("auto").openapi({
      description: "A ChatGPT model slug, or a Custom GPT/Project id from GET /v1/models.",
      example: "gpt-4o",
    }),
    messages: z.array(OpenAiMessage).min(1),
    tools: z.array(z.unknown()).optional().openapi({
      description: "Optional client-provided tool schemas. Mirror includes non-empty entries in the current prompt and returns compatible tool_calls for the client to execute.",
    }),
    tool_choice: z.union([z.enum(["none", "auto", "required"]), z.object({
      type: z.literal("function"), function: z.object({ name: z.string() }).strict(),
    }).strict()]).optional(),
    parallel_tool_calls: z.boolean().optional(),
    stream: z.boolean().default(true),
    stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    temperature: z.number().min(0).max(2).nullable().optional().openapi({
      description: "Accepted for client compatibility; ignored. ChatGPT's web backend controls sampling and does not expose a temperature setting.",
    }),
    /**
     * Official OpenAI field, repurposed rather than adding a new one: whether
     * this turn is attached to a continuable Mirror conversation thread.
     * Defaults to true (persistent threads by default, mirroring how real
     * ChatGPT conversations behave); pass store:false for a one-shot message
     * that will not be resumable by a later /v1/chat/completions call.
     */
    store: z.boolean().default(true),
    // Compatibility-only fields: some clients always send these. Mirror never
    // truncates the answer or stops generation based on them.
    max_tokens: z.number().int().positive().optional().openapi({
      description: "Accepted for client compatibility; ignored. Mirror returns the complete answer without a token or character cap.",
    }),
    max_completion_tokens: z.number().int().positive().optional().openapi({
      description: "Accepted for client compatibility; ignored. Mirror does not limit response length.",
    }),
    stop: z.union([z.string(), z.array(z.string().min(1)).min(1).max(4)]).optional().openapi({
      description: "Accepted for client compatibility; ignored. Mirror does not truncate answers at stop strings.",
    }),
    /**
     * Official OpenAI field (free-form string metadata), repurposed for
     * Mirror-specific routing so the request body needs no non-standard
     * fields. Recognized keys:
     *  - metadata.private = "true"      -> temporary/incognito chat, excluded
     *                                       from chatgpt.com history & training
     *  - metadata.mirror_model = "..."  -> the actual model (or another gizmo/
     *                                       project id) to run when `model` is
     *                                       itself a gizmo/project id, i.e. a
     *                                       Project's picked model
     *  - metadata.conversation_id = "..." -> reuse an id returned via the
     *                                       x-mirror-conversation-id response
     *                                       header to continue that thread, or
     *                                       supply your own new id up front to
     *                                       name a brand-new conversation.
     *                                       Optional: a client that always
     *                                       resends its full message history
     *                                       itself (rather than tracking a
     *                                       conversation id at all - e.g. a
     *                                       plain "OpenAI-compatible API"
     *                                       mode in a browser extension)
     *                                       still gets threaded onto the
     *                                       same Mirror conversation
     *                                       automatically, by recognizing
     *                                       its resent history. See
     *                                       findConversationByTranscript in
     *                                       store.ts. When no prior history
     *                                       is sent, Mirror resumes the
     *                                       account's current API conversation.
     *                                       Prefix the newest user message
     *                                       with `/new ` to start a fresh
     *                                       conversation (the command is
     *                                       removed before forwarding).
     *
     * Editing an earlier user turn in a resent history for an explicit
     * conversation_id rebases that Mirror conversation as a new branch
     * inside the existing upstream ChatGPT thread. Assistant turns are
     * immutable and requests that change or remove one are rejected. Both
     * the upstream and caller-facing conversation ids stay unchanged. See
     * rebaseConversationUpstream/replaceMessages in store.ts.
     *
     * The response's own `metadata` object (both the non-streaming
     * chat.completion object and the final streaming chunk) uses this same
     * mechanism in the other direction: it's how Mirror surfaces ChatGPT
     * product behavior that has no field anywhere in the official Chat
     * Completions response schema, without inventing new top-level response
     * fields a strict OpenAI-response parser might choke on. Response-only
     * keys (never meaningful in a request):
     *  - metadata.mirror_tool_events = "[...]"  -> present only when ChatGPT
     *                                       invoked one of its own built-in
     *                                       tools this turn (web browsing,
     *                                       the Python/code-interpreter
     *                                       sandbox, etc - see
     *                                       COMPATIBILITY.md). A JSON array
     *                                       of {name, status} objects, in
     *                                       the order observed. This is
     *                                       purely informational: there is
     *                                       no way to define a *new* tool or
     *                                       intercept these calls, only to
     *                                       see that ChatGPT's own ones ran.
     *  - metadata.mirror_images = "[...]"  -> present only when the turn
     *                                       included a generated image (the
     *                                       in-chat DALL-E tool, distinct
     *                                       from POST /v1/images/generations
     *                                       which has no ChatGPT-web
     *                                       equivalent at all). A JSON array
     *                                       of {url} objects; each url is a
     *                                       self-contained image data URI when
     *                                       preview bytes are available. Files
     *                                       are linked in the response text via
     *                                       scoped /api/asset-content tickets.
     * Every metadata value, request or response, is a JSON-stringified
     * string rather than a nested object, since the official metadata field
     * is documented as flat string:string pairs - Mirror never puts a raw
     * object where the official schema expects a string. Mirror does not
     * enforce OpenAI's own request-side metadata limits (16 keys, 64-char
     * keys, 512-char values) on these response-only keys, since they are a
     * Mirror-specific extension the official API never validates.
     */
    metadata: z
      .object({
        private: z.enum(["true", "false"]).optional().openapi({
          description: "Request ChatGPT's temporary/incognito chat mode for this turn.",
        }),
        mirror_model: z.string().min(1).optional().openapi({
          description:
            "Override the effective ChatGPT model slug independent of the model field " +
            "(e.g. picking a Project's underlying model).",
        }),
        conversation_id: z.string().min(1).max(200).optional().openapi({
          description: "Continue an existing Mirror conversation by id.",
        }),
        mirror_turnstile_token: z.string().min(1).optional().openapi({
          description: "Alias of turnstile_token below.",
        }),
        turnstile_token: z.string().min(1).optional().openapi({
          description:
            "Caller-supplied Cloudflare Turnstile response token, used when Sentinel " +
            "requires one. Tokens are used only for this request and never persisted. " +
            "See PROTOCOL.md's Turnstile resolution notes.",
        }),
      })
      .catchall(z.string())
      .optional()
      .openapi({
        description:
          "Officially a flat request-only string map in the real OpenAI API; Mirror " +
          "repurposes it (bidirectionally - the response carries its own mirror_tool_events/" +
          "mirror_images keys here too, see the response schema) for anything with no " +
          "dedicated schema slot. Unknown string metadata is passed through unchanged. See " +
          "COMPATIBILITY.md.",
      }),
  })
  .strict()
  .openapi({
    ref: "CompletionRequest",
    description:
      "OpenAI Chat Completions-shaped request, backed by chatgpt.com/backend-api. " +
      "Unsupported fields are rejected (400) rather than silently ignored.",
  });

type ClientToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function nonEmptyToolValues(tools: unknown[] | undefined): unknown[] {
  return (tools ?? []).filter(value => {
    if (!value) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
}

function canonicalToolCallText(toolCalls: ClientToolCall[]): string {
  return JSON.stringify({ tool_calls: toolCalls });
}

function clientToolCallNames(tools: unknown[]): Set<string> {
  return new Set(tools.flatMap((tool: any) => {
    const name = tool?.type === "function" ? tool.function?.name : tool?.name;
    return typeof name === "string" ? [name] : [];
  }));
}

function parseClientToolCalls(text: string, tools: unknown[], choice: z.infer<typeof CompletionBody>['tool_choice'], parallel: boolean | undefined): ClientToolCall[] | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();
  let value: any;
  try { value = JSON.parse(cleaned); } catch {
    if (choice === "required" || (typeof choice === "object" && choice !== null))
      throw Object.assign(new Error("The model did not return the required tool call"), { statusCode: 502 });
    return null;
  }
  if (!value || !Array.isArray(value.tool_calls)) {
    if (choice === "required" || (typeof choice === "object" && choice !== null))
      throw Object.assign(new Error("The model did not return the required tool call"), { statusCode: 502 });
    return null;
  }
  if (choice === "none") throw Object.assign(new Error("The model returned a tool call when tool_choice was none"), { statusCode: 502 });
  if (!value.tool_calls.length)
    throw Object.assign(new Error("The model returned an empty tool call list"), { statusCode: 502 });
  if (parallel === false && value.tool_calls.length > 1)
    throw Object.assign(new Error("The model returned multiple calls while parallel_tool_calls was false"), { statusCode: 502 });
  const knownNames = clientToolCallNames(tools);
  const requiredName = typeof choice === "object" && choice !== null ? choice.function.name : undefined;
  return value.tool_calls.map((item: any) => {
    const fn = item?.function ?? item;
    const name = fn?.name;
    if (typeof name !== "string" || !name || (knownNames.size > 0 && !knownNames.has(name)) || (requiredName && name !== requiredName))
      throw Object.assign(new Error("The model returned a tool name that was not supplied by the client"), { statusCode: 502 });
    let args = fn.arguments ?? item.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); }
      catch { throw Object.assign(new Error(`The model returned invalid JSON arguments for ${name}`), { statusCode: 502 }); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw Object.assign(new Error(`The model returned non-object arguments for ${name}`), { statusCode: 502 });
    return { id: typeof item.id === "string" && item.id ? item.id : `call_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
  });
}

function promptWithClientTools(messages: ReturnType<typeof normalized>, source: z.infer<typeof OpenAiMessage>[], tools: unknown[], choice?: z.infer<typeof CompletionBody>['tool_choice'], parallel?: boolean): string {
  let prompt: string;
  const latest = messages.at(-1);
  if (latest?.role === "tool") {
    let firstResult = source.length - 1;
    while (firstResult > 0 && source[firstResult - 1]?.role === "tool") firstResult--;
    const assistantCall = source[firstResult - 1];
    const results = source.slice(firstResult).map(message => ({
      tool_call_id: message.tool_call_id,
      name: message.name,
      result: textContent(message.content),
    }));
    prompt = [
      "The client executed the previously requested tool call(s). Continue the task using these results:",
      ...(assistantCall?.role === "assistant" && assistantCall.tool_calls?.length
        ? [`Tool calls: ${JSON.stringify(assistantCall.tool_calls)}`] : []),
      `Tool results: ${JSON.stringify(results)}`,
    ].join("\n\n");
  } else {
    prompt = promptFor(messages);
  }
  const toolValues = nonEmptyToolValues(tools);
  if (!toolValues.length) return prompt;
  const choiceInstruction = choice === "none" ? "Do not call a client tool; answer normally."
    : choice === "required" ? "You must return at least one tool call."
    : typeof choice === "object" && choice !== null ? `Call only the function named ${choice.function.name}.`
    : "Call tools when they help fulfill the user's request; otherwise answer normally.";
  const parallelInstruction = parallel === false ? "Return at most one tool call." : "You may return multiple independent tool calls together.";
  return `${prompt}\n\nTools:\n${JSON.stringify(toolValues, null, 2)}\n\nThe Tools section contains client-provided tool schemas. ${choiceInstruction} ${parallelInstruction} When calling a tool, return only a JSON object with a \"tool_calls\" array in the standard OpenAI format: each item has an \"id\", \"type\":\"function\", and \"function\" object with the exact schema \"name\" and JSON-string \"arguments\". Do not describe a tool call in prose. The client will execute each call and send its result in a later request. Never claim you executed a client tool.`;
}


// Slow-consumer guard. Real backpressure (a client reading slower than we
// can write) is normal and must be tolerated, not treated as "the client is
// gone" on the first snapshot over some byte count - ChatGPTBox in particular
// relays every SSE chunk through a Chrome extension `runtime.Port`, which can
// legitimately let the outbound buffer climb for a few seconds without the
// far end actually having disappeared. So this only gives up once the buffer
// has stayed backed up past SLOW_CONSUMER_STALL_MS *continuously*; a burst
// that drains again resets the clock and is invisible to the caller. This is
// still not real drain-event-driven backpressure (pausing production and
// resuming on a `drain` event) - it's a stall timeout layered on top of a
// byte-count high-water mark - but it stops a merely-bursty consumer from
// getting its connection killed mid-turn, which previously meant the
// in-flight generation's transcript never got persisted and the next request
// from the same client would fail to match it as a continuation, silently
// starting a brand-new conversation every turn.
//
// Exported (only) so a unit test can drive this directly with a fake
// `reply.raw` - reproducing real outbound-socket backpressure end-to-end
// inside a test is impractical/flaky, but the guard is a plain function of
// `reply.raw.writableLength` plus elapsed time and is fully specified
// without a real socket. `now` is likewise only for tests to drive the
// stall clock deterministically; production call sites always omit it.
const SLOW_CONSUMER_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const SLOW_CONSUMER_STALL_MS = 15_000;
const slowConsumerStalledSince = new WeakMap<object, number>();

export function sse(reply: FastifyReply, data: unknown, now: number = Date.now()): void {
  const raw = reply.raw;
  if (raw.writableLength > SLOW_CONSUMER_HIGH_WATER_BYTES) {
    const stalledSince = slowConsumerStalledSince.get(raw);
    if (stalledSince === undefined) {
      slowConsumerStalledSince.set(raw, now);
    } else if (now - stalledSince > SLOW_CONSUMER_STALL_MS) {
      slowConsumerStalledSince.delete(raw);
      raw.destroy();
      throw new Error("Response consumer is too slow");
    }
  } else if (slowConsumerStalledSince.has(raw)) {
    slowConsumerStalledSince.delete(raw);
  }
  raw.write(
    `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
  );
}

/**
 * Serializes overlapping /v1/chat/completions calls that target the same
 * explicit metadata.conversation_id - a double-click, a retry fired before
 * the first request's response landed, an eager client, etc - so a second
 * concurrent call waits for the first to finish instead of racing it. Left
 * unserialized, both calls independently read the same "current head" and
 * each branch off it, sending two sibling messages under the same parent to
 * the real upstream conversation at once: this is what produces "two
 * assistant replies in a row with no user message in between" and a GPT
 * noticing a partial/garbled follow-up.
 */
const conversationLocks = new Map<string, Promise<unknown>>();
function withConversationLock<T>(
  key: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  const prior = conversationLocks.get(key) ?? Promise.resolve();
  const queued = prior.catch(() => undefined);
  const settled = queued.then(fn);
  const tracked = settled.catch(() => undefined);
  conversationLocks.set(key, tracked);
  tracked.finally(() => {
    if (conversationLocks.get(key) === tracked) conversationLocks.delete(key);
  });
  return settled;
}

/**
 * Exported purely so openapi-document.ts can derive /mirror/openapi's
 * request-body schema from the exact same Zod schema this route validates
 * against, instead of maintaining a second, hand-written copy that can
 * silently drift out of sync with what the server actually accepts.
 */
/** SSE is append-only: reject a renderer that would rewrite delivered text. */
export function remainingStreamText(responseText: string, emittedText: string): string {
  if (!responseText.startsWith(emittedText)) throw new Error("Upstream changed text already delivered to the client");
  return responseText.slice(emittedText.length);
}

export { CompletionBody, OpenAiMessage, ContentPart };
export type { TextPart };

export async function registerOpenAiRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/v1/models", async () => {
    const creds = await getValidCredentials();
    const client = new ChatGptBackendClient(creds);
    const [models, projectsRaw, gptsRaw] = await Promise.all([
      normalizeModels(await client.fetchModels()),
      client
        .fetchGizmoSidebar({
          ownedOnly: false,
          limit: 50,
          conversationsPerGizmo: 0,
        }),
      client.fetchGizmoBootstrap({ limit: 20 }),
    ]);
    const seen = new Set<string>();
    const gizmos = [
      ...normalizeGizmos(gptsRaw),
      ...normalizeGizmos(projectsRaw),
    ].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return {
      object: "list",
      data: [
        ...models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "chatgpt-web",
          mirror: { supported: !model.id.endsWith("-wm"), execution_mode: model.id.endsWith("-wm") ? "unsupported_work" : "interactive", capabilities: model.capabilities ?? null },
        })),
        ...gizmos.map((gizmo) => ({
          id: gizmo.id,
          object: "model",
          created: 0,
          owned_by: gizmo.id.startsWith("g-p-")
            ? "chatgpt-project"
            : "chatgpt-gizmo",
          name: gizmo.name,
        })),
      ],
    };
  });

  const handleCompletion = async (req: FastifyRequest, reply: FastifyReply) => {
    const isResponses = req.routeOptions.url === "/v1/responses";
    const responsesParsed = isResponses ? ResponsesBody.safeParse(req.body) : undefined;
    if (responsesParsed && !responsesParsed.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error",
        message: responsesParsed.error.issues.map(issue => issue.message).join("; ") } });
    }
    const responses = responsesParsed?.success ? createResponseWriter(responsesParsed.data, event => {
      reply.raw.write(`event: ${event.type}\n`);
      sse(reply, event);
    }) : undefined;
    const parsed = CompletionBody.safeParse(responsesParsed?.success ? responsesToCompletion(responsesParsed.data) : req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
          type: "invalid_request_error",
        },
      });
    }
    const requestRevision = getSessionRevision();
    const body = parsed.data;
    const clientTools = nonEmptyToolValues(body.tools);
    const toolCallsEnabled = !isResponses && clientTools.length > 0;
    if ((body.metadata?.mirror_model ?? body.model).endsWith("-wm")) return reply.code(400).send({ error: {message: "Work Mode is not supported by Mirror; select an interactive model", type: "unsupported_parameter"} });
    let streamedText = "";
    let emittedText = "";
    let rich = false;
    let richOutput: RichOutput | undefined;
    const streamedMessages = new Map<string | null, string>();
    const capturedEvents: NormalizedConversationEvent[] = [];
    let messages = normalized(body.messages);
    const last = messages.at(-1);
    if (!last || (last.role !== "user" && last.role !== "tool"))
      return reply.code(400).send({
        error: {
          message: "The final message must have role=user or role=tool",
          type: "invalid_request_error",
        },
      });
    const newConversationCommand = last.role === "user" && /^\/new(?:\s+|$)/.test(last.content);
    if (newConversationCommand) {
      last.content = last.content.replace(/^\/new\s*/, "").trim();
      if (!last.content) return reply.code(400).send({ error: { message: "Add your prompt after /new to start a fresh conversation", type: "invalid_request_error" } });
      messages = [...messages.filter(message => message.role === "system" || message.role === "developer"), last];
    }
    // Only the final turn can carry attachments - matches how ChatGPT's own
    // UI (and Mirror's /api/chat) treat attachments as belonging to the
    // message being sent right now, not to arbitrary history.
    const imageParts = imagePartsOf(body.messages.at(-1)?.content ?? null);
    const fileParts = filePartsOf(body.messages.at(-1)?.content ?? null);
    if (!last.content.trim() && imageParts.length === 0 && fileParts.length === 0) {
      // An empty final turn (e.g. a client that pre-appends a fresh blank
      // user row after each reply for convenience, then gets submitted
      // before anything is typed into it) would otherwise be forwarded to
      // ChatGPT as a genuinely content-free message - the GPT notices
      // nothing came through and replies saying so, and depending on the
      // client's own history bookkeeping that reply can end up rendered
      // back-to-back with the prior one, with no visible user text between.
      // An image-only turn (no text) is fine - it's how a client asks
      // "what's in this picture" - so the check only fires when there is
      // neither text nor an image attached.
      return reply.code(400).send({
        error: {
          message: "The final user message must not be empty",
          type: "invalid_request_error",
        },
      });
    }
    let resolvedAttachments: UploadedFile[] | undefined;
    if (imageParts.length || fileParts.length) {
      try {
        const uploadClient = new ChatGptBackendClient(await getValidCredentials());
        const signal = (req as any).raw?.signal ?? req.signal;
        const [uploadedImages, uploadedFiles] = await Promise.all([
          Promise.all(imageParts.map((part, i) => resolveImageAttachment(uploadClient, part, i, signal))),
          Promise.all(fileParts.map((part, i) => resolveFileAttachment(uploadClient, part, i, signal))),
        ]);
        resolvedAttachments = [...uploadedImages, ...uploadedFiles];
        const accountId = getSession()?.accountId ?? "default";
        for (const file of resolvedAttachments) saveFile(file, accountId);
      } catch (error) {
        return reply.code(400).send({
          error: {
            message: error instanceof Error ? error.message : "Could not process an attachment",
            type: "invalid_request_error",
          },
        });
      }
    }

    // store:false means "one-shot": this call never continues (or is
    // continuable from) any thread, even if metadata.conversation_id is
    // supplied - it always gets its own throwaway conversation and never
    // returns x-mirror-conversation-id. See CompletionBody above.
    const oneShot = body.store === false;
    const turnstileToken =
      body.metadata?.mirror_turnstile_token ??
      body.metadata?.turnstile_token ??
      (typeof req.headers["openai-sentinel-turnstile-token"] === "string"
        ? req.headers["openai-sentinel-turnstile-token"]
        : undefined) ??
      (typeof req.headers["x-turnstile-token"] === "string"
        ? req.headers["x-turnstile-token"]
        : undefined);

    // metadata.conversation_id is optional (see CompletionBody above): if
    // present but doesn't exist yet, that's not an error - the caller is
    // picking their own id for a brand-new conversation, so we create one
    // using that id. It's only a conflict if the id is already taken by a
    // conversation on a different account. If absent entirely, resent
    // history alone can still land this on an existing conversation - see
    // findConversationByTranscript below.
    const explicitConversationId = !oneShot && !newConversationCommand
      ? body.metadata?.conversation_id
      : undefined;
    const accountId = getSession()?.accountId ?? "default";
    const implicitLockKey = `implicit:${accountId}`;
    // Same key a concurrent duplicate call (double-click, eager retry, etc)
    // for this exact conversation_id would compute, so they serialize
    // against each other rather than both reading the same "current head"
    // and branching off it at once (see withConversationLock above).
    const lockKey = explicitConversationId ?? (!oneShot ? implicitLockKey : null);
    const completionId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const deadline = turnDeadline(controller);
    const startedAt = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    req.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) {
        recordFailure("client_disconnected", req.id);
        req.log.info(
          { elapsedMs: Date.now() - startedAt, code: "client_disconnected" },
          "Completion client disconnected",
        );
        controller.abort();
      }
    });

    try {
      if (body.stream) {
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // Flush small chunks promptly on TCP; test transports and some
        // HTTP/2 socket wrappers do not expose setNoDelay. Keep all stream
        // setup inside try/finally so a failure after hijack still cleans up.
        if (typeof reply.raw.socket?.setNoDelay === "function")
          reply.raw.socket.setNoDelay(true);
        if (responses) responses.start();
        else sse(reply, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        });
        // ChatGPTBox forwards every data event through a runtime.Port, keeping
        // Chrome's extension worker alive. SSE comments are ignored by its
        // parser, so use a data event without a content field during silent preparation or
        // reasoning. This is transport activity only: never extend deadlines,
        // modify the transcript, or signal that generation has finished.
        heartbeat = setInterval(() => {
          try {
            if (responses) responses.delta("");
            else sse(reply, {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            });
          } catch (error) {
            controller.abort(error);
          }
        }, 10_000);
      }

      await abortable(withConversationLock(lockKey, async () => {
        controller.signal.throwIfAborted();
        assertSessionRevision(requestRevision);
        // Resolve state after acquiring the lock. Two concurrent calls using a
        // brand-new caller-selected id must not both decide to INSERT it.
        const accountId = getSession()?.accountId ?? "default";
        let explicitConversation = explicitConversationId
          ? getConversation(explicitConversationId)
          : null;
        let implicitConversation = false;
        if (!oneShot && !explicitConversationId && !newConversationCommand) {
          // Stateless OpenAI clients commonly send only the latest user turn.
          // Resume the account's last API conversation for those requests.
          const hasPriorTurns = messages.slice(0, -1).some(message => message.role === "user" || message.role === "assistant");
          const implicitId = hasPriorTurns ? null : getImplicitConversationId(accountId);
          const candidate = implicitId ? getConversation(implicitId) : null;
          const routeCandidate = routeModel(body.model, body.metadata);
          if (candidate && candidate.accountId === accountId &&
              !hasPriorTurns &&
              (routeCandidate.gizmoId === undefined || routeCandidate.gizmoId === candidate.gizmoId) &&
              (!routeCandidate.model || routeCandidate.model === "auto" || routeCandidate.model === candidate.model) &&
              (routeCandidate.private === undefined || routeCandidate.private === Boolean(candidate.private))) {
            explicitConversation = candidate;
            implicitConversation = true;
          }
        }
        if (
          explicitConversation &&
          explicitConversation.accountId !== accountId
        ) {
          throw Object.assign(
            new Error(
              `metadata.conversation_id is already in use: ${explicitConversationId}`,
            ),
            { statusCode: 400 },
          );
        }
        const newConversationId =
          explicitConversationId && !explicitConversation
            ? explicitConversationId
            : undefined;
        const route = routeModel(body.model, body.metadata);

        // An ID plus only the next user message is the cm continuation contract.
        // Expand from local canonical history before comparing or saving hashes.
        // Omitted instructions inherit; an explicitly supplied instruction block
        // remains an intentional edit, including with full-history clients.
        if (explicitConversation && (messages.length === 1 || implicitConversation)) {
          const incomingInstructions = messages.slice(0, -1).filter(message => message.role === "system" || message.role === "developer");
          messages = [
            ...(incomingInstructions.length ? incomingInstructions : getInstructions(explicitConversation.id) as ReturnType<typeof normalized>),
            ...listMessages(explicitConversation.id).map(({ role, content }) => ({ role, content })),
            messages.at(-1)!,
          ];
        }

        // priorTranscript is everything the caller sent *except* the new
        // final user turn - i.e. what they believe the conversation's
        // history already is. We compare/match against this, not the full
        // `messages` array, since the new turn obviously never matches
        // anything yet.
        const priorTranscript = messages.slice(0, -1);
        const priorTranscriptHash = priorTranscript.length
          ? fingerprintValue(priorTranscript)
          : null;

        // No metadata.conversation_id at all: try to recognize this as a
        // continuation purely from the resent history, for clients that
        // manage their own history and never track a conversation id (see
        // CompletionBody's metadata doc-comment above).
        let inferredConversation: StoredConversation | null = null;
        if (!oneShot && !explicitConversationId && priorTranscriptHash) {
          const candidate = findConversationByTranscript(
            accountId,
            priorTranscriptHash,
          );
          if (
            candidate &&
            (route.gizmoId === undefined ||
              route.gizmoId === candidate.gizmoId) &&
            (!route.model ||
              route.model === "auto" ||
              route.model === candidate.model) &&
            (route.private === undefined ||
              route.private === Boolean(candidate.private))
          ) {
            inferredConversation = candidate;
          }
        }

        const activeConversation = explicitConversation ?? inferredConversation;

        // An explicit conversation_id whose resent prior transcript no
        // longer matches what we have on record means the caller edited an
        // earlier turn rather than merely appending one. User-turn edits can
        // rebase; assistant-turn edits are rejected below.
        const storedTranscriptHash = explicitConversation
          ? getOpenAiTranscript(explicitConversation.id)
          : null;
        const priorConversationMessages = conversationalMessages(priorTranscript);
        const storedMessageRows = explicitConversation
          ? listMessages(explicitConversation.id)
          : [];
        const storedConversationMessages = storedMessageRows.map(
          ({ role, content }) => ({
              role,
              content,
            }),
        );
        const historyDifferenceIndex = firstHistoryDifference(
          storedConversationMessages,
          priorConversationMessages,
        );
        if (
          explicitConversation &&
          storedConversationMessages[historyDifferenceIndex]?.role ===
            "assistant"
        ) {
          throw Object.assign(
            new Error(
              "Assistant messages are read-only and cannot be changed or removed while continuing a Mirror conversation.",
            ),
            { statusCode: 400 },
          );
        }
        // Conversations created/imported before transcript fingerprints were
        // introduced still need safe edit detection. Their local logical
        // user/assistant rows are the best available baseline. The context
        // hash covers system/developer changes for older OpenAI-created rows;
        // imported ChatGPT conversations have no corresponding system row, so
        // their first unchanged Playground continuation remains possible.
        const legacyTranscriptChanged = Boolean(
          explicitConversation &&
            !storedTranscriptHash &&
            priorTranscriptHash &&
            storedConversationMessages.length > 0 &&
            fingerprintValue(storedConversationMessages) !==
              fingerprintValue(priorConversationMessages),
        );
        const storedContextHash = explicitConversation
          ? getOpenAiContext(explicitConversation.id)
          : null;
        const legacyContextChanged = Boolean(
          !storedTranscriptHash &&
            storedContextHash &&
            storedContextHash !== instructionsHash(messages),
        );
        const needsRebase = Boolean(
          explicitConversation &&
            priorTranscriptHash &&
            ((storedTranscriptHash &&
              storedTranscriptHash !== priorTranscriptHash) ||
              legacyTranscriptChanged ||
              legacyContextChanged),
        );
        const isUserHistoryEdit = Boolean(
          needsRebase &&
            storedConversationMessages[historyDifferenceIndex]?.role === "user",
        );
        const rebasePriorMessages = priorConversationMessages.map(
          (message, index) => {
            const stored = storedMessageRows[index];
            return stored &&
              stored.role === message.role &&
              stored.content === message.content
              ? {
                  ...message,
                  id: stored.id,
                  upstreamNodeId: stored.upstreamNodeId,
                  status: stored.status,
                  events: stored.events,
                  attachments: stored.attachments,
                }
              : message;
          },
        );

        if (explicitConversation && !needsRebase) {
          if (
            route.gizmoId !== undefined &&
            route.gizmoId !== explicitConversation.gizmoId
          ) {
            throw Object.assign(
              new Error(
                "The GPT/Project cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
          if (
            route.model &&
            route.model !== "auto" &&
            route.model !== explicitConversation.model
          ) {
            throw Object.assign(
              new Error(
                "The model cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
          if (
            route.private !== undefined &&
            route.private !== Boolean(explicitConversation.private)
          ) {
            throw Object.assign(
              new Error(
                "Private-chat mode cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
        }

        if (needsRebase) {
          const previousMessages = listMessages(explicitConversation!.id);
          const previousLast = previousMessages.at(-1);
          if (previousLast?.upstreamNodeId) {
            branchConversation(explicitConversation!.id, previousLast.upstreamNodeId,
              "Before edit: " + explicitConversation!.title, previousLast.id);
          }
          rebaseConversationUpstream(explicitConversation!.id, {
            model: route.model,
            gizmoId: route.gizmoId,
            private: route.private,
            currentNodeId: isUserHistoryEdit
              ? (storedMessageRows[historyDifferenceIndex - 1]
                  ?.upstreamNodeId ?? "client-created-root")
              : "client-created-root",
          });
          replaceMessages(explicitConversation!.id, rebasePriorMessages);
        }

        // A user edit is a real ChatGPT conversation-tree branch: attach only
        // the latest client message under its actual predecessor. Mirror keeps
        // the caller's full transcript locally for edit detection and history
        // matching, but never replays that transcript as another upstream turn.
        const continuing =
          Boolean(activeConversation?.conversationId) &&
          (!needsRebase || isUserHistoryEdit);
        let chat: Awaited<ReturnType<typeof runChat>>;
        try {
          const toolPrompt = toolCallsEnabled
            ? promptWithClientTools(messages, body.messages, clientTools, body.tool_choice, body.parallel_tool_calls)
            : last.role === "tool" ? promptWithClientTools(messages, body.messages, []) : promptFor(messages);
          chat = await runChat({
            conversationId: activeConversation?.id,
            newConversationId,
            prompt: toolPrompt,
            model: route.model,
            gizmoId: route.gizmoId,
            private: route.private || oneShot,
            ephemeral: oneShot,
            turnstileToken,
            attachments: resolvedAttachments,
            signal: controller.signal,
            onEvent: (event) => {
              deadline.touch();
              capturedEvents.push(event);
              rich ||= needsRichOutput(event);
              if (!body.stream || event.kind !== "assistant_text" || toolCallsEnabled) return;
              const previous = streamedMessages.get(event.messageId) ?? "";
              streamedMessages.set(event.messageId, event.text);
              if (!event.text || event.text === previous) return;
              // Upstream snapshots are per message; OpenAI deltas are one
              // append-only answer. Never reuse another message's offset.
              // A replacement cannot retract bytes already sent, so retain
              // it as a separate complete segment, with its raw event intact.
              const append = previous && event.text.startsWith(previous)
                ? event.text.slice(previous.length)
                : (streamedText ? "\n\n" : "") + event.text;
              streamedText += append;
              // Keep the unfinished line and reference-bearing suffix until
              // late file metadata has arrived. SSE heartbeats remain active.
              if (!rich) {
                const boundary = streamedText.lastIndexOf("\n") + 1;
                const reference = streamedText.search(/\[|[\uE000-\uF8FF]|sandbox:|file-service:|sediment:/);
                const safe = streamedText.slice(0, reference < 0 ? boundary : Math.min(boundary, reference));
                const delta = safe.slice(emittedText.length);
                if (delta) {
                  if (responses) responses.delta(delta);
                  else sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
                  emittedText += delta;
                }
              }
            },
          });
        } catch (error) {
          // runChat necessarily records the synthetic replay prompt (and an
          // error/partial assistant row) before contacting upstream. On a
          // failed rebase those implementation-detail rows must not leak into
          // the editor's canonical history; the client never appended the
          // failed turn either, so restore exactly the edited prior prefix.
          if (needsRebase) {
            replaceMessages(explicitConversation!.id, rebasePriorMessages);
          }
          throw error;
        }
        const { conversation, result, storedAssistantMessageId } = chat;
        if (!oneShot) setImplicitConversationId(accountId, conversation.id);
        // The API transcript must be exactly what the caller can send back.
        // The upstream retains its own full tree; captured events preserve
        // the underlying snapshots independently of this logical API answer.
        let responseText = body.stream ? (streamedText || result.text) : result.text;
        if (rich) {
          const downloadClient = new ChatGptBackendClient(await getValidCredentials());
          richOutput = await renderRichOutput(capturedEvents, responseText, (pointer, messageId, image) =>
            createAssetLinks(downloadClient, `${req.protocol}://${req.headers.host}`, pointer,
              conversation.conversationId, messageId ?? result.messageId, controller.signal, image));
          controller.signal.throwIfAborted();
          assertSessionRevision(requestRevision);
          responseText = richOutput.text;
          responses?.setSummaries(richOutput.summaries);
        }
        const clientToolCalls = toolCallsEnabled ? parseClientToolCalls(responseText, clientTools, body.tool_choice, body.parallel_tool_calls) : null;
        if (clientToolCalls) responseText = canonicalToolCallText(clientToolCalls);
        if (!clientToolCalls && !responseText.trim()) {
          throw Object.assign(new Error("ChatGPT completed the request without returning an assistant answer."), { statusCode: 502, code: "empty_completion" });
        }
        if (body.stream) {
          if (clientToolCalls) {
            sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model,
              choices: [{ index: 0, delta: { tool_calls: clientToolCalls.map((call, index) => ({ index, ...call })) }, finish_reason: null }] });
          } else {
            const delta = remainingStreamText(responseText, emittedText);
            if (delta) {
              if (responses) responses.delta(delta);
              else sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
            }
          }
        }
        if (!oneShot) {
          if (!continuing) {
            // A first/rebased upstream turn is sent as one synthetic prompt
            // containing the whole OpenAI transcript. That prompt is a wire
            // implementation detail, not a logical user message. Rewrite the
            // local rows to the exact user/assistant transcript the caller
            // owns, while retaining the real new user/assistant node ids and
            // assistant events from runChat. Otherwise loading the chat would
            // expose a duplicate flattened transcript, and its next request
            // would immediately fail transcript matching and rebase again.
            const stored = listMessages(conversation.id);
            const storedUser = stored.find(
              (message) => message.upstreamNodeId === result.userMessageId,
            );
            const storedAssistant = stored.find(
              (message) => message.id === storedAssistantMessageId,
            );
            const canonical = conversationalMessages(messages);
            const lastUserIndex = canonical.findLastIndex(
              (message) => message.role === "user",
            );
            replaceMessages(conversation.id, [
              ...canonical.map((message, index) =>
                index === lastUserIndex && storedUser
                  ? {
                      ...message,
                      id: storedUser.id,
                      upstreamNodeId: storedUser.upstreamNodeId,
                      status: storedUser.status,
                      events: storedUser.events,
                      attachments: storedUser.attachments,
                    }
                  : message,
              ),
              {
                role: "assistant",
                content: responseText,
                ...(storedAssistant
                  ? {
                      id: storedAssistant.id,
                      upstreamNodeId: storedAssistant.upstreamNodeId,
                      status: storedAssistant.status,
                      events: storedAssistant.events,
                      attachments: storedAssistant.attachments,
                    }
                  : {}),
              },
            ]);
          }
          updateMessage(storedAssistantMessageId, responseText, result.status ?? "done", result.messageId, capturedEvents);
          saveInstructions(conversation.id, messages);
          saveOpenAiContext(conversation.id, instructionsHash(messages));
          saveOpenAiTranscript(
            conversation.id,
            accountId,
            fingerprintValue([
              ...messages,
              { role: "assistant", content: responseText },
            ]),
          );
        }


        const responseMetadata = buildResponseMetadata(capturedEvents, conversation.conversationId) ?? (richOutput ? {} : undefined);
        if (richOutput && responseMetadata) {
          responseMetadata.mirror_assets = JSON.stringify(richOutput.assets);
          responseMetadata.mirror_tool_outputs = JSON.stringify(richOutput.tools);
          if (richOutput.summaries.length) responseMetadata.mirror_reasoning_summaries = JSON.stringify(richOutput.summaries);
          const resolvedImages = richOutput.assets.filter(asset => asset.url && !asset.previewUnavailable && capturedEvents.some(event => (event.kind === "image" || (event.kind === "file" && typeof (event as any).assetPointer === "string" && (event as any).assetPointer.startsWith("sediment://"))) && event.assetPointer === asset.pointer));
          const hadImage = capturedEvents.some(event => event.kind === "image" ||
            (event.kind === "file" && event.assetPointer.startsWith("sediment://")));
          if (hadImage) responseMetadata.mirror_images = JSON.stringify(resolvedImages.map(asset => ({ url: asset.url })));
        }

        const sanitizedRequestMetadata = body.metadata ? { ...body.metadata } : {};
        delete (sanitizedRequestMetadata as any).turnstile_token;
        delete (sanitizedRequestMetadata as any).mirror_turnstile_token;
        const responseFields = { ...sanitizedRequestMetadata, ...responseMetadata,
          ...(!oneShot ? { conversation_id: conversation.id } : {}) };
        if (oneShot) delete responseFields.conversation_id;
        if (body.stream) {
          if (responses) {
            responses.complete(responseText, conversation.model, responseFields);
            reply.raw.end();
            return;
          }
          // Not part of the OpenAI chunk schema: an SSE comment line (ignored
          // by any spec-compliant SSE parser) carrying the Mirror conversation
          // id, since HTTP response headers can no longer be set once the
          // stream has started and this may be a brand-new conversation whose
          // id was not known until runChat() returned.
          if (!oneShot)
            reply.raw.write(`: mirror-conversation-id ${conversation.id}\n\n`);
          sse(reply, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: conversation.model,
            choices: [{ index: 0, delta: {}, finish_reason: clientToolCalls ? "tool_calls" : "stop" }],
            ...(responseMetadata ? { metadata: responseMetadata } : {}),
          });
          sse(reply, "[DONE]");
          reply.raw.end();
          return;
        }
        if (!oneShot) reply.header("x-mirror-conversation-id", conversation.id);
        if (responses) return reply.send(responses.response(responseText, "completed", conversation.model, responseFields));
        return reply.send({
          id: completionId,
          object: "chat.completion",
          created,
          model: conversation.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: clientToolCalls ? null : responseText,
                ...(clientToolCalls ? { tool_calls: clientToolCalls } : {}) },
              finish_reason: clientToolCalls ? "tool_calls" : "stop",
            },
          ],
          usage: null,
          ...(responseMetadata ? { metadata: responseMetadata } : {}),
        });
      }), controller.signal);
    } catch (error) {
      if (reply.raw.destroyed) return;
      const upstreamResponseText = (error as { upstreamResponseText?: unknown })?.upstreamResponseText;
      const upstreamText = typeof upstreamResponseText === "string" ? upstreamResponseText : undefined;
      const hasUpstreamResponse = upstreamText !== undefined;
      const message = upstreamText !== undefined
        ? upstreamErrorMessage(upstreamText)
        : error instanceof Error ? error.message : "Generation failed";
      const status = Number((error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status ?? 502);
      const emptyCompletion = (error as { code?: string })?.code === "empty_completion";
      const envelope = apiError(status, message, req.id, hasUpstreamResponse || emptyCompletion);
      if (emptyCompletion) envelope.error.code = "empty_completion";
      // Classify against the private-protocol drift taxonomy (MIR-31) so a
      // real backend-api shape change is distinguishable from an ordinary
      // expired session or rate limit in diagnostics - this never changes
      // the sanitized message/status sent to the caller, only an internal,
      // already-generic-safe category recorded alongside it.
      const protocolCategory = classifyProtocolFailure(error).category;
      recordFailure(envelope.error.code, req.id, protocolCategory === "unknown" ? null : protocolCategory);
      if (body.stream) {
        if (responses) responses.fail(envelope.error.message, envelope.error.code);
        else {
          sse(reply, envelope);
          sse(reply, "[DONE]");
        }
        reply.raw.end();
        return;
      }
      return reply.code(status).send(envelope);
    } finally {
      clearInterval(heartbeat);
      deadline.close();
    }
  };
  app.post("/v1/chat/completions", handleCompletion);
  app.post("/v1/responses", handleCompletion);
}
