import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  SelectList,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { backendLabel, mediaCapability, parseCatalog, routedName } from "./catalog.ts";
import type { Config } from "./config.ts";
import { mediaKey } from "./media.ts";
import {
  effectiveMediaDefaults,
  MEDIA_DEFAULTS_ENTRY,
  type MediaDefaults,
  readMediaDefaults,
} from "./media-defaults.ts";
import { fetchCatalog } from "./provider.ts";

export function pickerCatalog(value: unknown) {
  const rows = new Map<
    string,
    {
      id: string;
      name: string;
      owner: string;
      backend: string;
      purpose: "image" | "video";
      supported: boolean;
      disabledReason?: string;
    }
  >();
  for (const entry of parseCatalog(value)) {
    if (entry.hidden || rows.has(entry.id)) continue;
    const media = mediaCapability(entry.id);
    if (!media) continue;
    rows.set(entry.id, {
      id: entry.id,
      name: routedName(entry.id, media.name),
      owner: entry.owner ?? "unknown owner",
      backend: backendLabel(entry.id),
      purpose: media.purpose,
      supported: !media.disabledReason,
      disabledReason: media.disabledReason,
    });
  }
  return [...rows.values()];
}

type PickerRow = ReturnType<typeof pickerCatalog>[number];
type PickerItem = { value: string; label: string; description: string; supported: boolean };

export function searchPickerItems(items: readonly PickerItem[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter((item) =>
    terms.every((term) => `${item.label} ${item.value} ${item.description}`.toLowerCase().includes(term)),
  );
}

function defaultsLabel(defaults: MediaDefaults, automatic?: string) {
  const label = (id?: string | null) => (id === null ? "invalid / disabled" : id ? routedName(id) : "none");
  return `Image: ${label(defaults.image)}${automatic ? " (automatic default)" : ""} | Video: ${label(defaults.video)}`;
}

function pickerItems(rows: PickerRow[], defaults: MediaDefaults) {
  return [
    ...rows.map((row) => ({
      value: row.id,
      label: `${row.name} (${row.id})`,
      description: `${row.owner} | ${row.purpose}${row.disabledReason ? ` | ${row.disabledReason}` : ""}${defaults.image === row.id || defaults.video === row.id ? " | selected" : ""}`,
      supported: row.supported,
    })),
    ...(["image", "video"] as const).map((purpose) => ({
      value: `clear ${purpose}`,
      label: `Clear ${purpose} default`,
      description: defaults[purpose] === null ? "invalid / disabled" : (defaults[purpose] ?? "none"),
      supported: true,
    })),
  ];
}

export class ModelPicker extends Container implements Focusable {
  private input = new Input({
    prompt: "Search: ",
    placeholder: "name, ID, backend, owner, image/video",
  });
  private items: PickerItem[];
  private selected = 0;
  private list: SelectList;
  private visible = 1;
  private allItems: PickerItem[];
  private summary: string;
  private theme: ExtensionContext["ui"]["theme"];
  private kb: Pick<KeybindingsManager, "matches" | "getKeys">;
  private height: () => number;
  private rerender: () => void;
  private done: (value: string | undefined) => void;
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  constructor(
    allItems: PickerItem[],
    query: string,
    summary: string,
    theme: ExtensionContext["ui"]["theme"],
    kb: Pick<KeybindingsManager, "matches" | "getKeys">,
    height: () => number,
    rerender: () => void,
    done: (value: string | undefined) => void,
  ) {
    super();
    this.allItems = allItems;
    this.summary = summary;
    this.theme = theme;
    this.kb = kb;
    this.height = height;
    this.rerender = rerender;
    this.done = done;
    this.input.setValue(query);
    this.items = searchPickerItems(allItems, query);
    this.list = this.createList();
    this.addChild(this.input);
    this.addChild(this.list);
  }

  private createList() {
    const list = new SelectList(
      this.items,
      this.visible,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 80 },
    );
    list.setSelectedIndex(this.selected);
    return list;
  }

  private rebuild() {
    this.removeChild(this.list);
    this.list = this.createList();
    this.addChild(this.list);
  }

  override handleMouse(_event: TuiMouseEvent) {
    return undefined;
  }

  handleInput(data: string) {
    if (this.kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.kb.matches(data, "tui.select.confirm")) {
      const item = this.items[this.selected];
      if (item?.supported) this.done(item.value);
      return;
    }
    if (this.kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (this.kb.matches(data, "tui.select.down"))
      this.selected = Math.min(this.items.length - 1, this.selected + 1);
    else if (this.kb.matches(data, "tui.select.pageUp"))
      this.selected = Math.max(0, this.selected - this.visible);
    else if (this.kb.matches(data, "tui.select.pageDown"))
      this.selected = Math.min(this.items.length - 1, this.selected + this.visible);
    else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) {
        this.items = searchPickerItems(this.allItems, this.input.getValue());
        this.selected = 0;
      }
    }
    this.rebuild();
    this.rerender();
  }

  override render(width: number) {
    const height = Math.max(1, this.height());
    const visible = Math.max(1, Math.min(10, height - 7));
    if (visible !== this.visible) {
      this.visible = visible;
      this.rebuild();
    }
    const item = this.items[this.selected];
    const hint = `${this.kb.getKeys("tui.select.confirm").join("/")} select | ${this.kb.getKeys("tui.select.cancel").join("/")} cancel`;
    return [
      this.theme.fg("accent", "CLIProxyAPI images and videos (keyboard only; selection does not generate)"),
      this.summary,
      ...super.render(Math.max(4, width)),
      item ? `ID: ${item.value}` : "No matching models",
      item?.description ?? "",
      this.theme.fg("dim", hint),
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, Math.max(0, width)));
  }
}

export function registerModelPicker(pi: ExtensionAPI, config: Config) {
  let commandSequence = 0;
  const savedSequence = { image: 0, video: 0 };
  pi.registerCommand("cli:model", {
    description: "Search CLIProxyAPI image/video models and select a session media default",
    getArgumentCompletions: (prefix) =>
      ["list", "search ", "select ", "clear image", "clear video"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      const sequence = ++commandSequence;
      const report = (content: string, error = false) => {
        if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
        else if (ctx.mode === "print") console.error(content);
        else
          pi.sendMessage(
            { customType: "cliproxyapi-models", content, display: true },
            { triggerTurn: false },
          );
      };
      try {
        const input = args.trim();
        const clear = input === "clear image" ? "image" : input === "clear video" ? "video" : undefined;
        const save = (choice: string) => {
          const clearing =
            choice === "clear image" ? "image" : choice === "clear video" ? "video" : undefined;
          const capability = clearing ? undefined : mediaCapability(choice);
          const purpose = clearing ?? capability?.purpose;
          if (!purpose || capability?.disabledReason)
            throw new Error("Unsupported CLIProxyAPI media selection.");
          ctx.signal?.throwIfAborted();
          if (sequence < savedSequence[purpose]) {
            report(`CLIProxyAPI ${purpose} choice superseded by a newer command; no change saved.`);
            return;
          }
          const defaults = readMediaDefaults(config, ctx);
          if (clearing) delete defaults[purpose];
          else defaults[purpose] = choice;
          pi.appendEntry(MEDIA_DEFAULTS_ENTRY, { version: 1, endpoint: config.baseUrl, defaults });
          savedSequence[purpose] = sequence;
          const effective = effectiveMediaDefaults(config, ctx);
          report(defaultsLabel(effective.defaults, effective.automatic));
        };
        if (clear) {
          save(`clear ${clear}`);
          return;
        }
        if (input.startsWith("clear")) throw new Error("Usage: /cli:model clear image|video");
        const disabledReason = input.startsWith("select ")
          ? mediaCapability(input.slice(7).trim())?.disabledReason
          : undefined;
        if (disabledReason) {
          report(disabledReason, true);
          return;
        }
        const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(15000)]);
        const key = await mediaKey(ctx, signal);
        const rows = pickerCatalog(await fetchCatalog(config, key, signal));
        const { defaults, automatic } = effectiveMediaDefaults(config, ctx);
        const items = pickerItems(rows, defaults);
        const explicit = input.startsWith("select ") ? input.slice(7).trim() : undefined;
        const query = input === "list" ? "" : input.startsWith("search ") ? input.slice(7) : input;
        let choice = explicit;
        if (choice === undefined) {
          if (ctx.mode === "tui" && input !== "list") {
            choice = await ctx.ui.custom<string | undefined>(
              (tui, theme, kb, done) =>
                new ModelPicker(
                  items,
                  query,
                  defaultsLabel(defaults, automatic),
                  theme,
                  kb,
                  () => tui.terminal.rows,
                  () => tui.requestRender(),
                  done,
                ),
            );
          } else {
            const matches = searchPickerItems(items, query);
            report(
              [
                defaultsLabel(defaults, automatic),
                ...matches.slice(0, 100).map((item) => `${item.label} | ${item.description}`),
                ...(matches.length > 100
                  ? [`Showing 100 of ${matches.length}; narrow with /cli:model search <query>.`]
                  : []),
                "Use /cli:model select <exact ID> or /cli:model clear image|video. Selection does not generate.",
              ].join("\n"),
            );
            return;
          }
        }
        if (choice === undefined) return;
        if (choice === "clear image" || choice === "clear video") {
          save(choice);
          return;
        }
        const row = rows.find((row) => row.id === choice);
        if (!row?.supported)
          throw new Error("Model unavailable or unsupported. Use /cli:model to list supported IDs.");
        save(row.id);
      } catch {
        report(
          "CLIProxyAPI model selection failed: unavailable/unsupported model, invalid command, authentication, or connection error. Check /login cliproxyapi. Use /cli:model list, select <exact ID>, or clear image|video.",
          true,
        );
      }
    },
  });
}
