import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type AssistantMessage,
  contentText,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { mapCatalog } from "../src/catalog.ts";
import { withCompactionRecovery } from "../src/compaction.ts";
import { isRecord, parseConfig } from "../src/config.ts";
import { builtinCatalog } from "../src/provider.ts";

const model: Model<"openai-responses"> = {
  id: "gpt-fixture",
  name: "Fixture",
  api: "openai-responses",
  provider: "cliproxyapi",
  baseUrl: "https://proxy.example/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 32768,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Summarize.", timestamp: 0 }] });

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "Complete summary." }],
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      cacheWrite1h: 1,
      reasoning: 3,
      totalTokens: 18,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
    ...overrides,
  };
}

function fixture(responses: AssistantMessage[], onCall?: () => void) {
  const controller = new AbortController();
  const signals = new WeakSet([controller.signal]);
  const calls: SimpleStreamOptions[] = [];
  const stream = withCompactionRecovery((_model, requestContext, options) => {
    assert.equal(requestContext, context);
    calls.push(options ?? {});
    onCall?.();
    const result = responses[calls.length - 1];
    assert.ok(result, "Unexpected extra request");
    const stream = createAssistantMessageEventStream();
    stream.end(result);
    return stream;
  }, signals);
  const options: SimpleStreamOptions = {
    signal: controller.signal,
    maxTokens: 8192,
    reasoning: "max",
    thinkingBudgets: { low: 30000 },
    sessionId: "fixture-routing-id",
    cacheRetention: "none",
    headers: { "x-fixture": "preserved" },
    env: { FIXTURE: "preserved" },
  };
  return { stream, calls, controller, options };
}

test("compaction retries a capped summary once with more output room and lower thinking", async () => {
  const first = response({ stopReason: "length", content: [{ type: "text", text: "Partial" }] });
  const second = response();
  const original = structuredClone([first, second]);
  const { stream, calls, options } = fixture([first, second]);
  const output = stream(model, context, options);
  const events = [];
  for await (const event of output) events.push(event);
  const result = await output.result();
  assert.equal(contentText(result.content), "Complete summary.");
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "done"],
  );
  assert.ok(!JSON.stringify(events).includes("Partial"));
  assert.deepEqual(
    calls.map((call) => call.maxTokens),
    [8192, 16384],
  );
  for (const call of calls) {
    assert.equal(call.reasoning, "low");
    assert.equal(call.thinkingBudgets, undefined);
    assert.equal(call.signal, options.signal);
    assert.equal(call.headers, options.headers);
    assert.equal(call.env, options.env);
    assert.equal(call.sessionId, options.sessionId);
    assert.equal(call.cacheRetention, "none");
  }
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.output, 10);
  assert.equal(result.usage.totalTokens, 36);
  assert.equal(result.usage.cacheWrite1h, 2);
  assert.equal(result.usage.reasoning, 6);
  assert.equal(result.usage.cost.total, 20);
  assert.deepEqual([first, second], original);
  assert.equal(options.reasoning, "max");
  assert.equal(options.maxTokens, 8192);
});

test("ordinary requests keep their options, result, and retry behavior", async () => {
  const original = response({ stopReason: "length" });
  const { stream, calls, options } = fixture([original]);
  const ordinary = { ...options, signal: new AbortController().signal };
  assert.equal(await stream(model, context, ordinary).result(), original);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], ordinary);
});

test("output retries stay within the model ceiling and stop after one retry", async () => {
  for (const maxTokens of [8192, 12000, 32768]) {
    const { stream, calls, options } = fixture([
      response({ stopReason: "length" }),
      response({ stopReason: "length" }),
    ]);
    const result = await stream({ ...model, maxTokens }, context, options).result();
    assert.equal(result.stopReason, "length");
    assert.equal(calls.length, maxTokens === 8192 ? 1 : 2);
    assert.ok(calls.every((call) => call.maxTokens !== undefined && call.maxTokens <= maxTokens));
  }
});

test("empty and thinking-only summaries get one retry and cannot become checkpoints", async () => {
  for (const content of [
    [],
    [{ type: "text", text: " \n" }],
    [{ type: "thinking", thinking: "Thinking" }],
  ] as const) {
    for (const recover of [false, true]) {
      const empty = response({ content: [...content] });
      const { stream, calls, options } = fixture([empty, recover ? response() : empty]);
      const result = await stream(model, context, options).result();
      assert.equal(result.stopReason, recover ? "stop" : "error");
      assert.equal(calls.length, 2);
      if (!recover) assert.match(result.errorMessage ?? "", /complete text summary/);
    }
  }
});

test("aborts, tool calls, and provider errors do not trigger output retries", async () => {
  for (const failure of [
    response({ stopReason: "error", errorMessage: "401 Unauthorized" }),
    response({ stopReason: "error", errorMessage: "context_length_exceeded" }),
    response({ stopReason: "error", errorMessage: "terminated" }),
    response({ stopReason: "aborted", content: [] }),
    response({ stopReason: "deferred", content: [] }),
    response({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
    }),
  ]) {
    const { stream, calls, options } = fixture([failure]);
    const result = await stream(model, context, options).result();
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, "error");
    if (failure.stopReason === "error") assert.equal(result.errorMessage, failure.errorMessage);
  }
  let abort = () => {};
  const { stream, calls, options, controller } = fixture([response({ stopReason: "length" })], () => abort());
  abort = () => controller.abort();
  const result = await stream(model, context, options).result();
  assert.equal(calls.length, 1);
  assert.equal(result.stopReason, "aborted");
});

for (const mode of ["manual", "threshold", "split", "exhausted", "empty", "transient"] as const)
  test(`Pi preserves native compaction behavior: ${mode}`, {
    timeout: 30000,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "picpa-compaction-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: directory,
      CLIPROXYAPI_BASE_URL: "http://localhost:8317",
    })) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const source = builtinCatalog().find(
      (entry) => entry.provider === "openai" && entry.reasoning && entry.maxTokens > 32768,
    );
    assert.ok(source);
    const selected = mapCatalog({ data: [{ id: source.id }] }, parseConfig({}), [source]).models[0];
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("cliproxyapi", async () => ({ type: "api_key", key: "fixture-key" }));
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      credentials,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      extensionFactories: [extension],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(String(input), "http://localhost:8317/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(isRecord(body));
      bodies.push(body);
      if (mode === "transient" && bodies.length === 1)
        return Response.json({ error: { message: "server_busy" } }, { status: 503 });
      const capped = mode === "exhausted" || (bodies.length === 1 && mode !== "empty");
      const text = mode === "empty" ? "" : capped ? "Partial" : "Checkpoint";
      const item = {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const events = [
        { type: "response.created", response: { id: "resp_fixture" } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: capped ? "response.incomplete" : "response.completed",
          response: {
            id: "resp_fixture",
            status: capped ? "incomplete" : "completed",
            output: [item],
            incomplete_details: capped ? { reason: "max_output_tokens" } : undefined,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const sessionManager = SessionManager.inMemory(directory);
    sessionManager.appendMessage({ role: "user", content: "Earlier task", timestamp: 0 });
    sessionManager.appendMessage(
      response({
        usage: { ...response().usage, input: selected.contextWindow, totalTokens: selected.contextWindow },
      }),
    );
    sessionManager.appendMessage({ role: "user", content: "Keep this recent task", timestamp: 1 });
    if (mode === "split") sessionManager.appendMessage(response());
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: selected,
      thinkingLevel: "high",
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
        retry: { enabled: mode === "transient", maxRetries: 1, baseDelayMs: 0, provider: { maxRetries: 0 } },
      }),
      sessionManager,
      resourceLoader,
      tools: [],
    });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    if (mode === "exhausted" || mode === "empty") {
      await assert.rejects(session.compact(), mode === "exhausted" ? /token cap/ : /complete text summary/);
      assert.equal(bodies.length, 2);
      assert.ok(!sessionManager.getEntries().some((entry) => entry.type === "compaction"));
      assert.equal(sessionManager.buildSessionContext().messages.length, 3);
      return;
    }
    if (mode === "threshold") await session.prompt("Continue.");
    else {
      const result = await session.compact("Preserve file paths.");
      assert.ok(result.summary.includes("Checkpoint"));
      assert.ok(JSON.stringify(bodies[0]).includes("Preserve file paths."));
    }
    const checkpoint = sessionManager.getEntries().find((entry) => entry.type === "compaction");
    assert.ok(checkpoint && checkpoint.type === "compaction");
    assert.equal(checkpoint.fromHook, false);
    assert.equal(checkpoint.usage?.totalTokens, mode === "split" ? 45 : mode === "transient" ? 15 : 30);
    const summaries = mode === "threshold" ? bodies.slice(0, -1) : bodies;
    assert.deepEqual(
      summaries.map((body) => body.max_output_tokens),
      mode === "split" ? [13107, 26214, 8192] : mode === "transient" ? [13107, 13107] : [13107, 26214],
    );
    assert.ok(summaries.every((body) => isRecord(body.reasoning) && body.reasoning.effort === "low"));
    assert.equal(session.thinkingLevel, "high");
    if (mode === "threshold") {
      assert.equal(bodies.length, 3);
      assert.deepEqual(bodies.at(-1)?.reasoning, { effort: "high", summary: "auto" });
    } else if (mode !== "split") {
      assert.equal(sessionManager.buildSessionContext().messages.at(-1)?.role, "user");
    }
  });
