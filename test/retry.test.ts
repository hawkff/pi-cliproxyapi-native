import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { builtinCatalog } from "../src/provider.ts";
import { registerAutoRetry } from "../src/retry.ts";

const delay = 10 * 60 * 1000;

function response(provider = "cliproxyapi", stopReason: AssistantMessage["stopReason"] = "error") {
  return {
    role: "assistant",
    api: "openai-responses",
    provider,
    model: "fixture-model",
    content: [],
    stopReason,
    errorMessage: stopReason === "error" ? "503 auth_unavailable: PROTOCOL_ERROR" : undefined,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } satisfies AssistantMessage;
}

async function fixture(t: TestContext, mode: ExtensionContext["mode"] = "tui") {
  const directory = await mkdtemp(join(tmpdir(), "picpa-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [registerAutoRetry],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const send = t.mock.fn();
  loaded.runtime.sendMessage = send;
  const command = extension.commands.get("auto-retry");
  assert.ok(command);
  const sessionManager = SessionManager.inMemory(directory);
  let terminalInput: Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0] | undefined;
  const status = t.mock.fn();
  const ctx = {
    mode,
    sessionManager,
    ui: {
      setStatus: status,
      notify: t.mock.fn(),
      onTerminalInput: (handler: typeof terminalInput) => {
        terminalInput = handler;
        return () => {
          terminalInput = undefined;
        };
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  async function emit(event: { type: string } & Record<string, unknown>) {
    for (const handler of extension.handlers.get(event.type) ?? []) await handler(event, ctx);
  }
  t.after(() => emit({ type: "session_shutdown", reason: "quit" }));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  async function fail(provider = "cliproxyapi", errorMessage?: string) {
    await emit({ type: "agent_start" });
    await emit({
      type: "agent_end",
      messages: [{ ...response(provider), ...(errorMessage ? { errorMessage } : {}) }],
    });
    await emit({ type: "agent_settled", aborted: false });
  }
  return {
    ctx,
    emit,
    fail,
    send,
    status,
    key: (data: string) => terminalInput?.(data),
    hasInputListener: () => terminalInput !== undefined,
    command: (args: string) => command.handler(args, ctx as unknown as Parameters<typeof command.handler>[1]),
  };
}

for (const provider of ["cliproxyapi", "openai", "anthropic", "google", "custom-provider"])
  test(`retries ${provider} only after ten minutes, then repeats until success`, async (t) => {
    const f = await fixture(t);
    await f.fail(provider);
    assert.match(f.status.mock.calls.at(-1)?.arguments[1] ?? "", /Auto-retry at/);
    t.mock.timers.tick(delay - 1);
    assert.equal(f.send.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(f.send.mock.callCount(), 1);
    assert.deepEqual(f.send.mock.calls[0].arguments[1], { triggerTurn: true });
    assert.equal(f.send.mock.calls[0].arguments[0].customType, "auto-retry");
    assert.equal(f.status.mock.calls.at(-1)?.arguments[1], undefined);
    assert.equal(f.hasInputListener(), false);
    await f.fail(provider);
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 2);
    await f.emit({ type: "agent_start" });
    await f.emit({ type: "agent_end", messages: [response(provider, "stop")] });
    await f.emit({ type: "agent_settled", aborted: false });
    t.mock.timers.tick(delay * 2);
    assert.equal(f.send.mock.callCount(), 2);
  });

for (const error of [
  "401 Unauthorized",
  "429 rate limit",
  "503 auth_unavailable",
  "Connection reset",
  "Unknown failure",
])
  test(`does not depend on an error-message allowlist: ${error}`, async (t) => {
    const f = await fixture(t);
    await f.fail("custom-provider", error);
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 1);
  });

test("waits for built-in retries and queued continuations to settle", async (t) => {
  const f = await fixture(t);
  await f.emit({ type: "agent_end", messages: [response()] });
  t.mock.timers.tick(delay * 2);
  assert.equal(f.send.mock.callCount(), 0);
  await f.emit({ type: "agent_start" });
  await f.emit({ type: "agent_end", messages: [response("cliproxyapi", "stop")] });
  await f.emit({ type: "agent_settled", aborted: false });
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 0);
});

for (const messages of [
  [],
  [response("openai", "aborted")],
  [response("openai", "stop")],
  [{ role: "toolResult", isError: true }],
])
  test(`ignores completed, aborted, empty, and tool-only runs: ${JSON.stringify(messages)}`, async (t) => {
    const f = await fixture(t);
    await f.emit({ type: "agent_end", messages });
    await f.emit({ type: "agent_settled", aborted: false });
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 0);
  });

test("does not resume when cancellation interrupted the built-in retry wait", async (t) => {
  const f = await fixture(t);
  await f.emit({ type: "agent_end", messages: [response()] });
  await f.emit({ type: "agent_settled", aborted: true });
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 0);
});

for (const type of [
  "input",
  "before_agent_start",
  "agent_start",
  "model_select",
  "user_bash",
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_start",
  "session_shutdown",
  "session_before_compact",
])
  test(`cancels a pending retry on ${type}`, async (t) => {
    const f = await fixture(t);
    await f.fail();
    await f.emit({ type, reason: "manual" });
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 0);
    assert.equal(f.hasInputListener(), false);
    assert.equal(f.status.mock.calls.at(-1)?.arguments[1], undefined);
  });

for (const key of ["\u001b", "\u0003"])
  test(`cancels on terminal abort input ${JSON.stringify(key)} without consuming it`, async (t) => {
    const f = await fixture(t);
    await f.fail();
    assert.equal(f.key(key), undefined);
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 0);
    assert.equal(f.hasInputListener(), false);
  });

test("off cancels and suppresses retries; on enables future failures; invalid arguments preserve state", async (t) => {
  const f = await fixture(t);
  await f.fail();
  await f.command("");
  assert.equal(f.ctx.ui.notify.mock.calls.at(-1)?.arguments[0], "Auto-retry is on. A retry is pending.");
  await f.command("invalid");
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 1);
  await f.fail();
  await f.command("off");
  t.mock.timers.tick(delay);
  await f.fail();
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 1);
  await f.command("on");
  await f.fail();
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 2);
});

for (const change of ["busy", "queued", "branch", "session"])
  test(`does not send stale work if ${change} changes before the timer fires`, async (t) => {
    const f = await fixture(t);
    await f.fail();
    if (change === "busy") f.ctx.isIdle = () => false;
    if (change === "queued") f.ctx.hasPendingMessages = () => true;
    if (change === "branch")
      f.ctx.sessionManager.appendMessage({ role: "user", content: "New work", timestamp: 1 });
    if (change === "session") f.ctx.sessionManager.newSession();
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 0);
  });

test("works in RPC mode without terminal listeners", async (t) => {
  const f = await fixture(t, "rpc");
  await f.fail();
  assert.equal(f.hasInputListener(), false);
  t.mock.timers.tick(delay);
  assert.equal(f.send.mock.callCount(), 1);
});

for (const mode of ["print", "json"] as const)
  test(`does not promise a delayed retry in one-shot ${mode} mode`, async (t) => {
    const f = await fixture(t, mode);
    await f.fail();
    t.mock.timers.tick(delay);
    assert.equal(f.send.mock.callCount(), 0);
    assert.equal(f.status.mock.callCount(), 0);
    assert.equal(f.ctx.ui.notify.mock.callCount(), 0);
  });

test("Pi exhausts native retries before delayed continuations and preserves the original task", {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "picpa-retry-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = builtinCatalog().find((model) => model.provider === "anthropic");
  assert.ok(model);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fixture-key" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [registerAutoRetry],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime: runtime,
    model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(directory),
    tools: [],
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    }),
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  t.mock.method(globalThis, "fetch", () => assert.fail("Retry must not make real network requests"));
  let requests = 0;
  session.agent.streamFunction = (_model, context) => {
    requests++;
    assert.ok(JSON.stringify(context.messages).includes("Original task"));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      ...response(model.provider, requests < 5 ? "error" : "stop"),
      api: model.api,
      model: model.id,
    };
    if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  const timeouts: number[] = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
    if (ms === delay) timeouts.push(requests);
    return originalTimeout(callback, ms === delay ? 1 : ms);
  });
  const completed = new Promise<void>((resolve) => {
    session.subscribe((event) => {
      if (event.type === "agent_settled" && requests === 5) resolve();
    });
  });
  await session.prompt("Original task");
  await completed;
  assert.deepEqual(timeouts, [2, 4]);
  assert.equal(requests, 5);
  assert.equal(
    session.messages.filter((message) => message.role === "custom" && message.customType === "auto-retry")
      .length,
    2,
  );
  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
});
