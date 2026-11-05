import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { join, resolve } from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import type {
  AssistantImages,
  ImageApi,
  ImageContent,
  ImageModel,
  ImagesContext,
  ImagesOptions,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { fetchCatalog, mapMediaCatalog, mediaCapability, mediaControls } from "./catalog.ts";
import { type Config, deadline, isRecord, PROVIDER_ID, validateKey } from "./config.ts";
import { type DefaultsContext, effectiveMediaDefaults, resolveMediaModel } from "./media-defaults.ts";

type MediaContext = Pick<ExtensionContext, "cwd" | "model"> &
  DefaultsContext & {
    modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;
  };

const MAX_INLINE_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024;

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
  quality: Type.Optional(
    Type.String({
      description: "OpenAI quality from controls.quality; Sunburst and Flare also support xhigh and max.",
    }),
  ),
  complexity: Type.Optional(
    Type.String({
      description:
        "GPT Image 2.6 Sunburst/Flare planning effort: low, medium, or high (upstream default high). Low suits quick edits.",
    }),
  ),
  background: Type.Optional(
    Type.String({
      description: "OpenAI background: auto, opaque, or transparent. Transparency requires PNG or WebP.",
    }),
  ),
  output_format: Type.Optional(
    Type.String({
      description:
        "OpenAI output format: png, jpeg, or webp. GPT Image 2.6 Sunburst/Flare also generate gif and svg (svg needs n of 1). Omit for the backend default.",
    }),
  ),
  output_compression: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "OpenAI JPEG/WebP compression, 0–100. Requires an explicit jpeg or webp output_format.",
    }),
  ),
  frame_count: Type.Optional(
    Type.Integer({
      minimum: 2,
      maximum: 16,
      description: "GIF output only: number of frames, 2–16 (upstream default 9).",
    }),
  ),
  frame_duration_ms: Type.Optional(
    Type.Integer({
      minimum: 20,
      maximum: 2000,
      description: "GIF output only: milliseconds per frame, 20–2000, rounded to 10 (upstream default 200).",
    }),
  ),
  moderation: Type.Optional(Type.String({ description: "OpenAI moderation: auto or low." })),
  n: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10,
      description:
        "OpenAI image count. Values above 1 require an explicit api/ route; see controls.n. Default 1.",
    }),
  ),
  partial_images: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 3,
      description:
        "OpenAI only: stream up to 3 partial previews while generating. Requires n of 1; each preview adds about 100 output tokens. Omit or 0 for none.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 16,
      description:
        "OpenAI editing: local PNG/JPEG/WebP paths, relative to the working directory or absolute. Uploads these files; no URLs. Max 14 MiB each and 20 MiB total including mask. Omit to generate a new image.",
    }),
  ),
  mask: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional local PNG mask for images[0]. The first image must also be PNG with matching dimensions; mask must have an alpha channel. Transparent regions are edited.",
    }),
  ),
  markup: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional local PNG annotation layer for images[0] with GPT Image 2.5/2.6 Sunburst or Flare: transparent except for marks showing where to edit. Same size as images[0]; cannot be combined with mask.",
    }),
  ),
  input_fidelity: Type.Optional(
    Type.String({
      description: "Editing fidelity for GPT Image 1.5 only: low or high. Omit for other models.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 32,
      description:
        "OpenAI image size: auto or WIDTHxHEIGHT. Use controls.size and controls.size_limits from cliproxyapi_media_models; GIF sizes are per frame and may go below min_pixels. Omit to preserve the backend default.",
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

function mediaOutputOptions(model: string, params: Partial<Static<typeof imageParameters>>) {
  const options = {
    size: params.size,
    resolution: params.resolution,
    aspect_ratio: params.aspect_ratio,
    quality: params.quality,
    complexity: params.complexity,
    background: params.background,
    output_format: params.output_format,
    output_compression: params.output_compression,
    moderation: params.moderation,
    n: params.n,
    input_fidelity: params.input_fidelity,
    partial_images: params.partial_images,
    frame_count: params.frame_count,
    frame_duration_ms: params.frame_duration_ms,
  };
  const controls = mediaControls(model);
  const gif = options.output_format === "gif";
  // OpenAI generates GIF and SVG without streaming and only on the generation endpoint.
  const generationOnly = gif || options.output_format === "svg";
  for (const field of [
    "size",
    "resolution",
    "aspect_ratio",
    "quality",
    "complexity",
    "background",
    "output_format",
    "moderation",
    "input_fidelity",
  ] as const) {
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
          (gif || pixels >= limits.min_pixels) &&
          pixels <= limits.max_pixels
        )
          continue;
      }
    }
    throw new Error(
      `CLIProxyAPI ${field} is unsupported for ${model}. See cliproxyapi_media_models for supported controls.`,
    );
  }
  if (
    options.n !== undefined &&
    (!controls.n || !Number.isInteger(options.n) || options.n < controls.n.min || options.n > controls.n.max)
  )
    throw new Error("CLIProxyAPI n is unsupported for this route. Use an api/ image model for 2–10 images.");
  if (
    options.partial_images !== undefined &&
    (!controls.partial_images ||
      !Number.isInteger(options.partial_images) ||
      options.partial_images < controls.partial_images.min ||
      options.partial_images > controls.partial_images.max ||
      (options.partial_images > 0 && ((options.n ?? 1) !== 1 || generationOnly)))
  )
    throw new Error(
      "CLIProxyAPI partial_images requires an OpenAI image model, n of 1, PNG, JPEG, or WebP output, and an integer from 0 to 3.",
    );
  for (const field of ["frame_count", "frame_duration_ms"] as const) {
    const value = options[field];
    const range = controls.gif?.[field];
    if (
      value !== undefined &&
      (!gif || !range || !Number.isInteger(value) || value < range.min || value > range.max)
    )
      throw new Error(`CLIProxyAPI ${field} requires gif output_format and a value within controls.gif.`);
  }
  if (options.output_format === "svg" && (options.n ?? 1) !== 1)
    throw new Error("CLIProxyAPI svg output_format requires n of 1.");
  if (generationOnly && params.images !== undefined)
    throw new Error("CLIProxyAPI gif and svg output_format are for generation, not editing.");
  if (
    options.output_compression !== undefined &&
    (!controls.output_compression ||
      !Number.isInteger(options.output_compression) ||
      options.output_compression < 0 ||
      options.output_compression > 100 ||
      !controls.output_compression.formats.includes(options.output_format ?? ""))
  )
    throw new Error(
      "CLIProxyAPI output_compression requires jpeg or webp output_format and an integer from 0 to 100.",
    );
  if (
    options.background === "transparent" &&
    options.output_format !== undefined &&
    !["png", "webp"].includes(options.output_format)
  )
    throw new Error("CLIProxyAPI transparent backgrounds require png or webp output_format.");
  if (options.input_fidelity !== undefined && params.images === undefined)
    throw new Error("CLIProxyAPI input_fidelity requires editing images.");
  return options;
}

async function imageInputs(
  model: string,
  params: Static<typeof imageParameters>,
  cwd: string,
  signal: AbortSignal,
) {
  if (params.images === undefined) {
    if (params.mask !== undefined || params.markup !== undefined)
      throw new Error("CLIProxyAPI mask and markup require editing images.");
    return {};
  }
  const limits = mediaControls(model).editing;
  if (
    !limits ||
    !Array.isArray(params.images) ||
    params.images.length < 1 ||
    params.images.length > limits.max_images
  )
    throw new Error("CLIProxyAPI editing requires 1–16 local images and a supported OpenAI image model.");
  if (params.markup !== undefined && (params.mask !== undefined || !limits.markup))
    throw new Error(
      "CLIProxyAPI markup requires GPT Image 2.5 or 2.6 Sunburst or Flare and cannot be combined with mask.",
    );
  // The mask or markup layer follows the input images.
  const layer = params.mask ?? params.markup;
  const images: { image_url: string }[] = [];
  let mask: { image_url: string } | undefined;
  let markup: { image_url: string } | undefined;
  let firstPngDimensions: Buffer | undefined;
  let total = 0;
  for (const [index, path] of [...params.images, ...(layer === undefined ? [] : [layer])].entries()) {
    signal.throwIfAborted();
    if (
      typeof path !== "string" ||
      !path.trim() ||
      path.includes("\0") ||
      /^[a-z][a-z\d+.-]*:\/\//i.test(path)
    )
      throw new Error("CLIProxyAPI editing accepts local image paths, not URLs.");
    // Nonblocking open prevents FIFOs from hanging before the regular-file check.
    const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limits.max_file_bytes || total + info.size > limits.max_total_bytes)
        throw new Error(
          "CLIProxyAPI editing requires regular files within the 14 MiB/file and 20 MiB total limits.",
        );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of file.createReadStream({
        signal,
        highWaterMark: 64 * 1024,
        autoClose: false,
      })) {
        size += chunk.length;
        total += chunk.length;
        if (size > limits.max_file_bytes || total > limits.max_total_bytes)
          throw new Error("CLIProxyAPI editing input exceeds the upload size limit.");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, size);
    } finally {
      await file.close();
    }
    let mimeType: string;
    try {
      ({ mimeType } = imageType(bytes));
    } catch {
      throw new Error(`CLIProxyAPI editing input "${path}" is not a supported PNG, JPEG, or WebP image.`);
    }
    const isLayer = index === params.images.length;
    if (index === 0 && mimeType === "image/png") firstPngDimensions = bytes.subarray(16, 24);
    // Masks need a matching PNG first image; OpenAI checks markup on JPEG or WebP images after orientation.
    const sameSize = firstPngDimensions?.equals(bytes.subarray(16, 24));
    if (
      isLayer &&
      (mimeType !== "image/png" ||
        ![4, 6].includes(bytes[25]) ||
        (sameSize === undefined ? params.mask !== undefined : !sameSize))
    )
      throw new Error(
        "CLIProxyAPI mask and markup layers must be alpha-channel PNGs matching a PNG first image's size; masks need a PNG first image.",
      );
    const input = { image_url: `data:${mimeType};base64,${bytes.toString("base64")}` };
    if (!isLayer) images.push(input);
    else if (params.mask !== undefined) mask = input;
    else markup = input;
  }
  return { images, mask, markup };
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

// Pi's native image interface can supply transport options; the image tool uses none.
type TransportOptions = Pick<ImagesOptions, "fetch" | "headers" | "env"> & {
  onResponse?: (response: { status: number; headers: Record<string, string> }) => unknown;
};

function requestHeaders(key: string, extra: TransportOptions["headers"] = {}) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra))
    if (value !== null && !["authorization", "content-type", "accept-encoding"].includes(name.toLowerCase()))
      headers[name] = value;
  return { ...headers, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function openaiImageResponse(
  config: Config,
  key: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
  { headers, env }: TransportOptions,
) {
  return new Promise<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    body: ResponseBody | null;
  }>((resolve, reject) => {
    const url = new URL(`${config.baseUrl}/${path}`);
    const transport = url.protocol === "https:" ? https : http;
    const options = "options" in transport.globalAgent ? transport.globalAgent.options : undefined;
    // Pi exports its proxy setting to the environment. Node 22.21+ and 24.5+ apply proxyEnv,
    // including NO_PROXY; older Node versions connect directly. The global socket timeout is dropped.
    const agent = new transport.Agent({
      ...(isRecord(options) ? options : {}),
      proxyEnv: { ...process.env, ...env },
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
        headers: { ...requestHeaders(key, headers), "Accept-Encoding": "identity" },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const ok = status >= 200 && status < 300;
        const received = Object.fromEntries(
          Object.entries(incoming.headers).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
          ),
        );
        if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
          incoming.destroy();
          if (ok) reject(new Error("Unsupported image response encoding."));
          else resolve({ ok, status, headers: received, body: null });
          return;
        }
        resolve({
          ok,
          status,
          headers: received,
          body: Readable.toWeb(addAbortSignal(signal, incoming), { strategy: { highWaterMark: 1 } }),
        });
      },
    );
    request.on("error", reject);
    request.on("upgrade", (incoming, socket) => {
      socket.destroy();
      resolve({ ok: false, status: incoming.statusCode ?? 101, headers: {}, body: null });
    });
    request.end(JSON.stringify(body));
  });
}

type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};
// Fetch and Node web streams have incompatible DOM typings; both satisfy this shape.
type ResponseBody = { getReader(): StreamReader & { releaseLock(): void }; cancel(): Promise<void> };

// Upstream errors name the rejected option or model. Show a short JSON message without credentials.
async function errorDetail(reader: StreamReader, key: string) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // A stalled error body must not hold the failure until the request deadline; cancel ends pending reads.
  const stall = setTimeout(() => void reader.cancel().catch(() => {}), 5000);
  try {
    while (size <= 64 * 1024) {
      const chunk = await reader.read();
      if (chunk.done || !chunk.value) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
    return errorText(JSON.parse(Buffer.concat(chunks).toString("utf8")), key);
  } catch {
    return "";
  } finally {
    clearTimeout(stall);
    void reader.cancel().catch(() => {});
  }
}

function errorText(value: unknown, key: string) {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value;
  // OpenAI-style bodies nest { message }; xAI-style bodies use a string error.
  const message = !isRecord(error)
    ? undefined
    : typeof error.message === "string"
      ? error.message
      : typeof error.error === "string"
        ? error.error
        : undefined;
  if (message === undefined) return "";
  // Covers the proxy key, bearer tokens, and OpenAI, Anthropic, xAI, and Google key formats.
  return message
    .split(key)
    .join("[redacted]")
    .replace(/\b(?:sk-|xai-|AIza|ya29\.|Bearer\s+)[\w.~+/=-]+/gi, "[redacted]")
    .replace(/[\p{C}\s]+/gu, " ")
    .trim()
    .slice(0, 500);
}

// Server-sent events: partial previews go to the callback, other events are returned in order.
async function readEvents(
  reader: StreamReader,
  maxBytes: number,
  onPartial: (event: Record<string, unknown>) => void,
) {
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  // A CRLF pair can straddle two chunks; hold a trailing CR until the next chunk arrives.
  let carry = "";
  let size = 0;
  const frame = (text: string) => {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "").replace(/\r$/, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    const event: unknown = JSON.parse(data);
    if (!isRecord(event)) throw new Error("Invalid image event.");
    if (typeof event.type === "string" && event.type.endsWith(".partial_image")) onPartial(event);
    else events.push(event);
  };
  for (let searched = 0; ; ) {
    const chunk = await reader.read();
    if (chunk.done || !chunk.value) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) throw new Error("Response too large.");
    const text = carry + decoder.decode(chunk.value, { stream: true });
    carry = text.endsWith("\r") ? "\r" : "";
    buffer += (carry ? text.slice(0, -1) : text).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n", searched); end >= 0; end = buffer.indexOf("\n\n")) {
      frame(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
    searched = Math.max(0, buffer.length - 1);
  }
  frame(buffer + (carry + decoder.decode()).replace(/\r\n/g, "\n"));
  return events;
}

async function mediaRequest(
  config: Config,
  key: string,
  path: string,
  signal: AbortSignal,
  {
    maxBytes,
    body,
    openaiImage = false,
    onPartial,
    ...transport
  }: TransportOptions & {
    maxBytes: number;
    body?: unknown;
    openaiImage?: boolean;
    onPartial?: (event: Record<string, unknown>) => void;
  },
) {
  let response: Awaited<ReturnType<typeof openaiImageResponse>>;
  try {
    // A caller-supplied fetch replaces the dedicated image connection and owns its timeouts.
    if (openaiImage && body && !transport.fetch)
      response = await openaiImageResponse(config, key, path, body, signal, transport);
    else {
      const result = await (transport.fetch ?? fetch)(`${config.baseUrl}/${path}`, {
        method: body ? "POST" : "GET",
        headers: requestHeaders(key, transport.headers),
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal,
      });
      response = {
        ok: result.ok,
        status: result.status,
        headers: Object.fromEntries(result.headers),
        body: result.body,
      };
    }
  } catch {
    throw new Error(
      "CLIProxyAPI media request failed: connection, cancellation, timeout, or redirect error. Generation was not retried.",
    );
  }
  try {
    await transport.onResponse?.({ status: response.status, headers: response.headers });
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body?.getReader();
  if (!response.ok) {
    const detail = reader ? await errorDetail(reader, key) : "";
    throw new Error(
      `CLIProxyAPI media request failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  if (!reader) throw new Error("CLIProxyAPI media returned an empty response.");
  try {
    if (onPartial) return await readEvents(reader, maxBytes, onPartial);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done || !chunk.value) break;
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
    void reader.cancel().catch(() => {});
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

function imageType(bytes: Buffer) {
  let extension: string;
  let mimeType: string;
  if (
    bytes.length > 24 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.toString("latin1", 12, 16) === "IHDR"
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
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    extension = "webp";
    mimeType = "image/webp";
  } else {
    throw new Error("CLIProxyAPI returned an unsupported or malformed image; expected JPEG, PNG, or WebP.");
  }
  return { extension, mimeType };
}

// OpenAI documents static SVG without scripts, external resources, or raster images. Only static drawing
// elements and same-document references pass; anything the checks cannot read fails closed.
const svgElements = new Set(
  `svg g defs title desc symbol use style path rect circle ellipse line polyline polygon text tspan textPath
  linearGradient radialGradient stop pattern clipPath mask marker filter feBlend feColorMatrix feComponentTransfer
  feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA
  feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight
  feSpecularLighting feSpotLight feTile feTurbulence`.split(/\s+/),
);
// Matches declarations, CDATA, processing instructions, event handlers, CSS escapes and imports, foreign
// namespaces, and references outside the document.
const unsafeSvg =
  /<[!?]|\son[a-z]+\s*=|\\|@import|image-set\(|xmlns(?::[\w.-]+)?\s*=\s*["'](?!http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)["'])|(?:href|src)\s*=\s*(?:"(?!#)|'(?!#)|[^"'\s#>])|url\(\s*(?:"(?!#)|'(?!#)|[^"'\s#)])/i;

// Accept GIF or SVG only when the request asked GPT Image 2.6 for that format.
function outputType(bytes: Buffer, format?: string) {
  if (format === "gif") {
    if (bytes.length > 13 && /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)) && bytes.at(-1) === 0x3b)
      return { extension: "gif", mimeType: "image/gif" };
    throw new Error("CLIProxyAPI returned a malformed GIF.");
  }
  if (format !== "svg") return imageType(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("CLIProxyAPI returned an SVG that is not valid UTF-8.");
  }
  // Comments cannot run, and decoding character references keeps them from hiding text from the checks.
  const body = text
    .replace(/^\s*<\?xml[^>]*\?>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_, code: string) => {
      const point = /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : "\\";
    })
    .trim();
  if (
    !/^<svg[\s>]/.test(body) ||
    !body.endsWith("</svg>") ||
    unsafeSvg.test(body) ||
    [...body.matchAll(/<\/?([^\s/>]*)/g)].some(([, name]) => !svgElements.has(name))
  )
    throw new Error("CLIProxyAPI returned a malformed SVG or one with active or external content.");
  return { extension: "svg", mimeType: "image/svg+xml" };
}

function parseImage(entry: unknown, format?: string) {
  if (!isRecord(entry) || typeof entry.b64_json !== "string") {
    throw new Error("CLIProxyAPI did not return b64_json image data. URL-only images are not downloaded.");
  }
  const encoded = entry.b64_json;
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) {
    throw new Error("CLIProxyAPI returned invalid base64 image data.");
  }
  const { extension, mimeType } = outputType(bytes, format);
  const image: ImageContent = { type: "image", data: encoded, mimeType };
  return { bytes, extension, image };
}

function parseImages(value: unknown, count: number, format?: string) {
  if (
    !isRecord(value) ||
    value.error !== undefined ||
    !Array.isArray(value.data) ||
    value.data.length !== count
  )
    throw new Error(`CLIProxyAPI image response must contain ${count} image(s).`);
  return value.data.map((entry: unknown) => parseImage(entry, format));
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
      const parsed = parseImage({ b64_json: part.inlineData.data });
      if (part.inlineData.mimeType !== parsed.image.mimeType) throw invalid();
      images.push(parsed);
    } else if (typeof part.text !== "string") throw invalid();
  }
  if (images.length === 0 || images.length > 16) throw invalid();
  return images;
}

// OpenAI reports image token usage. Costs use list prices and stay zero for unpriced models.
function imageUsage(model: string, value: unknown, svg?: unknown) {
  const tokens = (field: unknown) =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
  if (!isRecord(value)) return undefined;
  const input = tokens(value.input_tokens);
  const output = tokens(value.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const imageInput = Math.min(
    input,
    tokens(isRecord(value.input_tokens_details) ? value.input_tokens_details.image_tokens : 0) ?? 0,
  );
  const [textPrice, imagePrice, outputPrice] = mediaCapability(model)?.price ?? [0, 0, 0];
  const cost = {
    input: ((input - imageInput) * textPrice + imageInput * imagePrice) / 1e6,
    output: (output * outputPrice) / 1e6,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  const usage: Usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
  // SVG output adds the authoring model's tokens, priced from Pi's OpenAI metadata when Pi knows it.
  if (isRecord(svg)) {
    const author = svg.model;
    const svgInput = tokens(svg.input_tokens);
    const svgOutput = tokens(svg.output_tokens);
    if (svgInput !== undefined && svgOutput !== undefined) {
      const price = getBuiltinModels("openai").find(({ id }) => id === author)?.cost;
      usage.input += svgInput;
      usage.output += svgOutput;
      usage.totalTokens += svgInput + svgOutput;
      cost.input += (svgInput * (price?.input ?? 0)) / 1e6;
      cost.output += (svgOutput * (price?.output ?? 0)) / 1e6;
    }
  }
  cost.total = cost.input + cost.output;
  return usage;
}

// Shared by the image tool and Pi's native image interface.
async function requestImages(
  config: Config,
  key: string,
  model: string,
  request: {
    prompt: string;
    output: Partial<ReturnType<typeof mediaOutputOptions>>;
    images?: { image_url: string }[];
    mask?: { image_url: string };
    markup?: { image_url: string };
  },
  signal: AbortSignal,
  onPartial?: (image: ImageContent, index: number) => void,
  { onPayload, ...transport }: TransportOptions & { onPayload?: (payload: unknown) => unknown } = {},
) {
  const route = mediaCapability(model)?.route;
  const { prompt, images, mask, markup } = request;
  const { partial_images = 0, ...output } = request.output;
  const n = output.n ?? 1;
  const stream = route === "openai" && partial_images > 0;
  const body =
    route === "xai"
      ? {
          model,
          prompt,
          n: 1,
          response_format: "b64_json",
          resolution: output.resolution,
          aspect_ratio: output.aspect_ratio,
        }
      : route === "openai"
        ? { model, prompt, ...output, n, images, mask, markup, ...(stream ? { stream, partial_images } : {}) }
        : {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              candidateCount: 1,
              ...(output.resolution !== undefined || output.aspect_ratio !== undefined
                ? { imageConfig: { imageSize: output.resolution, aspectRatio: output.aspect_ratio } }
                : {}),
            },
          };
  const payload = (await onPayload?.(body)) ?? body;
  const path =
    route === "gemini"
      ? `v1beta/models/${model}:generateContent`
      : images
        ? "v1/images/edits"
        : "v1/images/generations";
  if (!stream) {
    const result = await mediaRequest(config, key, path, signal, {
      ...transport,
      maxBytes: MAX_IMAGE_RESPONSE_BYTES,
      body: payload,
      openaiImage: route === "openai",
    });
    // Decode the format actually requested, which a native payload hook may have changed.
    const format =
      route === "openai" && isRecord(payload) && typeof payload.output_format === "string"
        ? payload.output_format
        : undefined;
    return {
      images: route === "gemini" ? parseGoogleImages(result) : parseImages(result, n, format),
      usage:
        route === "openai" && isRecord(result)
          ? imageUsage(model, result.usage, result.svg_usage)
          : undefined,
    };
  }
  // Each frame carries one full image, so the stream may hold the final image plus every preview.
  const events = await mediaRequest(config, key, path, signal, {
    ...transport,
    maxBytes: MAX_IMAGE_RESPONSE_BYTES * (1 + partial_images),
    body: payload,
    openaiImage: true,
    onPartial: (event) => {
      try {
        const index = typeof event.partial_image_index === "number" ? event.partial_image_index : 0;
        onPartial?.(parseImage(event).image, index);
      } catch {
        // A malformed preview does not affect the final image.
      }
    },
  });
  if (!Array.isArray(events)) throw new Error("CLIProxyAPI returned an invalid image stream.");
  const failed = events.find(
    (event) => isRecord(event) && (event.type === "error" || event.error !== undefined),
  );
  if (failed) {
    const detail = errorText(failed, key);
    throw new Error(`CLIProxyAPI image stream failed${detail ? `: ${detail}` : "."}`);
  }
  const completed = events.filter(
    (event) => isRecord(event) && typeof event.type === "string" && event.type.endsWith(".completed"),
  );
  if (completed.length !== n) throw new Error(`CLIProxyAPI image stream must complete ${n} image(s).`);
  return {
    images: completed.map((event) => parseImage(event)),
    usage: imageUsage(model, completed[0].usage),
  };
}

export async function generateNativeImages(
  config: Config,
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
) {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    const capability = mediaCapability(model.id);
    if (capability?.purpose !== "image" || capability.disabledReason)
      throw new Error(capability?.disabledReason ?? "Choose a supported CLIProxyAPI image model.");
    const prompt = context.input.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
    if (!prompt.trim() || (capability.route === "openai" && prompt.length > 32000))
      throw new Error(
        "CLIProxyAPI requires a non-empty prompt; OpenAI prompts are limited to 32000 characters.",
      );
    const limits = mediaControls(model.id).editing;
    const blocks = context.input.flatMap((block) => (block.type === "image" ? [block] : []));
    let total = 0;
    const images = blocks.map(({ data }) => {
      const bytes = Buffer.from(data, "base64");
      total += bytes.length;
      if (
        !limits ||
        blocks.length > limits.max_images ||
        bytes.length > limits.max_file_bytes ||
        total > limits.max_total_bytes
      )
        throw new Error(
          "CLIProxyAPI image inputs need an OpenAI image model: at most 16 images, 14 MiB each, 20 MiB total.",
        );
      let mimeType: string;
      try {
        ({ mimeType } = imageType(bytes));
      } catch {
        throw new Error("CLIProxyAPI image inputs must be PNG, JPEG, or WebP.");
      }
      return { image_url: `data:${mimeType};base64,${bytes.toString("base64")}` };
    });
    const generated = await requestImages(
      config,
      validateKey(options?.apiKey ?? ""),
      model.id,
      { prompt, output: {}, ...(images.length ? { images } : {}) },
      deadline(options?.signal, capability.route === "openai" ? 600000 : 180000),
      undefined,
      {
        fetch: options?.fetch,
        headers: options?.headers,
        env: options?.env,
        onPayload: options?.onPayload && ((payload) => options.onPayload?.(payload, model)),
        onResponse: options?.onResponse && ((response) => options.onResponse?.(response, model)),
      },
    );
    result.output = generated.images.map(({ image }) => image);
    result.usage = generated.usage;
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function generateImage(
  config: Config,
  params: Static<typeof imageParameters>,
  ctx: MediaContext,
  signal?: AbortSignal,
  onProgress?: (text: string) => void,
  onPartial?: (image: ImageContent, index: number) => void,
) {
  const model = resolveMediaModel(config, ctx, "image", params.model);
  const route = mediaCapability(model)?.route;
  const output = mediaOutputOptions(model, params);
  if (
    typeof params.prompt !== "string" ||
    !params.prompt.trim() ||
    (route === "openai" && params.prompt.length > 32000)
  )
    throw new Error(
      "CLIProxyAPI requires a non-empty prompt; OpenAI prompts are limited to 32000 characters.",
    );
  const bounded = deadline(signal, route === "openai" ? 600000 : 180000);
  const inputs = await imageInputs(model, params, ctx.cwd, bounded);
  const key = await generationKey(config, { ...params, model }, ctx, bounded);
  bounded.throwIfAborted();
  onProgress?.(inputs.images ? "Editing image..." : "Generating image...");
  bounded.throwIfAborted();
  const { images, usage } = await requestImages(
    config,
    key,
    model,
    { prompt: params.prompt, output, ...inputs },
    bounded,
    onPartial,
  );
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
    // Chat providers disagree on animated GIF input and reject SVG, so both skip inline previews.
    const previewOmitted = ["image/gif", "image/svg+xml"].includes(image.mimeType)
      ? "Preview omitted: GIF and SVG results are saved without an inline preview."
      : !ctx.model?.input.includes("image")
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
  return { content, details: { model, files }, usage };
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
  const result = await mediaRequest(config, key, "v1/videos", bounded, {
    maxBytes: 64 * 1024,
    body: {
      model,
      prompt: params.prompt,
      duration: params.duration,
      resolution: output.resolution,
      aspect_ratio: output.aspect_ratio,
    },
  });
  if (!isRecord(result)) throw new Error("CLIProxyAPI returned an invalid video submission.");
  return { model, request_id: requestId(result.request_id), status: "pending" };
}

export async function videoStatus(config: Config, id: string, ctx: MediaContext, signal?: AbortSignal) {
  const request_id = requestId(id);
  const bounded = deadline(signal, 15000);
  const key = await mediaKey(ctx, bounded);
  const result = await mediaRequest(config, key, `v1/videos/${request_id}`, bounded, { maxBytes: 64 * 1024 });
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
      "Generate images, or edit local images with OpenAI models by supplying images and an optional mask or markup layer. Supports OpenAI size, quality, complexity, background, format/compression, GIF/SVG output, image count and streamed partial previews; check cliproxyapi_media_models for each model's controls. Uses the selected model or automatic OpenAI/GPT default without changing chat. Saves final images under a new .pi/ directory with optional previews. Maximum response: 32 MiB in total, plus 32 MiB per streamed preview; inline base64: 4 MiB. No automatic retries.",
    promptSnippet: "Generate requested raster images through CLIProxyAPI using the effective image default.",
    promptGuidelines: [
      "Use cliproxyapi_generate_image for requested raster images. Omit model to use the effective default unless a specific image model is requested; keep the current chat model.",
    ],
    parameters: imageParameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      return generateImage(
        config,
        params,
        ctx,
        signal,
        (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        (image, index) => {
          const large = image.data.length > MAX_INLINE_IMAGE_BASE64_BYTES;
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Partial image ${index + 1}${large ? " (preview over 4 MiB omitted)" : ""}`,
              },
              ...(large ? [] : [image]),
            ],
            details: {},
          });
        },
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
