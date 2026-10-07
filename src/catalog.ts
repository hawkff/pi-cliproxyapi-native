import type { Api, Model } from "@earendil-works/pi-ai";
import { type Config, isModelId, isRecord, PROVIDER_ID } from "./config.ts";

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
  return value.data.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isModelId(entry.id) ||
      (entry.owned_by !== undefined && !isModelId(entry.owned_by))
    ) {
      throw new Error("Invalid CLIProxyAPI model catalog entry.");
    }
    return { id: entry.id, owner: entry.owned_by, hidden: entry.visibility === "hide" };
  });
}

// Resolve metadata and capabilities without changing registry or request IDs.
export function modelRoute(id: string) {
  const match = /^(vertex|antigravity)\/(.+)$/.exec(id);
  return {
    metadataId: match?.[2] ?? id,
    backend: match ? (match[1] === "vertex" ? "Vertex" : "Antigravity") : undefined,
  };
}

export function backendLabel(id: string) {
  return modelRoute(id).backend ?? (id.includes("/") ? "Unknown backend" : "Automatic (proxy routing)");
}

export function routedName(id: string, name = id) {
  return `${name} · ${backendLabel(id)}`;
}

export type MediaPurpose = "image" | "video";

const imagenRetirement = "Retired on Vertex (June 2026); disabled. Select a Nano Banana image model instead.";

// Exact media IDs, including retired entries; vision input alone does not imply image output.
const mediaModels = new Map<
  string,
  { name: string; purpose: MediaPurpose; route?: "xai" | "gemini" | "openai"; disabledReason?: string }
>([
  ["gpt-image-2.5-flare", { name: "GPT Image 2.5 Flare", purpose: "image", route: "openai" }],
  ["gpt-image-2.5-sunburst", { name: "GPT Image 2.5 Sunburst", purpose: "image", route: "openai" }],
  ["gpt-image-2.5", { name: "GPT Image 2.5", purpose: "image", route: "openai" }],
  ["gpt-image-2", { name: "GPT Image 2", purpose: "image", route: "openai" }],
  ["gpt-image-1.5", { name: "GPT Image 1.5", purpose: "image", route: "openai" }],
  ["grok-imagine-image", { name: "Grok Imagine Image", purpose: "image", route: "xai" }],
  ["grok-imagine-image-quality", { name: "Grok Imagine Image Quality", purpose: "image", route: "xai" }],
  ["grok-imagine-image-2.0", { name: "Grok Imagine Image 2.0", purpose: "image", route: "xai" }],
  ["grok-imagine-video", { name: "Grok Imagine Video", purpose: "video", route: "xai" }],
  ["grok-imagine-video-1.5", { name: "Grok Imagine Video 1.5", purpose: "video", route: "xai" }],
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
  const { metadataId, backend } = modelRoute(id);
  const capability = mediaModels.get(metadataId);
  if (backend && (capability?.route === "xai" || capability?.route === "openai")) {
    return { ...capability, route: undefined, disabledReason: `Unsupported media execution on ${backend}.` };
  }
  return capability;
}

export function mediaPurpose(id: string) {
  return mediaCapability(id)?.purpose;
}

export function mediaControls(id: string) {
  const capability = mediaCapability(id);
  const { metadataId } = modelRoute(id);
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
  };
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
};

const metadataFallbacks = new Map([
  ["claude-opus-5-5-high", "anthropic/claude-opus-5-5"],
  ["claude-sonnet-5-5-high", "anthropic/claude-sonnet-5-5"],
]);

export function mapCatalog(value: unknown, config: Config, known: readonly Model<Api>[]) {
  const models = new Map<string, Model<CpaApi>>();
  const skipped = new Set<string>();
  for (const entry of parseCatalog(value)) {
    if (entry.hidden || models.has(entry.id)) continue;
    if (mediaPurpose(entry.id)) {
      skipped.add(entry.id);
      continue;
    }
    const { metadataId, backend } = modelRoute(entry.id);
    const alias = Object.hasOwn(config.aliases, entry.id)
      ? config.aliases[entry.id]
      : backend && Object.hasOwn(config.aliases, metadataId)
        ? config.aliases[metadataId]
        : undefined;
    let candidates = known.filter((model) =>
      alias
        ? `${model.provider}/${model.id}` === alias
        : (!entry.id.includes("/") || backend) && model.id === metadataId,
    );
    const fallback = metadataFallbacks.get(metadataId);
    if (!alias && candidates.length === 0 && fallback && (!entry.id.includes("/") || backend)) {
      candidates = known.filter((model) => `${model.provider}/${model.id}` === fallback);
      if (candidates.length !== 1) candidates = [];
    }
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
    const model: Model<CpaApi> = {
      ...structuredClone(reference),
      id: entry.id,
      name: routedName(entry.id, alias ? `${entry.id} (${reference.name})` : reference.name),
      provider: PROVIDER_ID,
      api,
      baseUrl: endpoint(config.baseUrl, api),
      headers: undefined,
      compat:
        api === "anthropic-messages"
          ? {
              ...reference.compat,
              supportsEagerToolInputStreaming: false,
              supportsStrictTools: false,
              supportsMidConvoSystemMessages: false,
              supportsMidConvoToolChanges: false,
              supportsMidConvoEffort: false,
              allowedFallbackModels: undefined,
            }
          : api === "google-generative-ai"
            ? reference.compat
            : {
                ...reference.compat,
                supportsStrictMode: false,
                supportsMidConvoSystemMessages: false,
                supportsMidConvoToolAdditions: false,
                supportsOpenAIGrammarTools: false,
                supportsToolSearch: false,
                supportsAdditionalTools: false,
              },
    };
    models.set(model.id, model);
    skipped.delete(model.id);
  }
  return { models: [...models.values()], skipped: [...skipped] };
}
