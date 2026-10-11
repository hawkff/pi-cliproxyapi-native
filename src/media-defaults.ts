import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MediaPurpose, mediaCapability, mediaPurpose, modelRoute } from "./catalog.ts";
import { type Config, isModelId, isRecord, PROVIDER_ID } from "./config.ts";

export const MEDIA_DEFAULTS_ENTRY = "cliproxyapi-media-defaults";
export const OPENAI_IMAGE_DEFAULT = "gpt-image-2.5-sunburst";
// null blocks fallback for invalid selections, including after unrelated picker saves.
export type MediaDefaults = Partial<Record<MediaPurpose, string | null>>;
export type DefaultsContext = {
  sessionManager?: Pick<ExtensionContext["sessionManager"], "getBranch">;
  model?: ExtensionContext["model"];
};

export function readMediaDefaults(config: Config, ctx: DefaultsContext) {
  let defaults: MediaDefaults = {};
  for (const entry of ctx.sessionManager?.getBranch() ?? []) {
    if (entry.type !== "custom" || entry.customType !== MEDIA_DEFAULTS_ENTRY) continue;
    const data: unknown = entry.data;
    if (!isRecord(data) || data.endpoint !== config.baseUrl) continue;
    // An invalid latest snapshot must not resurrect an older or automatic default.
    defaults = { image: null, video: null };
    if (data.version !== 1 || !isRecord(data.defaults)) continue;
    defaults = {};
    for (const purpose of ["image", "video"] as const) {
      if (!Object.hasOwn(data.defaults, purpose)) continue;
      const id = data.defaults[purpose];
      defaults[purpose] =
        isModelId(id) && mediaPurpose(id) === purpose && !mediaCapability(id)?.disabledReason ? id : null;
    }
  }
  return defaults;
}

export function automaticImageDefault(config: Config, ctx: DefaultsContext) {
  const model = ctx.model;
  if (!model || mediaPurpose(model.id)) return undefined;
  const { metadataId, prefix } = modelRoute(model.id);
  const alias =
    model.provider === PROVIDER_ID
      ? Object.hasOwn(config.aliases, model.id)
        ? config.aliases[model.id]
        : prefix && Object.hasOwn(config.aliases, metadataId)
          ? config.aliases[metadataId]
          : undefined
      : undefined;
  const openai = alias
    ? /^(openai|openai-codex)\//.test(alias)
    : model.provider === "openai" ||
      model.provider === "openai-codex" ||
      /^(?:(?:openai|openai-codex)\/)?(?:gpt-|chatgpt-|o[1-9](?:-|$))/.test(metadataId);
  return openai ? OPENAI_IMAGE_DEFAULT : undefined;
}

export function effectiveMediaDefaults(config: Config, ctx: DefaultsContext) {
  const defaults = readMediaDefaults(config, ctx);
  const automatic = defaults.image === undefined ? automaticImageDefault(config, ctx) : undefined;
  if (automatic) defaults.image = automatic;
  return { defaults, automatic };
}

export function resolveMediaModel(
  config: Config,
  ctx: DefaultsContext,
  purpose: MediaPurpose,
  explicit?: string,
) {
  const model = explicit === undefined ? effectiveMediaDefaults(config, ctx).defaults[purpose] : explicit;
  if (model === undefined || model === null) {
    throw new Error(
      `No ${purpose} default${model === null ? " (saved selection is invalid or disabled)" : ""}. Use /cli:model to select one, or pass an explicit model ID from cliproxyapi_media_models.`,
    );
  }
  const disabledReason = mediaCapability(model)?.disabledReason;
  if (disabledReason) throw new Error(disabledReason);
  if (mediaPurpose(model) !== purpose) {
    throw new Error(`Choose an explicit supported ${purpose} model from cliproxyapi_media_models.`);
  }
  return model;
}
