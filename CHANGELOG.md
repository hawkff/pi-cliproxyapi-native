# Changelog

For releases before 0.3.6, see the [GitHub releases](https://github.com/hawkff/pi-cliproxyapi-native/releases).

## [0.3.12] - 2026-11-26

- Copilot models from CLIProxyAPI 8.1's GitHub Copilot provider register with Pi's `github-copilot` metadata, so they get Copilot's context and output limits. Before, discovery skipped Copilot-only IDs such as `claude-sonnet-5.5`, `kimi-k3`, and `mai-code-2`, and gave shared IDs such as `gpt-6.2-sol` the OpenAI limits. Other owners never resolve to Copilot metadata, so Antigravity's `gemini-4-argon` keeps its Google metadata.
- Copilot's Claude models keep Pi's five-minute cache refreshes. The one-hour cache lifetime applies only to CLIProxyAPI's own Claude routes.
- Pi 1.6.1 bundles Gemini 4 Carbon, Hydrogen, and Neon metadata, so their Antigravity IDs no longer need Pi's pi.dev catalog.
- The extension targets Pi 1.6.1 and CLIProxyAPI 8.1.4.

## [0.3.11] - 2026-11-20

- Antigravity's `gemini-4-neon-xhigh` registers with `google/gemini-4-neon` metadata. CLIProxyAPI 8.0.78 added the ID, and discovery skipped it. Pi 1.5.2 doesn't bundle Gemini 4 Neon metadata, so the ID needs Pi's pi.dev catalog, as Gemini 4 Carbon and Hydrogen do.
- The extension targets Pi 1.5.2 and CLIProxyAPI 8.0.79.

## [0.3.10] - 2026-11-15

- Antigravity's `gemini-4-hydrogen-xhigh` registers with `google/gemini-4-hydrogen` metadata, and `gemini-3.8-flash-tiered` with `google/gemini-3.8-flash` metadata. CLIProxyAPI 8.0.68 added both IDs, and discovery skipped them. Pi 1.5.2 doesn't bundle Gemini 4 Hydrogen metadata, so `gemini-4-hydrogen` and `gemini-4-hydrogen-xhigh` need Pi's pi.dev catalog, as Gemini 4 Carbon does.
- The extension targets Pi 1.5.2 and CLIProxyAPI 8.0.72.

## [0.3.9] - 2026-11-11

- Antigravity's `gemini-4-carbon-high` and `gemini-3.8-flash-high` register with `google/gemini-4-carbon` and `google/gemini-3.8-flash` metadata, as `gemini-4-argon-high` does with `google/gemini-4-argon`. Before, discovery skipped both IDs. Pi 1.5.2 doesn't bundle Gemini 4 Carbon metadata. Until a Pi release does, `gemini-4-carbon-high` needs the metadata from Pi's pi.dev catalog, which Pi downloads only while Google has credentials in Pi, such as a stored login or `GEMINI_API_KEY`.
- The extension targets Pi 1.5.2 and CLIProxyAPI 8.0.67.

## [0.3.8] - 2026-11-10

- Model discovery skips an ID it cannot use and keeps the rest of the catalog. CLIProxyAPI accepts any text as a model alias, and one ID with a space, a non-ASCII character, or more than 256 characters made discovery fail. A catalog with no usable ID still fails, so it cannot replace a working model list.
- `cliproxyapi_generate_image` creates its output directory before the request. If `.pi/` cannot be created, the call fails before anything is generated. Before, the extension generated the image and then discarded it.
- Image edits reject `data:` URLs and paths over 4096 characters as image data. Before, the file error repeated the whole value.
- Live Claude quota lookups run less often while the reset is far away. The interval grows with the remaining wait, up to ten minutes. Within 20 minutes of the reset they run every minute, as before.
- `/cli:model` reports the reason for a failure, such as the HTTP status or a rejected login. Before, most failures showed one generic message.

## [0.3.7] - 2026-11-10

- Model discovery accepts catalogs where a provider's name is empty or contains spaces. CLIProxyAPI reports the configured name of an OpenAI-compatible provider as `owned_by`, and one such entry made login, `/cliproxyapi-refresh`, `/cli:model`, and the media tools fail.
- Image edits accept JPEG files with data after the end marker, such as Samsung camera photos and motion photos. Before, the extension rejected them as unsupported images.
- `cliproxyapi_generate_image` accepts `n: 1` and `partial_images: 0` on Google and xAI models. Both values are the defaults, and the extension rejected them there as unsupported.
- Large streamed image previews no longer freeze Pi. The extension copied the pending frame for each network chunk, so a 20 MiB preview and final image blocked Pi for over a second. Reading them now takes under 50 ms.
- Aliases accept `xai/` metadata references.
- The extension targets Pi 1.5.2 and CLIProxyAPI 8.0.64.

## [0.3.6] - 2026-11-10

- Pi's background prompt-cache refreshes skip the quota wait. Before, a refresh that hit a quota limit showed a quota countdown while Pi sat idle, then sent the whole request again after the reset.
- Claude on unprefixed, `oauth/`, `vertex/`, and `antigravity/` routes reports a one-hour cache lifetime, so Pi stops refreshing those caches every five minutes. CLIProxyAPI keeps OAuth Claude caches for an hour. `api/` routes keep Pi's five-minute refreshes.
- Claude message threads stay off. A proxy route that drops the `thread` field would send only the newest messages.
- Live Claude quota lookups send the Claude Code version that CLIProxyAPI 8.0.63 uses.
- The `/cli:model` picker reports Pi as waiting for input in terminals that show program status.
- The extension targets Pi 1.5.1 and CLIProxyAPI 8.0.63.
