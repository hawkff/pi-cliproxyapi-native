import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Api,
  createProvider,
  envApiKeyAuth,
  lazyStream,
  type Model,
  type ProviderStreams,
  type RefreshModelsContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's SDK loader aliases these entry points; deep pi-ai imports resolve to invalid paths.
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type CpaApi, endpoint, mapCatalog, modelRoute } from "./catalog.ts";
import { type QuotaWaitHandler, waitForClaudeQuota } from "./claude-quota.ts";
import { type Config, isRecord, PROVIDER_ID } from "./config.ts";

export type { QuotaWaitHandler } from "./claude-quota.ts";

export function builtinCatalog() {
  return [
    ...getBuiltinModels("anthropic"),
    ...getBuiltinModels("openai"),
    ...getBuiltinModels("openai-codex"),
    ...getBuiltinModels("google"),
  ];
}

export function validateKey(key: string) {
  if (!/^[!-~]{1,4096}$/.test(key)) {
    throw new Error("CLIProxyAPI requires a non-empty API key without whitespace or control characters.");
  }
  return key;
}

export function deadline(signal: AbortSignal | undefined, milliseconds: number) {
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(milliseconds)]);
}

export async function fetchCatalog(config: Config, key: string, signal: AbortSignal) {
  validateKey(key);
  const boundedSignal = deadline(signal, 10000);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: boundedSignal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("CLIProxyAPI discovery failed: connection, timeout, or redirect error.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CLIProxyAPI discovery failed (HTTP ${response.status}).`);
  }
  let payload: unknown;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CLIProxyAPI discovery returned an empty response.");
  try {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Catalog too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    payload = JSON.parse(text + decoder.decode());
  } catch {
    signal.throwIfAborted();
    throw new Error("CLIProxyAPI catalog is invalid, incomplete, or larger than 4 MiB.");
  } finally {
    reader.releaseLock();
  }
  return payload;
}

export async function discover(
  config: Config,
  key: string,
  signal: AbortSignal,
  known: readonly Model<Api>[],
) {
  return mapCatalog(await fetchCatalog(config, key, signal), config, known);
}

export function nonStrictTools(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
  return {
    ...payload,
    tools: payload.tools.map((tool: unknown) =>
      isRecord(tool) && tool.type === "function" && tool.strict === undefined
        ? { ...tool, strict: null }
        : tool,
    ),
  };
}

function quotaError(message: string | undefined) {
  let error: unknown;
  if (message && message.length <= 65536) {
    try {
      const body: unknown = JSON.parse(message.slice(message.indexOf("{"), message.lastIndexOf("}") + 1));
      error = isRecord(body) && isRecord(body.error) ? body.error : body;
    } catch {
      // SDK messages without a JSON body can still carry Retry-After headers.
    }
  }
  return isRecord(error) ? error : undefined;
}

const quotaErrorTypes = ["model_cooldown", "rate_limit_error", "rate_limit_exceeded", "usage_limit_reached"];

function isQuotaFailure(error: ReturnType<typeof quotaError>, status?: number) {
  const code = error?.code ?? error?.type;
  if (code === "permission_error" || code === "authentication_error") return false;
  const quota = typeof code === "string" && quotaErrorTypes.includes(code);
  return status === undefined ? code === "model_cooldown" : status === 429 || (status === 403 && quota);
}

export function quotaRetryAt(
  message: string | undefined,
  response?: Pick<Response, "status" | "headers">,
  now = Date.now(),
) {
  const error = quotaError(message);
  if (!isQuotaFailure(error, response?.status)) return undefined;
  const resets: number[] = [];
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const serverDate = Date.parse(response?.headers.get("date") ?? "");
    resets.push(
      /^\d+$/.test(retryAfter)
        ? now + Number(retryAfter) * 1000
        : now + Date.parse(retryAfter) - (Number.isFinite(serverDate) ? serverDate : now),
    );
  }
  const code = error?.code ?? error?.type;
  if (
    typeof code === "string" &&
    quotaErrorTypes.includes(code) &&
    typeof error?.reset_seconds === "number"
  ) {
    resets.push(now + error.reset_seconds * 1000);
  }
  // Support five-hour and weekly windows without trusting unbounded server delays.
  const valid = resets.filter((at) => Number.isSafeInteger(at) && at > now && at - now <= 7 * 86400000);
  return valid.length ? Math.max(...valid) + 1000 : undefined;
}

async function waitForQuota(resetAt: number, signal?: AbortSignal, onWait?: QuotaWaitHandler) {
  const id = Symbol();
  try {
    for (let remaining = resetAt - Date.now(); remaining > 0; remaining = resetAt - Date.now()) {
      signal?.throwIfAborted();
      onWait?.(id, Math.ceil(remaining / 1000));
      await sleep(Math.min(remaining, 1000), undefined, { signal });
    }
    signal?.throwIfAborted();
  } finally {
    onWait?.(id, undefined);
  }
}

function route(streams: ProviderStreams, config: Config, onWait?: QuotaWaitHandler): ProviderStreams {
  const wrap =
    (stream: ProviderStreams["streamSimple"]): ProviderStreams["streamSimple"] =>
    (selected, context, options) => {
      // A resumed selection must not send the current key to an old endpoint.
      const model = { ...selected, baseUrl: endpoint(config.baseUrl, selected.api) };
      const { metadataId, backend } = modelRoute(model.id);
      const google = backend && model.api === "google-generative-ai";
      const liveClaude = model.api === "anthropic-messages" && !backend;
      const adapterModel = google ? { ...model, id: metadataId } : model;
      // Google needs canonical IDs for tool turns. Swap identities to keep bare history cross-route.
      const adapterContext = google
        ? {
            ...context,
            messages: context.messages.map((message) =>
              message.role === "assistant" && message.provider === model.provider
                ? {
                    ...message,
                    model:
                      message.model === model.id
                        ? metadataId
                        : message.model === metadataId
                          ? model.id
                          : message.model,
                  }
                : message,
            ),
          }
        : context;
      const onPayload: SimpleStreamOptions["onPayload"] = async (payload) => {
        // Responses defaults omitted strictness to strict; preserve optional tool arguments.
        const adapted =
          google && isRecord(payload)
            ? { ...payload, model: model.id }
            : model.api === "openai-responses"
              ? nonStrictTools(payload)
              : payload;
        const result = await options?.onPayload?.(adapted, model);
        return result === undefined ? adapted : result;
      };
      let response: Pick<Response, "status" | "headers"> | undefined;
      const run = () => {
        response = undefined;
        return stream(adapterModel, adapterContext, {
          ...options,
          // Google rejects custom fetch; its structured cooldown body remains available on errors.
          fetch:
            model.api === "google-generative-ai"
              ? options?.fetch
              : async (input, init) => {
                  response = undefined;
                  const result = await (options?.fetch ?? globalThis.fetch)(input, init);
                  response = { status: result.status, headers: result.headers };
                  if (liveClaude && result.status === 429) {
                    // Inspect the first quota rejection without disabling transient-error retries.
                    const headers = new Headers(result.headers);
                    headers.set("x-should-retry", "false");
                    return new Response(result.body, {
                      status: result.status,
                      statusText: result.statusText,
                      headers,
                    });
                  }
                  return result;
                },
          onPayload,
          onResponse: options?.onResponse ? (response) => options.onResponse?.(response, model) : undefined,
          onProviderStreamEvent: options?.onProviderStreamEvent
            ? (event) => options.onProviderStreamEvent?.(event, model)
            : undefined,
        });
      };
      return lazyStream(model, async () => ({
        async *[Symbol.asyncIterator]() {
          let quotaDeadline: number | undefined;
          for (;;) {
            let started = false;
            let retry = false;
            for await (const event of run()) {
              if (event.type === "error" && event.reason === "error" && !started) {
                const resetAt = quotaRetryAt(event.error.errorMessage, response);
                const failure = quotaError(event.error.errorMessage);
                const upstream =
                  failure?.provider ??
                  (typeof failure?.message === "string"
                    ? /via provider ([\w-]+)/.exec(failure.message)?.[1]
                    : undefined);
                const checkClaude =
                  liveClaude &&
                  (upstream === undefined || upstream === "claude") &&
                  isQuotaFailure(failure, response?.status);
                if ((checkClaude || resetAt) && !options?.signal?.aborted) {
                  quotaDeadline ??= Date.now() + 7 * 86400000 + 1000;
                  try {
                    // Keep quota waits outside HTTP timeouts and within one fixed weekly deadline.
                    if (checkClaude) {
                      const key =
                        options?.env?.CLIPROXYAPI_MANAGEMENT_KEY ??
                        process.env.CLIPROXYAPI_MANAGEMENT_KEY ??
                        "";
                      await waitForClaudeQuota(
                        config,
                        key,
                        model.id,
                        quotaDeadline,
                        options?.signal,
                        onWait,
                        typeof failure?.message === "string" &&
                          /would exceed your account's rate limit/i.test(failure.message),
                      );
                    } else if (resetAt) {
                      if (resetAt > quotaDeadline)
                        throw new Error("The seven-day quota waiting deadline was reached.");
                      await waitForQuota(resetAt, options?.signal, onWait);
                    }
                  } catch (error) {
                    const reason = options?.signal?.aborted ? ("aborted" as const) : ("error" as const);
                    yield {
                      type: "error" as const,
                      reason,
                      error: {
                        ...event.error,
                        model: model.id,
                        stopReason: reason,
                        errorMessage:
                          reason === "aborted"
                            ? "Request was aborted during the quota wait."
                            : `CLIProxyAPI quota wait stopped. ${error instanceof Error ? error.message : "Live quota could not be verified."}`,
                      },
                    };
                    return;
                  }
                  retry = true;
                  break;
                }
              }
              started = true;
              if (!google) yield event;
              else if (event.type === "done")
                yield { ...event, message: { ...event.message, model: model.id } };
              else if (event.type === "error") yield { ...event, error: { ...event.error, model: model.id } };
              else yield { ...event, partial: { ...event.partial, model: model.id } };
            }
            if (!retry) return;
          }
        },
      }));
    };
  return { stream: wrap(streams.stream), streamSimple: wrap(streams.streamSimple) };
}

export function createCliproxyProvider(
  config: Config,
  known: readonly Model<Api>[] = builtinCatalog(),
  onQuotaWait?: QuotaWaitHandler,
) {
  const standardAuth = envApiKeyAuth("CLIProxyAPI API key", ["CLIPROXYAPI_API_KEY"]);
  const scope = createHash("sha256")
    .update(JSON.stringify([4, { baseUrl: config.baseUrl, aliases: config.aliases }]))
    .digest("hex");
  const provider = createProvider<CpaApi>({
    id: PROVIDER_ID,
    name: "CLIProxyAPI",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        ...standardAuth,
        async login(interaction) {
          const credential = await standardAuth.login?.(interaction);
          if (!credential?.key) throw new Error("CLIProxyAPI requires an API key.");
          validateKey(credential.key);
          await discover(config, credential.key, interaction.signal, known);
          return credential;
        },
        async resolve(input) {
          const result = await standardAuth.resolve(input);
          if (!result?.auth.apiKey) return undefined;
          const key = validateKey(result.auth.apiKey);
          return { ...result, auth: { apiKey: key, headers: { Authorization: `Bearer ${key}` } } };
        },
      },
    },
    models: [],
    async fetchModels(context) {
      if (context.credential?.type !== "api_key" || !context.credential.key) {
        throw new Error("Use /login cliproxyapi or set CLIPROXYAPI_API_KEY before refreshing.");
      }
      return (await discover(config, context.credential.key, context.signal, known)).models;
    },
    api: {
      "anthropic-messages": route(anthropicMessagesApi(), config, onQuotaWait),
      "openai-responses": route(openAIResponsesApi(), config, onQuotaWait),
      "openai-completions": route(openAICompletionsApi(), config, onQuotaWait),
      "google-generative-ai": route(googleGenerativeAIApi(), config, onQuotaWait),
    },
  });
  const refresh = provider.refreshModels;
  return {
    ...provider,
    async refreshModels(context: RefreshModelsContext) {
      await refresh?.({
        ...context,
        // Pi owns storage and publication; the validator isolates endpoint/config changes.
        stored: context.stored?.etag === scope ? context.stored : { models: [] },
        publish: (publication) =>
          context.publish({
            ...publication,
            persist: publication.persist ? { ...publication.persist, etag: scope } : publication.persist,
          }),
      });
    },
  };
}
