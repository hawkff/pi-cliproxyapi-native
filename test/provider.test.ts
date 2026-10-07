import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createModels,
  getSupportedThinkingLevels,
  hasApi,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  normalizeContext,
  Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { mapCatalog, parseCatalog } from "../src/catalog.ts";
import { isRecord, normalizeBaseUrl, PROVIDER_ID, parseConfig } from "../src/config.ts";
import { builtinCatalog, createCliproxyProvider, discover, nonStrictTools } from "../src/provider.ts";

const key = "fixture-api-key";
const known: Model<Api>[] = [
  ["anthropic", "anthropic-messages", "claude-fixture"],
  ["openai", "openai-responses", "gpt-fixture"],
  ["openai-codex", "openai-codex-responses", "codex-fixture"],
  ["google", "google-generative-ai", "gemini-fixture"],
  ["openai", "openai-completions", "chat-fixture"],
].map(([provider, api, id]) => ({
  id,
  provider,
  api,
  name: id,
  baseUrl: "https://upstream.example/v1",
  headers: { "x-upstream-only": "must-not-forward" },
  reasoning: true,
  thinkingLevelMap: { off: null, high: "high", xhigh: "max", max: "max" },
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  compat: {
    forceAdaptiveThinking: true,
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolChanges: true,
    supportsMidConvoToolAdditions: true,
  },
}));
const catalog = { data: known.map(({ id, provider }) => ({ id, owned_by: provider })) };
const noEnvironment = { env: async () => undefined, fileExists: async () => false };

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

async function collection(baseUrl: string, store = new InMemoryModelsStore(), authenticated = true) {
  const credentials = new InMemoryCredentialStore();
  if (authenticated) await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key", key }));
  const models = createModels({ credentials, modelsStore: store, authContext: noEnvironment });
  const provider = createCliproxyProvider(parseConfig({ baseUrl }), known);
  models.setProvider(provider);
  return { models, provider, store };
}

test("configuration normalizes prefixes and rejects unsafe or invalid values", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8317/v1/"), "http://localhost:8317");
  assert.equal(normalizeBaseUrl("https://proxy.example/gateway/v1beta"), "https://proxy.example/gateway");
  assert.equal(normalizeBaseUrl("http://[::1]:8317"), "http://[::1]:8317");
  for (const value of [
    "ftp://proxy.example",
    "http://proxy.example",
    "https://x:y@proxy.example",
    "https://proxy.example?key=fixture",
    "https://proxy.example#fragment",
    "not-a-url",
  ]) {
    assert.throws(() => normalizeBaseUrl(value));
  }
  for (const value of [
    null,
    [],
    { apiKey: "fixture" },
    { baseUrl: 7 },
    { aliases: null },
    { aliases: [] },
    { aliases: { alias: 7 } },
    { aliases: { alias: "unsupported/example" } },
    { aliases: { alias: "anthropicX" } },
    { aliases: { alias: "anthropic/" } },
  ]) {
    assert.throws(() => parseConfig(value));
  }
  assert.equal(
    parseConfig({ baseUrl: "https://old.example" }, "https://new.example").baseUrl,
    "https://new.example",
  );
});

test("mapping keeps native metadata and routes every supported family to the proxy", () => {
  const before = structuredClone(known);
  const result = mapCatalog(catalog, parseConfig({}), known);
  assert.equal(result.models.length, 5);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.models.map((model) => model.api),
    [
      "anthropic-messages",
      "openai-responses",
      "openai-responses",
      "google-generative-ai",
      "openai-completions",
    ],
  );
  assert.deepEqual(
    result.models.map((model) => model.baseUrl),
    [
      "http://localhost:8317",
      "http://localhost:8317/v1",
      "http://localhost:8317/v1",
      "http://localhost:8317/v1beta",
      "http://localhost:8317/v1",
    ],
  );
  for (const model of result.models) {
    assert.equal(model.provider, PROVIDER_ID);
    assert.equal(model.headers, undefined);
    assert.deepEqual(model.cost, known[0].cost);
    assert.deepEqual(model.thinkingLevelMap, known[0].thinkingLevelMap);
    assert.equal(model.contextWindow, 128000);
  }
  assert.deepEqual(known, before);
  const claude = result.models[0];
  assert.ok(hasApi(claude, "anthropic-messages"));
  assert.equal(claude.compat?.forceAdaptiveThinking, true);
  assert.equal(claude.compat?.supportsEagerToolInputStreaming, false);
  assert.equal(claude.compat?.supportsMidConvoToolChanges, false);
  for (const model of result.models) {
    if (hasApi(model, "google-generative-ai")) continue;
    assert.equal(model.compat?.supportsMidConvoSystemMessages, false);
    if (hasApi(model, "openai-completions")) assert.equal(model.compat?.supportsMidConvoToolAdditions, false);
  }
});

test("aliases keep wire IDs, hidden entries disappear, and unknowns are not guessed", () => {
  const config = parseConfig({ aliases: { "team-chat": "anthropic/claude-fixture" } });
  const result = mapCatalog(
    {
      data: [
        { id: "team-chat" },
        { id: "team-chat" },
        { id: "future-fixture" },
        { id: "gpt-fixture", visibility: "hide" },
      ],
    },
    config,
    known,
  );
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["team-chat"],
  );
  assert.deepEqual(result.skipped, ["future-fixture"]);
  const ambiguous = [...known, { ...known[1], id: known[0].id }];
  assert.equal(mapCatalog({ data: [{ id: known[0].id }] }, config, ambiguous).models.length, 0);
  assert.equal(
    mapCatalog({ data: [{ id: known[0].id, owned_by: "claude" }] }, config, ambiguous).models[0].api,
    "anthropic-messages",
  );
});

test("Antigravity high IDs use exact Claude metadata fallbacks without changing advertised IDs", () => {
  const sources = builtinCatalog();
  for (const canonical of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    const reference = sources.find((model) => model.provider === "anthropic" && model.id === canonical);
    assert.ok(reference);
    const bare = `${canonical}-high`;
    for (const id of [bare, `antigravity/${bare}`, `vertex/${bare}`]) {
      const catalog = { data: [{ id }] };
      const mapped = mapCatalog(catalog, parseConfig({}), sources);
      assert.deepEqual(mapped.skipped, []);
      assert.equal(mapped.models.length, 1);
      const model = mapped.models[0];
      assert.equal(model.id, id);
      assert.equal(model.api, "anthropic-messages");
      assert.equal(model.contextWindow, 1000000);
      assert.equal(model.maxTokens, 128000);
      assert.deepEqual(model.thinkingLevelMap, reference.thinkingLevelMap);
      assert.deepEqual(model.cost, reference.cost);
      assert.deepEqual(mapCatalog(catalog, parseConfig({}), known).skipped, [id]);
      assert.deepEqual(mapCatalog(catalog, parseConfig({}), [reference, reference]).models, []);
      const exact: Model<Api> = { ...reference, id: bare, contextWindow: 42 };
      assert.equal(mapCatalog(catalog, parseConfig({}), [...sources, exact]).models[0].contextWindow, 42);
      assert.deepEqual(
        mapCatalog(catalog, parseConfig({}), [...sources, exact, { ...known[1], id: bare }]).models,
        [],
      );
      const config = parseConfig({ aliases: { [bare]: "openai/gpt-fixture" } });
      assert.equal(mapCatalog(catalog, config, [...sources, ...known]).models[0].api, "openai-responses");
      assert.deepEqual(mapCatalog(catalog, config, sources).models, []);
      const fullAlias = parseConfig({
        aliases: { [bare]: "openai/gpt-fixture", [id]: "google/gemini-fixture" },
      });
      assert.equal(
        mapCatalog(catalog, fullAlias, [...sources, ...known]).models[0].api,
        "google-generative-ai",
      );
    }
    for (const id of [`${bare}-extra`, `${canonical}-low`, `custom/${bare}`, `Antigravity/${bare}`]) {
      assert.deepEqual(mapCatalog({ data: [{ id }] }, parseConfig({}), sources).skipped, [id]);
    }
  }
});

test("malformed catalogs fail rather than replacing a working list", () => {
  for (const value of [
    null,
    {},
    { data: null },
    { data: [null] },
    { data: [{}] },
    { data: [{ id: "bad\nvalue" }] },
    { data: [{ id: "valid", owned_by: {} }] },
    { data: Array(10001).fill({ id: "fixture" }) },
  ]) {
    assert.throws(() => parseCatalog(value));
  }
  assert.deepEqual(parseCatalog({ data: [] }), []);
});

test("native refresh persists metadata, restores offline, keeps failures, and accepts an empty catalog", async (t) => {
  let body: unknown = catalog;
  let status = 200;
  let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests++;
    assert.equal(req.url, "/gateway/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const first = await collection(`${baseUrl}/gateway`);
  assert.equal((await first.models.refresh()).errors.size, 0);
  assert.equal(first.provider.getModels().length, 5);
  const stored = await first.store.read(PROVIDER_ID);
  assert.ok(stored?.etag);
  assert.ok(!JSON.stringify(stored).includes(key));
  assert.ok(!JSON.stringify(stored).includes("must-not-forward"));
  const second = await collection(`${baseUrl}/gateway`, first.store);
  await second.models.refresh({ allowNetwork: false });
  assert.equal(requests, 1);
  assert.equal(second.provider.getModels().length, 5);
  status = 401;
  body = { error: key };
  const failed = await second.models.refresh({ force: true });
  assert.match(failed.errors.get(PROVIDER_ID)?.message ?? "", /HTTP 401/);
  assert.ok(!failed.errors.get(PROVIDER_ID)?.message.includes(key));
  assert.equal(second.provider.getModels().length, 5);
  status = 200;
  body = { broken: true };
  assert.equal((await second.models.refresh()).errors.size, 1);
  assert.equal(second.provider.getModels().length, 5);
  body = { data: [] };
  await second.models.refresh();
  assert.equal(second.provider.getModels().length, 0);
  assert.equal((await second.store.read(PROVIDER_ID))?.models.length, 0);
});

test("fresh Pi runtimes need provider registration to resolve cached models and thinking suffixes", async (t) => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify(catalog));
  });
  const first = await collection(baseUrl);
  await first.models.refresh();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key", key }));
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    modelsStore: first.store,
    credentials,
  });
  const reference = `${PROVIDER_ID}/${known[0].id}`;
  for (const suffix of ["", ":high", ":max"]) {
    assert.ok(resolveCliModel({ cliModel: `${reference}${suffix}`, modelRuntime: runtime }).error);
  }
  runtime.registerNativeProvider(createCliproxyProvider(parseConfig({ baseUrl }), known));
  assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(runtime.getAvailableSnapshot().filter((model) => model.provider === PROVIDER_ID).length, 5);
  for (const source of known) {
    for (const level of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const resolved = resolveCliModel({
        cliModel: `${PROVIDER_ID}/${source.id}${level ? `:${level}` : ""}`,
        modelRuntime: runtime,
      });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.warning, undefined);
      assert.equal(resolved.model?.provider, PROVIDER_ID);
      assert.equal(resolved.model?.id, source.id);
      assert.equal(resolved.thinkingLevel, level);
      assert.deepEqual(resolved.model?.thinkingLevelMap, source.thinkingLevelMap);
      assert.ok(resolved.model);
      assert.deepEqual(getSupportedThinkingLevels(resolved.model), [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  }
  assert.equal(requests, 1);
});

test("old-policy chat catalogs cannot restore qualified retired media aliases", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Offline restoration must not contact the proxy"));
  const id = "vertex/imagen-4.0-generate-001";
  const config = parseConfig({ aliases: { [id]: "google/gemini-fixture" } });
  const provider = createCliproxyProvider(config, known);
  await provider.refreshModels({
    allowNetwork: false,
    signal: AbortSignal.timeout(5000),
    stored: {
      etag: createHash("sha256")
        .update(JSON.stringify([1, config]))
        .digest("hex"),
      models: [{ ...known[3], id, provider: PROVIDER_ID, headers: undefined }],
    },
    async publish(publication) {
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(provider.getModels(), []);
});

test("previous Pi compatibility catalogs cannot restore unverified transcript capabilities", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Offline restoration must not contact the proxy"));
  const config = parseConfig({});
  const provider = createCliproxyProvider(config, known);
  await provider.refreshModels({
    allowNetwork: false,
    signal: AbortSignal.timeout(5000),
    stored: {
      etag: createHash("sha256")
        .update(JSON.stringify([3, config]))
        .digest("hex"),
      models: [{ ...known[0], provider: PROVIDER_ID, headers: undefined }],
    },
    async publish(publication) {
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(provider.getModels(), []);
});

test("cache cannot cross endpoints or alias configurations", async (t) => {
  const baseUrl = await server(t, (_req, res) => res.end(JSON.stringify(catalog)));
  const first = await collection(baseUrl);
  await first.models.refresh();
  const changed = await collection(`${baseUrl}/different`, first.store);
  await changed.models.refresh({ allowNetwork: false });
  assert.equal(changed.provider.getModels().length, 0);
  const aliasProvider = createCliproxyProvider(
    parseConfig({ baseUrl, aliases: { alias: "anthropic/claude-fixture" } }),
    known,
  );
  first.models.setProvider(aliasProvider);
  await first.models.refresh({ allowNetwork: false });
  assert.equal(aliasProvider.getModels().length, 0);
});

test("unconfigured providers and offline refreshes do not access the network", async (t) => {
  let requests = 0;
  const baseUrl = await server(t, (_req, res) => {
    requests++;
    res.end(JSON.stringify(catalog));
  });
  const { models } = await collection(baseUrl, undefined, false);
  await models.refresh();
  await models.refresh({ allowNetwork: false });
  assert.equal(requests, 0);
  assert.equal(await models.getAuth(PROVIDER_ID), undefined);
});

test("stored keys win over ambient keys, and login validates without publishing credentials", async (t) => {
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end(JSON.stringify(catalog));
  });
  const { provider } = await collection(baseUrl);
  const auth = provider.auth.apiKey;
  assert.ok(auth?.login);
  const result = await auth.resolve({
    credential: { type: "api_key", key },
    ctx: { ...noEnvironment, env: async () => "wrong-fixture-key" },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(result?.auth.apiKey, key);
  assert.equal(result?.auth.headers?.Authorization, `Bearer ${key}`);
  const credential = await auth.login({
    prompt: async () => key,
    notify() {},
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(credential, { type: "api_key", key });
  assert.deepEqual(provider.getModels(), []);
  await assert.rejects(
    auth.resolve({
      ctx: { ...noEnvironment, env: async () => "bad\nkey" },
      signal: AbortSignal.timeout(5000),
    }),
    /without whitespace/,
  );
});

test("discovery rejects redirects, oversized bodies, and raw error content", async (t) => {
  let mode = "redirect";
  const baseUrl = await server(t, (_req, res) => {
    if (mode === "redirect") res.writeHead(302, { location: "https://must-not-contact.example" }).end();
    else if (mode === "oversized") res.end("x".repeat(4 * 1024 * 1024 + 1));
    else res.end(`invalid-json-${key}`);
  });
  const run = () => discover(parseConfig({ baseUrl }), key, AbortSignal.timeout(5000), known);
  await assert.rejects(run(), /redirect error/);
  mode = "oversized";
  await assert.rejects(run(), /larger than 4 MiB/);
  mode = "malformed";
  await assert.rejects(run(), (error: unknown) => error instanceof Error && !error.message.includes(key));
});

test("cancelled and superseded refreshes cannot overwrite the latest catalog", async (t) => {
  let count = 0;
  const waiting = Promise.withResolvers<void>();
  const baseUrl = await server(t, (_req, res) => {
    count++;
    if (count === 1) {
      waiting.resolve();
      return;
    }
    res.end(JSON.stringify({ data: [{ id: "gpt-fixture" }] }));
  });
  const { models, provider } = await collection(baseUrl);
  const first = models.refresh();
  await waiting.promise;
  const second = models.refresh({ force: true });
  await Promise.all([first, second]);
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["gpt-fixture"],
  );
  const signal = AbortSignal.abort();
  assert.equal((await models.refresh({ signal })).aborted, true);
  assert.equal(count, 2);
});

test("non-strict Responses tools retain optional arguments and explicit strictness", () => {
  const input = {
    tools: [
      {
        type: "function",
        name: "optional",
        parameters: { type: "object", properties: { optional: { type: "string" } } },
      },
      { type: "function", strict: true },
      { type: "custom", name: "grammar" },
    ],
  };
  const output = nonStrictTools(input);
  assert.ok(isRecord(output) && Array.isArray(output.tools));
  assert.equal(output.tools[0].strict, null);
  assert.equal(output.tools[1].strict, true);
  assert.equal(output.tools[2].strict, undefined);
  assert.ok(!("strict" in input.tools[0]));
});

function sse(res: ServerResponse, events: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    if (isRecord(event) && typeof event.type === "string") res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function respond(res: ServerResponse, api: string, model?: string) {
  if (api === "anthropic-messages") {
    sse(res, [
      {
        type: "message_start",
        message: {
          id: "fixture-message",
          model,
          type: "message",
          role: "assistant",
          content: [],
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  } else if (api === "google-generative-ai") {
    sse(res, [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
      },
    ]);
  } else if (api === "openai-completions") {
    sse(res, [
      {
        id: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        id: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    ]);
  } else {
    const item = {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    };
    sse(res, [
      { type: "response.created", response: { id: "resp_fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "ok" },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [item],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
      },
    ]);
  }
}

test("native adapters stream each family and qualified route through the right endpoint with the proxy key", async (t) => {
  for (const source of known.flatMap((model) => [
    model,
    ...["vertex", "antigravity"].map((prefix) => ({ ...model, id: `${prefix}/${model.id}` })),
  ])) {
    await t.test(source.id, async (t) => {
      const actualApi = source.api === "openai-codex-responses" ? "openai-responses" : source.api;
      let seenPath = "";
      let seenBody: unknown;
      let providerEvents = 0;
      const baseUrl = await server(t, (req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        assert.equal(req.headers["x-upstream-only"], undefined);
        if (req.method === "GET") {
          res.end(JSON.stringify({ data: [{ id: source.id, owned_by: source.provider }] }));
          return;
        }
        seenPath = req.url ?? "";
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          seenBody = JSON.parse(body);
          respond(res, actualApi, source.id.slice(source.id.indexOf("/") + 1));
        });
      });
      const { models } = await collection(`${baseUrl}/gateway`);
      await models.refresh();
      const model = models.getModel(PROVIDER_ID, source.id);
      assert.ok(model);
      const stream = models.streamSimple(
        { ...model, baseUrl: "https://must-not-contact.example" },
        {
          systemPrompt: "fixture-system",
          messages: [
            { role: "user", content: "fixture", timestamp: 0 },
            {
              role: "system",
              content: "fixture-update",
              toolsAdded: [
                { name: "late_fixture_tool", description: "Fixture tool", parameters: Type.Object({}) },
              ],
              timestamp: 0,
            },
            { role: "user", content: "Return ok.", timestamp: 0 },
          ],
          tools: [
            {
              name: "fixture_tool",
              description: "Fixture tool",
              parameters: Type.Object({ optional: Type.Optional(Type.String()) }),
            },
          ],
        },
        {
          maxTokens: 32,
          maxRetries: 0,
          signal: AbortSignal.timeout(10000),
          reasoning: actualApi === "anthropic-messages" ? "high" : undefined,
          async onProviderStreamEvent(event, hookModel) {
            await Promise.resolve();
            assert.ok(isRecord(event));
            assert.equal(hookModel.id, source.id);
            assert.equal(hookModel.provider, PROVIDER_ID);
            assert.equal(hookModel.api, actualApi);
            assert.ok(hookModel.baseUrl.startsWith(`${baseUrl}/gateway`));
            providerEvents++;
          },
        },
      );
      const partials = new Set<AssistantMessage>();
      for await (const event of stream) {
        if ("partial" in event) partials.add(event.partial);
      }
      const result = await stream.result();
      if (actualApi !== "google-generative-ai") assert.equal(partials.size, 1);
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
        "ok",
      );
      assert.equal(result.usage.output, 1);
      assert.ok(providerEvents > 0);
      if (source.id.includes("/")) assert.equal(result.model, source.id);
      const expected =
        actualApi === "anthropic-messages"
          ? "/gateway/v1/messages"
          : actualApi === "google-generative-ai"
            ? `/gateway/v1beta/models/${source.id}:streamGenerateContent`
            : actualApi === "openai-completions"
              ? "/gateway/v1/chat/completions"
              : "/gateway/v1/responses";
      const requestUrl = new URL(seenPath, baseUrl);
      assert.equal(requestUrl.pathname, expected);
      if (actualApi === "google-generative-ai") assert.equal(requestUrl.searchParams.get("alt"), "sse");
      assert.ok(isRecord(seenBody));
      for (const marker of ["fixture-system", "fixture-update", "late_fixture_tool"])
        assert.ok(JSON.stringify(seenBody).includes(marker), marker);
      if (actualApi !== "google-generative-ai") assert.equal(seenBody.model, source.id);
      if (actualApi === "anthropic-messages") {
        assert.ok(isRecord(seenBody.thinking));
        assert.equal(seenBody.thinking.type, "adaptive");
        assert.deepEqual(seenBody.output_config, { effort: "high" });
      }
      if (actualApi === "openai-responses") {
        assert.ok(Array.isArray(seenBody.tools));
        assert.equal(seenBody.tools[0].strict, null);
        assert.ok(!seenBody.tools[0].parameters.required?.includes("optional"));
      }
    });
  }
});

test("native Anthropic requests retain Antigravity high IDs and separate thinking effort", async (t) => {
  const ids = ["claude-opus-5-5-high", "claude-sonnet-5-5-high"].flatMap((id) => [id, `antigravity/${id}`]);
  const seen: string[] = [];
  const baseUrl = await server(t, (req, res) => {
    assert.equal(new URL(req.url ?? "", "http://localhost").pathname, "/v1/messages");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      seen.push(payload.model);
      assert.deepEqual(payload.output_config, { effort: "high" });
      respond(res, "anthropic-messages", payload.model);
    });
  });
  const config = parseConfig({ baseUrl });
  const sources = builtinCatalog();
  const provider = createCliproxyProvider(config, sources);
  for (const id of ids) {
    const model = mapCatalog({ data: [{ id }] }, config, sources).models[0];
    assert.ok(model);
    const result = await provider
      .streamSimple(
        model,
        normalizeContext({ messages: [{ role: "user", content: "Return ok.", timestamp: 0 }] }),
        {
          apiKey: key,
          headers: { Authorization: `Bearer ${key}` },
          reasoning: "high",
          maxTokens: 32,
          maxRetries: 0,
          signal: AbortSignal.timeout(5000),
        },
      )
      .result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.model, id);
  }
  assert.deepEqual(seen, ids);
});

test("native OpenAI adapters forward effective thinking-level sampling defaults and request overrides", async (t) => {
  for (const fixture of [known[1], known[2], known[4]]) {
    await t.test(fixture.api, async (t) => {
      const source = {
        ...fixture,
        thinkingLevelMap: { off: "none", high: "high" },
        samplingParams: { temperature: 0.7, top_p: 0.9 },
        samplingParamsByThinkingLevel: { off: { temperature: 0.1 }, high: { temperature: 0.3 } },
      };
      const api = source.api === "openai-codex-responses" ? "openai-responses" : source.api;
      const payloads: Record<string, unknown>[] = [];
      const baseUrl = await server(t, (req, res) => {
        assert.equal(req.url, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          payloads.push(JSON.parse(body));
          respond(res, api, source.id);
        });
      });
      const config = parseConfig({ baseUrl });
      const provider = createCliproxyProvider(config, [source]);
      const model = mapCatalog({ data: [{ id: source.id }] }, config, [source]).models[0];
      assert.ok(model);
      assert.deepEqual(model.samplingParamsByThinkingLevel, source.samplingParamsByThinkingLevel);
      for (const [reasoning, temperature, expected] of [
        [undefined, undefined, 0.1],
        ["high", undefined, 0.3],
        ["max", undefined, 0.3],
        ["max", 0.2, 0.2],
      ] as const) {
        const result = await provider
          .streamSimple(
            model,
            normalizeContext({ messages: [{ role: "user", content: "Return ok.", timestamp: 0 }] }),
            {
              apiKey: key,
              headers: { Authorization: `Bearer ${key}` },
              reasoning,
              samplingParams: temperature === undefined ? undefined : { temperature },
              maxTokens: 32,
              maxRetries: 0,
              signal: AbortSignal.timeout(5000),
            },
          )
          .result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const payload = payloads.at(-1);
        assert.ok(payload);
        assert.equal(payload.model, source.id);
        assert.equal(payload.temperature, expected);
        assert.equal(payload.top_p, 0.9);
        if (reasoning) {
          if (api === "openai-responses")
            assert.deepEqual(payload.reasoning, { effort: "high", summary: "auto" });
          else assert.equal(payload.reasoning_effort, "high");
        }
      }
      assert.equal(payloads.length, 4);
    });
  }
});

test("Pi loads the package, restores its catalog offline, and sends thinking suffixes as effort", async (t) => {
  const fixture = builtinCatalog().find(
    (model) =>
      hasApi(model, "anthropic-messages") &&
      model.thinkingLevelMap?.max === "max" &&
      model.thinkingLevelMap?.xhigh === "xhigh",
  );
  assert.ok(fixture);
  let requests = 0;
  let seenBody: unknown;
  const baseUrl = await server(t, (req, res) => {
    if (req.method === "POST") {
      assert.equal(new URL(req.url ?? "", "http://localhost").pathname, "/v1/messages");
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seenBody = JSON.parse(body);
        respond(res, "anthropic-messages");
      });
      return;
    }
    requests++;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end(
      JSON.stringify({
        data: [
          { id: fixture.id, owned_by: fixture.provider },
          { id: "unknown-fixture", owned_by: "unmapped" },
        ],
      }),
    );
  });
  const home = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [resolve(".")] }));
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const options = {
    cwd: home,
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: home,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      CLIPROXYAPI_BASE_URL: baseUrl,
      CLIPROXYAPI_API_KEY: key,
    },
  };
  const run = promisify(execFile);
  const cold = await run(process.execPath, [cli, "--list-models", PROVIDER_ID], options);
  assert.ok(!cold.stdout.includes(fixture.id));
  assert.equal(requests, 0);
  // Pi needs an available model to enter RPC, even for extension-only commands.
  // This unrelated fixture never runs inference and does not seed the proxy catalog.
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        fixture: { baseUrl, api: "openai-completions", apiKey: key, models: [{ id: "bootstrap" }] },
      },
    }),
  );
  const rpc = spawn(
    process.execPath,
    [cli, "--mode", "rpc", "--no-session", "--model", "fixture/bootstrap"],
    options,
  );
  const closed = once(rpc, "close");
  const refreshed = Promise.withResolvers<void>();
  let buffer = "";
  let diagnostics = "";
  let notified = false;
  let accepted = false;
  rpc.stderr.setEncoding("utf8");
  rpc.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  rpc.stdout.setEncoding("utf8");
  rpc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event)) {
          if (
            event.type === "extension_ui_request" &&
            event.method === "notify" &&
            event.message === "CLIProxyAPI: 1 models." &&
            event.notifyType === "info"
          )
            notified = true;
          if (event.type === "response" && event.id === "refresh") {
            if (event.success === true) accepted = true;
            else refreshed.reject(new Error("Refresh command failed."));
          }
          if (accepted && notified) refreshed.resolve();
        }
      } catch (error) {
        refreshed.reject(error);
      }
      newline = buffer.indexOf("\n");
    }
  });
  rpc.stdin.write(`${JSON.stringify({ id: "refresh", type: "prompt", message: "/cliproxyapi-refresh" })}\n`);
  try {
    await Promise.race([
      refreshed.promise,
      closed.then(() => {
        throw new Error(`RPC exited before refresh completed: ${diagnostics}`);
      }),
    ]);
  } finally {
    rpc.kill();
    await closed;
  }
  assert.ok(notified, diagnostics);
  assert.ok(!diagnostics.includes("[pi-cliproxyapi]"), diagnostics);
  assert.ok(requests > 0);
  await rm(join(home, "models.json"));
  const afterRefresh = requests;
  const { stdout, stderr } = await run(
    process.execPath,
    [cli, "--offline", "--list-models", PROVIDER_ID],
    options,
  );
  assert.ok(stdout.includes(fixture.id), `${stdout}\n${stderr}`);
  assert.ok(stdout.includes(PROVIDER_ID));
  assert.ok(!stderr.includes("Failed to load extension"));
  assert.equal(requests, afterRefresh);
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    const { DefaultResourceLoader, ModelRuntime, resolveCliModel } = await import(${JSON.stringify(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href)});
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      noExtensions: true, noSkills: true, noContextFiles: true,
      additionalExtensionPaths: [${JSON.stringify(resolve("extensions/index.ts"))}],
    });
    await loader.reload();
    const { errors, runtime: registrations } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(registrations.pendingNativeProviderRegistrations.length, 1);
    const runtime = await ModelRuntime.create();
    for (const { provider } of registrations.pendingNativeProviderRegistrations) runtime.registerNativeProvider(provider);
    assert.equal((await runtime.refresh({ allowNetwork: false })).errors.size, 0);
    for (const suffix of ["", ":high", ":xhigh", ":max"]) {
      const resolved = resolveCliModel({ cliModel: ${JSON.stringify(`${PROVIDER_ID}/${fixture.id}`)} + suffix, modelRuntime: runtime });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.warning, undefined);
      assert.equal(resolved.model.id, ${JSON.stringify(fixture.id)});
      assert.equal(resolved.thinkingLevel, suffix ? suffix.slice(1) : undefined);
    }
  `,
    ],
    options,
  );
  for (const level of [undefined, "high", "xhigh", "max"] as const) {
    seenBody = undefined;
    const pending = run(
      process.execPath,
      [
        cli,
        "--offline",
        "--no-extensions",
        "-e",
        resolve("extensions/index.ts"),
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-context-files",
        "--model",
        `${PROVIDER_ID}/${fixture.id}${level ? `:${level}` : ""}`,
        "-p",
        "Return ok.",
      ],
      options,
    );
    pending.child.stdin?.end();
    await pending.then(({ stdout, stderr }) => assert.equal(stdout.trim(), "ok", stderr));
    assert.ok(isRecord(seenBody));
    assert.equal(seenBody.model, fixture.id);
    if (level) {
      assert.ok(isRecord(seenBody.thinking));
      assert.equal(seenBody.thinking.type, "adaptive");
      assert.ok(isRecord(seenBody.output_config));
      assert.equal(seenBody.output_config.effort, level);
    }
  }
  assert.equal(requests, afterRefresh);
});

test("catalog preserves separate backend IDs, canonical aliases and exact alias precedence without owner routing guesses", () => {
  const ids = known.flatMap(({ id }) => [id, `vertex/${id}`, `antigravity/${id}`]);
  const config = parseConfig({
    aliases: {
      "team-chat": "anthropic/claude-fixture",
      "vertex/team-chat": "google/gemini-fixture",
      "custom/chat": "anthropic/claude-fixture",
    },
  });
  const data = [
    ...ids,
    "vertex/team-chat",
    "antigravity/team-chat",
    "custom/chat",
    "custom/gemini-fixture",
    "vertex/custom/gemini-fixture",
    "vertex/future",
    "Vertex/gemini-fixture",
  ];
  const mapped = mapCatalog(
    { data: [...data, ids[0]].map((id) => ({ id, owned_by: "google" })) },
    config,
    known,
  );
  assert.deepEqual(
    mapped.models.map((model) => model.id),
    data.slice(0, -4),
  );
  for (const model of mapped.models) {
    assert.match(
      model.name,
      model.id.startsWith("vertex/")
        ? / · Vertex$/
        : model.id.startsWith("antigravity/")
          ? / · Antigravity$/
          : model.id.includes("/")
            ? / · Unknown backend$/
            : / · Automatic \(proxy routing\)$/,
    );
  }
  assert.equal(mapped.models.find((model) => model.id === "vertex/team-chat")?.api, "google-generative-ai");
  assert.equal(
    mapped.models.find((model) => model.id === "antigravity/team-chat")?.api,
    "anthropic-messages",
  );
  const ambiguous = [...known, { ...known[0], name: "Duplicate metadata" }];
  assert.deepEqual(mapCatalog({ data: [{ id: "antigravity/team-chat" }] }, config, ambiguous).models, []);
});

test("qualified chat IDs restore in the native registry and resolve exact CLI thinking references", async (t) => {
  const ids = [known[0].id, `vertex/${known[0].id}`, `antigravity/${known[0].id}`];
  let gets = 0;
  const baseUrl = await server(t, (_req, res) => {
    gets++;
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  const first = await collection(baseUrl);
  await first.models.refresh();
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStore: first.store });
  runtime.registerNativeProvider(createCliproxyProvider(parseConfig({ baseUrl }), known));
  await runtime.refresh({ allowNetwork: false });
  for (const id of ids) {
    const resolved = resolveCliModel({ cliModel: `${PROVIDER_ID}/${id}:high`, modelRuntime: runtime });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.model?.id, id);
    assert.equal(resolved.thinkingLevel, "high");
  }
  assert.equal(gets, 1);
});

test("qualified Gemini adapters retain thinking, tool IDs, strict sampling, image turns and route-isolated signatures", async (t) => {
  const ids = [
    "gemini-2.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
  ];
  const sources = builtinCatalog().filter((model) => model.provider === "google" && ids.includes(model.id));
  assert.equal(sources.length, ids.length);
  const baseUrl = await server(t, (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      assert.equal(JSON.parse(body).generationConfig.temperature, 0.25);
      respond(res, "google-generative-ai");
    });
  });
  const provider = createCliproxyProvider(parseConfig({ baseUrl }), sources);
  for (const source of sources) {
    const signature = "c2lnbmF0dXJl";
    const history = (id: string): Context => ({
      systemPrompt: "fixture-system",
      messages: [
        { role: "user", content: "fixture", timestamp: 0 },
        {
          role: "assistant",
          api: "google-generative-ai",
          provider: PROVIDER_ID,
          model: id,
          content: [
            { type: "thinking", thinking: "fixture thought", thinkingSignature: signature },
            { type: "toolCall", id: "call_1", name: "fixture", arguments: {}, thoughtSignature: signature },
          ],
          stopReason: "toolUse",
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        } satisfies AssistantMessage,
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "fixture",
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          isError: false,
          timestamp: 0,
        },
      ],
      tools: [
        {
          name: "fixture",
          description: "fixture",
          parameters: Type.Object({}),
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        },
      ],
    });
    let baseline: unknown;
    const run = async (id: string, context: Context, inspect: (payload: Record<string, unknown>) => void) => {
      const model = mapCatalog({ data: [{ id }] }, parseConfig({ baseUrl }), sources).models[0];
      assert.ok(model);
      const before = structuredClone(context);
      const stream = provider.streamSimple(model, normalizeContext(context), {
        apiKey: key,
        headers: { Authorization: `Bearer ${key}` },
        reasoning: "high",
        maxRetries: 0,
        signal: AbortSignal.timeout(5000),
        onPayload(payload, hookModel) {
          assert.equal(hookModel.id, id);
          assert.ok(isRecord(payload));
          assert.equal(payload.model, id);
          assert.ok(isRecord(payload.config));
          assert.equal(payload.config.systemInstruction, "fixture-system");
          inspect(payload);
          return { ...payload, config: { ...(payload.config as object), temperature: 0.25 } };
        },
      });
      for await (const event of stream) {
        const message =
          event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
        assert.equal(message.model, id);
      }
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.deepEqual(context, before);
    };
    await run(source.id, history(source.id), ({ model: _model, ...payload }) => {
      baseline = JSON.parse(JSON.stringify(payload));
    });
    for (const prefix of ["vertex", "antigravity"]) {
      const id = `${prefix}/${source.id}`;
      await run(id, history(id), ({ model: _model, ...payload }) => {
        assert.deepEqual(JSON.parse(JSON.stringify(payload)), baseline);
        assert.ok(JSON.stringify(payload).includes(signature));
        if (source.id.startsWith("gemini-3")) {
          assert.match(JSON.stringify(payload), /"id":"call_1"/);
          assert.match(JSON.stringify(payload), /VALIDATED/);
        }
        if (source.id.startsWith("gemini-2")) assert.match(JSON.stringify(payload), /Tool result image:/);
      });
      for (const previous of [source.id, `${prefix === "vertex" ? "antigravity" : "vertex"}/${source.id}`]) {
        await run(id, history(previous), (payload) =>
          assert.ok(!JSON.stringify(payload).includes(signature)),
        );
      }
    }
  }
});

test("previous-policy caches cannot restore GPT-image chat aliases", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Offline restoration must not contact the proxy"));
  for (const id of [
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5",
  ]) {
    const config = parseConfig({ aliases: { [id]: "openai/gpt-fixture" } });
    const provider = createCliproxyProvider(config, known);
    await provider.refreshModels({
      allowNetwork: false,
      signal: AbortSignal.timeout(5000),
      stored: {
        etag: createHash("sha256")
          .update(JSON.stringify([2, config]))
          .digest("hex"),
        models: [{ ...known[1], id, provider: PROVIDER_ID, headers: undefined }],
      },
      async publish(publication) {
        publication.update?.();
        return true;
      },
    });
    assert.deepEqual(provider.getModels(), []);
  }
});
