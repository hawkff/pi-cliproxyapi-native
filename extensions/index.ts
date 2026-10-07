import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, parseConfig } from "../src/config.ts";
import { registerMediaTools } from "../src/media.ts";
import { registerModelPicker } from "../src/picker.ts";
import { createCliproxyProvider } from "../src/provider.ts";

export default async function (pi: ExtensionAPI) {
  let contents = "{}";
  try {
    contents = await readFile(join(getAgentDir(), "pi-cliproxyapi.json"), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("Cannot read pi-cliproxyapi.json.");
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new Error("pi-cliproxyapi.json must contain valid JSON.");
  }
  const config = parseConfig(raw, process.env.CLIPROXYAPI_BASE_URL);
  let context: ExtensionContext | undefined;
  const waits = new Map<symbol, number>();
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  pi.on("session_shutdown", () => {
    context?.ui.setStatus("cliproxyapi-quota", undefined);
    context = undefined;
    waits.clear();
  });
  pi.registerProvider(
    createCliproxyProvider(config, undefined, (id, seconds) => {
      if (!context) return;
      if (seconds === undefined) waits.delete(id);
      else {
        if (!waits.has(id)) {
          const message = `CLIProxyAPI quota limit. Retrying at ${new Date(Date.now() + seconds * 1000).toLocaleString()}. Cancel the current request to stop waiting.`;
          if (context.mode === "print" || context.mode === "json") process.stderr.write(`${message}\n`);
          else context.ui.notify(message, "warning");
        }
        waits.set(id, seconds);
      }
      const remaining = Math.min(...waits.values());
      context.ui.setStatus(
        "cliproxyapi-quota",
        waits.size
          ? `CLIProxyAPI quota: retry in ${Math.floor(remaining / 3600)}h ${Math.floor(remaining / 60) % 60}m ${remaining % 60}s`
          : undefined,
      );
    }),
  );
  registerMediaTools(pi, config);
  registerModelPicker(pi, config);
  pi.registerCommand("cliproxyapi-refresh", {
    description: "Refresh the CLIProxyAPI model catalog",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
        return;
      }
      if (ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured === false) {
        ctx.ui.notify("Use /login cliproxyapi or set CLIPROXYAPI_API_KEY before refreshing.", "warning");
        return;
      }
      const result = await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        signal: AbortSignal.timeout(15000),
      });
      const error = result.errors.get(PROVIDER_ID);
      if (error || result.aborted) {
        ctx.ui.notify(error?.message ?? "CLIProxyAPI refresh timed out.", "error");
        return;
      }
      const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
      ctx.ui.notify(`CLIProxyAPI: ${count} models.`, "info");
    },
  });
}
