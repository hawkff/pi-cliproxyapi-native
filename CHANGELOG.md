# Changelog

For releases before 0.3.6, see the [GitHub releases](https://github.com/hawkff/pi-cliproxyapi-native/releases).

## [0.3.6] - 2026-11-10

- Pi's background prompt-cache refreshes skip the quota wait. Before, a refresh that hit a quota limit showed a quota countdown while Pi sat idle, then sent the whole request again after the reset.
- Claude on unprefixed, `oauth/`, `vertex/`, and `antigravity/` routes reports a one-hour cache lifetime, so Pi stops refreshing those caches every five minutes. CLIProxyAPI keeps OAuth Claude caches for an hour. `api/` routes keep Pi's five-minute refreshes.
- Claude message threads stay off. A proxy route that drops the `thread` field would send only the newest messages.
- Live Claude quota lookups send the Claude Code version that CLIProxyAPI 8.0.63 uses.
- The `/cli:model` picker reports Pi as waiting for input in terminals that show program status.
- The extension targets Pi 1.5.1 and CLIProxyAPI 8.0.63.
