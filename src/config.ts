export const PROVIDER_ID = "cliproxyapi";
export const DEFAULT_BASE_URL = "http://localhost:8317";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[!-~]{1,256}$/.test(value);
}

export function normalizeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLIProxyAPI baseUrl must be an absolute HTTP(S) URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CLIProxyAPI requires HTTPS except on loopback addresses.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CLIProxyAPI baseUrl must not contain credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:v1|v1beta)$/, "");
  return url.href.replace(/\/+$/, "");
}

export function parseConfig(value: unknown, baseUrlOverride?: string) {
  if (!isRecord(value) || Object.keys(value).some((key) => !["baseUrl", "aliases", "quota"].includes(key))) {
    throw new Error("pi-cliproxyapi.json accepts only baseUrl, aliases, and quota.");
  }
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    throw new Error("CLIProxyAPI baseUrl must be a string.");
  }
  const quota = value.quota === undefined ? {} : value.quota;
  if (
    !isRecord(quota) ||
    Object.keys(quota).some((key) => key !== "waitForWeeklyReset") ||
    (quota.waitForWeeklyReset !== undefined && typeof quota.waitForWeeklyReset !== "boolean")
  ) {
    throw new Error("CLIProxyAPI quota accepts only a boolean waitForWeeklyReset.");
  }
  const rawAliases = value.aliases === undefined ? {} : value.aliases;
  if (!isRecord(rawAliases)) throw new Error("CLIProxyAPI aliases must be an object.");
  const aliases = Object.fromEntries(
    Object.entries(rawAliases).map(([id, reference]) => {
      if (!isModelId(id) || typeof reference !== "string") {
        throw new Error("CLIProxyAPI aliases must map model IDs to provider/model references.");
      }
      const separator = reference.indexOf("/");
      const provider = reference.slice(0, separator);
      if (
        separator < 1 ||
        !isModelId(reference.slice(separator + 1)) ||
        !["anthropic", "openai", "openai-codex", "google"].includes(provider)
      ) {
        throw new Error(
          "CLIProxyAPI aliases require an anthropic, openai, openai-codex, or google reference.",
        );
      }
      return [id, reference] as const;
    }),
  );
  return {
    baseUrl: normalizeBaseUrl(baseUrlOverride ?? value.baseUrl ?? DEFAULT_BASE_URL),
    aliases,
    quota: { waitForWeeklyReset: quota.waitForWeeklyReset ?? false },
  };
}

export type Config = ReturnType<typeof parseConfig>;
