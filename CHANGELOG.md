# Changelog

For releases before 0.3.6, see the [GitHub releases](https://github.com/hawkff/pi-cliproxyapi-native/releases).

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
