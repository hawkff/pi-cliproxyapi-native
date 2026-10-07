# Pi CLIProxyAPI Native

Use [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for chat, image generation, and video generation in [Pi](https://pi.dev).

Chat uses Pi's native API adapters and model metadata, with availability from your proxy. Image and video tools have separate model selections, so you can generate media without switching your chat model.

## Install

This release targets Pi 1.0.4 and CLIProxyAPI 8.0.18, with Node.js 22.19 or newer. Run CLIProxyAPI with your upstream accounts configured before connecting Pi. The extension uses Pi's host-provided packages, adds no runtime dependencies, and needs no compilation.

If you installed `pi-cliproxy-native`, remove it before installing the renamed package. Both register the same `cliproxyapi` provider.

```sh
pi install npm:pi-cliproxyapi-native@0.1.5
```

For Git installation, use `pi install git:github.com/hawkff/pi-cliproxyapi-native@v0.1.5`. For a local checkout, use `pi install /path/to/pi-cliproxyapi-native`.

The default proxy address is `http://localhost:8317`. For another address, set the [connection](#connection) before logging in. Restart Pi, then run:

```text
/login cliproxyapi
/cliproxyapi-refresh
/model
```

Enter your CLIProxyAPI client key at login. Pi validates it against the proxy before saving it. Upstream account authentication stays in CLIProxyAPI.

**Use Pi's built-in `/model` picker for chat.** Choose a `cliproxyapi/` entry there. This extension's `/cli:model` picker is only for CLIProxyAPI image and video models. Selecting a media model does not change chat or generate anything.

Enable only one extension that registers the `cliproxyapi` provider ID. This extension leaves other providers and their hand-written model lists unchanged.

## Connection

Set `CLIPROXYAPI_BASE_URL` or create `~/.pi/agent/pi-cliproxyapi.json`:

```json
{
  "baseUrl": "http://localhost:8317"
}
```

| Setting | Behavior |
| --- | --- |
| `CLIPROXYAPI_BASE_URL` | Overrides `baseUrl` in the configuration file. |
| `CLIPROXYAPI_API_KEY` | Supplies a client key when Pi has no stored login credential. |

Use an absolute URL. Root URLs and URLs ending in `/v1` or `/v1beta` work; the extension preserves path prefixes. Remote endpoints require HTTPS. HTTP works on loopback addresses. URLs cannot contain credentials, query strings, or fragments.

Connection and alias settings are global. Project-local files cannot redirect your proxy key. Run `/reload` after changing these settings.

Pi stores login credentials in its auth store; the extension does not keep another copy. Stored credentials take precedence over `CLIPROXYAPI_API_KEY`. `/logout` removes the stored key but leaves environment variables unchanged.

## Images and videos

### Choose a media model

Open `/cli:model` to search the live image/video catalog, or use its subcommands:

```text
/cli:model search banana
/cli:model list
/cli:model select gemini-2.5-flash-image
/cli:model clear image
/cli:model clear video
```

Search by friendly name, exact ID, backend, owner, or image/video purpose. The picker shows known media models, including disabled entries with a reason. It omits chat models and unknown IDs.

The terminal picker is keyboard-only. Type to search, use the selection keys to move, press Enter to select, or Escape to cancel. It respects custom selection keybindings. Mouse clicks and wheel events do not change selection.

RPC, print, and JSON modes return text instead of opening the picker. Print mode uses stderr, JSON mode emits custom-message events, and RPC sends notifications. Listings show up to 100 matches; narrow larger lists with `search`. Use `select <exact ID>` to choose a model in these modes.

### Generate media

Ask Pi to use the media tools:

```text
List available CLIProxyAPI media models.
Generate an image of a red circle with grok-imagine-image.
Generate a 1-second video of a red circle moving left with grok-imagine-video.
Check video status for request_id <returned-id>.
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `cliproxyapi_media_models` | None | Available image/video IDs, supported output controls, and effective defaults. |
| `cliproxyapi_generate_image` | `prompt`; optional `model`, `size`, `resolution`, `aspect_ratio` | Saved images and paths, plus previews when the chat model supports images. |
| `cliproxyapi_generate_video` | `prompt`; optional `model`, `resolution`, `aspect_ratio`, and integer `duration` from 1 to 15 seconds | A `request_id` for the submitted video. |
| `cliproxyapi_video_status` | `request_id` | One status check: pending, completed with a URL, or failed. |

Pass `model` to choose an exact ID for one tool call. Otherwise, the tool uses its saved `/cli:model` selection. Without either, eligible OpenAI/GPT chats default to `gpt-image-2.5-sunburst` for images. Other chats need an image selection or explicit ID. Videos need a selection or explicit ID.

The automatic image default applies to native OpenAI/Codex chats, recognized GPT chat IDs through other providers, and configured OpenAI metadata aliases. An OpenAI-compatible API alone does not qualify.

Pi saves image and video selections per session branch and proxy endpoint. Reload, resume, and tree navigation restore them; forks inherit them from the copied branch. New sessions have no saved selections. Clearing an image selection restores the automatic default where it applies.

Invalid or disabled saved selections block automatic fallback until you clear or replace them. Generation checks the live catalog before submitting and rejects missing or hidden IDs without choosing a replacement. Picker and media requests contact the proxy even in offline chat mode. They do not refresh Pi's chat catalog.

### Resolution and aspect ratio

Pass output controls for each generation, or omit them to keep the backend defaults. `cliproxyapi_media_models` lists each model's `controls.size`, `controls.resolution`, and `controls.aspect_ratio`. Empty lists mean the control is unsupported; `size_limits` describes custom pixel sizes beyond the listed presets.

| Models | Controls |
| --- | --- |
| OpenAI images | `size`: `auto` or `WIDTHxHEIGHT`. No separate `resolution` or `aspect_ratio`. |
| Gemini images | `aspect_ratio` and model-specific `resolution` tiers. |
| xAI images | `resolution`: `1k` or `2k`, plus `aspect_ratio`. |
| xAI videos | `resolution`: `480p` or `720p`, plus `aspect_ratio`. The 1.5 model and its preview alias also accept `1080p`. |

GPT Image 1.5 accepts `auto`, `1024x1024`, `1536x1024`, and `1024x1536`. GPT Image 2 and 2.5 also accept custom dimensions: both edges must be multiples of 16 and at most 3840 pixels. The longer edge cannot exceed three times the shorter one. Total pixels must be between 655,360 and 8,294,400. OpenAI marks resolutions above `2560x1440` as experimental.

Gemini 3 Pro Image supports `1K`, `2K`, and `4K`. Gemini 3.1 Flash Image also supports `512`. Flash Lite Image supports `1K` only. Gemini 2.5 Flash Image has no resolution selector. Use the exact case shown in discovery, including uppercase `K` for Gemini and lowercase `k` for xAI.

Aspect ratios vary by model and proxy route. For example, CLIProxyAPI 8.0.7 accepts `20:9` for xAI images but drops xAI's `21:9` and `auto` values. The extension rejects unsupported controls before authentication or network access instead of substituting another size or shape.

```text
Generate an image with gpt-image-2.5-sunburst at size 2048x2048.
Generate a 2K image at 16:9 with gemini-3-pro-image.
Generate a 1-second 1080p video at 9:16 with grok-imagine-video-1.5.
```

Larger outputs can increase generation cost and latency. The extension saves the returned image bytes without resizing, and the existing response and preview limits still apply.

Control values follow the [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output), [Gemini image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation#aspect_ratios_and_image_size), and xAI's [image](https://docs.x.ai/developers/model-capabilities/images/generation#configuration) and [video](https://docs.x.ai/developers/model-capabilities/video/generation#configuration) documentation, restricted to what CLIProxyAPI forwards.

### Supported media models

Your proxy must advertise the exact ID for a model to be available.

| Provider | Models |
| --- | --- |
| OpenAI models | `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5`, `gpt-image-2`, `gpt-image-1.5` |
| Google models | `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-3.1-flash-lite-image` |
| xAI models | `grok-imagine-image`, `grok-imagine-image-quality`, `grok-imagine-image-2.0`, `grok-imagine-video`, `grok-imagine-video-1.5`, `grok-imagine-video-1.5-preview` |

The listed Gemini image models also support advertised `vertex/` and `antigravity/` routes. Those prefixes do not enable OpenAI or xAI media execution; the picker shows those entries as disabled. Other prefixes, media aliases, unknown media IDs, Google Veo, and editing endpoints are unsupported.

The extension disables these retired Imagen IDs, including their `vertex/` and `antigravity/` forms:

- `imagen-3.0-generate-002`
- `imagen-3.0-fast-generate-001`
- `imagen-4.0-generate-001`
- `imagen-4.0-fast-generate-001`
- `imagen-4.0-ultra-generate-001`

The picker explains their retirement, and generation rejects them before network access. Saved Imagen defaults become invalid without a fallback. Use an available Nano Banana model instead. This follows Google's [Vertex retirement notice](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes#March_24_2026) for June 30, 2026; it does not imply that every custom gateway rejects Imagen.

### Files, status, and limits

Image generation saves JPEG, PNG, or WebP files under a new `.pi/cliproxyapi-image-*/` directory in your working directory. The extension checks base64 and file signatures, uses private permissions, and does not overwrite existing files. Keep `.pi/` out of version control.

Inline previews require a vision-capable chat model and share a 4 MiB base64 budget per result. Larger images return file paths without previews. Use Pi's `read` tool to inspect saved images. URL-only image responses fail without a download.

Gemini responses must contain one completed candidate. The extension skips thought parts and saves up to 16 final images within a 256-part response limit. Safety/refusal signals, incomplete or text-only results, malformed data, MIME/signature mismatches, and excess images or parts fail before saving.

Video submission returns a request ID without waiting for generation. Call `cliproxyapi_video_status` with that ID for each later check. Upstream `done` maps to completed; `failed`, `expired`, and moderation-rejected results map to failed. The extension omits URLs for moderation failures. It returns successful video URLs without downloading them or sending proxy credentials to them. xAI video URLs are temporary.

| Operation | Deadline | Response limit |
| --- | --- | --- |
| Catalog fetch | 10 seconds | 4 MiB |
| Media listing or video status | 15 seconds | 4 MiB for the catalog; 64 KiB for video status |
| OpenAI image generation | 10 minutes | 32 MiB |
| Other image generation | 3 minutes | 32 MiB |
| Video submission | 60 seconds | 64 KiB |

Media deadlines include authentication and network waits. Discovery and media requests reject redirects and report HTTP errors without upstream response bodies.

The media tools do not retry generation. Cancellation or timeout can leave work running upstream. Check a known video request ID before submitting another generation.

## Chat models

The extension discovers available IDs through `/v1/models` and matches them against Pi's built-in metadata for limits, prices, inputs, and thinking capabilities.

### Refresh

Run `/cliproxyapi-refresh` to update the chat catalog.

### Aliases and model limits

The chat catalog skips unknown IDs rather than guessing their capabilities. Recognized catalog owners resolve duplicate metadata IDs; ambiguous cross-family matches stay out.

To describe a proxy alias, add a canonical metadata reference to `~/.pi/agent/pi-cliproxyapi.json`:

```json
{
  "aliases": {
    "team-chat": "anthropic/<canonical-model-id>"
  }
}
```

Replace `<canonical-model-id>` with an ID from Pi's Anthropic catalog. References can also use `openai/`, `openai-codex/`, or `google/`. Aliases select metadata; requests retain the original proxy ID.

A `vertex/` or `antigravity/` route can reuse its unprefixed ID's alias if that reference resolves to one metadata entry. An alias for the full prefixed ID takes precedence. Custom prefixes need an explicit chat alias. Arbitrary aliases may lack ID-specific adapter behavior; canonical Gemini IDs and the two recognized prefixes retain native thinking and tool-turn handling.

For Antigravity IDs `claude-opus-5-5-high` and `claude-sonnet-5-5-high`, the extension falls back to `anthropic/claude-opus-5-5` and `anthropic/claude-sonnet-5-5` metadata. This applies to bare IDs and recognized `antigravity/` or `vertex/` routes. Explicit aliases take precedence, followed by exact native metadata. The fallback requires the corresponding canonical entry in Pi; requests keep the advertised `-high` ID.

Use Pi's `models.json` `modelOverrides` for limits, prices, or compatibility changes. Use its `models` array for IDs with no built-in metadata. Updating Pi supplies newer metadata. Catalog prices are estimates, not the proxy's bill; check upstream limits before increasing them.

## Backend routes

Keep the full advertised ID when selecting a backend, for example:

```text
/cli:model select vertex/gemini-2.5-flash-image
/cli:model select antigravity/gemini-3.1-flash-image
```

These examples select media defaults. Chat routes belong in Pi's built-in `/model` picker.

Set the CLIProxyAPI auth record's top-level `prefix` to `vertex` or `antigravity` to advertise those routes. With `routing.force-model-prefix: false` in CLIProxyAPI 8, the proxy retains bare IDs too. Legacy configurations use the top-level `force-model-prefix` setting. This extension does not change proxy configuration or restart it.

## Thinking and child sessions

Use a reference such as `cliproxyapi/<model-id>:high` in Pi or pi-subagents. Pi separates the thinking suffix from the request ID. Supported levels come from model metadata; `xhigh` and `max` require explicit support. Pi clamps unsupported levels, and models that require thinking cannot use `off`. Keep thinking suffixes out of alias references.

The `-high` in Antigravity model IDs belongs to the request ID. Pi's `:high` suffix sets thinking effort. For example, `cliproxyapi/antigravity/claude-opus-5-5-high:high` sends `antigravity/claude-opus-5-5-high` with high effort.

Child loading depends on the [pi-subagents extension settings](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md#tool-and-extension-selection). Local foreground children can inherit providers from the parent. Background children load extensions through discovery or an allowlist. A saved catalog alone does not register this provider.

For native roles that need explicit loading, add this extension to `subagentOnlyExtensions`. Merge this example into `~/.pi/agent/settings.json`, replacing the path and role name while preserving existing entries:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "subagentOnlyExtensions": ["/path/to/pi-cliproxyapi-native/extensions/index.ts"]
      }
    }
  }
}
```

Run `/reload` after changing settings and `/cliproxyapi-refresh` before starting new children that need an updated catalog. Extension allowlists and policies still apply. If a child cannot resolve a model, check extension loading, authentication, and the saved catalog before changing its thinking suffix.

## Protocol notes

Claude uses the legacy fine-grained tool-streaming header in place of eager tool fields. The extension disables unverified deferred-tool and strict-tool capabilities. Responses function tools use `strict: null` when Pi omits strictness, so optional arguments remain optional. Explicit payload hooks retain final control.

OpenAI images POST `model`, `prompt`, and `n=1` to `/v1/images/generations`, without `response_format`. xAI uses the same route with `response_format: "b64_json"`. Gemini uses `/v1beta/models/{id}:generateContent`. Media generation sends the prompt and generation options without chat history, system instructions, or tools.

OpenAI image POSTs use a dedicated HTTP connection and preserve Node's configured proxy routing. They disable socket timeouts so the ten-minute deadline controls the request, request identity encoding, and reject compressed responses.

The implementation follows CLIProxyAPI v7.3.1's [OpenAI image handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.1/sdk/api/handlers/openai/openai_images_handlers.go) and [Codex image executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.1/internal/runtime/executor/codex_openai_images.go). The xAI and Google routes follow v7.2.158's [video handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_videos_handlers.go), [Gemini handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/gemini/gemini_handlers.go), and [Vertex executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/internal/runtime/executor/gemini_vertex_executor.go). See [xAI's video documentation](https://docs.x.ai/developers/model-capabilities/video/generation) for duration and status semantics.

## License

[MIT](LICENSE)
