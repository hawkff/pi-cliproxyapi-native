import { contentText, lazyStream, type ProviderStreams } from "@earendil-works/pi-ai";

export function withCompactionRecovery(
  stream: ProviderStreams["streamSimple"],
  signals: WeakSet<AbortSignal>,
): ProviderStreams["streamSimple"] {
  return (model, context, options) => {
    if (!options?.signal || !signals.has(options.signal)) return stream(model, context, options);
    const signal = options.signal;
    return lazyStream(model, async () => ({
      async *[Symbol.asyncIterator]() {
        const limit = model.maxTokens > 0 ? model.maxTokens : 32768;
        let maxTokens = Math.max(1, Math.min(options.maxTokens ?? 16384, limit));
        const reasoning =
          options.reasoning && !["minimal", "low"].includes(options.reasoning) ? "low" : options.reasoning;
        const run = () =>
          stream(model, context, {
            ...options,
            maxTokens,
            reasoning,
            // Chat-specific thinking budgets must not consume the summary's output allowance.
            thinkingBudgets: undefined,
          }).result();
        let response = await run();
        const retryTokens = Math.min(Math.max(maxTokens * 2, 16384), limit);
        const empty = response.stopReason === "stop" && !contentText(response.content).trim();
        if (
          !signal.aborted &&
          !response.content.some((block) => block.type === "toolCall") &&
          ((response.stopReason === "length" && retryTokens > maxTokens) || empty)
        ) {
          maxTokens = retryTokens;
          const previous = response.usage;
          response = await run();
          response = { ...response, usage: structuredClone(response.usage) };
          for (const key of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "cacheWrite1h",
            "reasoning",
            "totalTokens",
          ] as const) {
            if (previous[key] !== undefined) response.usage[key] = (response.usage[key] ?? 0) + previous[key];
          }
          for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
            response.usage.cost[key] += previous.cost[key];
        }
        if (signal.aborted) {
          yield {
            type: "error",
            reason: "aborted",
            error: { ...response, stopReason: "aborted", errorMessage: "Compaction was aborted." },
          };
          return;
        }
        if (
          response.content.some((block) => block.type === "toolCall") ||
          !["stop", "length", "error"].includes(response.stopReason) ||
          (response.stopReason === "stop" && !contentText(response.content).trim())
        ) {
          response = {
            ...response,
            stopReason: "error",
            errorMessage: "CLIProxyAPI compaction did not return a complete text summary.",
          };
        }
        if (response.stopReason === "stop" || response.stopReason === "length") {
          yield { type: "start", partial: { ...response, content: [], stopReason: "pending" } };
          yield { type: "done", reason: response.stopReason, message: response };
        } else {
          yield { type: "error", reason: "error", error: response };
        }
      },
    }));
  };
}
