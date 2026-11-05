import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import fs, { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { type ClientRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type ExtensionAPI,
  type ExtensionToolContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mapCatalog, mapMediaCatalog, mediaCapability, mediaControls, routedName } from "../src/catalog.ts";
import { PROVIDER_ID, parseConfig } from "../src/config.ts";
import {
  generateImage,
  generateVideo,
  listMediaModels,
  registerMediaTools,
  videoStatus,
} from "../src/media.ts";
import { MEDIA_DEFAULTS_ENTRY } from "../src/media-defaults.ts";
import { builtinCatalog } from "../src/provider.ts";

const key = "fixture-media-key";
const imageModel = "grok-imagine-image";
const videoModel = "grok-imagine-video-1.5-preview";
const ids = [
  imageModel,
  "grok-imagine-image-quality",
  "grok-imagine-image-2.0",
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "grok-imagine-video-1.5-lite",
  videoModel,
];
const catalog = { data: ids.map((id) => ({ id, owned_by: "xai" })) };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const jpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAr/2Q==";
const webp = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const svgDocument = (root: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!-- fixture -->\n${root}\n`;
const svg = (root: string) => Buffer.from(svgDocument(root)).toString("base64");

async function home(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-media-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function context(cwd: string) {
  return {
    cwd,
    model: builtinCatalog().find((model) => model.input.includes("image")),
    modelRegistry: {
      async getProviderAuth(provider: string) {
        assert.equal(provider, PROVIDER_ID);
        return {
          auth: {
            apiKey: key,
            baseUrl: "https://must-not-contact.example",
            headers: { "x-extra": "not-forwarded" },
          },
        };
      },
    },
  };
}

async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  t.after(async () => {
    const closed = once(instance, "close");
    instance.close();
    instance.closeAllConnections();
    await closed;
  });
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}

test("media catalog maps seven exact IDs, excludes hidden and unknown IDs, and cannot seed chat aliases", () => {
  assert.deepEqual(
    mapMediaCatalog(catalog),
    ids.map((id, index) => ({
      id,
      purpose: index < 3 ? "image" : "video",
      name: routedName(id, mediaCapability(id)?.name),
      controls: mediaControls(id),
    })),
  );
  assert.deepEqual(
    mapMediaCatalog({
      data: [
        { id: imageModel, visibility: "hide" },
        { id: videoModel },
        { id: videoModel },
        { id: "grok-imagine-image-future" },
        { id: "gpt-image-1" },
        ...["xai", "x-ai", "grok", "team"].map((prefix) => ({ id: `${prefix}/${imageModel}` })),
      ],
    }),
    [
      {
        id: videoModel,
        purpose: "video",
        name: routedName(videoModel, mediaCapability(videoModel)?.name),
        controls: mediaControls(videoModel),
      },
    ],
  );
  const known = builtinCatalog();
  const chat = known[0];
  const config = parseConfig({
    aliases: Object.fromEntries(ids.map((id) => [id, `${chat.provider}/${chat.id}`])),
  });
  assert.deepEqual(mapCatalog(catalog, config, known).models, []);
  assert.throws(() => mapMediaCatalog({ data: [{ id: imageModel, owned_by: 1 }] }));
});

test("media discovery stays live and generation requires an explicit available model and valid purpose", async (t) => {
  let data: unknown = catalog;
  let gets = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      gets++;
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/models");
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      res.end(JSON.stringify(data));
    }),
  });
  const ctx = context(await home(t));
  assert.equal((await listMediaModels(config, ctx)).length, ids.length);
  for (const model of ["", "gpt-image-1", videoModel, `xai/${imageModel}`, "team-image"]) {
    await assert.rejects(
      generateImage(config, { model, prompt: "fixture" }, ctx),
      /explicit supported image model/,
    );
  }
  await assert.rejects(
    generateVideo(config, { model: imageModel, prompt: "fixture" }, ctx),
    /explicit supported video model/,
  );
  await assert.rejects(generateImage(config, { model: imageModel, prompt: "  " }, ctx), /non-empty prompt/);
  for (const duration of [0, 16, 1.5, Number.NaN]) {
    await assert.rejects(
      generateVideo(config, { model: videoModel, prompt: "fixture", duration }, ctx),
      /integer from 1 to 15/,
    );
  }
  assert.equal(gets, 1);
  data = { data: [{ id: imageModel, visibility: "hide" }] };
  await assert.rejects(generateImage(config, { model: imageModel, prompt: "fixture" }, ctx), /not available/);
  data = { data: [] };
  assert.deepEqual(await listMediaModels(config, ctx), []);
  await assert.rejects(generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx), /not available/);
  assert.equal(gets, 4);
});

test("image generation pins paths/auth, requests b64_json, and saves private unique JPEG/PNG/WebP artifacts", async (t) => {
  let encoded = png;
  let posts = 0;
  const requests: string[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers["x-extra"], undefined);
      if (req.method === "GET") return void res.end(JSON.stringify(catalog));
      posts++;
      void body(req).then((value) => {
        assert.deepEqual(value, { model: imageModel, prompt: "fixture", n: 1, response_format: "b64_json" });
        res.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
      });
    })}/gateway/v1`,
  });
  const cwd = await home(t);
  await writeFile(join(cwd, "image.png"), "keep");
  const ctx = context(cwd);
  const selected = ctx.model;
  const paths = new Set<string>();
  for (const [data, mimeType, extension] of [
    [png, "image/png", "png"],
    [jpeg, "image/jpeg", "jpg"],
    [webp, "image/webp", "webp"],
  ]) {
    encoded = data;
    const result = await generateImage(config, { model: imageModel, prompt: "fixture" }, ctx);
    const file = result.details.files[0];
    assert.equal(file.mimeType, mimeType);
    assert.ok(file.path.startsWith(join(cwd, ".pi", "cliproxyapi-image-")));
    assert.ok(file.path.endsWith(`image.${extension}`));
    paths.add(file.path);
    assert.equal((await readFile(file.path)).toString("base64"), data);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
    assert.deepEqual(result.content[1], { type: "image", data, mimeType });
  }
  encoded = png;
  const textOnly = await generateImage(
    config,
    { model: imageModel, prompt: "fixture" },
    { ...ctx, model: undefined },
  );
  assert.equal(textOnly.content.length, 1);
  assert.match(JSON.stringify(textOnly.content), /Preview omitted.*does not support images/);
  encoded = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(3 * 1024 * 1024)]).toString("base64");
  const large = await generateImage(config, { model: imageModel, prompt: "fixture" }, ctx);
  assert.equal(large.content.length, 1);
  assert.match(JSON.stringify(large.content), /Preview omitted.*4 MiB inline budget/);
  assert.equal((await readFile(large.details.files[0].path)).toString("base64"), encoded);
  assert.equal(paths.size, 3);
  assert.equal(await readFile(join(cwd, "image.png"), "utf8"), "keep");
  assert.equal(ctx.model, selected);
  assert.equal(posts, 5);
  assert.deepEqual(
    requests,
    Array.from({ length: 5 }, () => ["GET /gateway/v1/models", "POST /gateway/v1/images/generations"]).flat(),
  );
});

test("image responses reject malformed base64, unsupported bytes and URL-only results without downloads or artifacts", async (t) => {
  let result: unknown;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      res.end(JSON.stringify(req.method === "GET" ? catalog : result));
    }),
  });
  const ctx = context(await home(t));
  for (const value of [
    null,
    {},
    { data: [] },
    { data: [null] },
    { data: [{ url: "https://must-not-contact.example/image" }] },
    { data: [{ b64_json: "" }] },
    { data: [{ b64_json: "!!!!" }] },
    { data: [{ b64_json: "aGVsbG8=" }] },
    { data: [{ b64_json: png }, { b64_json: png }] },
  ]) {
    result = value;
    await assert.rejects(generateImage(config, { model: imageModel, prompt: "fixture" }, ctx), /CLIProxyAPI/);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("native video submission preserves the preview ID and polls once for pending, done, failed, expired and moderation failures", async (t) => {
  let response: unknown = { status: "pending" };
  const requests: string[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      if (req.url === "/gateway/v1/models") return void res.end(JSON.stringify(catalog));
      if (req.method === "POST") {
        void body(req).then((value) => {
          assert.deepEqual(value, { model: videoModel, prompt: "fixture", duration: 1 });
          res.end(JSON.stringify({ request_id: "video_fixture-1" }));
        });
        return;
      }
      assert.equal(req.url, "/gateway/v1/videos/video_fixture-1");
      res.end(JSON.stringify(response));
    })}/gateway`,
  });
  const ctx = context(await home(t));
  const submitted = await generateVideo(config, { model: videoModel, prompt: "fixture", duration: 1 }, ctx);
  assert.deepEqual(submitted, { model: videoModel, request_id: "video_fixture-1", status: "pending" });
  assert.equal((await videoStatus(config, submitted.request_id, ctx)).status, "pending");
  response = {
    status: "done",
    video: { url: "https://media.example/video.mp4?token=fixture", respect_moderation: true },
  };
  assert.deepEqual(await videoStatus(config, submitted.request_id, ctx), {
    request_id: submitted.request_id,
    status: "completed",
    upstream_status: "done",
    url: "https://media.example/video.mp4?token=fixture",
  });
  for (const status of ["failed", "expired"]) {
    response = { status, error: { message: key } };
    const result = await videoStatus(config, submitted.request_id, ctx);
    assert.equal(result.status, "failed");
    assert.equal(result.upstream_status, status);
    assert.ok(!JSON.stringify(result).includes(key));
  }
  response = {
    status: "done",
    video: { url: "https://media.example/blocked.mp4", respect_moderation: false },
  };
  const blocked = await videoStatus(config, submitted.request_id, ctx);
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.url, undefined);
  assert.deepEqual(requests, [
    "GET /gateway/v1/models",
    "POST /gateway/v1/videos",
    ...Array(5).fill("GET /gateway/v1/videos/video_fixture-1"),
  ]);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("video rejects invalid IDs, submission responses, unknown states and unsafe final URLs", async (t) => {
  let response: unknown = {};
  let requests = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      requests++;
      res.end(JSON.stringify(req.url === "/v1/models" ? catalog : response));
    }),
  });
  const ctx = context(await home(t));
  for (const id of ["", "..", "a/b", "a?key=secret", "https://elsewhere", "bad\nvalue"]) {
    await assert.rejects(videoStatus(config, id, ctx), /valid request_id/);
  }
  assert.equal(requests, 0);
  for (const value of [null, {}, { request_id: "../models" }]) {
    response = value;
    await assert.rejects(generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx), /CLIProxyAPI/);
  }
  for (const value of [
    null,
    {},
    { status: "future" },
    { status: "done" },
    { status: "done", video: {} },
    { status: "done", video: { url: "https://media.example/video.mp4", respect_moderation: "false" } },
    ...[
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:secret@example.com/video",
      "not a url",
    ].map((url) => ({ status: "done", video: { url } })),
  ]) {
    response = value;
    await assert.rejects(videoStatus(config, "fixture", ctx), /CLIProxyAPI/);
  }
});

test("media HTTP failures suppress upstream bodies, block redirects, bound responses and never retry POSTs", async (t) => {
  let mode = "http";
  let posts = 0;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.url === "/v1/models") return void res.end(JSON.stringify(catalog));
      if (req.method === "POST") posts++;
      if (mode === "http") res.writeHead(401).end(key);
      else if (mode === "redirect")
        res.writeHead(307, { location: "https://must-not-contact.example" }).end();
      else if (mode === "oversized")
        res.end("x".repeat(req.url === "/v1/images/generations" ? 32 * 1024 * 1024 + 1 : 64 * 1024 + 1));
      else res.end(`invalid-json-${key}`);
    }),
  });
  const ctx = context(await home(t));
  for (const nextMode of ["http", "redirect", "malformed", "oversized"]) {
    mode = nextMode;
    for (const operation of [
      () => generateImage(config, { model: imageModel, prompt: "fixture" }, ctx),
      () => generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx),
      () => videoStatus(config, "fixture", ctx),
    ]) {
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        if (mode === "http") assert.match(error.message, /HTTP 401/);
        if (mode === "redirect") assert.match(error.message, /redirect error/);
        return true;
      });
    }
  }
  assert.equal(posts, 8);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("media cancellation bounds auth, discovery, submission and response-body waits", async (t) => {
  const ctx = context(await home(t));
  const config = parseConfig({});
  const noAuth = { ...ctx, modelRegistry: { getProviderAuth: async () => undefined } };
  await assert.rejects(listMediaModels(config, noAuth), /authentication failed/);
  const authStarted = Promise.withResolvers<void>();
  const authController = new AbortController();
  const waitingAuth = {
    ...ctx,
    modelRegistry: {
      getProviderAuth() {
        authStarted.resolve();
        return new Promise<never>(() => {});
      },
    },
  };
  const authCancelled = assert.rejects(
    listMediaModels(config, waitingAuth, authController.signal),
    /cancelled or timed out/,
  );
  await authStarted.promise;
  authController.abort();
  await authCancelled;
  await assert.rejects(listMediaModels(config, ctx, AbortSignal.abort()));
  for (const phase of ["catalog", "post", "body", "status"]) {
    const arrived = Promise.withResolvers<void>();
    let posts = 0;
    const config = parseConfig({
      baseUrl: await server(t, (req, res) => {
        if (req.method === "POST") posts++;
        if (req.url === "/v1/models" && phase !== "catalog") return void res.end(JSON.stringify(catalog));
        if (phase === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"data":[');
        }
        arrived.resolve();
      }),
    });
    const controller = new AbortController();
    const running =
      phase === "status"
        ? videoStatus(config, "fixture", ctx, controller.signal)
        : generateImage(config, { model: imageModel, prompt: "fixture" }, ctx, controller.signal);
    const rejected = assert.rejects(running);
    await arrived.promise;
    controller.abort();
    await rejected;
    assert.equal(posts, phase === "catalog" || phase === "status" ? 0 : 1);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("Pi loads and executes all four media tools with registry auth without chat selection or startup discovery", async (t) => {
  const requests: string[] = [];
  const baseUrl = await server(t, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (req.url === "/v1/models") res.end(JSON.stringify(catalog));
    else if (req.url === "/v1/images/generations") res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    else if (req.url === "/v1/videos") res.end(JSON.stringify({ request_id: "fixture" }));
    else if (req.url === "/v1/videos/fixture")
      res.end(
        JSON.stringify({
          status: "done",
          video: { url: "https://media.example/video.mp4", respect_moderation: true },
        }),
      );
    else assert.fail(`Unexpected route: ${req.url}`);
  });
  const cwd = await home(t);
  const agentImport = pathToFileURL(
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  ).href;
  const aiImport = pathToFileURL(resolve("node_modules/@earendil-works/pi-ai/dist/index.js")).href;
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const { DefaultResourceLoader, ModelRuntime, ModelRegistry } = await import(${JSON.stringify(agentImport)});
    const { InMemoryCredentialStore } = await import(${JSON.stringify(aiImport)});
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), noExtensions: true, noSkills: true, noContextFiles: true, additionalExtensionPaths: [${JSON.stringify(resolve("extensions/index.ts"))}] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('cliproxyapi', async () => ({ type: 'api_key', key: ${JSON.stringify(key)} }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
    for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations) {
      assert.deepEqual(provider.getModels(), []);
      runtime.registerNativeProvider(provider);
    }
    const tools = loaded.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
    assert.deepEqual(tools.map(tool => tool.name), ['cliproxyapi_media_models', 'cliproxyapi_generate_image', 'cliproxyapi_generate_video', 'cliproxyapi_video_status']);
    const ctx = { cwd: process.cwd(), model: undefined, modelRegistry: new ModelRegistry(runtime) };
    const call = (index, params) => tools[index].execute('fixture', params, AbortSignal.timeout(5000), undefined, ctx);
    const listed = await call(0, {});
    assert.equal(listed.details.models.length, ${ids.length});
    const image = await call(1, { model: ${JSON.stringify(imageModel)}, prompt: 'fixture' });
    assert.equal(image.details.files[0].mimeType, 'image/png');
    const video = await call(2, { model: ${JSON.stringify(videoModel)}, prompt: 'fixture', duration: 1 });
    assert.equal(video.details.request_id, 'fixture');
    const status = await call(3, { request_id: video.details.request_id });
    assert.equal(status.details.status, 'completed');
    assert.equal(ctx.model, undefined);
    assert.deepEqual(ctx.modelRegistry.getAll().filter(model => model.provider === 'cliproxyapi'), []);
  `,
    ],
    {
      cwd,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        PI_CODING_AGENT_DIR: cwd,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        CLIPROXYAPI_BASE_URL: baseUrl,
      },
    },
  );
  assert.deepEqual(requests, [
    "GET /v1/models",
    "GET /v1/models",
    "POST /v1/images/generations",
    "GET /v1/models",
    "POST /v1/videos",
    "GET /v1/videos/fixture",
  ]);
});

const googleIds = [
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image",
];
const retiredIds = [
  "imagen-3.0-generate-002",
  "imagen-3.0-fast-generate-001",
  "imagen-4.0-generate-001",
  "imagen-4.0-fast-generate-001",
  "imagen-4.0-ultra-generate-001",
];
const qualifiedGoogleIds = googleIds.flatMap((id) => [id, `vertex/${id}`, `antigravity/${id}`]);
const qualifiedRetiredIds = retiredIds.flatMap((id) => [id, `vertex/${id}`, `antigravity/${id}`]);
const googleCatalog = {
  data: [...qualifiedGoogleIds, ...qualifiedRetiredIds].map((id) => ({ id, owned_by: "google" })),
};
const expectedGoogleModels = qualifiedGoogleIds.map((id) => ({
  id,
  purpose: "image",
  name: routedName(id, mediaCapability(id)?.name),
  controls: mediaControls(id),
}));
const inline = (data = png, mimeType = "image/png") => ({ inlineData: { data, mimeType } });
const googleResponse = (parts: unknown[] = [inline()]) => ({
  candidates: [{ finishReason: "STOP", content: { parts } }],
});

test("Google exact IDs cannot become chat aliases and require live availability, including Nano Banana 2 Lite", () => {
  const known = builtinCatalog();
  const chat = known[0];
  const config = parseConfig({
    aliases: Object.fromEntries(
      [...qualifiedGoogleIds, ...qualifiedRetiredIds].map((id) => [id, `${chat.provider}/${chat.id}`]),
    ),
  });
  assert.deepEqual(mapCatalog(googleCatalog, config, known).models, []);
  assert.deepEqual(mapMediaCatalog(googleCatalog), expectedGoogleModels);
  assert.deepEqual(
    mapMediaCatalog({
      data: [
        { id: "google/gemini-2.5-flash-image" },
        { id: "veo-3" },
        { id: "gemini-3.1-flash-lite-image", visibility: "hide" },
      ],
    }),
    [],
  );
});

test("retired Imagen IDs reject explicit generation and saved defaults before network, even when advertised", async (t) => {
  let requests = 0;
  const config = parseConfig({
    baseUrl: await server(t, (_req, res) => {
      requests++;
      res.end(JSON.stringify(googleCatalog));
    }),
  });
  const ctx = { ...context(await home(t)), sessionManager: SessionManager.inMemory() };
  assert.deepEqual(await listMediaModels(config, ctx), expectedGoogleModels);
  for (const id of qualifiedRetiredIds) {
    await assert.rejects(
      generateImage(config, { model: id, prompt: "fixture" }, ctx),
      /Retired on Vertex.*Nano Banana/,
    );
    await assert.rejects(generateVideo(config, { model: id, prompt: "fixture" }, ctx), /Retired on Vertex/);
    ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
      version: 1,
      endpoint: config.baseUrl,
      defaults: { image: googleIds[0] },
    });
    ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
      version: 1,
      endpoint: config.baseUrl,
      defaults: { image: id },
    });
    await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /No image default/);
  }
  assert.equal(requests, 1);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("Google Gemini models use proxy generateContent with minimal payloads and final image normalization", async (t) => {
  let expected = "";
  const requests: string[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers["x-extra"], undefined);
      if (req.method === "GET") return void res.end(JSON.stringify(googleCatalog));
      assert.equal(req.url, `/gateway/v1beta/models/${expected}:generateContent`);
      void body(req).then((value) => {
        assert.deepEqual(value, {
          contents: [{ role: "user", parts: [{ text: "fixture" }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: 1 },
        });
        res.end(
          JSON.stringify(
            googleResponse([
              { thought: true, ...inline("invalid-thought-data") },
              { text: "Final image" },
              inline(),
            ]),
          ),
        );
      });
    })}/gateway/v1beta`,
  });
  const ctx = context(await home(t));
  for (const id of qualifiedGoogleIds) {
    expected = id;
    const result = await generateImage(config, { model: id, prompt: "fixture" }, ctx);
    assert.equal(result.details.model, id);
    assert.equal(result.details.files.length, 1);
    assert.equal((await readFile(result.details.files[0].path)).toString("base64"), png);
    assert.deepEqual(result.content[1], { type: "image", data: png, mimeType: "image/png" });
  }
  assert.equal(requests.length, qualifiedGoogleIds.length * 2);
});

test("Google preserves every final image, recognizes MIME signatures, and shares the inline preview budget", async (t) => {
  let parts = [inline(), inline(jpeg, "image/jpeg"), inline(webp, "image/webp")];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) =>
      res.end(JSON.stringify(req.method === "GET" ? googleCatalog : googleResponse(parts))),
    ),
  });
  const ctx = context(await home(t));
  const result = await generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx);
  assert.equal(result.details.files.length, 3);
  assert.equal(new Set(result.details.files.map((file) => file.path)).size, 3);
  assert.deepEqual(
    result.details.files.map((file) => file.mimeType),
    ["image/png", "image/jpeg", "image/webp"],
  );
  const large = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64");
  parts = [inline(large), inline(large)];
  const limited = await generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx);
  assert.equal(limited.details.files.length, 2);
  assert.equal(limited.content.filter((part) => part.type === "image").length, 1);
  assert.match(JSON.stringify(limited.content.filter((part) => part.type === "text")), /4 MiB inline budget/);
});

test("Google rejects safety/refusal, thought-only, text-only, nonfinal and malformed images atomically", async (t) => {
  let response: unknown;
  const config = parseConfig({
    baseUrl: await server(t, (req, res) =>
      res.end(JSON.stringify(req.method === "GET" ? googleCatalog : response)),
    ),
  });
  const ctx = context(await home(t));
  for (const value of [
    null,
    {},
    { error: { message: key } },
    { ...googleResponse(), promptFeedback: { blockReason: "SAFETY" } },
    { ...googleResponse(), promptFeedback: { safetyRatings: [{ blocked: true }] } },
    { ...googleResponse(), refusal: key },
    ...["SAFETY", "IMAGE_SAFETY", "RECITATION", "MAX_TOKENS", "OTHER", undefined].map((finishReason) => ({
      candidates: [{ finishReason, content: { parts: [inline()] } }],
    })),
    { candidates: [{ ...googleResponse().candidates[0], safetyRatings: [{ blocked: true }] }] },
    { candidates: [{ ...googleResponse().candidates[0], refusal: key }] },
    googleResponse([{ text: "Cannot generate that image." }]),
    googleResponse([{ thought: true, ...inline() }]),
    googleResponse([inline(), { refusal: key }]),
    googleResponse([inline(), inline(png, "image/jpeg")]),
    googleResponse([inline(), inline("!!!!")]),
    googleResponse([inline(), { inlineData: { data: png } }]),
    googleResponse([inline(), { fileData: { fileUri: "https://must-not-contact.example" } }]),
    googleResponse([null]),
    googleResponse([]),
    googleResponse(Array(17).fill(inline())),
    { candidates: [...googleResponse().candidates, ...googleResponse().candidates] },
  ]) {
    response = value;
    await assert.rejects(
      generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /CLIProxyAPI/);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("media defaults are per purpose, explicit IDs win, and hidden/stale defaults fail before POST", async (t) => {
  let advertised = [...catalog.data, ...googleCatalog.data];
  const posted: string[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify({ data: advertised }));
      posted.push(req.url ?? "");
      if (req.url === "/v1/videos") res.end(JSON.stringify({ request_id: "fixture" }));
      else
        res.end(
          JSON.stringify(
            req.url === "/v1/images/generations" ? { data: [{ b64_json: png }] } : googleResponse(),
          ),
        );
    }),
  });
  const ctx = { ...context(await home(t)), sessionManager: SessionManager.inMemory() };
  await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /No image default.*\/cli:model/);
  await assert.rejects(generateVideo(config, { prompt: "fixture" }, ctx), /No video default/);
  ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image: googleIds[0], video: videoModel },
  });
  assert.equal((await generateImage(config, { prompt: "fixture" }, ctx)).details.model, googleIds[0]);
  assert.equal(
    (await generateImage(config, { prompt: "fixture", model: imageModel }, ctx)).details.model,
    imageModel,
  );
  assert.equal((await generateVideo(config, { prompt: "fixture" }, ctx)).model, videoModel);
  for (const visibility of ["hide", "absent"]) {
    advertised = visibility === "hide" ? [{ id: googleIds[0], owned_by: "google", ...{ visibility } }] : [];
    await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /not available/);
  }
  assert.deepEqual(posted, [
    `/v1beta/models/${googleIds[0]}:generateContent`,
    "/v1/images/generations",
    "/v1/videos",
  ]);
});

test("Google HTTP errors, redirects, response caps and cancellation never retry or leak upstream bodies", async (t) => {
  let mode = "http";
  let posts = 0;
  const arrived = Promise.withResolvers<void>();
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify(googleCatalog));
      posts++;
      if (mode === "http") res.writeHead(403).end(key);
      else if (mode === "redirect")
        res.writeHead(307, { location: "https://must-not-contact.example" }).end();
      else if (mode === "oversized") res.end("x".repeat(32 * 1024 * 1024 + 1));
      else if (mode === "cancel") {
        res.writeHead(200);
        res.write('{"candidates":[');
        arrived.resolve();
      } else res.end(key);
    }),
  });
  const ctx = context(await home(t));
  for (const next of ["http", "redirect", "oversized", "malformed"]) {
    mode = next;
    await assert.rejects(
      generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        if (mode === "http") assert.match(error.message, /HTTP 403/);
        return true;
      },
    );
  }
  mode = "cancel";
  const controller = new AbortController();
  const rejected = assert.rejects(
    generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx, controller.signal),
  );
  await arrived.promise;
  controller.abort();
  await rejected;
  assert.equal(posts, 5);
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("qualified Gemini defaults retain the wire ID and fail closed when only bare or another backend remains", async (t) => {
  const canonical = googleIds[0];
  const selected = `vertex/${canonical}`;
  const other = `antigravity/${canonical}`;
  let advertised = [canonical, selected, other];
  const posted: string[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET")
        return void res.end(JSON.stringify({ data: advertised.map((id) => ({ id })) }));
      posted.push(req.url ?? "");
      res.end(JSON.stringify(googleResponse()));
    }),
  });
  const ctx = { ...context(await home(t)), sessionManager: SessionManager.inMemory() };
  ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image: selected },
  });
  assert.equal((await generateImage(config, { prompt: "fixture" }, ctx)).details.model, selected);
  assert.equal((await generateImage(config, { prompt: "fixture", model: other }, ctx)).details.model, other);
  advertised = [canonical, other];
  await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /not available/);
  await assert.rejects(generateImage(config, { prompt: "fixture", model: selected }, ctx), /not available/);
  assert.deepEqual(
    posted,
    [selected, other].map((id) => `/v1beta/models/${id}:generateContent`),
  );
});

test("recognized backends do not enable xAI media and unknown prefixes do not inherit capabilities", async (t) => {
  const unsupported = ids.flatMap((id) => [`vertex/${id}`, `antigravity/${id}`]);
  const unknown = googleIds.flatMap((id) => [`custom/${id}`, `vertex/custom/${id}`]);
  t.mock.method(globalThis, "fetch", () => assert.fail("Unsupported media must fail before network"));
  assert.deepEqual(mapMediaCatalog({ data: [...unsupported, ...unknown].map((id) => ({ id })) }), []);
  const config = parseConfig({});
  const ctx = context(await home(t));
  for (const id of unsupported) {
    assert.equal(mediaCapability(id)?.route, undefined);
    await assert.rejects(
      generateImage(config, { model: id, prompt: "fixture" }, ctx),
      /Unsupported media execution/,
    );
    await assert.rejects(
      generateVideo(config, { model: id, prompt: "fixture" }, ctx),
      /Unsupported media execution/,
    );
  }
  for (const id of unknown)
    await assert.rejects(
      generateImage(config, { model: id, prompt: "fixture" }, ctx),
      /supported image model/,
    );
});

const openaiIds = [
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2",
  "gpt-image-1.5",
];
const openaiCatalog = { data: openaiIds.map((id) => ({ id, owned_by: "openai" })) };

test("OpenAI image IDs are image-only, preserve all wire IDs, and reject unsupported backend execution", async (t) => {
  const known = builtinCatalog();
  const chat = known[0];
  const qualified = openaiIds.flatMap((id) => [`vertex/${id}`, `antigravity/${id}`]);
  const config = parseConfig({
    aliases: Object.fromEntries(
      [...openaiIds, ...qualified].map((id) => [id, `${chat.provider}/${chat.id}`]),
    ),
  });
  assert.deepEqual(
    mapCatalog({ data: [...openaiIds, ...qualified].map((id) => ({ id })) }, config, known).models,
    [],
  );
  assert.deepEqual(
    mapMediaCatalog(openaiCatalog).map(({ id, purpose }) => ({ id, purpose })),
    openaiIds.map((id) => ({ id, purpose: "image" })),
  );
  const ctx = context(await home(t));
  t.mock.method(globalThis, "fetch", () => assert.fail("Unsupported routes must not access the network"));
  for (const id of qualified) {
    assert.equal(mediaCapability(id)?.purpose, "image");
    await assert.rejects(
      generateImage(config, { model: id, prompt: "fixture" }, ctx),
      /Unsupported media execution/,
    );
  }
  for (const id of openaiIds.flatMap((id) => [`openai/${id}`, `custom/${id}`, `vertex/custom/${id}`])) {
    assert.equal(mediaCapability(id), undefined);
    await assert.rejects(
      generateImage(config, { model: id, prompt: "fixture" }, ctx),
      /supported image model/,
    );
  }
});

test("all eight OpenAI IDs POST one image without response_format and reuse bounded private artifact validation", async (t) => {
  const cwd = await home(t);
  const ctx = context(cwd);
  let response: unknown;
  let expected = "";
  let posts = 0;
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers["x-extra"], undefined);
      if (req.method === "GET") {
        assert.equal(req.url, "/gateway/v1/models");
        return void res.end(JSON.stringify(openaiCatalog));
      }
      assert.equal(req.url, "/gateway/v1/images/generations");
      assert.equal(req.method, "POST");
      assert.equal(req.headers["accept-encoding"], "identity");
      posts++;
      void body(req).then((value) => {
        assert.deepEqual(value, { model: expected, prompt: "fixture", n: 1 });
        res.end(JSON.stringify(response));
      });
    })}/gateway/v1`,
  });
  for (const id of openaiIds) {
    expected = id;
    for (const [data, mimeType] of [
      [png, "image/png"],
      [jpeg, "image/jpeg"],
      [webp, "image/webp"],
    ]) {
      response = { data: [{ b64_json: data }] };
      const progress: string[] = [];
      const result = await generateImage(config, { model: id, prompt: "fixture" }, ctx, undefined, (text) =>
        progress.push(text),
      );
      assert.deepEqual(progress, ["Generating image...", "Saving image..."]);
      assert.equal(result.details.model, id);
      assert.equal((await readFile(result.details.files[0].path)).toString("base64"), data);
      assert.equal((await stat(result.details.files[0].path)).mode & 0o777, 0o600);
      assert.equal((await stat(resolve(result.details.files[0].path, ".."))).mode & 0o777, 0o700);
      assert.deepEqual(result.content[1], { type: "image", data, mimeType });
    }
    const before = await readdir(join(cwd, ".pi"));
    for (const invalid of [
      null,
      {},
      { data: [] },
      { data: [{ url: "https://must-not-contact.example" }] },
      { data: [{ b64_json: "!!!!" }] },
      { data: [{ b64_json: "aGVsbG8=" }] },
      { data: [{ b64_json: png }, { b64_json: png }] },
    ]) {
      response = invalid;
      await assert.rejects(generateImage(config, { model: id, prompt: "fixture" }, ctx), /CLIProxyAPI/);
    }
    assert.deepEqual(await readdir(join(cwd, ".pi")), before);
  }
  assert.equal(posts, openaiIds.length * 10);
});

test("OpenAI automatic and selected defaults recheck exact live availability without fallback or implicit generation", async (t) => {
  let advertised: object[] = openaiCatalog.data;
  const posted: string[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify({ data: advertised }));
      void body(req).then((value) => {
        assert.ok(value && typeof value === "object" && "model" in value);
        posted.push(String(value.model));
        res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
    }),
  });
  const ctx = {
    ...context(await home(t)),
    model: builtinCatalog().find((model) => model.provider === "openai-codex"),
    sessionManager: SessionManager.inMemory(),
  };
  assert.ok(ctx.model);
  await listMediaModels(config, ctx);
  assert.deepEqual(posted, []);
  assert.equal((await generateImage(config, { prompt: "fixture" }, ctx)).details.model, openaiIds[1]);
  ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: { image: openaiIds[0] },
  });
  assert.equal((await generateImage(config, { prompt: "fixture" }, ctx)).details.model, openaiIds[0]);
  assert.equal(
    (await generateImage(config, { prompt: "fixture", model: openaiIds[2] }, ctx)).details.model,
    openaiIds[2],
  );
  for (const hidden of [true, false]) {
    advertised = [
      ...openaiCatalog.data.filter(({ id }) => id !== openaiIds[0]),
      ...(hidden ? [{ id: openaiIds[0], visibility: "hide" }] : []),
    ];
    await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /not available/);
  }
  for (const defaults of [
    null,
    [],
    { image: null },
    { image: "unknown-image" },
    { image: "bad\nvalue" },
    { image: videoModel },
    { image: retiredIds[0] },
  ]) {
    ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
      version: 1,
      endpoint: config.baseUrl,
      defaults,
    });
    await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /No image default/);
  }
  ctx.sessionManager.appendCustomEntry(MEDIA_DEFAULTS_ENTRY, {
    version: 1,
    endpoint: config.baseUrl,
    defaults: {},
  });
  advertised = [];
  await assert.rejects(generateImage(config, { prompt: "fixture" }, ctx), /not available/);
  assert.deepEqual(posted, [openaiIds[1], openaiIds[0], openaiIds[2]]);
});

test("OpenAI overall deadline remains 600000ms and caller cancellation bounds each phase without retries", async (t) => {
  let elapsed = 0;
  const deadlines: { milliseconds: number; expiresAt: number; controller: AbortController }[] = [];
  const advance = (milliseconds: number) => {
    elapsed += milliseconds;
    for (const deadline of deadlines) if (deadline.expiresAt <= elapsed) deadline.controller.abort();
  };
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, expiresAt: elapsed + milliseconds, controller });
    return controller.signal;
  });
  const ctx = context(await home(t));
  for (const phase of [
    "long-wait",
    "deadline",
    "deadline-body",
    "auth",
    "catalog",
    "generating",
    "post",
    "body",
    "saving",
  ] as const) {
    deadlines.length = 0;
    elapsed = 0;
    const arrived = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const caller = new AbortController();
    let posts = 0;
    const config = parseConfig({
      baseUrl: await server(t, (req, res) => {
        if (req.url === "/v1/models" && phase !== "catalog")
          return void res.end(JSON.stringify(openaiCatalog));
        if (req.method === "POST") posts++;
        if (phase === "saving") return void res.end(JSON.stringify({ data: [{ b64_json: png }] }));
        if (phase === "body" || phase === "deadline-body") res.write('{"data":[');
        arrived.resolve();
        if (phase === "long-wait")
          void finish.promise.then(() => res.end(JSON.stringify({ data: [{ b64_json: png }] })));
      }),
    });
    const progress: string[] = [];
    const running = generateImage(
      config,
      { model: openaiIds[1], prompt: "fixture" },
      phase === "auth"
        ? {
            ...ctx,
            modelRegistry: {
              getProviderAuth: () => {
                arrived.resolve();
                return new Promise<never>(() => {});
              },
            },
          }
        : ctx,
      caller.signal,
      (text) => {
        progress.push(text);
        if ((phase === "saving" && text === "Saving image...") || phase === "generating") caller.abort();
      },
    );
    if (phase === "saving" || phase === "generating") {
      await assert.rejects(running);
    } else {
      const settled = phase === "long-wait" ? running : assert.rejects(running);
      await arrived.promise;
      assert.equal(deadlines[0].milliseconds, 600000);
      assert.ok(!deadlines.some(({ milliseconds }) => milliseconds === 180000));
      if (phase === "long-wait") {
        advance(180001);
        assert.equal(deadlines[0].controller.signal.aborted, false);
        advance(419998);
        assert.equal(deadlines[0].controller.signal.aborted, false);
        assert.deepEqual(progress, ["Generating image..."]);
        finish.resolve();
        const result = await running;
        assert.equal(result.details.model, openaiIds[1]);
        assert.deepEqual(progress, ["Generating image...", "Saving image..."]);
      } else if (phase === "deadline" || phase === "deadline-body") advance(600000);
      else caller.abort();
      await settled;
    }
    assert.equal(posts, phase === "auth" || phase === "catalog" || phase === "generating" ? 0 : 1);
    if (phase !== "long-wait") assert.ok(phase === "saving" || !progress.includes("Saving image..."));
  }
  assert.equal((await readdir(join(ctx.cwd, ".pi"))).length, 1);
});

test("OpenAI tool metadata, effective listing and progress stay local until execution and errors never retry", async (t) => {
  let mode = "success";
  let posts = 0;
  let redirects = 0;
  const redirectTarget = await server(t, (_req, res) => {
    redirects++;
    res.end(key);
  });
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify(openaiCatalog));
      assert.equal(req.url, "/v1/images/generations");
      posts++;
      if (mode === "http") res.writeHead(403).end(key);
      else if (mode === "redirect") res.writeHead(307, { location: redirectTarget }).end(key);
      else if (mode === "oversized") res.end("x".repeat(32 * 1024 * 1024 + 1));
      else if (mode === "malformed") res.end(key);
      else if (mode === "upgrade") res.writeHead(101, { connection: "Upgrade", upgrade: "fixture" }).end();
      else if (mode === "disconnect") res.destroy();
      else if (mode === "incomplete") {
        res.write('{"data":[');
        res.socket?.destroy();
      } else if (mode === "encoded") res.writeHead(200, { "content-encoding": "gzip" }).end(key);
      else res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    }),
  });
  const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  registerMediaTools(
    {
      registerTool(tool) {
        tools.push(tool as unknown as (typeof tools)[number]);
      },
    } as ExtensionAPI,
    config,
  );
  const image = tools.find((tool) => tool.name === "cliproxyapi_generate_image");
  assert.ok(image);
  assert.ok(image.promptSnippet?.includes("raster"));
  assert.ok(image.promptGuidelines?.every((line) => line.includes("cliproxyapi_generate_image")));
  assert.match(image.promptGuidelines?.join(" ") ?? "", /Omit model.*keep the current chat model/);
  const ctx = {
    ...context(await home(t)),
    model: builtinCatalog().find((model) => model.provider === "openai-codex"),
  } as unknown as ExtensionToolContext;
  const listed = await tools[0].execute("fixture", {}, undefined, undefined, ctx);
  assert.deepEqual(listed.details, {
    models: mapMediaCatalog(openaiCatalog),
    defaults: { image: openaiIds[1] },
    automatic: openaiIds[1],
  });
  assert.equal(posts, 0);
  const updates: string[] = [];
  await image.execute(
    "fixture",
    { prompt: "fixture" },
    undefined,
    (result) => updates.push(JSON.stringify(result)),
    ctx,
  );
  assert.match(updates[0], /Generating image/);
  assert.match(updates[1], /Saving image/);
  for (const next of [
    "http",
    "redirect",
    "oversized",
    "malformed",
    "disconnect",
    "incomplete",
    "encoded",
    "upgrade",
  ]) {
    mode = next;
    await assert.rejects(
      image.execute("fixture", { prompt: "fixture" }, undefined, undefined, ctx),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
  }
  assert.equal(posts, 9);
  assert.equal(redirects, 0);
});

test("OpenAI native transport completes delayed headers and bodies beyond fetch's 300000ms limits", async (t) => {
  const cwd = await home(t);
  for (const phase of ["headers", "body"]) {
    await t.test(phase, async () => {
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import assert from 'node:assert/strict';
      import { createServer, globalAgent } from 'node:http';
      import { once } from 'node:events';
      import { subscribe } from 'node:diagnostics_channel';
      import { mock } from 'node:test';
      import { generateImage } from ${JSON.stringify(pathToFileURL(resolve("src/media.ts")).href)};
      import { parseConfig } from ${JSON.stringify(pathToFileURL(resolve("src/config.ts")).href)};
      const phase = ${JSON.stringify(phase)};
      const originalTimeout = globalThis.setTimeout;
      let tick;
      mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
        if (fn.name === 'onTick' && ms === 499) tick = fn;
        return originalTimeout(fn, ms, ...args);
      });
      let ready = Promise.withResolvers();
      let response;
      let nativeRequest;
      let posts = 0;
      subscribe('undici:request:headers', ({ request }) => {
        if (phase === 'body' && request.method === 'POST') ready.resolve();
      });
      subscribe('http.client.request.start', ({ request }) => {
        if (request.method !== 'POST') return;
        nativeRequest = request;
        request.once('response', incoming => incoming.once('data', () => ready.resolve()));
      });
      const server = createServer((req, res) => {
        req.resume();
        if (req.url === '/v1/models') return res.end(JSON.stringify(${JSON.stringify(openaiCatalog)}));
        assert.equal(req.method, 'POST');
        if (req.url === '/v1/images/generations') posts++;
        else assert.equal(req.url, '/control');
        response = res;
        if (phase === 'body') res.write('{"data":[');
        else ready.resolve();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const caller = new AbortController();
      const advanceTransport = async () => {
        await ready.promise;
        await new Promise(setImmediate);
        assert.equal(typeof tick, 'function', 'Unsupported bundled fetch timer: ' + process.version);
        for (let i = 0; i < 604; i++) tick();
        await new Promise(setImmediate);
      };
      try {
        // Validate the accelerated transport clock against real fetch before testing the image POST.
        const control = fetch(baseUrl + '/control', { method: 'POST', signal: caller.signal })
          .then(res => res.text()).then(() => null, error => error.cause?.code);
        await advanceTransport();
        assert.equal(await control, phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT');
        ready = Promise.withResolvers();
        const ctx = { cwd: process.cwd(), model: undefined, modelRegistry: {
          getProviderAuth: async () => ({ auth: { apiKey: ${JSON.stringify(key)} } })
        } };
        const result = generateImage(parseConfig({ baseUrl }),
          { model: ${JSON.stringify(openaiIds[1])}, prompt: 'fixture' }, ctx, caller.signal)
          .then(value => ({ value }), error => ({ error }));
        await advanceTransport();
        assert.equal(caller.signal.aborted, false);
        response.end(phase === 'body'
          ? JSON.stringify({ b64_json: ${JSON.stringify(png)} }) + ']}'
          : JSON.stringify({ data: [{ b64_json: ${JSON.stringify(png)} }] }));
        const settled = await result;
        assert.equal(settled.error, undefined);
        assert.ok(nativeRequest);
        assert.notEqual(nativeRequest.agent, globalAgent);
        assert.equal(nativeRequest.agent.options.timeout ?? 0, 0);
        assert.equal(nativeRequest.socket.timeout ?? 0, 0);
        assert.equal(settled.value.details.model, ${JSON.stringify(openaiIds[1])});
        assert.equal(posts, 1);
      } finally {
        caller.abort();
        mock.restoreAll();
        server.closeAllConnections();
        server.close();
      }
    `,
        ],
        { cwd, timeout: 15000, env: { PATH: process.env.PATH, HOME: cwd } },
      );
    });
  }
});

test("OpenAI images honor the proxy environment and NO_PROXY without Node's proxy flag", {
  timeout: 30000,
}, async (t) => {
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    t.skip("Node's environment proxy support is unavailable.");
    return;
  }
  const cwd = await home(t);
  const requests: string[] = [];
  const respond = (req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    req.resume();
    res.end(JSON.stringify(req.method === "GET" ? openaiCatalog : { data: [{ b64_json: png }] }));
  };
  const baseUrl = await server(t, (req, res) => {
    requests.push(`origin ${req.method}`);
    respond(req, res);
  });
  const tunnels = new WeakSet();
  const proxyServer = createServer((req, res) => {
    assert.equal(new URL(req.url ?? "", tunnels.has(req.socket) ? baseUrl : undefined).origin, baseUrl);
    requests.push(`proxy ${req.method}`);
    respond(req, res);
  });
  proxyServer.on("connect", (req, socket, head) => {
    assert.equal(req.url, new URL(baseUrl).host);
    tunnels.add(req.socket);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    proxyServer.emit("connection", socket);
  });
  proxyServer.listen(0, "127.0.0.1");
  await once(proxyServer, "listening");
  t.after(async () => {
    const closed = once(proxyServer, "close");
    proxyServer.close();
    proxyServer.closeAllConnections();
    await closed;
  });
  const address = proxyServer.address();
  assert.ok(address && typeof address !== "string");
  const proxy = `http://127.0.0.1:${address.port}`;
  for (const [flag, bypass] of [
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ] as const) {
    requests.length = 0;
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        import { generateImage } from ${JSON.stringify(pathToFileURL(resolve("src/media.ts")).href)};
        import { parseConfig } from ${JSON.stringify(pathToFileURL(resolve("src/config.ts")).href)};
        const result = await generateImage(parseConfig({ baseUrl: ${JSON.stringify(baseUrl)} }),
          { model: ${JSON.stringify(openaiIds[1])}, prompt: "fixture" },
          { cwd: process.cwd(), model: undefined, modelRegistry: {
            getProviderAuth: async () => ({ auth: { apiKey: ${JSON.stringify(key)} } })
          } }, AbortSignal.timeout(5000));
        assert.equal(result.details.files[0].mimeType, "image/png");
        `,
      ],
      {
        cwd,
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          ...(flag ? { NODE_USE_ENV_PROXY: "1" } : {}),
          HTTP_PROXY: proxy,
          NO_PROXY: bypass ? "127.0.0.1" : "",
        },
      },
    );
    // Pi's own dispatcher proxies discovery; plain Node fetch needs the flag. Images use proxyEnv.
    assert.deepEqual(
      requests,
      bypass ? ["origin GET", "origin POST"] : [`${flag ? "proxy" : "origin"} GET`, "proxy POST"],
    );
  }
});

test("OpenAI cancellation closes HTTPS proxy sockets before CONNECT completes", {
  timeout: 15000,
}, async (t) => {
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    t.skip("Node's environment proxy support is unavailable.");
    return;
  }
  const cwd = await home(t);
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const sockets = new Set<IncomingMessage["socket"]>();
  const proxy = createServer(() => assert.fail("The image request must wait for CONNECT"));
  proxy.on("connect", (req, socket) => {
    assert.equal(req.url, "media.example:443");
    assert.equal(req.headers.authorization, undefined);
    sockets.add(req.socket);
    socket.once("end", () => socket.end());
    socket.once("close", () => {
      sockets.delete(req.socket);
      closed.resolve();
    });
    socket.resume();
    connected.resolve();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const pending = promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { generateImage } from ${JSON.stringify(pathToFileURL(resolve("src/media.ts")).href)};
      import { parseConfig } from ${JSON.stringify(pathToFileURL(resolve("src/config.ts")).href)};
      globalThis.fetch = async (url) => {
        assert.equal(url, "https://media.example/v1/models");
        return Response.json(${JSON.stringify(openaiCatalog)});
      };
      const caller = new AbortController();
      process.stdin.once("data", () => caller.abort());
      await assert.rejects(generateImage(parseConfig({ baseUrl: "https://media.example" }),
        { model: ${JSON.stringify(openaiIds[1])}, prompt: "fixture" },
        { cwd: process.cwd(), model: undefined, modelRegistry: {
          getProviderAuth: async () => ({ auth: { apiKey: ${JSON.stringify(key)} } })
        } }, caller.signal), /media request failed.*cancellation/);
      `,
    ],
    {
      cwd,
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
      },
    },
  );
  await Promise.race([connected.promise, pending]);
  pending.child.stdin?.end("abort");
  await pending;
  await closed.promise;
  assert.deepEqual(await readdir(cwd), []);
});

test("media discovery reports model-specific output controls and preserves qualified routes", () => {
  const models = mapMediaCatalog({
    data: [...openaiIds, ...ids, ...qualifiedGoogleIds].map((id) => ({ id })),
  });
  const controls = (id: string) => {
    const model = models.find((model) => model.id === id);
    assert.ok(model);
    return model.controls;
  };
  assert.deepEqual(controls("gpt-image-1.5").size, ["auto", "1024x1024", "1536x1024", "1024x1536"]);
  assert.equal(controls("gpt-image-1.5").size_limits, undefined);
  assert.deepEqual(controls("gpt-image-2.5-sunburst").size_limits, {
    multiple_of: 16,
    max_edge: 3840,
    min_pixels: 655360,
    max_pixels: 8294400,
    max_aspect_ratio: 3,
  });
  for (const id of ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]) {
    assert.deepEqual(controls(id).size_limits, controls("gpt-image-2.5-sunburst").size_limits);
    assert.deepEqual(controls(id).quality, controls("gpt-image-2.5-sunburst").quality);
    assert.deepEqual(controls(id).complexity, ["low", "medium", "high"]);
    assert.deepEqual(controls(id).output_format, ["png", "jpeg", "webp", "gif", "svg"]);
    assert.deepEqual(controls(id).gif, {
      frame_count: { min: 2, max: 16 },
      frame_duration_ms: { min: 20, max: 2000 },
    });
    assert.equal(controls(id).editing?.markup, "png");
  }
  for (const id of ["gpt-image-2.6", "gpt-image-2.5-sunburst", "gpt-image-2.5", "gpt-image-2"]) {
    assert.deepEqual(controls(id).complexity, []);
    assert.deepEqual(controls(id).output_format, ["png", "jpeg", "webp"]);
    assert.equal(controls(id).gif, undefined);
    assert.equal(controls(id).editing?.markup, id === "gpt-image-2.5-sunburst" ? "png" : undefined);
  }
  assert.deepEqual(controls("gpt-image-2.6").quality, ["auto", "low", "medium", "high"]);
  assert.deepEqual(controls("gemini-2.5-flash-image").resolution, []);
  assert.deepEqual(controls("gemini-3-pro-image").resolution, ["1K", "2K", "4K"]);
  assert.deepEqual(controls("gemini-3.1-flash-image").resolution, ["512", "1K", "2K", "4K"]);
  assert.deepEqual(controls("gemini-3.1-flash-lite-image").resolution, ["1K"]);
  assert.ok(controls("gemini-3.1-flash-image").aspect_ratio.includes("8:1"));
  assert.ok(!controls("gemini-3.1-flash-lite-image").aspect_ratio.includes("8:1"));
  for (const id of googleIds) {
    assert.deepEqual(controls(`vertex/${id}`), controls(id));
    assert.deepEqual(controls(`antigravity/${id}`), controls(id));
  }
  assert.deepEqual(controls(imageModel).resolution, ["1k", "2k"]);
  assert.ok(controls(imageModel).aspect_ratio.includes("20:9"));
  for (const ratio of ["auto", "21:9", "2:1", "19.5:9"])
    assert.ok(!controls(imageModel).aspect_ratio.includes(ratio));
  assert.deepEqual(controls("grok-imagine-video").resolution, ["480p", "720p"]);
  assert.deepEqual(controls(videoModel).resolution, ["480p", "720p", "1080p"]);
  assert.deepEqual(controls("grok-imagine-video-1.5-lite").resolution, ["480p", "720p", "1080p"]);
  for (const id of ["unknown", "vertex/gpt-image-2", `vertex/${videoModel}`, ...qualifiedRetiredIds]) {
    const unavailable = mediaControls(id);
    assert.deepEqual(unavailable.size, []);
    assert.deepEqual(unavailable.resolution, []);
    assert.deepEqual(unavailable.aspect_ratio, []);
    assert.equal(unavailable.size_limits, undefined);
  }
});

test("image and video output controls reach only the selected backend's wire fields", {
  timeout: 30000,
}, async (t) => {
  const requests: { path: string | undefined; body: unknown }[] = [];
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      if (req.method === "GET") {
        res.end(
          JSON.stringify({ data: [...openaiIds, ...ids, ...qualifiedGoogleIds].map((id) => ({ id })) }),
        );
        return;
      }
      void body(req).then((value) => {
        requests.push({ path: req.url, body: value });
        res.end(
          JSON.stringify(
            req.url === "/gateway/v1/videos"
              ? { request_id: "fixture" }
              : req.url?.includes("generateContent")
                ? googleResponse()
                : { data: [{ b64_json: png }] },
          ),
        );
      });
    })}/gateway`,
  });
  const ctx = { ...context(await home(t)), sessionManager: SessionManager.inMemory() };
  const chat = ctx.model;
  for (const model of openaiIds) {
    const sizes =
      model === "gpt-image-1.5"
        ? ["auto", "1024x1536"]
        : ["auto", "1024x640", "1536x512", "1536x864", "2048x2048", "3840x2160", "2160x3840"];
    for (const size of sizes) {
      const image = await generateImage(config, { model, prompt: "fixture", size }, ctx);
      assert.equal(image.details.model, model);
      assert.deepEqual(requests.at(-1), {
        path: "/gateway/v1/images/generations",
        body: { model, prompt: "fixture", n: 1, size },
      });
      assert.equal((await readFile(image.details.files[0].path)).toString("base64"), png);
    }
  }
  for (const model of ids.slice(0, 3)) {
    await generateImage(config, { model, prompt: "fixture", resolution: "2k", aspect_ratio: "20:9" }, ctx);
    assert.deepEqual(requests.at(-1), {
      path: "/gateway/v1/images/generations",
      body: {
        model,
        prompt: "fixture",
        n: 1,
        response_format: "b64_json",
        resolution: "2k",
        aspect_ratio: "20:9",
      },
    });
  }
  for (const model of qualifiedGoogleIds) {
    const resolutions = mediaControls(model).resolution;
    for (const resolution of resolutions.length ? resolutions : [undefined]) {
      const aspect_ratio = model.endsWith("gemini-3.1-flash-image") ? "8:1" : "9:16";
      const image = await generateImage(config, { model, prompt: "fixture", resolution, aspect_ratio }, ctx);
      assert.equal(image.details.model, model);
      assert.deepEqual(requests.at(-1), {
        path: `/gateway/v1beta/models/${model}:generateContent`,
        body: {
          contents: [{ role: "user", parts: [{ text: "fixture" }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            candidateCount: 1,
            imageConfig: { aspectRatio: aspect_ratio, ...(resolution ? { imageSize: resolution } : {}) },
          },
        },
      });
    }
  }
  for (const model of ids.slice(3)) {
    for (const resolution of mediaControls(model).resolution) {
      const video = await generateVideo(
        config,
        { model, prompt: "fixture", duration: 1, resolution, aspect_ratio: "9:16" },
        ctx,
      );
      assert.equal(video.model, model);
      assert.deepEqual(requests.at(-1), {
        path: "/gateway/v1/videos",
        body: { model, prompt: "fixture", duration: 1, resolution, aspect_ratio: "9:16" },
      });
    }
  }
  assert.equal(ctx.model, chat);
  assert.deepEqual(ctx.sessionManager.getBranch(), []);
});

test("unsupported output controls fail before auth, discovery, generation, or file writes", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid controls must not access the network"));
  const config = parseConfig({});
  const ctx = {
    ...context(await home(t)),
    modelRegistry: { getProviderAuth: async () => assert.fail("Invalid controls must fail before auth") },
  };
  for (const size of [
    "",
    "16x16",
    "0x1024",
    "-1024x1024",
    "1025x1024",
    "3856x1792",
    "3072x3072",
    "3072x768",
    "1024x624",
    "1024X1024",
    "1024x1024\n",
    " 1024x1024",
    "1024x1024 ",
    "1e3x1024",
    "999999999x1024",
  ]) {
    await assert.rejects(
      generateImage(config, { model: "gpt-image-2", prompt: "fixture", size }, ctx),
      /CLIProxyAPI size/,
    );
  }
  for (const params of [
    { model: "gpt-image-1.5", size: "2048x2048" },
    { model: "gpt-image-2", resolution: "2K" },
    { model: "gpt-image-2.5-sunburst", size: "1024x1024", aspect_ratio: "1:1" },
    { model: "gemini-2.5-flash-image", resolution: "1K" },
    { model: "gemini-3-pro-image", resolution: "512" },
    { model: "gemini-3-pro-image", size: "1024x1024" },
    { model: "gemini-3.1-flash-lite-image", resolution: "2K" },
    { model: "gemini-3.1-flash-lite-image", aspect_ratio: "8:1" },
    { model: "gemini-3.1-flash-image", resolution: "2k" },
    { model: imageModel, resolution: "4k" },
    { model: imageModel, size: "1024x1024" },
    { model: imageModel, aspect_ratio: "21:9" },
    { model: imageModel, aspect_ratio: "auto" },
  ])
    await assert.rejects(
      generateImage(config, { prompt: "fixture", ...params }, ctx),
      /CLIProxyAPI .*unsupported/,
    );
  for (const params of [
    { model: "grok-imagine-video", resolution: "1080p" },
    { model: videoModel, resolution: "4K" },
    { model: videoModel, aspect_ratio: "21:9" },
    { model: videoModel, size: "1280x720" },
  ])
    await assert.rejects(
      generateVideo(config, { prompt: "fixture", ...params }, ctx),
      /CLIProxyAPI .*unsupported/,
    );
  for (const field of ["size", "resolution", "aspect_ratio"]) {
    for (const value of [null, 123, {}, [], "", "\n"]) {
      await assert.rejects(
        generateImage(config, { model: "gpt-image-2", prompt: "fixture", [field]: value }, ctx),
        /CLIProxyAPI .*unsupported/,
      );
    }
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("OpenAI controls preserve quality, transparency, compression, and exact API-key image count", async (t) => {
  const model = "api/gpt-image-2.5-sunburst";
  const requests: unknown[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify({ data: [{ id: model }] }));
      assert.equal(req.url, "/v1/images/generations");
      void body(req).then((value) => {
        requests.push(value);
        res.end(JSON.stringify({ data: [{ b64_json: webp }, { b64_json: png }] }));
      });
    }),
  });
  const ctx = context(await home(t));
  const params = {
    model,
    prompt: "fixture",
    size: "2048x2048",
    quality: "max",
    background: "transparent",
    output_format: "webp",
    output_compression: 0,
    moderation: "auto",
    n: 2,
  };
  const result = await generateImage(config, params, ctx);
  assert.deepEqual(requests, [params]);
  assert.equal(result.details.files.length, 2);
  assert.deepEqual(
    result.details.files.map((file) => file.mimeType),
    ["image/webp", "image/png"],
  );
  assert.deepEqual(mediaControls(model).quality, ["auto", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(mediaControls("api/gpt-image-1.5").input_fidelity, ["low", "high"]);
  assert.deepEqual(mediaControls(model).input_fidelity, []);
});

test("OpenAI editing uploads bounded local files and a mask to the exact edit route without changing inputs", async (t) => {
  const model = "api/gpt-image-1.5";
  let posted: unknown;
  const config = parseConfig({
    baseUrl: `${await server(t, (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      if (req.method === "GET") return void res.end(JSON.stringify({ data: [{ id: model }] }));
      assert.equal(req.url, "/gateway/v1/images/edits");
      assert.equal(req.headers["content-type"], "application/json");
      void body(req).then((value) => {
        posted = value;
        res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
    })}/gateway`,
  });
  const ctx = context(await home(t));
  const files = [
    ["source.png", png],
    ["reference.jpg", jpeg],
    ["mask.png", png],
  ];
  for (const [name, data] of files) await writeFile(join(ctx.cwd, name), Buffer.from(data, "base64"));
  const progress: string[] = [];
  await generateImage(
    config,
    {
      model,
      prompt: "fixture",
      images: ["source.png", join(ctx.cwd, "reference.jpg")],
      mask: "mask.png",
      input_fidelity: "high",
      quality: "high",
    },
    ctx,
    undefined,
    (text) => progress.push(text),
  );
  assert.deepEqual(posted, {
    model,
    prompt: "fixture",
    n: 1,
    quality: "high",
    input_fidelity: "high",
    images: [{ image_url: `data:image/png;base64,${png}` }, { image_url: `data:image/jpeg;base64,${jpeg}` }],
    mask: { image_url: `data:image/png;base64,${png}` },
  });
  assert.deepEqual(progress, ["Editing image...", "Saving image..."]);
  for (const [name, data] of files)
    assert.equal((await readFile(join(ctx.cwd, name))).toString("base64"), data);
});

test("markup edits send a transparent PNG layer to Sunburst and Flare without a mask", async (t) => {
  const ids = ["gpt-image-2.6-flare", "oauth/gpt-image-2.5-sunburst"];
  const posted: unknown[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
      assert.equal(req.url, "/v1/images/edits");
      void body(req).then((value) => {
        posted.push(value);
        res.end(JSON.stringify({ data: [{ b64_json: png }] }));
      });
    }),
  });
  const ctx = context(await home(t));
  for (const [name, data] of [
    ["kitchen.jpg", jpeg],
    ["kitchen.png", png],
    ["overlay.png", png],
  ])
    await writeFile(join(ctx.cwd, name), Buffer.from(data, "base64"));
  // OpenAI checks markup on a JPEG first image after orientation; the extension checks PNG sizes.
  await generateImage(
    config,
    { model: ids[0], prompt: "fixture", images: ["kitchen.jpg"], markup: "overlay.png", complexity: "low" },
    ctx,
  );
  await generateImage(
    config,
    { model: ids[1], prompt: "fixture", images: ["kitchen.png"], markup: "overlay.png" },
    ctx,
  );
  const layer = { image_url: `data:image/png;base64,${png}` };
  assert.deepEqual(posted, [
    {
      model: ids[0],
      prompt: "fixture",
      complexity: "low",
      n: 1,
      images: [{ image_url: `data:image/jpeg;base64,${jpeg}` }],
      markup: layer,
    },
    { model: ids[1], prompt: "fixture", n: 1, images: [layer], markup: layer },
  ]);
});

test("invalid OpenAI controls and edit inputs fail before authentication or network access", async (t) => {
  const image26 = "api/gpt-image-2.6-sunburst";
  const config = parseConfig({});
  const ctx = {
    ...context(await home(t)),
    modelRegistry: { getProviderAuth: t.mock.fn(async () => ({ auth: { apiKey: key } })) },
  };
  const network = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  for (const params of [
    { quality: "ultra" },
    { model: "gpt-image-1.5", quality: "max" },
    { output_format: "gif" },
    { background: "transparent", output_format: "jpeg" },
    { output_compression: 80 },
    { output_format: "png", output_compression: 80 },
    { output_format: "webp", output_compression: -1 },
    { output_format: "jpeg", output_compression: 101 },
    { output_format: "webp", output_compression: 1.5 },
    { moderation: "disabled" },
    { n: 0 },
    { n: 11 },
    { n: 1.5 },
    { model: "gpt-image-2", n: 2 },
    { model: "oauth/gpt-image-2", n: 2 },
    { model: imageModel, quality: "high" },
    { model: "gemini-3-pro-image", images: ["source.png"] },
    { mask: "mask.png" },
    { images: [] },
    { images: Array(17).fill("source.png") },
    { images: ["https://must-not-contact.example/source.png"] },
    { images: [""] },
    { images: ["."] },
    { images: ["missing.png"] },
    { input_fidelity: "high" },
    { images: ["source.png"], input_fidelity: "high" },
    { prompt: "x".repeat(32001) },
    { partial_images: 4 },
    { partial_images: -1 },
    { partial_images: 1.5 },
    { partial_images: 1, n: 2 },
    { model: imageModel, partial_images: 1 },
    { model: "gemini-3-pro-image", partial_images: 1 },
    { complexity: "low" },
    { output_format: "svg" },
    { model: image26, complexity: "max" },
    { model: "oauth/gpt-image-2.6", complexity: "low" },
    { model: "api/gpt-image-2", output_format: "gif" },
    { model: image26, output_format: "svg", n: 2 },
    { model: image26, output_format: "gif", partial_images: 1 },
    { model: image26, output_format: "svg", partial_images: 2 },
    { model: image26, output_format: "gif", output_compression: 50 },
    { model: image26, frame_count: 4 },
    { model: image26, output_format: "png", frame_duration_ms: 100 },
    { model: image26, output_format: "gif", frame_count: 1 },
    { model: image26, output_format: "gif", frame_count: 17 },
    { model: image26, output_format: "gif", frame_count: 2.5 },
    { model: image26, output_format: "gif", frame_duration_ms: 10 },
    { model: image26, output_format: "gif", frame_duration_ms: 2001 },
    { model: image26, output_format: "gif", size: "520x512" },
    { model: image26, output_format: "gif", images: ["source.png"] },
    { model: image26, output_format: "svg", images: ["source.png"] },
    { markup: "mask.png" },
    { model: "api/gpt-image-2", images: ["source.png"], markup: "mask.png" },
    { images: ["source.png"], mask: "mask.png", markup: "mask.png" },
  ])
    await assert.rejects(
      generateImage(config, { model: "api/gpt-image-2.5-sunburst", prompt: "fixture", ...params }, ctx),
    );
  await writeFile(join(ctx.cwd, "source.png"), Buffer.from(png, "base64"));
  await writeFile(join(ctx.cwd, "invalid.png"), "not an image");
  const wrongSize = Buffer.from(png, "base64");
  wrongSize.writeUInt32BE(2, 16);
  await writeFile(join(ctx.cwd, "wrong-size.png"), wrongSize);
  const noAlpha = Buffer.from(png, "base64");
  noAlpha[25] = 2;
  await writeFile(join(ctx.cwd, "no-alpha.png"), noAlpha);
  for (const mask of ["invalid.png", "wrong-size.png", "no-alpha.png"])
    await assert.rejects(
      generateImage(
        config,
        { model: "api/gpt-image-2", prompt: "fixture", images: ["source.png"], mask },
        ctx,
      ),
    );
  for (const markup of ["invalid.png", "wrong-size.png", "no-alpha.png"])
    await assert.rejects(
      generateImage(config, { model: image26, prompt: "fixture", images: ["source.png"], markup }, ctx),
    );
  await assert.rejects(
    generateImage(config, { model: "api/gpt-image-2", prompt: "fixture", images: ["invalid.png"] }, ctx),
  );
  await truncate(join(ctx.cwd, "source.png"), 14 * 1024 * 1024 + 1);
  await assert.rejects(
    generateImage(config, { model: "api/gpt-image-2", prompt: "fixture", images: ["source.png"] }, ctx),
    /limits/,
  );
  await truncate(join(ctx.cwd, "source.png"), 11 * 1024 * 1024);
  await assert.rejects(
    generateImage(
      config,
      { model: "api/gpt-image-2", prompt: "fixture", images: ["source.png", "source.png"] },
      ctx,
    ),
    /limits/,
  );
  assert.equal(ctx.modelRegistry.getProviderAuth.mock.callCount(), 0);
  assert.equal(network.mock.callCount(), 0);
  assert.ok(!(await readdir(ctx.cwd)).includes(".pi"));
});

test("cancellation during edit-file reading closes the file before authentication", async (t) => {
  const ctx = {
    ...context(await home(t)),
    modelRegistry: { getProviderAuth: t.mock.fn(async () => ({ auth: { apiKey: key } })) },
  };
  await writeFile(
    join(ctx.cwd, "source.png"),
    Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(128 * 1024)]),
  );
  const network = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const controller = new AbortController();
  const original = fs.open;
  let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    opened = file;
    const stream = file.createReadStream.bind(file);
    t.mock.method(file, "createReadStream", (...options: Parameters<typeof file.createReadStream>) => {
      const input = stream(...options);
      input.once("data", () => controller.abort());
      return input;
    });
    return file;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      generateImage(
        parseConfig({}),
        { model: "api/gpt-image-2", prompt: "fixture", images: ["source.png"] },
        ctx,
        controller.signal,
      ),
    );
    assert.ok(controller.signal.aborted);
    assert.ok(opened);
    assert.equal(opened.fd, -1);
    assert.equal(ctx.modelRegistry.getProviderAuth.mock.callCount(), 0);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("multi-image output cleans up a partial save and isolates concurrent generations", async (t) => {
  const model = "api/gpt-image-2";
  const config = parseConfig({
    baseUrl: await server(t, (req, res) =>
      res.end(
        JSON.stringify(
          req.method === "GET" ? { data: [{ id: model }] } : { data: [{ b64_json: png }, { b64_json: png }] },
        ),
      ),
    ),
  });
  const ctx = context(await home(t));
  const params = { model, prompt: "fixture", n: 2 };
  const original = fs.writeFile;
  let writes = 0;
  const mocked = t.mock.method(fs, "writeFile", (...args: Parameters<typeof fs.writeFile>) => {
    if (++writes === 2) return Promise.reject(new Error("Fixture write failure"));
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(generateImage(config, params, ctx), /could not save/);
    assert.equal(writes, 2);
    assert.deepEqual(await readdir(join(ctx.cwd, ".pi")), []);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const results = await Promise.all([generateImage(config, params, ctx), generateImage(config, params, ctx)]);
  const files = results.flatMap((result) => result.details.files);
  assert.equal(new Set(files.map((file) => file.path)).size, 4);
  assert.equal((await readdir(join(ctx.cwd, ".pi"))).length, 2);
  for (const file of files) assert.equal((await readFile(file.path)).toString("base64"), png);
});

test("OpenAI caller cancellation and overall timeout destroy an incoming body after partial data", {
  timeout: 15000,
}, async (t) => {
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  const ctx = context(await home(t));
  for (const phase of ["caller", "deadline"]) {
    deadlines.length = 0;
    const partial = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const onRequest = (message: unknown) => {
      const { request } = message as { request: ClientRequest };
      if (request.method === "POST")
        request.once("response", (incoming) => {
          incoming.once("data", () => partial.resolve());
          incoming.once("close", () => closed.resolve());
        });
    };
    subscribe("http.client.request.start", onRequest);
    let posts = 0;
    const config = parseConfig({
      baseUrl: await server(t, (req, res) => {
        if (req.method === "GET") return void res.end(JSON.stringify(openaiCatalog));
        posts++;
        res.write('{"data":[');
      }),
    });
    const caller = new AbortController();
    try {
      const rejected = assert.rejects(
        generateImage(config, { model: openaiIds[1], prompt: "fixture" }, ctx, caller.signal),
        /media response is invalid, incomplete, cancelled/,
      );
      await partial.promise;
      assert.equal(deadlines[0].milliseconds, 600000);
      if (phase === "caller") caller.abort();
      else deadlines[0].controller.abort();
      await rejected;
      await closed.promise;
      assert.equal(posts, 1);
    } finally {
      caller.abort();
      unsubscribe("http.client.request.start", onRequest);
    }
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("media errors show a short upstream reason without credentials, control text or raw bodies", async (t) => {
  let response = "";
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models")
        return void res.end(
          JSON.stringify({ data: [...openaiCatalog.data, ...googleCatalog.data, ...catalog.data] }),
        );
      req.resume();
      res.writeHead(400, { "content-type": "application/json" }).end(response);
    }),
  });
  const ctx = context(await home(t));
  const operations = [
    () => generateImage(config, { model: openaiIds[1], prompt: "fixture" }, ctx),
    () => generateImage(config, { model: googleIds[0], prompt: "fixture" }, ctx),
    () => generateVideo(config, { model: videoModel, prompt: "fixture" }, ctx),
    () => videoStatus(config, "fixture", ctx),
  ];
  response = JSON.stringify({
    error: {
      message: `Invalid size for ${key}: sk-proj-fixture123, Bearer fixture-token, xai-fixture-secret, AIzaFixtureGoogleKey012345, ya29.fixture-oauth.\n\u001b[31mred\u202e${"x".repeat(1000)}`,
    },
  });
  for (const operation of operations)
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof Error);
      const prefix = "CLIProxyAPI media request failed (HTTP 400): ";
      assert.ok(
        error.message.startsWith(
          `${prefix}Invalid size for [redacted]: [redacted], [redacted], [redacted], [redacted], [redacted] [31mred x`,
        ),
      );
      assert.ok(error.message.length <= prefix.length + 500);
      for (const hidden of [
        key,
        "sk-proj",
        "fixture-token",
        "xai-fixture",
        "AIzaFixture",
        "ya29.",
        "\u001b",
        "\u202e",
        "\n",
      ])
        assert.ok(!error.message.includes(hidden), hidden);
      return true;
    });
  response = JSON.stringify({ code: "invalid-argument", error: "Malformed request ID" });
  for (const operation of operations)
    await assert.rejects(operation(), /\(HTTP 400\): Malformed request ID$/);
  for (const value of ["<html>Bad Request</html>", JSON.stringify({ error: { code: 400 } }), "{}"]) {
    response = value;
    for (const operation of operations)
      await assert.rejects(operation(), /: CLIProxyAPI media request failed \(HTTP 400\)\.$/);
  }
  assert.deepEqual(await readdir(ctx.cwd), []);
});

test("OpenAI image usage reaches the tool result with list-price estimates", async (t) => {
  let usage: unknown = {
    input_tokens: 60,
    input_tokens_details: { text_tokens: 10, image_tokens: 50 },
    output_tokens: 1000,
    total_tokens: 1060,
  };
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET")
        return void res.end(JSON.stringify({ data: [...openaiCatalog.data, ...catalog.data] }));
      req.resume();
      res.end(JSON.stringify({ data: [{ b64_json: png }], usage }));
    }),
  });
  const ctx = context(await home(t));
  const priced = await generateImage(config, { model: openaiIds[1], prompt: "fixture" }, ctx);
  assert.ok(priced.usage);
  assert.deepEqual(
    { ...priced.usage, cost: undefined },
    { input: 60, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 1060, cost: undefined },
  );
  assert.ok(Math.abs(priced.usage.cost.total - (10 * 5 + 50 * 8 + 1000 * 30) / 1e6) < 1e-12);
  const legacy = await generateImage(config, { model: "gpt-image-1.5", prompt: "fixture" }, ctx);
  assert.ok(Math.abs((legacy.usage?.cost.output ?? 0) - (1000 * 32) / 1e6) < 1e-12);
  const unpriced = await generateImage(config, { model: openaiIds[2], prompt: "fixture" }, ctx);
  assert.equal(unpriced.usage?.totalTokens, 1060);
  assert.equal(unpriced.usage?.cost.total, 0);
  assert.equal((await generateImage(config, { model: imageModel, prompt: "fixture" }, ctx)).usage, undefined);
  for (const value of [
    undefined,
    null,
    {},
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: "1", output_tokens: 1 },
  ]) {
    usage = value;
    assert.equal(
      (await generateImage(config, { model: openaiIds[1], prompt: "fixture" }, ctx)).usage,
      undefined,
    );
  }
});

test("GPT Image 2.6 GIF and SVG output saves validated files without previews and counts SVG authoring", async (t) => {
  const model = "api/gpt-image-2.6-sunburst";
  const author = getBuiltinModels("openai").find(({ cost }) => cost.input > 0 && cost.output > 0);
  assert.ok(author);
  const root =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><defs><linearGradient id="g"><stop offset="0" stop-color="#fa0"/></linearGradient><rect id="r" width="8" height="8"/></defs><rect width="16" height="16" fill="url(#g)"/><use xlink:href="#r"/></svg>';
  const usage = {
    input_tokens: 60,
    input_tokens_details: { text_tokens: 10, image_tokens: 50 },
    output_tokens: 1000,
    total_tokens: 1060,
  };
  let response: unknown;
  const posted: unknown[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify({ data: [{ id: model }] }));
      assert.equal(req.url, "/v1/images/generations");
      void body(req).then((value) => {
        posted.push(value);
        res.end(JSON.stringify(response));
      });
    }),
  });
  const ctx = context(await home(t));
  response = { data: [{ b64_json: gif }, { b64_json: gif }] };
  // GIF frames may go below the still-image minimum pixel count.
  const params = {
    model,
    prompt: "fixture",
    output_format: "gif",
    frame_count: 4,
    frame_duration_ms: 120,
    size: "256x256",
    complexity: "low",
    n: 2,
  };
  const animated = await generateImage(config, params, ctx);
  assert.deepEqual(posted, [params]);
  assert.deepEqual(
    animated.details.files.map(({ mimeType }) => mimeType),
    ["image/gif", "image/gif"],
  );
  assert.ok(animated.details.files[1].path.endsWith("image-2.gif"));
  assert.equal((await readFile(animated.details.files[1].path)).toString("base64"), gif);
  assert.ok(animated.content.every((part) => part.type === "text"));
  assert.match(JSON.stringify(animated.content), /GIF and SVG results are saved without an inline preview/);
  for (const [svgModel, authorCost] of [
    [author.id, (100 * author.cost.input + 2000 * author.cost.output) / 1e6],
    ["unknown-author", 0],
  ] as const) {
    response = {
      data: [{ b64_json: svg(root) }],
      usage,
      svg_usage: {
        model: svgModel,
        input_tokens: 100,
        output_tokens: 2000,
        reasoning_tokens: 1500,
        total_tokens: 2100,
      },
    };
    const vector = await generateImage(
      config,
      { model, prompt: "fixture", output_format: "svg", quality: "low" },
      ctx,
    );
    assert.deepEqual(posted.at(-1), { model, prompt: "fixture", output_format: "svg", quality: "low", n: 1 });
    assert.equal(vector.details.files[0].mimeType, "image/svg+xml");
    assert.ok(vector.details.files[0].path.endsWith("image.svg"));
    assert.equal(await readFile(vector.details.files[0].path, "utf8"), svgDocument(root));
    assert.equal(vector.content.length, 1);
    assert.equal(vector.usage?.totalTokens, 1060 + 2100);
    assert.equal(vector.usage?.output, 3000);
    assert.ok(
      Math.abs((vector.usage?.cost.total ?? 0) - ((10 * 5 + 50 * 8 + 1000 * 30) / 1e6 + authorCost)) < 1e-12,
    );
  }
  const before = await readdir(join(ctx.cwd, ".pi"));
  for (const [output_format, data] of [
    ["gif", png],
    ["gif", Buffer.from("GIF89a").toString("base64")],
    ["svg", png],
    ["svg", Buffer.from("<svg>\u00ff</svg>", "latin1").toString("base64")],
    ["svg", svg('<svg xmlns="http://www.w3.org/2000/svg">')],
    ["svg", svg('<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>')],
    ["svg", Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>').toString("base64")],
    ...[
      "<script>alert(1)</script>",
      '<rect onclick="alert(1)"/>',
      '<image href="https://media.example/x.png"/>',
      '<a href="javascript:alert(1)"><rect/></a>',
      '<use href="https://media.example/a.svg#x"/>',
      "<rect fill=\"url('https://media.example/x')\"/>",
      '<style>@import "https://media.example/x.css";</style>',
      '<set attributeName="fill" to="red"/>',
      "<foreignObject><div/></foreignObject>",
    ].map((element) => ["svg", svg(`<svg xmlns="http://www.w3.org/2000/svg">${element}</svg>`)]),
  ]) {
    response = { data: [{ b64_json: data }] };
    await assert.rejects(
      generateImage(config, { model, prompt: "fixture", output_format }, ctx),
      /CLIProxyAPI returned/,
    );
  }
  assert.deepEqual(await readdir(join(ctx.cwd, ".pi")), before);
});

test("partial previews stream over the image transport and only the final image is saved", async (t) => {
  let mode = "success";
  const posted: unknown[] = [];
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET") return void res.end(JSON.stringify(openaiCatalog));
      assert.equal(req.headers["accept-encoding"], "identity");
      void body(req).then((value) => {
        posted.push(value);
        if (!(value && typeof value === "object" && "stream" in value))
          return void res.end(JSON.stringify({ data: [{ b64_json: png }] }));
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: { type: string; [field: string]: unknown }) =>
          res.write(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
        res.write(": keep-alive\n\n");
        send({ type: "image_generation.partial_image", b64_json: jpeg, partial_image_index: 0 });
        // Split the CRLF separator between two writes so the reader sees CR and LF in separate chunks.
        const invalid = { type: "image_generation.partial_image", b64_json: "!!!!", partial_image_index: 1 };
        res.write(`event: ${invalid.type}\r\ndata: ${JSON.stringify(invalid)}\r\n\r`);
        void sleep(25).then(() => {
          res.write("\n");
          if (mode === "error") send({ type: "error", error: { message: `Moderation blocked ${key}` } });
          else if (mode === "success") {
            const usage = { input_tokens: 10, output_tokens: 300, total_tokens: 310 };
            const frame = `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: png, usage })}\n\n`;
            res.write(frame.slice(0, 20));
            res.write(frame.slice(20));
          }
          res.end();
        });
      });
    }),
  });
  const ctx = context(await home(t));
  const previews: { index: number; image: ImageContent }[] = [];
  const progress: string[] = [];
  const result = await generateImage(
    config,
    { model: openaiIds[1], prompt: "fixture", partial_images: 2 },
    ctx,
    undefined,
    (text) => progress.push(text),
    (image, index) => previews.push({ index, image }),
  );
  assert.deepEqual(posted[0], {
    model: openaiIds[1],
    prompt: "fixture",
    n: 1,
    stream: true,
    partial_images: 2,
  });
  assert.deepEqual(previews, [{ index: 0, image: { type: "image", data: jpeg, mimeType: "image/jpeg" } }]);
  assert.deepEqual(progress, ["Generating image...", "Saving image..."]);
  assert.equal(result.details.files.length, 1);
  assert.equal((await readFile(result.details.files[0].path)).toString("base64"), png);
  assert.equal(result.usage?.totalTokens, 310);
  const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  registerMediaTools(
    {
      registerTool(tool) {
        tools.push(tool as unknown as (typeof tools)[number]);
      },
    } as ExtensionAPI,
    config,
  );
  const tool = tools.find((entry) => entry.name === "cliproxyapi_generate_image");
  assert.ok(tool);
  const updates: unknown[] = [];
  await tool.execute(
    "fixture",
    { model: openaiIds[1], prompt: "fixture", partial_images: 1 },
    undefined,
    (update) => updates.push(update),
    ctx as unknown as ExtensionToolContext,
  );
  assert.deepEqual(updates[1], {
    content: [
      { type: "text", text: "Partial image 1" },
      { type: "image", data: jpeg, mimeType: "image/jpeg" },
    ],
    details: {},
  });
  mode = "error";
  await assert.rejects(
    generateImage(config, { model: openaiIds[1], prompt: "fixture", partial_images: 1 }, ctx),
    /: CLIProxyAPI image stream failed: Moderation blocked \[redacted\]$/,
  );
  mode = "incomplete";
  await assert.rejects(
    generateImage(config, { model: openaiIds[1], prompt: "fixture", partial_images: 1 }, ctx),
    /must complete 1 image/,
  );
  await generateImage(config, { model: openaiIds[1], prompt: "fixture", partial_images: 0 }, ctx);
  assert.deepEqual(posted.at(-1), { model: openaiIds[1], prompt: "fixture", n: 1 });
  assert.equal((await readdir(join(ctx.cwd, ".pi"))).length, 3);
});

test("OpenAI images complete over HTTPS through a CONNECT proxy with certificate checks", {
  timeout: 30000,
}, async (t) => {
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    t.skip("Node's environment proxy support is unavailable.");
    return;
  }
  const cwd = await home(t);
  const [keyPath, certPath] = [join(cwd, "key.pem"), join(cwd, "cert.pem")];
  try {
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { timeout: 10000 },
    );
  } catch {
    t.skip("OpenSSL is unavailable.");
    return;
  }
  const requests: string[] = [];
  const origin = createHttpsServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (req, res) => {
      requests.push(`origin ${req.method}`);
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      req.resume();
      res.end(JSON.stringify(req.method === "GET" ? openaiCatalog : { data: [{ b64_json: png }] }));
    },
  );
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  t.after(() => {
    origin.closeAllConnections();
    origin.close();
  });
  const originAddress = origin.address();
  assert.ok(originAddress && typeof originAddress !== "string");
  const proxy = createServer(() => assert.fail("HTTPS image requests must use a CONNECT tunnel"));
  proxy.on("connect", (req, socket, head) => {
    requests.push(`proxy CONNECT ${req.url}`);
    const upstream = connect(originAddress.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { generateImage } from ${JSON.stringify(pathToFileURL(resolve("src/media.ts")).href)};
      import { parseConfig } from ${JSON.stringify(pathToFileURL(resolve("src/config.ts")).href)};
      const result = await generateImage(parseConfig({ baseUrl: "https://127.0.0.1:${originAddress.port}" }),
        { model: ${JSON.stringify(openaiIds[1])}, prompt: "fixture" },
        { cwd: process.cwd(), model: undefined, modelRegistry: {
          getProviderAuth: async () => ({ auth: { apiKey: ${JSON.stringify(key)} } })
        } }, AbortSignal.timeout(10000));
      assert.equal(result.details.files[0].mimeType, "image/png");
      `,
    ],
    {
      cwd,
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
        NODE_EXTRA_CA_CERTS: certPath,
      },
    },
  );
  assert.deepEqual(requests, ["origin GET", `proxy CONNECT 127.0.0.1:${originAddress.port}`, "origin POST"]);
});

test("a stalled upstream error body still reports the HTTP status promptly", {
  timeout: 30000,
}, async (t) => {
  const config = parseConfig({
    baseUrl: await server(t, (req, res) => {
      if (req.method === "GET" && req.url === "/v1/models")
        return void res.end(JSON.stringify(openaiCatalog));
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      res.write('{"error":{"message":"partial');
    }),
  });
  const ctx = context(await home(t));
  for (const operation of [
    () => generateImage(config, { model: openaiIds[1], prompt: "fixture" }, ctx),
    () => videoStatus(config, "fixture", ctx),
  ]) {
    const started = Date.now();
    await assert.rejects(operation(), /\(HTTP 400\)\.$/);
    assert.ok(Date.now() - started < 10000);
  }
});
