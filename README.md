# Pi CLIProxyAPI Native

Use [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) for chat, image generation and editing, and video generation in [Pi](https://pi.dev).

Chat uses Pi's native API adapters and model metadata, with availability from your proxy. Image and video tools have separate model selections, so you can generate media without switching your chat model.

## Contents

- [Install](#install)
- [Connection](#connection)
- [Images and videos](#images-and-videos)
  - [Choose a media model](#choose-a-media-model)
  - [Generate media](#generate-media)
  - [Resolution and aspect ratio](#resolution-and-aspect-ratio)
  - [OpenAI image controls and editing](#openai-image-controls-and-editing)
  - [Image usage and cost](#image-usage-and-cost)
  - [Pi image models](#pi-image-models)
  - [Supported media models](#supported-media-models)
  - [Files, status, and limits](#files-status-and-limits)
- [Chat models](#chat-models)
  - [Refresh](#refresh)
  - [Wait for quota reset](#wait-for-quota-reset)
  - [Retry failed turns](#retry-failed-turns)
  - [Prompt cache refreshes](#prompt-cache-refreshes)
  - [Compaction](#compaction)
  - [Aliases and model limits](#aliases-and-model-limits)
- [Backend routes](#backend-routes)
- [OAuth and API-key routes](#oauth-and-api-key-routes)
- [Thinking and child sessions](#thinking-and-child-sessions)
- [Protocol notes](#protocol-notes)
- [License](#license)

## Install

The extension targets Pi 1.5.2 and CLIProxyAPI 8.0.67, with Node.js 22.19 or newer. Run CLIProxyAPI with your upstream accounts configured before connecting Pi. The extension uses Pi's host-provided packages, adds no runtime dependencies, and needs no compilation.

If you installed `pi-cliproxy-native`, remove it before installing the renamed package. Both register the same `cliproxyapi` provider.

```sh
pi install npm:pi-cliproxyapi-native@0.3.9
```

For Git installation, use `pi install git:github.com/hawkff/pi-cliproxyapi-native@v0.3.9`. For a local checkout, use `pi install /path/to/pi-cliproxyapi-native`. After an update, Pi shows the new [changelog](CHANGELOG.md) entries under "Extension Updates" on its next launch.

The default proxy address is `http://localhost:8317`. For another address, set the [connection](#connection) before logging in. Restart Pi, then run:

```text
/login cliproxyapi
/cliproxyapi-refresh
/model
```

Enter your CLIProxyAPI client key at login. Pi validates it against the proxy before saving it. Upstream account authentication stays in CLIProxyAPI.

**Use Pi's built-in `/model` picker for chat.** Choose a `cliproxyapi/` entry there. This extension's `/cli:model` picker is only for CLIProxyAPI image and video models. Selecting a media model does not change chat or generate anything.

Enable only one extension that registers the `cliproxyapi` provider ID. Model discovery leaves other providers' model lists unchanged. [Delayed retries](#retry-failed-turns) apply to all providers.

## Connection

Set `CLIPROXYAPI_BASE_URL` or create `~/.pi/agent/pi-cliproxyapi.json`:

```json
{
  "baseUrl": "http://localhost:8317"
}
```

| Setting                      | Behavior                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CLIPROXYAPI_BASE_URL`       | Overrides `baseUrl` in the configuration file.                                                                    |
| `CLIPROXYAPI_API_KEY`        | Supplies a client key when Pi has no stored login credential.                                                     |
| `CLIPROXYAPI_MANAGEMENT_KEY` | Enables live Claude quota lookup through the same proxy's management API. Keep this separate from the client key. |

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

The terminal picker is keyboard-only. Type to search, use the selection keys to move, press Enter to select, or Escape to cancel. It respects custom selection keybindings. Mouse clicks and wheel events do not change selection. Terminals that show program status mark Pi as waiting for input while the picker is open.

Starting session or branch navigation discards pending picker commands, even if another extension later cancels navigation. Run the selection again if you stay on the same branch.

RPC, print, and JSON modes return text instead of opening the picker. Print mode uses stderr, JSON mode emits custom-message events, and RPC sends notifications. Listings show up to 100 matches; narrow larger lists with `search`. Use `select <exact ID>` to choose a model in these modes.

### Generate media

Ask Pi to use the media tools:

```text
List available CLIProxyAPI media models.
Generate an image of a red circle with grok-imagine-image.
Generate a 1-second video of a red circle moving left with grok-imagine-video.
Check video status for request_id <returned-id>.
```

| Tool                         | Arguments                                                                                                                                      | Result                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `cliproxyapi_media_models`   | None                                                                                                                                           | Available image/video IDs, supported output controls, and effective defaults. |
| `cliproxyapi_generate_image` | `prompt`; optional `model`, `size`, `resolution`, `aspect_ratio`, and [OpenAI controls and editing inputs](#openai-image-controls-and-editing) | Saved images and paths, plus previews when the chat model supports images.    |
| `cliproxyapi_generate_video` | `prompt`; optional `model`, `resolution`, `aspect_ratio`, and integer `duration` from 1 to 15 seconds                                          | A `request_id` for the submitted video.                                       |
| `cliproxyapi_video_status`   | `request_id`                                                                                                                                   | One status check: pending, completed with a URL, or failed.                   |

Pass `model` to choose an exact ID for one tool call. Otherwise, the tool uses its saved `/cli:model` selection. Without either, eligible OpenAI/GPT chats default to `gpt-image-2.6-sunburst` for images, which needs CLIProxyAPI 8.0.56 or newer. Other chats need an image selection or explicit ID. Videos need a selection or explicit ID.

The automatic image default applies to native OpenAI/Codex chats, recognized GPT chat IDs through other providers, and configured OpenAI metadata aliases. An OpenAI-compatible API alone does not qualify.

Pi saves image and video selections per session branch and proxy endpoint. Reload, resume, and tree navigation restore them; forks inherit them from the copied branch. New sessions have no saved selections. Clearing an image selection restores the automatic default where it applies.

Invalid or disabled saved selections block automatic fallback until you clear or replace them. Generation checks the live catalog before submitting and rejects missing or hidden IDs without choosing a replacement. Picker and media requests contact the proxy even in offline chat mode. They do not refresh Pi's chat catalog.

### Resolution and aspect ratio

Pass output controls for each generation, or omit them to keep the backend defaults. `cliproxyapi_media_models` lists each model's `controls.size`, `controls.resolution`, and `controls.aspect_ratio`. Empty lists mean the control is unsupported; `size_limits` describes custom pixel sizes beyond the listed presets.

| Models        | Controls                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| OpenAI images | `size`: `auto` or `WIDTHxHEIGHT`. No separate `resolution` or `aspect_ratio`.                                            |
| Gemini images | `aspect_ratio` and model-specific `resolution` tiers.                                                                    |
| xAI images    | `resolution`: `1k` or `2k`, plus `aspect_ratio`.                                                                         |
| xAI videos    | `resolution`: `480p` or `720p`, plus `aspect_ratio`. The 1.5 model, its preview alias, and 1.5 Lite also accept `1080p`. |

GPT Image 1.5 accepts `auto`, `1024x1024`, `1536x1024`, and `1024x1536`. GPT Image 2, 2.5, and 2.6 also accept custom dimensions: both edges must be multiples of 16 and at most 3840 pixels. The longer edge cannot exceed three times the shorter one. Total pixels must be between 655,360 and 8,294,400. OpenAI marks resolutions above `2560x1440` as experimental. For GIF output, `size` sets each frame and can go below the 655,360-pixel minimum. OpenAI checks the frame size, frame count, and image count against its request budget.

Gemini 3 Pro Image supports `1K`, `2K`, and `4K`. Gemini 3.1 Flash Image also supports `512`. Flash Lite Image supports `1K` only. Gemini 2.5 Flash Image has no resolution selector. Use the exact case shown in discovery, including uppercase `K` for Gemini and lowercase `k` for xAI.

Aspect ratios vary by model and proxy route. For example, CLIProxyAPI 8.0.7 accepts `20:9` for xAI images but drops xAI's `21:9` and `auto` values. The extension rejects unsupported controls before authentication or network access instead of substituting another size or shape.

```text
Generate an image with gpt-image-2.6-sunburst at size 2048x2048.
Generate a 2K image at 16:9 with gemini-3-pro-image.
Generate a 1-second 1080p video at 9:16 with grok-imagine-video-1.5.
```

Larger outputs can increase generation cost and latency. The extension saves the returned image bytes without resizing, and the existing response and preview limits still apply.

Control values follow the [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation#customize-image-output), [Gemini image guide](https://ai.google.dev/gemini-api/docs/generate-content/image-generation#aspect_ratios_and_image_size), and xAI's [image](https://docs.x.ai/developers/model-capabilities/images/generation#configuration) and [video](https://docs.x.ai/developers/model-capabilities/video/generation#configuration) documentation, restricted to what CLIProxyAPI forwards.

### OpenAI image controls and editing

Use `cliproxyapi_media_models` to inspect controls for the exact advertised model ID. Omitted options keep the backend defaults. The extension rejects unsupported values before contacting the proxy.

| Option               | Supported values                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`            | `auto`, `low`, `medium`, `high`. Sunburst and Flare also accept `xhigh` and `max`.                                                                                                                                               |
| `complexity`         | `low`, `medium`, `high` for GPT Image 2.6 Sunburst and Flare. It sets how much the model plans before rendering, and OpenAI defaults to `high`. Use `low` for quick edits.                                                       |
| `background`         | `auto`, `opaque`, `transparent`. Transparent output requires PNG or WebP; GPT Image 2 transparency is in preview upstream.                                                                                                       |
| `output_format`      | `png`, `jpeg`, `webp`. GPT Image 2.6 Sunburst and Flare also generate `gif` and `svg`. JPEG and WebP can reduce file size and help keep results within the response limit.                                                       |
| `output_compression` | Integer from 0 to 100, with an explicit `jpeg` or `webp` format. Zero is a valid value.                                                                                                                                          |
| `frame_count`        | GIF output only. Integer from 2 to 16. OpenAI defaults to 9.                                                                                                                                                                     |
| `frame_duration_ms`  | GIF output only. Milliseconds per frame from 20 to 2000, rounded to 10. OpenAI defaults to 200.                                                                                                                                  |
| `moderation`         | `auto` or `low`. OpenAI still applies its content policies.                                                                                                                                                                      |
| `n`                  | Integer from 1 to 10 on an explicit `api/` image route. Other routes allow only 1 because subscription translation can drop the count.                                                                                           |
| `partial_images`     | Integer from 0 to 3. The proxy streams up to that many draft frames while the image renders, and Pi shows them as tool progress. Requires `n` of 1 and PNG, JPEG, or WebP output. Each draft adds about 100 image output tokens. |
| `images`             | One to 16 local PNG, JPEG, or WebP paths. Supplying these selects `/v1/images/edits` instead of generation.                                                                                                                      |
| `mask`               | Optional local PNG mask. The first image must also be PNG with matching dimensions. The mask needs a grayscale-alpha or RGBA alpha channel; transparent regions mark edits.                                                      |
| `markup`             | Optional local PNG annotation layer for GPT Image 2.5 and 2.6 Sunburst and Flare. It needs an alpha channel, the first image's dimensions, and transparency outside the marks. It cannot be combined with `mask`.                |
| `input_fidelity`     | `low` or `high`, for GPT Image 1.5 editing only. Omit it for other models.                                                                                                                                                       |

Editing uploads the files you name to the configured proxy. Paths can be absolute or relative to the working directory. The extension accepts regular files, checks file signatures, and limits uploads to 14 MiB per file and 20 MiB total including the mask or markup layer. It compares markup dimensions only with a PNG first image; OpenAI checks JPEG and WebP inputs. It rejects URLs and inline image data such as `data:` URLs. It does not resize inputs or modify source files. OpenAI performs full image decoding and validates the edit. These local limits keep base64 uploads bounded and may be lower than upstream limits.

```text
Generate two images with api/gpt-image-2.6-sunburst at 1536x864, quality max, output_format webp, output_compression 85.
Edit ./photo.png with api/gpt-image-2.6-flare: replace the background with a garden, using ./mask.png as the mask.
Edit ./kitchen.webp with gpt-image-2.6-flare and complexity low, using ./circle.png as markup: recolor the circled vase cobalt blue.
Generate a looping GIF of a waving robot with gpt-image-2.6-flare, output_format gif, frame_count 8, size 512x512.
Generate an SVG logo for a bakery with gpt-image-2.6-sunburst and output_format svg.
```

GIF and SVG output work only for generation, without streaming, `partial_images`, or `output_compression`. SVG also needs `n` of 1. OpenAI renders a reference image at the chosen `quality`, and a second model writes the SVG from it. The extension saves `.gif` and `.svg` files without inline previews and checks the GIF signature. SVG must be UTF-8 static drawing markup with presentation attributes and references only inside the file, which matches OpenAI's documented output. The extension rejects anything else before saving, including scripts, CSS, comments, animation, event handlers, and external references.

All returned images share the existing 32 MiB response limit and 4 MiB preview budget. Streamed requests allow another 32 MiB for each draft frame. The extension saves only the final image and drops drafts it cannot decode. Larger sizes, higher quality, and multiple images can increase cost and latency. Use fewer images or JPEG/WebP if the response exceeds the limit. Generation and editing do not retry after a failure.

The extension supports the verified options above, not a general OpenAI API passthrough. Remote file IDs, SVG author model selection, audio, batches, and realtime APIs are not exposed. Adding an upstream API key does not enable endpoints that the proxy or extension cannot handle.

### Image usage and cost

OpenAI image responses report token usage. The image tool returns it to Pi, so image calls count toward the session totals in the footer and `/session`.

Costs are estimates at OpenAI list prices per million tokens: $5 for text input, $8 for image input, and $30 for image output on GPT Image 2, and on 2.5 and 2.6 Sunburst and Flare. GPT Image 1.5 output costs $32. The plain `gpt-image-2.5` and `gpt-image-2.6` subscription models have no published price, so they report tokens at zero cost. SVG output also reports the tokens of the model that writes the SVG. The extension adds them to the totals and prices them from Pi's OpenAI model metadata, or at zero when Pi doesn't know that model. Subscription routes show the same estimates when the proxy reports usage, even though the plan covers them. Google and xAI image results report no usage.

### Pi image models

When Pi refreshes the catalog, at interactive startup or through `/cliproxyapi-refresh`, the advertised image models also register as Pi image models. Codemode scripts list them with `models.getAvailableOfType("image", "cliproxyapi")` and call `models.generateImages()`, and other extensions can use `ctx.modelRegistry.generateImages()`.

These calls send the prompt with backend defaults. Pi's image interface has no size, quality, count, format, mask, markup, or preview options. Image blocks in the input select OpenAI editing, under the same 16-image, 14 MiB per image, and 20 MiB total limits. Google and xAI models accept text only. Results arrive as image blocks with usage and are not saved to disk. Use `cliproxyapi_generate_image` when you need controls, masks, markup, GIF or SVG output, or saved files.

### Supported media models

Your proxy must advertise the exact ID for a model to be available.

| Provider      | Models                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI models | `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`, `gpt-image-2.6`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5`, `gpt-image-2`, `gpt-image-1.5`                            |
| Google models | `gemini-2.5-flash-image`, `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-3.1-flash-lite-image`                                                                                       |
| xAI models    | `grok-imagine-image`, `grok-imagine-image-quality`, `grok-imagine-image-2.0`, `grok-imagine-video`, `grok-imagine-video-1.5`, `grok-imagine-video-1.5-lite`, `grok-imagine-video-1.5-preview` |

Supported media IDs can also use advertised `api/` and `oauth/` credential routes. OpenAI's API has no plain `gpt-image-2.5` or `gpt-image-2.6`, so the picker disables their `api/` routes and points to Sunburst or Flare; subscription routes keep them. Gemini image models also support `vertex/` and `antigravity/` backend routes. Those backend prefixes do not enable OpenAI or xAI media execution; the picker shows those entries as disabled. Other prefixes, nested prefixes, media aliases, unknown media IDs, Google Veo, and non-OpenAI editing are unsupported.

The extension disables these retired Imagen IDs, including their supported prefixed forms:

- `imagen-3.0-generate-002`
- `imagen-3.0-fast-generate-001`
- `imagen-4.0-generate-001`
- `imagen-4.0-fast-generate-001`
- `imagen-4.0-ultra-generate-001`

The picker explains their retirement, and generation rejects them before network access. Saved Imagen defaults become invalid without a fallback. Use an available Nano Banana model instead. This follows Google's [Vertex retirement notice](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes#March_24_2026) for June 30, 2026; it does not imply that every custom gateway rejects Imagen.

### Files, status, and limits

Image generation saves JPEG, PNG, WebP, GIF, or SVG files under a new `.pi/cliproxyapi-image-*/` directory in your working directory. The extension creates that directory before it sends the request. If it cannot, the call fails and nothing is generated. A failed generation removes the directory again. The extension checks base64 and file signatures, uses private permissions, and does not overwrite existing files. Keep `.pi/` out of version control.

Inline previews require a vision-capable chat model and share a 4 MiB base64 budget per result. Larger images return file paths without previews, and GIF and SVG results never include one. Use Pi's `read` tool to inspect saved images. URL-only image responses fail without a download.

Gemini responses must contain one completed candidate. The extension skips thought parts and saves up to 16 final images within a 256-part response limit. Safety/refusal signals, incomplete or text-only results, malformed data, MIME/signature mismatches, and excess images or parts fail before saving.

Video submission returns a request ID without waiting for generation. Call `cliproxyapi_video_status` with that ID for each later check. Upstream `done` maps to completed; `failed`, `expired`, and moderation-rejected results map to failed. The extension omits URLs for moderation failures. It returns successful video URLs without downloading them or sending proxy credentials to them. xAI video URLs are temporary.

| Operation                          | Deadline   | Response limit                                 |
| ---------------------------------- | ---------- | ---------------------------------------------- |
| Catalog fetch                      | 10 seconds | 4 MiB                                          |
| Media listing or video status      | 15 seconds | 4 MiB for the catalog; 64 KiB for video status |
| OpenAI image generation or editing | 10 minutes | 32 MiB, plus 32 MiB per streamed draft         |
| Other image generation             | 3 minutes  | 32 MiB                                         |
| Video submission                   | 60 seconds | 64 KiB                                         |

Media deadlines include input-file reads, authentication, and network waits. Discovery and media requests reject redirects. Media errors quote the `message` from an upstream JSON error, cut to 500 characters, with credentials and control characters removed. Other error bodies and discovery errors report only the HTTP status.

The media tools do not retry generation. Cancellation or timeout can leave work running upstream. Check a known video request ID before submitting another generation.

## Chat models

The extension discovers available IDs through `/v1/models` and matches them against Pi's Anthropic, OpenAI, OpenAI Codex, Google, and xAI metadata for limits, prices, inputs, and thinking capabilities. xAI Grok models use Pi's native Responses adapter through the proxy.

During a session, the extension also reads the provider catalogs that Pi refreshes from its catalog service. Pi downloads a provider's catalog only while that provider has credentials in Pi. Models newer than Pi's bundled data can then register; for models Pi already bundles, the bundled metadata wins.

### Refresh

Run `/cliproxyapi-refresh` to update the chat and image catalogs. It reports both counts and lists up to 20 advertised IDs that it could not register because Pi has no metadata for them or the match is ambiguous.

### Wait for quota reset

Set `CLIPROXYAPI_MANAGEMENT_KEY` in Pi's environment to enable live Claude quota lookup. With live lookup enabled, Claude subscription requests enter quota handling on the first quota rejection, before SDK or Pi retries. The extension asks CLIProxyAPI to fetch Claude's OAuth usage, using the same upstream endpoint as the management dashboard. It reads absolute `resets_at` timestamps.

While waiting, the extension refreshes usage every minute within 20 minutes of the reset. Before that the interval grows with the remaining wait, up to ten minutes. It refreshes again at the reported reset, with a one-second buffer. Each refresh checks the five-hour allowance and applicable weekly limits, including model-specific limits. A request that would exceed the remaining account allowance can wait for the five-hour reset before utilization reaches 100%. For an account pool, it considers enabled Claude subscription accounts that advertise the selected model and uses the earliest eligible recovery. The terminal countdown follows updated reset times. Cancel the current request to stop waiting; closing or reloading Pi discards the wait.

Weekly exhaustion stops the request by default and reports the reset time. To wait for weekly resets too, merge this setting into `~/.pi/agent/pi-cliproxyapi.json`, then run `/reload`:

```json
{
  "quota": {
    "waitForWeeklyReset": true
  }
}
```

Without a management key, Claude retains its SDK retry settings and response-based waits. If live usage shows available quota before a wait begins, the extension uses valid response reset timing or returns the original error for Pi's bounded retries.

Invalid management credentials, rejected account access, invalid usage data, or an exhausted allowance with an expired reset stop the quota wait with an explanation. These failures do not trigger Pi's quick retries. Extension-managed waits share one fixed seven-day deadline per provider call; a new cooldown cannot extend it. The extension checks the deadline after waking and before accepting available quota, including after machine sleep. It does not replay a request that has started streaming.

Live quota lookup requires CLIProxyAPI's `/v8/management` API and does not fall back to legacy `/v0/management` routes. Management requests stay on the configured proxy and reject redirects. Account access tokens stay in CLIProxyAPI. The extension reads account metadata and proxies usage GETs; it does not reset quotas, change credentials, or clear proxy cooldowns. Management keys grant broader access than chat keys, so keep them private. Live lookup supports up to 100 active Claude subscription accounts.

Explicit `api/` routes skip live Claude subscription lookup, even with a management key. `oauth/` routes keep the lookup for matching OAuth accounts. Retries keep the selected route's full model ID.

Other chat routes retain the response-based fallback: `Retry-After` on HTTP 429 or a recognized quota HTTP 403, or `reset_seconds` in a `model_cooldown` error. Google's native adapter exposes only the structured error body. Those waits share the same seven-day deadline but cannot inspect live weekly usage. Image and video generation still do not retry.

### Retry failed turns

Keep Pi open in terminal or RPC mode to retry failed model turns across all providers, including those outside CLIProxyAPI. After Pi finishes its built-in retries and recovery, the extension waits ten minutes and adds a visible continuation message to resume the unfinished task. Another failed turn starts another ten-minute wait. Successful turns, tool errors, and deliberate cancellations do not start a wait.

Delayed retries are on by default. Use `/auto-retry` to see the status, `/auto-retry off` to cancel the pending retry and disable future ones, or `/auto-retry on` to enable retries for future failures. Reloading the extension restores the default.

Escape or Ctrl+C cancels a pending retry in the terminal. New input, a model change, manual compaction, or session navigation also cancels it. Reloading or closing Pi discards pending retries. One-shot print and JSON runs do not schedule them.

Retries preserve the conversation rather than replaying the original prompt. They do not fix credentials or increase quotas, and resumed work can incur provider charges. Use `/auto-retry off` if a persistent error needs manual correction.

### Prompt cache refreshes

Pi refreshes a Claude prompt cache in the background so it doesn't expire between requests. Since 1.5.1, Pi does this by default, during runs and for up to 30 minutes after them. Set Pi's `cacheWarming` setting to `"streaming"` to limit refreshes to active runs, or to `"off"` to stop them.

CLIProxyAPI keeps OAuth Claude caches for an hour. The extension reports a one-hour cache lifetime for Claude on unprefixed, `oauth/`, `vertex/`, and `antigravity/` routes, so Pi doesn't refresh those caches. `api/` routes keep Anthropic's five-minute lifetime. Pi refreshes them when it estimates that a refresh saves at least $0.05. If your unprefixed Claude IDs reach API keys, select their `api/` IDs, or set `promptCache` for those IDs through `modelOverrides` in Pi's `models.json`.

A refresh that hits a quota limit fails without waiting for the reset. Chat and compaction requests keep the quota waits described above.

### Compaction

For automatic compaction and `/compact`, the extension limits medium or higher thinking to low without changing your chat thinking level. It uses Pi's default thinking budgets for these requests. Without an explicit output cap, summaries use the model's output limit. Pi's native adapters reduce the output allowance when needed to fit the remaining context space.

If a caller supplies a smaller cap and the summary hits it, the extension retries once with more output room, up to the model's output limit. An empty or thinking-only response gets one retry, including at the model's output limit.

Pi still selects which messages to summarize and retains recent history, previous summaries, custom instructions, and file tracking. Only the final response reaches the compactor, with usage from all attempts. Compaction fails rather than saving an incomplete summary. Cancellation, tool calls, and provider failures do not trigger these output retries; Pi keeps its configured transient-error retries and the extension keeps its quota handling.

Authentication failures, exhausted quotas, and inputs that exceed the model's context window still need correction. Run `/compact` after resolving the cause. The extension does not truncate history to force a summary or switch models. CLIProxyAPI's Responses compaction endpoint is separate from Pi's text-summary workflow.

### Aliases and model limits

The chat catalog skips unknown IDs rather than guessing their capabilities. Discovery also skips IDs it cannot send or display safely: empty IDs, IDs over 256 characters, and IDs with spaces or non-ASCII characters. A catalog with no usable ID fails as invalid and leaves the current model list in place. Recognized catalog owners resolve duplicate metadata IDs; ambiguous cross-family matches stay out. For example, CLIProxyAPI 8.0.67 lists `gpt-6-chat-thinking` and `gemini-omni-1.2-flash`, which have no metadata in Pi 1.5.2, so `/cliproxyapi-refresh` reports them as not registered until you add an alias. Pi 1.5.2 includes `claude-fable-5-2`, which registers without one.

To describe a proxy alias, add a canonical metadata reference to `~/.pi/agent/pi-cliproxyapi.json`:

```json
{
  "aliases": {
    "team-chat": "anthropic/<canonical-model-id>"
  }
}
```

Replace `<canonical-model-id>` with an ID from Pi's Anthropic catalog. References can also use `openai/`, `openai-codex/`, `google/`, or `xai/`. Aliases select metadata; requests retain the original proxy ID.

The recognized prefixes are `vertex/`, `antigravity/`, `api/`, and `oauth/`. Each can reuse its unprefixed ID's alias if that reference resolves to one metadata entry. An alias for the full prefixed ID takes precedence. Other prefixes need an explicit chat alias. Arbitrary aliases may lack ID-specific adapter behavior; canonical Gemini IDs and the recognized prefixes retain native thinking and tool-turn handling.

For Antigravity IDs `claude-opus-5-5-high` and `claude-sonnet-5-5-high`, the extension falls back to `anthropic/claude-opus-5-5` and `anthropic/claude-sonnet-5-5` metadata. This applies to bare IDs and the recognized route prefixes. Explicit aliases take precedence, followed by exact native metadata. The fallback requires the corresponding canonical entry in Pi and names the model like a configured alias, for example `claude-opus-5-5-high (Claude Opus 5.5)`; requests keep the advertised `-high` ID.

The same fallback rules map `gemini-4-argon-high`, `gemini-4-carbon-high`, and `gemini-3.8-flash-high` to `google/gemini-4-argon`, `google/gemini-4-carbon`, and `google/gemini-3.8-flash`, including recognized route prefixes. Pi 1.5.2 doesn't bundle Gemini 4 Carbon metadata. Until a Pi release does, `gemini-4-carbon` and `gemini-4-carbon-high` need the metadata from Pi's pi.dev catalog, which Pi downloads only while Google has credentials in Pi, such as a stored login or `GEMINI_API_KEY`.

Use Pi's `models.json` `modelOverrides` for limits, prices, or compatibility changes. Use its `models` array for IDs with no built-in metadata. Updating Pi supplies newer metadata. Catalog prices are estimates, not the proxy's bill; check upstream limits before increasing them.

## Backend routes

Keep the full advertised ID when selecting a backend, for example:

```text
/cli:model select vertex/gemini-2.5-flash-image
/cli:model select antigravity/gemini-3.1-flash-image
```

These examples select media defaults. Chat routes belong in Pi's built-in `/model` picker.

Set the CLIProxyAPI auth record's top-level `prefix` to `vertex` or `antigravity` to advertise those routes. With `routing.force-model-prefix: false` in CLIProxyAPI 8, the proxy retains bare IDs too. Legacy configurations use the top-level `force-model-prefix` setting. This extension does not change proxy configuration or restart it.

## OAuth and API-key routes

CLIProxyAPI can advertise separate model IDs for OAuth and API-key credentials. The extension labels `oauth/<model>` as **OAuth** and `api/<model>` as **API key**. It matches the unprefixed model's metadata and sends the full advertised ID on requests. It does not retry an explicit route as a bare ID or another credential route.

Configure the prefixes in CLIProxyAPI's v8 layout:

- For an API-key group, set `api-keys.<provider>[].prefix` to `api`. A key-level `prefix` can override the group value.
- For an OAuth credential, set the auth record's top-level `prefix` to `oauth`.

If a legacy file stores client keys in the root `api-keys` list, migrate them to `access.api-keys` before adding provider groups. A successful v8 management write performs this migration.

CLIProxyAPI also supports per-group and per-key model aliases, exclusions, priorities, and proxy overrides. See its [configuration fields](https://github.com/router-for-me/cliproxyapidocs/blob/main/docs/en/configuration/options.md).

The [v8 management API](https://github.com/router-for-me/cliproxyapidocs/blob/main/docs/en/management/apiv8.md) manages API-key groups through `/v8/management/config/api-keys/<provider>`. These lists must be replaced as a whole; numeric paths cannot select an entry. OAuth fields use `PATCH /v8/management/credentials/fields`. The extension does not call these endpoints or need a management key for model discovery.

After setting the prefixes, run `/cliproxyapi-refresh`. Choose `cliproxyapi/oauth/<model>` or `cliproxyapi/api/<model>` in Pi's `/model` picker. Media routes appear in `/cli:model`.

The extension trusts your prefix configuration; it does not inspect credential types. Keep each prefix limited to its matching credential type. Unprefixed IDs remain **Automatic (proxy routing)** and may use either pool. Set `routing.force-model-prefix: true` in CLIProxyAPI to exclude prefixed credentials from unprefixed requests.

Chat and media selections remain independent. The automatic OpenAI image default is still unprefixed; select a prefixed media model to choose its credential route.

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

Claude uses the legacy fine-grained tool-streaming header in place of eager tool fields. Claude message threads stay off, because a proxy route that drops the `thread` field would send only the newest messages.

The extension doesn't ask Claude for server-side refusal fallbacks. CLIProxyAPI 8.0.66 and newer inject them only when `upstream.claude.server-side-fallback` is on, and the setting is off by default. Older versions inject them into Claude Opus 5.5 and Fable 5.1 requests on OAuth accounts. Keep the setting off and keep `fallbacks` out of the proxy's payload rules, because Pi stops with an error when a fallback model takes over after the answer has started.

GPT models keep Pi's OpenAI Responses capabilities when the proxy lists them as owned by OpenAI. These capabilities are strict tools, grammar tools such as codemode, tool declarations added mid-conversation, tool search, and instructions placed mid-conversation. Each passed live checks through CLIProxyAPI 8.0.48 with an OpenAI API key and with a ChatGPT subscription. OpenAI-compatible providers and other model families keep these capabilities off.

On `api/` routes, Pi can send thinking effort as a `configuration_update` item. ChatGPT subscriptions ignore that item, so unprefixed and `oauth/` routes send the effort as a request field.

When Pi omits strictness in the top-level Responses tool list, the extension sends `strict: null`, so optional arguments remain optional. Tools declared inside the conversation keep Pi's strictness values. Explicit payload hooks retain final control.

OpenAI images POST `model`, `prompt`, `n`, and supplied controls to `/v1/images/generations`, without `response_format`. Editing uses `/v1/images/edits` with JSON `images` and optional `mask` or `markup` data URLs. A nonzero `partial_images` adds `stream: true`, and the extension reads server-sent events. With `streaming.keepalive-seconds` set, streamed previews need CLIProxyAPI 8.0.60 or newer, because older versions could insert keep-alive comments inside an image event. Each `*.partial_image` frame becomes a progress preview, and the `*.completed` frame carries the final image and usage. xAI uses the same route with `response_format: "b64_json"`. Gemini uses `/v1beta/models/{id}:generateContent`. Media generation sends the prompt and generation options without chat history, system instructions, or tools.

OpenAI image POSTs use a dedicated HTTP connection. It follows `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` from the environment, where Pi also places its `httpProxy` setting, on Node 22.21+ and 24.5+. Older Node versions connect directly. The connection disables socket timeouts so the ten-minute deadline controls the request, requests identity encoding, and rejects compressed responses.

The OpenAI image implementation follows CLIProxyAPI v8.0.67's [image handler](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.67/sdk/api/handlers/openai/openai_images_handlers.go) and [Codex image executor](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.67/internal/runtime/executor/codex_openai_images.go), plus the OpenAI [generation](https://developers.openai.com/api/reference/resources/images/methods/generate) and [editing](https://developers.openai.com/api/reference/resources/images/methods/edit) references. The xAI and Google routes follow v7.2.158's [video handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/openai/openai_videos_handlers.go), [Gemini handler](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/sdk/api/handlers/gemini/gemini_handlers.go), and [Vertex executor](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.158/internal/runtime/executor/gemini_vertex_executor.go). See [xAI's video documentation](https://docs.x.ai/developers/model-capabilities/video/generation) for duration and status semantics.

## License

[MIT](LICENSE)
