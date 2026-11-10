import type { Api, Model } from "@earendil-works/pi-ai";
import { type Config, deadline, isModelId, isRecord, PROVIDER_ID, readJson, validateKey } from "./config.ts";

export type CpaApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

function isCpaApi(api: string): api is CpaApi {
  return ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(
    api,
  );
}

export function endpoint(baseUrl: string, api: string) {
  if (api === "anthropic-messages") return baseUrl;
  return `${baseUrl}/${api === "google-generative-ai" ? "v1beta" : "v1"}`;
}

export function parseCatalog(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 10000) {
    throw new Error("Invalid CLIProxyAPI model catalog: expected a data array.");
  }
  const entries = value.data.flatMap((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      (entry.owned_by !== undefined && typeof entry.owned_by !== "string")
    ) {
      throw new Error("Invalid CLIProxyAPI model catalog entry.");
    }
    // The proxy accepts any text as a model alias. An ID with spaces or other characters that requests and
    // the terminal cannot carry safely is skipped, so the rest of the catalog stays available.
    if (!isModelId(entry.id)) return [];
    // The proxy reports a custom provider's configured name as the owner; it can be empty or contain spaces.
    const owner = isModelId(entry.owned_by) ? entry.owned_by : undefined;
    return [{ id: entry.id, owner, hidden: entry.visibility === "hide" }];
  });
  // A response with entries but no usable ID is not an empty catalog, and must not replace a working list.
  if (value.data.length && !entries.length) {
    throw new Error("Invalid CLIProxyAPI model catalog: no usable model ID.");
  }
  return entries;
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
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CLIProxyAPI discovery returned an empty response.");
  try {
    return await readJson(reader, 4 * 1024 * 1024);
  } catch {
    void reader.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error("CLIProxyAPI catalog is invalid, incomplete, or larger than 4 MiB.");
  } finally {
    reader.releaseLock();
  }
}

// Resolve metadata and capabilities without changing registry or request IDs.
export function modelRoute(id: string) {
  const match = /^(vertex|antigravity|oauth|api)\/(.+)$/.exec(id);
  const prefix = match?.[1];
  return {
    metadataId: match?.[2] ?? id,
    prefix,
    backend: prefix === "vertex" ? "Vertex" : prefix === "antigravity" ? "Antigravity" : undefined,
    authType: prefix === "api" ? "api-key" : prefix === "oauth" ? "oauth" : undefined,
  };
}

// An alias for the full ID wins. A recognized route prefix can reuse its unprefixed ID's alias.
export function configuredAlias(config: Config, id: string) {
  const { metadataId, prefix } = modelRoute(id);
  if (Object.hasOwn(config.aliases, id)) return config.aliases[id];
  return prefix && Object.hasOwn(config.aliases, metadataId) ? config.aliases[metadataId] : undefined;
}

export function backendLabel(id: string) {
  const { backend, authType } = modelRoute(id);
  if (authType) return authType === "api-key" ? "API key" : "OAuth";
  return backend ?? (id.includes("/") ? "Unknown backend" : "Automatic (proxy routing)");
}

export function routedName(id: string, name = id) {
  return `${name} · ${backendLabel(id)}`;
}

export type MediaPurpose = "image" | "video";

const imagenRetirement = "Retired on Vertex (June 2026); disabled. Select a Nano Banana image model instead.";
// OpenAI list prices in USD per million tokens: text input, image input, image output.
const gptImage2Price = [5, 8, 30] as const;

// Exact media IDs, including retired entries; vision input alone does not imply image output.
const mediaModels = new Map<
  string,
  {
    name: string;
    purpose: MediaPurpose;
    route?: "xai" | "gemini" | "openai";
    disabledReason?: string;
    price?: readonly [number, number, number];
  }
>([
  [
    "gpt-image-2.6-flare",
    { name: "GPT Image 2.6 Flare", purpose: "image", route: "openai", price: gptImage2Price },
  ],
  [
    "gpt-image-2.6-sunburst",
    { name: "GPT Image 2.6 Sunburst", purpose: "image", route: "openai", price: gptImage2Price },
  ],
  ["gpt-image-2.6", { name: "GPT Image 2.6", purpose: "image", route: "openai" }],
  [
    "gpt-image-2.5-flare",
    { name: "GPT Image 2.5 Flare", purpose: "image", route: "openai", price: gptImage2Price },
  ],
  [
    "gpt-image-2.5-sunburst",
    { name: "GPT Image 2.5 Sunburst", purpose: "image", route: "openai", price: gptImage2Price },
  ],
  ["gpt-image-2.5", { name: "GPT Image 2.5", purpose: "image", route: "openai" }],
  ["gpt-image-2", { name: "GPT Image 2", purpose: "image", route: "openai", price: gptImage2Price }],
  ["gpt-image-1.5", { name: "GPT Image 1.5", purpose: "image", route: "openai", price: [5, 8, 32] }],
  ["grok-imagine-image", { name: "Grok Imagine Image", purpose: "image", route: "xai" }],
  ["grok-imagine-image-quality", { name: "Grok Imagine Image Quality", purpose: "image", route: "xai" }],
  ["grok-imagine-image-2.0", { name: "Grok Imagine Image 2.0", purpose: "image", route: "xai" }],
  ["grok-imagine-video", { name: "Grok Imagine Video", purpose: "video", route: "xai" }],
  ["grok-imagine-video-1.5", { name: "Grok Imagine Video 1.5", purpose: "video", route: "xai" }],
  ["grok-imagine-video-1.5-lite", { name: "Grok Imagine Video 1.5 Lite", purpose: "video", route: "xai" }],
  [
    "grok-imagine-video-1.5-preview",
    { name: "Grok Imagine Video 1.5 Preview", purpose: "video", route: "xai" },
  ],
  ["gemini-2.5-flash-image", { name: "Nano Banana", purpose: "image", route: "gemini" }],
  ["gemini-3.1-flash-image", { name: "Nano Banana 2", purpose: "image", route: "gemini" }],
  ["gemini-3-pro-image", { name: "Nano Banana Pro", purpose: "image", route: "gemini" }],
  ["gemini-3.1-flash-lite-image", { name: "Nano Banana 2 Lite", purpose: "image", route: "gemini" }],
  ["imagen-3.0-generate-002", { name: "Imagen 3", purpose: "image", disabledReason: imagenRetirement }],
  [
    "imagen-3.0-fast-generate-001",
    { name: "Imagen 3 Fast", purpose: "image", disabledReason: imagenRetirement },
  ],
  ["imagen-4.0-generate-001", { name: "Imagen 4", purpose: "image", disabledReason: imagenRetirement }],
  [
    "imagen-4.0-fast-generate-001",
    { name: "Imagen 4 Fast", purpose: "image", disabledReason: imagenRetirement },
  ],
  [
    "imagen-4.0-ultra-generate-001",
    { name: "Imagen 4 Ultra", purpose: "image", disabledReason: imagenRetirement },
  ],
]);

export function mediaCapability(id: string) {
  const { metadataId, backend, authType } = modelRoute(id);
  const capability = mediaModels.get(metadataId);
  if (backend && (capability?.route === "xai" || capability?.route === "openai")) {
    return { ...capability, route: undefined, disabledReason: `Unsupported media execution on ${backend}.` };
  }
  // CLIProxyAPI advertises the plain names for API keys, but OpenAI's Images API has only Sunburst and Flare.
  if (capability && authType === "api-key" && /^gpt-image-2\.[56]$/.test(metadataId)) {
    return {
      ...capability,
      route: undefined,
      disabledReason: `OpenAI's API has no ${metadataId} model. Use api/${metadataId}-sunburst or api/${metadataId}-flare.`,
    };
  }
  return capability;
}

export function mediaPurpose(id: string) {
  return mediaCapability(id)?.purpose;
}

export function mediaControls(id: string) {
  const capability = mediaCapability(id);
  const { metadataId, authType } = modelRoute(id);
  const openai = capability?.route === "openai";
  // Sunburst and Flare add quality tiers and markup edits; 2.6 adds complexity plus GIF and SVG output.
  const tiered = openai && /^gpt-image-2\.[56]-(sunburst|flare)$/.test(metadataId);
  const image26 = tiered && metadataId.startsWith("gpt-image-2.6-");
  const commonRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
  let resolution: string[] = [];
  let aspect_ratio: string[] = [];
  if (capability?.route === "gemini") {
    aspect_ratio = [...commonRatios, "4:5", "5:4", "21:9"];
    if (metadataId === "gemini-3.1-flash-image") {
      resolution = ["512", "1K", "2K", "4K"];
      aspect_ratio.push("1:4", "4:1", "1:8", "8:1");
    } else if (metadataId === "gemini-3-pro-image") resolution = ["1K", "2K", "4K"];
    else if (metadataId === "gemini-3.1-flash-lite-image") resolution = ["1K"];
  } else if (capability?.route === "xai") {
    aspect_ratio = commonRatios;
    if (capability.purpose === "image") {
      resolution = ["1k", "2k"];
      // CLIProxyAPI 8.0.7 drops other xAI image ratios, including auto.
      aspect_ratio.push("9:20", "20:9");
    } else {
      resolution = ["480p", "720p"];
      if (metadataId !== "grok-imagine-video") resolution.push("1080p");
    }
  }
  return {
    size: capability?.route === "openai" ? ["auto", "1024x1024", "1536x1024", "1024x1536"] : [],
    size_limits:
      capability?.route === "openai" && metadataId !== "gpt-image-1.5"
        ? { multiple_of: 16, max_edge: 3840, min_pixels: 655360, max_pixels: 8294400, max_aspect_ratio: 3 }
        : undefined,
    resolution,
    aspect_ratio,
    quality: openai ? ["auto", "low", "medium", "high", ...(tiered ? ["xhigh", "max"] : [])] : [],
    complexity: image26 ? ["low", "medium", "high"] : [],
    background: openai ? ["auto", "opaque", "transparent"] : [],
    output_format: openai ? ["png", "jpeg", "webp", ...(image26 ? ["gif", "svg"] : [])] : [],
    // GIF sizes are per frame and skip min_pixels; OpenAI checks the animation against its pixel budget.
    gif: image26
      ? { frame_count: { min: 2, max: 16 }, frame_duration_ms: { min: 20, max: 2000 } }
      : undefined,
    output_compression: openai ? { min: 0, max: 100, formats: ["jpeg", "webp"] } : undefined,
    moderation: openai ? ["auto", "low"] : [],
    // Subscription image-tool translation does not forward n.
    n: openai ? { min: 1, max: authType === "api-key" ? 10 : 1 } : undefined,
    partial_images: openai ? { min: 0, max: 3 } : undefined,
    editing: openai
      ? {
          max_images: 16,
          max_file_bytes: 14 * 1024 * 1024,
          max_total_bytes: 20 * 1024 * 1024,
          mask: "png",
          ...(tiered ? { markup: "png" } : {}),
        }
      : undefined,
    input_fidelity: openai && metadataId === "gpt-image-1.5" ? ["low", "high"] : [],
  };
}

export const IMAGE_API = "cliproxyapi-images";

// Pi image models for codemode and extensions; video stays tool-only because Pi has no video interface.
export function mapImageModels(value: unknown, config: Config) {
  return mapMediaCatalog(value).flatMap(({ id, purpose, name, controls }) => {
    if (purpose !== "image") return [];
    const [input = 0, , output = 0] = mediaCapability(id)?.price ?? [];
    return [
      {
        type: "image" as const,
        id,
        name,
        api: IMAGE_API,
        provider: PROVIDER_ID,
        baseUrl: config.baseUrl,
        input: controls.editing ? ["text" as const, "image" as const] : ["text" as const],
        output: ["image" as const],
        cost: { input, output, cacheRead: 0, cacheWrite: 0 },
      },
    ];
  });
}

export function mapMediaCatalog(value: unknown) {
  const models = new Map<
    string,
    { id: string; purpose: MediaPurpose; name: string; controls: ReturnType<typeof mediaControls> }
  >();
  for (const entry of parseCatalog(value)) {
    const capability = mediaCapability(entry.id);
    if (!entry.hidden && capability && !capability.disabledReason)
      models.set(entry.id, {
        id: entry.id,
        purpose: capability.purpose,
        name: routedName(entry.id, capability.name),
        controls: mediaControls(entry.id),
      });
  }
  return [...models.values()];
}

const owners: Readonly<Record<string, string>> = {
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  codex: "openai-codex",
  "openai-codex": "openai-codex",
  google: "google",
  gemini: "google",
  "gemini-cli": "google",
  xai: "xai",
};

// Built-in aliases for advertised IDs without native metadata; exact metadata still wins.
const metadataFallbacks = new Map([
  ["claude-opus-5-5-high", "anthropic/claude-opus-5-5"],
  ["claude-sonnet-5-5-high", "anthropic/claude-sonnet-5-5"],
  ["gemini-4-argon-high", "google/gemini-4-argon"],
]);

export function mapCatalog(value: unknown, config: Config, known: readonly Model<Api>[]) {
  const models = new Map<string, Model<CpaApi>>();
  const skipped = new Set<string>();
  const byId = Map.groupBy(known, (model) => model.id);
  const byReference = Map.groupBy(known, (model) => `${model.provider}/${model.id}`);
  for (const entry of parseCatalog(value)) {
    if (entry.hidden || models.has(entry.id) || mediaPurpose(entry.id)) continue;
    const { metadataId, prefix } = modelRoute(entry.id);
    const routed = !entry.id.includes("/") || prefix;
    const alias =
      configuredAlias(config, entry.id) ??
      (routed && !byId.has(metadataId) ? metadataFallbacks.get(metadataId) : undefined);
    const candidates = (alias ? byReference.get(alias) : routed ? byId.get(metadataId) : undefined) ?? [];
    const families = new Set(
      candidates.map((model) => (model.provider === "openai-codex" ? "openai" : model.provider)),
    );
    const preferred = entry.owner ? owners[entry.owner.toLowerCase()] : undefined;
    const reference = alias
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : (candidates.find((model) => model.provider === preferred) ??
        (families.size === 1 ? candidates[0] : undefined));
    if (!reference) {
      skipped.add(entry.id);
      continue;
    }
    const api = reference.api === "openai-codex-responses" ? "openai-responses" : reference.api;
    if (!isCpaApi(api)) {
      skipped.add(entry.id);
      continue;
    }
    // CLIProxyAPI 8.0.48 forwards strict and grammar tools, additional_tools, tool search, and
    // mid-conversation instructions to OpenAI API keys and ChatGPT subscriptions (live-checked).
    // Other owners stay conservative. If an OpenAI-compatible provider shares a bare ID, the proxy
    // lists one owner, and its Chat translator converts these items for that provider.
    const openai =
      api === "openai-responses" &&
      !metadataId.includes("/") &&
      (!prefix || prefix === "api" || prefix === "oauth") &&
      (preferred === "openai" || preferred === "openai-codex") &&
      (reference.provider === "openai" || reference.provider === "openai-codex");
    const model: Model<CpaApi> = {
      ...structuredClone(reference),
      id: entry.id,
      name: routedName(entry.id, alias ? `${entry.id} (${reference.name})` : reference.name),
      provider: PROVIDER_ID,
      api,
      baseUrl: endpoint(config.baseUrl, api),
      headers: undefined,
      // CLIProxyAPI gives OAuth Claude caches a one-hour TTL. Only api/ routes keep Pi's five-minute refreshes.
      ...(api === "anthropic-messages" && prefix !== "api"
        ? { promptCache: { short: 3600, long: 3600 } }
        : {}),
      compat:
        api === "anthropic-messages"
          ? {
              ...reference.compat,
              supportsEagerToolInputStreaming: false,
              supportsStrictTools: false,
              supportsMidConvoSystemMessages: false,
              supportsMidConvoToolChanges: false,
              supportsMidConvoEffort: false,
              // A route that drops the thread field would send only the newest messages.
              supportsMessageThreads: false,
              allowedFallbackModels: undefined,
            }
          : api === "google-generative-ai"
            ? reference.compat
            : openai
              ? // ChatGPT subscriptions ignore configuration_update effort items; only API keys apply them.
                { ...reference.compat, ...(prefix === "api" ? {} : { supportsMidConvoEffort: false }) }
              : {
                  ...reference.compat,
                  supportsStrictMode: false,
                  supportsMidConvoSystemMessages: false,
                  supportsMidConvoToolAdditions: false,
                  supportsOpenAIGrammarTools: false,
                  supportsToolSearch: false,
                  supportsAdditionalTools: false,
                  supportsMidConvoEffort: false,
                },
    };
    models.set(model.id, model);
    skipped.delete(model.id);
  }
  return { models: [...models.values()], skipped: [...skipped] };
}
