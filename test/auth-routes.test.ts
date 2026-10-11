import assert from "node:assert/strict";
import { test } from "node:test";
import { mapCatalog, mapMediaCatalog, mediaCapability, mediaControls } from "../src/catalog.ts";
import { PROVIDER_ID, parseConfig } from "../src/config.ts";
import { automaticImageDefault, OPENAI_IMAGE_DEFAULT } from "../src/media-defaults.ts";
import { pickerCatalog, searchPickerItems } from "../src/picker.ts";
import { builtinCatalog } from "../src/provider.ts";

const mediaIds = ["gpt-image-1.5", "gemini-3-pro-image", "grok-imagine-image", "grok-imagine-video"];

test("auth-prefixed media retains its execution route, controls and searchable labels", () => {
  for (const prefix of ["api", "oauth"]) {
    const ids = mediaIds.map((id) => `${prefix}/${id}`);
    const catalog = { data: ids.map((id) => ({ id })) };
    const models = mapMediaCatalog(catalog);
    assert.deepEqual(
      models.map((model) => model.id),
      ids,
    );
    for (const [index, id] of ids.entries()) {
      assert.equal(mediaCapability(id)?.route, mediaCapability(mediaIds[index])?.route);
      assert.deepEqual(mediaControls(id), mediaControls(mediaIds[index]));
      assert.match(models[index].name, prefix === "api" ? / · API key$/ : / · OAuth$/);
    }
    const rows = pickerCatalog(catalog);
    assert.equal(rows.length, ids.length);
    assert.ok(rows.every((row) => row.supported));
    assert.deepEqual(
      searchPickerItems(
        rows.map((row) => ({
          value: row.id,
          label: row.name,
          description: row.backend,
          supported: row.supported,
        })),
        prefix === "api" ? "API key" : "OAuth",
      ).map((row) => row.value),
      ids,
    );
  }
});

test("auth prefixes preserve hidden, retired and unknown media exclusions", () => {
  for (const prefix of ["api", "oauth"]) {
    const retired = `${prefix}/imagen-4.0-generate-001`;
    const unknown = `${prefix}/future-image`;
    const hidden = `${prefix}/gpt-image-1.5`;
    const catalog = { data: [{ id: retired }, { id: unknown }, { id: hidden, visibility: "hide" }] };
    assert.deepEqual(mapMediaCatalog(catalog), []);
    const rows = pickerCatalog(catalog);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, retired);
    assert.equal(rows[0].supported, false);
    assert.match(rows[0].disabledReason ?? "", /Retired/);
  }
  for (const id of ["custom/gpt-image-1.5", "API/gpt-image-1.5", "api/custom/gpt-image-1.5"])
    assert.equal(mediaCapability(id), undefined);
  assert.match(mediaCapability("vertex/gpt-image-1.5")?.disabledReason ?? "", /Unsupported/);
});

test("auth-prefixed media cannot become chat through metadata aliases", () => {
  const known = builtinCatalog();
  const reference = known.find((model) => model.provider === "openai");
  assert.ok(reference);
  const ids = ["api/gpt-image-1.5", "oauth/grok-imagine-video"];
  const config = parseConfig({
    aliases: Object.fromEntries(ids.map((id) => [id, `openai/${reference.id}`])),
  });
  assert.deepEqual(mapCatalog({ data: ids.map((id) => ({ id })) }, config, known).models, []);
});

test("automatic media selection remains separate from the chat credential route", () => {
  const reference = builtinCatalog().find((model) => model.provider === "openai");
  assert.ok(reference);
  for (const prefix of ["api", "oauth"]) {
    const model: typeof reference = { ...reference, provider: PROVIDER_ID, id: `${prefix}/gpt-fixture` };
    assert.equal(automaticImageDefault(parseConfig({}), { model }), OPENAI_IMAGE_DEFAULT);
    const config = parseConfig({ aliases: { "team-chat": "openai/gpt-fixture" } });
    const aliasModel: typeof reference = { ...model, id: `${prefix}/team-chat` };
    assert.equal(automaticImageDefault(config, { model: aliasModel }), OPENAI_IMAGE_DEFAULT);
    config.aliases[aliasModel.id] = "anthropic/claude-fixture";
    assert.equal(automaticImageDefault(config, { model: aliasModel }), undefined);
  }
});
