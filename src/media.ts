import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { join } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { type ImageContent, type Static, type TextContent, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mapMediaCatalog, mediaCapability, mediaControls } from "./catalog.ts";
import { type Config, isRecord, PROVIDER_ID } from "./config.ts";
import { type DefaultsContext, effectiveMediaDefaults, resolveMediaModel } from "./media-defaults.ts";
import { deadline, fetchCatalog, validateKey } from "./provider.ts";

type MediaContext = Pick<ExtensionContext, "cwd" | "model"> &
  DefaultsContext & {
    modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
  };

const MAX_INLINE_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

const generationParameters = Type.Object({
  model: Type.Optional(
    Type.String({
      description:
        "Exact advertised ID, including any routing prefix, from cliproxyapi_media_models. Omit to use the effective default (selected with /cli:model, or automatic for OpenAI/GPT images); explicit ID wins.",
    }),
  ),
  prompt: Type.String({ minLength: 1 }),
});

const outputParameters = {
  resolution: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 8,
      description:
        "Model-specific resolution tier, with exact spelling from cliproxyapi_media_models controls.resolution. Omit to preserve the backend default. OpenAI images use size instead.",
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.String({
      minLength: 3,
      maxLength: 8,
      description:
        "Output aspect ratio from cliproxyapi_media_models controls.aspect_ratio, such as 16:9. OpenAI images encode this in size instead. Omit to preserve the backend default.",
    }),
  ),
};

const imageParameters = Type.Object({
  ...generationParameters.properties,
  ...outputParameters,
  size: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 32,
      description:
        "OpenAI image size: auto or WIDTHxHEIGHT. Use controls.size and controls.size_limits from cliproxyapi_media_models. Omit to preserve the backend default.",
    }),
  ),
});

const videoParameters = Type.Object({
  ...generationParameters.properties,
  ...outputParameters,
  duration: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 15, description: "Video length in seconds (1–15)." }),
  ),
});

function mediaOutputOptions(
  model: string,
  params: Pick<Static<typeof imageParameters>, "size" | "resolution" | "aspect_ratio">,
) {
  const options = { size: params.size, resolution: params.resolution, aspect_ratio: params.aspect_ratio };
  const controls = mediaControls(model);
  for (const field of ["size", "resolution", "aspect_ratio"] as const) {
    const value = options[field];
    if (value === undefined) continue;
    if (typeof value === "string" && controls[field].includes(value)) continue;
    const limits = field === "size" ? controls.size_limits : undefined;
    if (typeof value === "string" && limits) {
      const match = /^([1-9]\d{0,3})x([1-9]\d{0,3})$/.exec(value);
      if (match && match[0] === value) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        const pixels = width * height;
        if (
          width % limits.multiple_of === 0 &&
          height % limits.multiple_of === 0 &&
          Math.max(width, height) <= limits.max_edge &&
          Math.max(width, height) / Math.min(width, height) <= limits.max_aspect_ratio &&
          pixels >= limits.min_pixels &&
          pixels <= limits.max_pixels
        )
          continue;
      }
    }
    throw new Error(
      `CLIProxyAPI ${field} is unsupported for ${model}. See cliproxyapi_media_models for supported controls.`,
    );
  }
  return options;
}

export async function mediaKey(ctx: Pick<MediaContext, "modelRegistry">, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(new Error("CLIProxyAPI media operation cancelled or timed out."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Pi's provider-auth facade has no signal argument; bound the wait without reading its store.
    const resolved = await Promise.race([ctx.modelRegistry.getProviderAuth(PROVIDER_ID), cancelled.promise]);
    signal.throwIfAborted();
    if (!resolved?.auth.apiKey) {
      throw new Error("Use /login cliproxyapi or set CLIPROXYAPI_API_KEY before using media tools.");
    }
    return validateKey(resolved.auth.apiKey);
  } catch {
    if (signal.aborted) throw new Error("CLIProxyAPI media operation cancelled or timed out.");
    throw new Error(
      "CLIProxyAPI media authentication failed. Use /login cliproxyapi or check CLIPROXYAPI_API_KEY.",
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function openaiImageResponse(config: Config, key: string, body: object, signal: AbortSignal) {
  return new Promise<{ ok: boolean; status: number; body: ReturnType<typeof Readable.toWeb> | null }>(
    (resolve, reject) => {
      const url = new URL(`${config.baseUrl}/v1/images/generations`);
      const transport = url.protocol === "https:" ? https : http;
      const options = "options" in transport.globalAgent ? transport.globalAgent.options : undefined;
      // Preserve configured proxies without inheriting the global agent's socket timeout.
      const agent = new transport.Agent({
        ...(isRecord(options) ? options : {}),
        keepAlive: false,
        timeout: 0,
      });
      const connect = agent.createConnection.bind(agent);
      agent.createConnection = (connectionOptions, callback) => {
        // Node assigns HTTPS proxy sockets to the request only after CONNECT completes.
        const socket = connect(connectionOptions, callback);
        return socket ? addAbortSignal(signal, socket) : socket;
      };
      const request = transport.request(
        url,
        {
          method: "POST",
          agent,
          timeout: 0,
          signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
          },
        },
        (incoming) => {
          const status = incoming.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            incoming.destroy();
            resolve({ ok: false, status, body: null });
            return;
          }
          if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
            incoming.destroy();
            reject(new Error("Unsupported image response encoding."));
            return;
          }
          resolve({
            ok: true,
            status,
            body: Readable.toWeb(addAbortSignal(signal, incoming), { strategy: { highWaterMark: 1 } }),
          });
        },
      );
      request.on("error", reject);
      request.on("upgrade", (incoming, socket) => {
        socket.destroy();
        resolve({ ok: false, status: incoming.statusCode ?? 101, body: null });
      });
      request.end(JSON.stringify(body));
    },
  );
}

async function mediaRequest(
  config: Config,
  key: string,
  path: string,
  signal: AbortSignal,
  maxBytes: number,
  body?: object,
  openaiImage = false,
) {
  let response: Response | Awaited<ReturnType<typeof openaiImageResponse>>;
  try {
    response =
      openaiImage && body
        ? await openaiImageResponse(config, key, body, signal)
        : await fetch(`${config.baseUrl}/${path}`, {
            method: body ? "POST" : "GET",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "error",
            signal,
          });
  } catch {
    throw new Error(
      "CLIProxyAPI media request failed: connection, cancellation, timeout, or redirect error. Generation was not retried.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CLIProxyAPI media request failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CLIProxyAPI media returned an empty response.");
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Response too large.");
      }
      chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return result;
  } catch {
    throw new Error(
      "CLIProxyAPI media response is invalid, incomplete, cancelled, or exceeds the response size limit.",
    );
  } finally {
    reader.releaseLock();
  }
}

export async function listMediaModels(config: Config, ctx: MediaContext, signal?: AbortSignal) {
  const bounded = deadline(signal, 15000);
  const key = await mediaKey(ctx, bounded);
  return mapMediaCatalog(await fetchCatalog(config, key, bounded));
}

async function generationKey(
  config: Config,
  params: { model: string; prompt: string },
  ctx: MediaContext,
  signal: AbortSignal,
) {
  if (typeof params.prompt !== "string" || !params.prompt.trim()) {
    throw new Error("CLIProxyAPI media requires a non-empty prompt.");
  }
  const key = await mediaKey(ctx, signal);
  const available = mapMediaCatalog(await fetchCatalog(config, key, signal));
  if (!available.some(({ id }) => id === params.model)) {
    throw new Error("The selected media model is not available in the live CLIProxyAPI catalog.");
  }
  return key;
}

function parseImage(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== 1) {
    throw new Error("CLIProxyAPI image response must contain one image.");
  }
  const entry: unknown = value.data[0];
  if (!isRecord(entry) || typeof entry.b64_json !== "string") {
    throw new Error("CLIProxyAPI did not return b64_json image data. URL-only images are not downloaded.");
  }
  const encoded = entry.b64_json;
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) {
    throw new Error("CLIProxyAPI returned invalid base64 image data.");
  }
  let extension: string;
  let mimeType: string;
  if (
    bytes.length > 24 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    extension = "png";
    mimeType = "image/png";
  } else if (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  ) {
    extension = "jpg";
    mimeType = "image/jpeg";
  } else if (
    bytes.length > 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    extension = "webp";
    mimeType = "image/webp";
  } else {
    throw new Error("CLIProxyAPI returned an unsupported or malformed image; expected JPEG, PNG, or WebP.");
  }
  const image: ImageContent = { type: "image", data: encoded, mimeType };
  return { bytes, extension, image };
}

function parseGoogleImages(value: unknown) {
  const invalid = () =>
    new Error(
      "CLIProxyAPI Google image response is blocked, refused, incomplete, text-only, or malformed. No images saved.",
    );
  if (
    !isRecord(value) ||
    value.error !== undefined ||
    value.refusal !== undefined ||
    (value.promptFeedback !== undefined &&
      (!isRecord(value.promptFeedback) || value.promptFeedback.blockReason !== undefined)) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length !== 1
  )
    throw invalid();
  const candidate: unknown = value.candidates[0];
  if (
    !isRecord(candidate) ||
    candidate.finishReason !== "STOP" ||
    candidate.refusal !== undefined ||
    !isRecord(candidate.content) ||
    !Array.isArray(candidate.content.parts) ||
    candidate.content.parts.length > 256
  )
    throw invalid();
  for (const ratings of [
    isRecord(value.promptFeedback) ? value.promptFeedback.safetyRatings : undefined,
    candidate.safetyRatings,
  ]) {
    if (
      ratings !== undefined &&
      (!Array.isArray(ratings) ||
        ratings.some(
          (rating: unknown) =>
            !isRecord(rating) || (rating.blocked !== undefined && rating.blocked !== false),
        ))
    )
      throw invalid();
  }
  const images: ReturnType<typeof parseImage>[] = [];
  for (const part of candidate.content.parts) {
    if (
      !isRecord(part) ||
      part.refusal !== undefined ||
      (part.thought !== undefined && typeof part.thought !== "boolean")
    )
      throw invalid();
    if (part.thought === true) continue;
    if (part.inlineData !== undefined) {
      if (!isRecord(part.inlineData) || typeof part.inlineData.data !== "string") throw invalid();
      const parsed = parseImage({ data: [{ b64_json: part.inlineData.data }] });
      if (part.inlineData.mimeType !== parsed.image.mimeType) throw invalid();
      images.push(parsed);
    } else if (typeof part.text !== "string") throw invalid();
  }
  if (images.length === 0 || images.length > 16) throw invalid();
  return images;
}

export async function generateImage(
  config: Config,
  params: Static<typeof imageParameters>,
  ctx: MediaContext,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
) {
  const model = resolveMediaModel(config, ctx, "image", params.model);
  const route = mediaCapability(model)?.route;
  const output = mediaOutputOptions(model, params);
  const bounded = deadline(signal, route === "openai" ? 600000 : 180000);
  const key = await generationKey(config, { ...params, model }, ctx, bounded);
  bounded.throwIfAborted();
  onProgress?.("Generating image...");
  bounded.throwIfAborted();
  const result = await mediaRequest(
    config,
    key,
    route === "gemini" ? `v1beta/models/${model}:generateContent` : "v1/images/generations",
    bounded,
    32 * 1024 * 1024,
    route === "xai"
      ? {
          model,
          prompt: params.prompt,
          n: 1,
          response_format: "b64_json",
          resolution: output.resolution,
          aspect_ratio: output.aspect_ratio,
        }
      : route === "openai"
        ? { model, prompt: params.prompt, n: 1, size: output.size }
        : {
            contents: [{ role: "user", parts: [{ text: params.prompt }] }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              candidateCount: 1,
              ...(output.resolution !== undefined || output.aspect_ratio !== undefined
                ? { imageConfig: { imageSize: output.resolution, aspectRatio: output.aspect_ratio } }
                : {}),
            },
          },
    route === "openai",
  );
  const images = route === "gemini" ? parseGoogleImages(result) : [parseImage(result)];
  bounded.throwIfAborted();
  onProgress?.("Saving image...");
  bounded.throwIfAborted();
  const artifacts = join(ctx.cwd, ".pi");
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(artifacts, "cliproxyapi-image-"));
  const files = images.map(({ extension, image }, index) => ({
    path: join(directory, `${index === 0 ? "image" : `image-${index + 1}`}.${extension}`),
    mimeType: image.mimeType,
  }));
  try {
    for (const [index, { bytes }] of images.entries()) {
      await writeFile(files[index].path, bytes, { flag: "wx", mode: 0o600, signal: bounded });
    }
    bounded.throwIfAborted();
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("CLIProxyAPI generated images but could not save the artifacts.");
  }
  let previewBudget = MAX_INLINE_IMAGE_BASE64_BYTES;
  const content: (TextContent | ImageContent)[] = [];
  for (const [index, { image }] of images.entries()) {
    const previewOmitted = !ctx.model?.input.includes("image")
      ? "Preview omitted: the current chat model does not support images."
      : image.data.length > previewBudget
        ? "Preview omitted: image base64 exceeds the 4 MiB inline budget. Use read on the saved file."
        : undefined;
    content.push({
      type: "text",
      text: `Saved image: ${files[index].path}${previewOmitted ? `\n${previewOmitted}` : ""}`,
    });
    if (!previewOmitted) {
      content.push(image);
      previewBudget -= image.data.length;
    }
  }
  return { content, details: { model, files } };
}

function requestId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error(
      "CLIProxyAPI video requires a valid request_id (letters, digits, underscore, or hyphen).",
    );
  }
  return value;
}

export async function generateVideo(
  config: Config,
  params: Static<typeof videoParameters>,
  ctx: MediaContext,
  signal?: AbortSignal,
) {
  if (
    params.duration !== undefined &&
    (!Number.isInteger(params.duration) || params.duration < 1 || params.duration > 15)
  ) {
    throw new Error("CLIProxyAPI video duration must be an integer from 1 to 15 seconds.");
  }
  const model = resolveMediaModel(config, ctx, "video", params.model);
  const output = mediaOutputOptions(model, params);
  const bounded = deadline(signal, 60000);
  const key = await generationKey(config, { ...params, model }, ctx, bounded);
  const result = await mediaRequest(config, key, "v1/videos", bounded, 64 * 1024, {
    model,
    prompt: params.prompt,
    duration: params.duration,
    resolution: output.resolution,
    aspect_ratio: output.aspect_ratio,
  });
  if (!isRecord(result)) throw new Error("CLIProxyAPI returned an invalid video submission.");
  return { model, request_id: requestId(result.request_id), status: "pending" };
}

export async function videoStatus(config: Config, id: string, ctx: MediaContext, signal?: AbortSignal) {
  const request_id = requestId(id);
  const bounded = deadline(signal, 15000);
  const key = await mediaKey(ctx, bounded);
  const result = await mediaRequest(config, key, `v1/videos/${request_id}`, bounded, 64 * 1024);
  if (!isRecord(result)) throw new Error("CLIProxyAPI returned an invalid video status.");
  if (result.status === "pending") return { request_id, status: "pending" };
  if (result.status === "failed" || result.status === "expired") {
    return { request_id, status: "failed", upstream_status: result.status };
  }
  if (result.status === "done" && isRecord(result.video) && result.video.respect_moderation === false) {
    return { request_id, status: "failed", upstream_status: "done", respect_moderation: false };
  }
  if (
    result.status !== "done" ||
    !isRecord(result.video) ||
    typeof result.video.url !== "string" ||
    (result.video.respect_moderation !== undefined && typeof result.video.respect_moderation !== "boolean")
  ) {
    throw new Error("CLIProxyAPI returned an unknown or malformed video status.");
  }
  let url: URL;
  try {
    url = new URL(result.video.url);
  } catch {
    throw new Error("CLIProxyAPI returned an invalid video URL.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 8192) {
    throw new Error("CLIProxyAPI returned an unsafe video URL.");
  }
  return { request_id, status: "completed", upstream_status: "done", url: url.href };
}

export function registerMediaTools(pi: ExtensionAPI, config: Config) {
  pi.registerTool({
    name: "cliproxyapi_media_models",
    label: "CLIProxyAPI media models",
    description:
      "List available CLIProxyAPI image/video models, their supported output controls, and effective defaults. Does not change the chat model.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const models = await listMediaModels(config, ctx, signal);
      const { defaults, automatic } = effectiveMediaDefaults(config, ctx);
      return {
        content: [{ type: "text", text: JSON.stringify({ models, defaults, automatic }) }],
        details: { models, defaults, automatic },
      };
    },
  });
  pi.registerTool({
    name: "cliproxyapi_generate_image",
    label: "CLIProxyAPI image",
    description:
      "Generate images using an explicit available image model, a selected session default, or gpt-image-2.5-sunburst automatically for OpenAI/GPT chats. Saves each final image under a new .pi/ artifact directory and returns paths and previews for vision-capable chat models. Maximum response: 32 MiB; inline image base64: 4 MiB. Larger images return paths without previews. No automatic retries.",
    promptSnippet: "Generate requested raster images through CLIProxyAPI using the effective image default.",
    promptGuidelines: [
      "Use cliproxyapi_generate_image for requested raster images. Omit model to use the effective default unless a specific image model is requested; keep the current chat model.",
    ],
    parameters: imageParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      return generateImage(config, params, ctx, signal, (text) =>
        onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      );
    },
  });
  pi.registerTool({
    name: "cliproxyapi_generate_video",
    label: "CLIProxyAPI video",
    description:
      "Submit one video generation using an explicit available video model or the session video default selected with /cli:model and optional duration (1–15 seconds). Returns request_id; use cliproxyapi_video_status to check it. Do not submit again to poll. No automatic retries.",
    parameters: videoParameters,
    async execute(_id, params, signal, _update, ctx) {
      const details = await generateVideo(config, params, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
  pi.registerTool({
    name: "cliproxyapi_video_status",
    label: "CLIProxyAPI video status",
    description:
      "Check one video request_id once. Returns pending, completed with a video URL, or failed. Does not download the video or submit generation.",
    parameters: Type.Object({ request_id: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      const details = await videoStatus(config, params.request_id, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
