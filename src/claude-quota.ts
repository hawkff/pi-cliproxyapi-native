import { setTimeout as sleep } from "node:timers/promises";
import { type Config, isRecord } from "./config.ts";

export type QuotaWaitHandler = (id: symbol, remainingSeconds: number | undefined) => void;

const WEEK_MS = 7 * 86400000;

async function managementRequest(
  config: Config,
  key: string,
  path: string,
  signal: AbortSignal,
  body?: object,
) {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v0/management/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error("The live quota request could not complete.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Management API authentication or access was rejected. Check its key and access settings."
        : "The management API is unavailable. Waiting stopped.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The management API returned an empty response.");
  try {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Response too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    throw new Error("The live quota response is invalid, incomplete, or larger than 2 MiB.");
  } finally {
    reader.releaseLock();
  }
}

export function claudeQuotaState(
  payload: unknown,
  modelId: string,
  now = Date.now(),
  serverNow = now,
  requestRejected = false,
) {
  if (!isRecord(payload) || !("five_hour" in payload) || !("seven_day" in payload)) {
    throw new Error("Claude did not report both five-hour and seven-day quota windows.");
  }
  const family = ["opus", "sonnet", "fable"].find((name) => modelId.toLowerCase().includes(name));
  const keys = ["five_hour", "seven_day", "seven_day_oauth_apps"];
  if (family) keys.push(family === "fable" ? "iguana_necktie" : `seven_day_${family}`);
  const windows = keys.map((key) => ({ value: payload[key], weekly: key !== "five_hour" }));
  if (family === "fable" && Array.isArray(payload.limits)) {
    const scoped = payload.limits.filter((limit: unknown) => {
      if (!isRecord(limit) || limit.kind !== "weekly_scoped" || limit.is_active === false) return false;
      const model = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model : undefined;
      return (
        typeof model?.display_name === "string" &&
        ["fable", "fable 5"].includes(model.display_name.trim().toLowerCase())
      );
    });
    const limit: unknown =
      scoped.find((limit: unknown) => isRecord(limit) && limit.is_active === true) ?? scoped[0];
    if (isRecord(limit)) {
      windows.pop();
      windows.push({ value: { utilization: limit.percent, resets_at: limit.resets_at }, weekly: true });
    }
  }
  const blocked: { retryAt: number; resetAt: number; weekly: boolean }[] = [];
  for (const { value, weekly } of windows) {
    if (value === undefined || value === null) continue;
    if (
      !isRecord(value) ||
      typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) ||
      value.utilization < 0 ||
      value.utilization > 100
    ) {
      throw new Error("Claude returned an invalid quota window.");
    }
    // A rejected request can need more tokens than the unused part of the five-hour allowance.
    if (value.utilization < 100 && (weekly || !requestRejected || value.utilization === 0)) continue;
    const resetAt =
      typeof value.resets_at === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value.resets_at)
        ? Date.parse(value.resets_at)
        : NaN;
    const delay = resetAt - serverNow;
    if (!Number.isFinite(delay) || delay <= 0 || delay > WEEK_MS) {
      throw new Error("Claude still reports exhausted quota without a valid future reset. Waiting stopped.");
    }
    blocked.push({ resetAt, retryAt: now + delay + 1000, weekly });
  }
  if (!blocked.length) return { state: "ready" as const };
  const latest = blocked.reduce((a, b) => (a.retryAt > b.retryAt ? a : b));
  const weekly = blocked.filter((window) => window.weekly);
  return {
    state: "blocked" as const,
    retryAt: latest.retryAt,
    resetAt: latest.resetAt,
    weeklyResetAt: weekly.length ? Math.max(...weekly.map((window) => window.resetAt)) : undefined,
  };
}

export async function fetchClaudeQuota(
  config: Config,
  key: string,
  modelId: string,
  signal?: AbortSignal,
  requestRejected = false,
) {
  if (!/^[!-~]{1,4096}$/.test(key)) {
    throw new Error(
      "Set CLIPROXYAPI_MANAGEMENT_KEY to read live Claude quota. The chat API key is not a management key.",
    );
  }
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  const listing = await managementRequest(config, key, "auth-files", bounded);
  if (!isRecord(listing) || !Array.isArray(listing.files) || listing.files.length > 10000) {
    throw new Error("The management API returned an invalid account list.");
  }
  const accounts = listing.files.filter(
    (file: unknown) =>
      isRecord(file) &&
      (file.provider ?? file.type) === "claude" &&
      file.disabled !== true &&
      file.status !== "disabled" &&
      file.account_type !== "api_key",
  );
  if (!accounts.length) throw new Error("No supported active Claude subscription account was found.");
  // ponytail: probe at most 100 accounts; batch larger pools before raising this limit.
  if (accounts.length > 100)
    throw new Error("Live quota lookup supports at most 100 active Claude accounts.");
  const reference = config.aliases[modelId] ?? modelId;
  const results = await Promise.allSettled(
    accounts.map(async (account: unknown) => {
      if (
        !isRecord(account) ||
        typeof account.auth_index !== "string" ||
        !account.auth_index ||
        typeof account.name !== "string" ||
        !account.name
      ) {
        throw new Error("A Claude account is missing its quota lookup identifier.");
      }
      const models = await managementRequest(
        config,
        key,
        `auth-files/models?name=${encodeURIComponent(account.name)}`,
        bounded,
      );
      if (!isRecord(models) || !Array.isArray(models.models))
        throw new Error("The management API returned an invalid account catalog.");
      if (!models.models.some((model: unknown) => isRecord(model) && model.id === modelId)) return undefined;
      const response = await managementRequest(config, key, "api-call", bounded, {
        auth_index: account.auth_index,
        method: "GET",
        url: "https://api.anthropic.com/api/oauth/usage",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.280 (external, cli)",
        },
      });
      if (!isRecord(response) || typeof response.status_code !== "number")
        throw new Error("The management API returned an invalid quota result.");
      if (response.status_code === 401 || response.status_code === 403) return { state: "rejected" as const };
      if (response.status_code !== 200 || typeof response.body !== "string")
        throw new Error("Claude usage is unavailable. Waiting stopped rather than guessing a reset time.");
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error("Claude returned invalid usage data.");
      }
      const date = isRecord(response.header)
        ? Object.entries(response.header).find(([name]) => name.toLowerCase() === "date")?.[1]
        : undefined;
      const serverNow = Array.isArray(date) && typeof date[0] === "string" ? Date.parse(date[0]) : NaN;
      return claudeQuotaState(
        payload,
        reference,
        Date.now(),
        Number.isFinite(serverNow) ? serverNow : Date.now(),
        requestRejected,
      );
    }),
  );
  const eligible = results.flatMap((result) =>
    result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
  );
  if (!eligible.length) {
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected" && failed.reason instanceof Error) throw failed.reason;
    throw new Error("No active Claude subscription account advertises the selected model.");
  }
  if (eligible.some((result) => result.state === "ready")) return { state: "ready" as const };
  const blocked = eligible.filter((result) => result.state === "blocked");
  if (!blocked.length)
    throw new Error(
      "Claude rejected the account credentials or access. Sign in again or check the account status.",
    );
  const permitted = config.quota.waitForWeeklyReset
    ? blocked
    : blocked.filter((result) => result.weeklyResetAt === undefined);
  if (!permitted.length) {
    const resetAt = Math.min(...blocked.map((result) => result.weeklyResetAt ?? result.resetAt));
    throw new Error(
      `Seven-day quota is exhausted. Earliest weekly reset: ${new Date(resetAt).toISOString()}. Set quota.waitForWeeklyReset to true in pi-cliproxyapi.json to wait for it.`,
    );
  }
  return permitted.reduce((a, b) => (a.retryAt < b.retryAt ? a : b));
}

export async function waitForClaudeQuota(
  config: Config,
  key: string,
  modelId: string,
  deadline: number,
  signal?: AbortSignal,
  onWait?: QuotaWaitHandler,
  remainingInsufficient = false,
) {
  const id = Symbol();
  let retryAt: number | undefined;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const quota = await fetchClaudeQuota(
        config,
        key,
        modelId,
        signal,
        remainingInsufficient && (retryAt === undefined || Date.now() < retryAt),
      );
      signal?.throwIfAborted();
      if (quota.state === "ready") {
        if (retryAt === undefined)
          throw new Error(
            "Live Claude quota is available, but the proxy rejected the request. Check its cooldown state.",
          );
        return;
      }
      if (quota.retryAt > deadline || Date.now() >= deadline)
        throw new Error(
          "The seven-day quota waiting deadline was reached. Start a new request after confirming account access.",
        );
      retryAt = quota.retryAt;
      const refreshAt = Math.min(quota.retryAt, Date.now() + 60000);
      while (Date.now() < refreshAt) {
        signal?.throwIfAborted();
        onWait?.(id, Math.max(0, Math.ceil((quota.retryAt - Date.now()) / 1000)));
        await sleep(Math.min(1000, refreshAt - Date.now()), undefined, { signal });
      }
    }
  } finally {
    onWait?.(id, undefined);
  }
}
