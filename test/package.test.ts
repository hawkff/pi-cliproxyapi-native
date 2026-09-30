import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isRecord } from "../src/config.ts";

const run = promisify(execFile);

test("npm package contains only release files and loads without checkout dependencies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cliproxyapi-native-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    {
      timeout: 30000,
    },
  );
  const packed: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(packed) && packed.length === 1);
  const entry: unknown = packed[0];
  assert.ok(isRecord(entry) && Array.isArray(entry.files));
  assert.equal(entry.name, "pi-cliproxyapi-native");
  assert.ok(typeof entry.filename === "string");
  assert.equal(basename(entry.filename), entry.filename);
  assert.deepEqual(
    entry.files
      .map((file: unknown) => {
        assert.ok(isRecord(file) && typeof file.path === "string");
        return file.path;
      })
      .sort(),
    [
      "LICENSE",
      "README.md",
      "extensions/index.ts",
      "package.json",
      "src/catalog.ts",
      "src/config.ts",
      "src/media-defaults.ts",
      "src/media.ts",
      "src/picker.ts",
      "src/provider.ts",
    ],
  );
  await run("tar", ["-xzf", join(directory, entry.filename), "-C", directory], {
    timeout: 10000,
  });
  const manifest: unknown = JSON.parse(await readFile(join(directory, "package/package.json"), "utf8"));
  assert.ok(isRecord(manifest) && Array.isArray(manifest.keywords));
  for (const keyword of ["pi-package", "pi-extension", "cliproxyapi"])
    assert.ok(manifest.keywords.includes(keyword));
  assert.ok(isRecord(manifest.peerDependencies));
  for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"])
    assert.equal(manifest.peerDependencies[`@earendil-works/${name}`], "*");
  assert.equal(manifest.dependencies, undefined);
  const agent = pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      const { DefaultResourceLoader } = await import(${JSON.stringify(agent)});
      globalThis.fetch = () => assert.fail("Package loading must not access the network");
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: process.cwd(),
        noExtensions: true, noSkills: true, noContextFiles: true,
        additionalExtensionPaths: [${JSON.stringify(join(directory, "package"))}],
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
      assert.equal(loaded.runtime.pendingNativeProviderRegistrations[0].provider.id, "cliproxyapi");
      assert.deepEqual(loaded.extensions.flatMap(extension => [...extension.tools.keys()]).sort(), [
        "cliproxyapi_generate_image", "cliproxyapi_generate_video", "cliproxyapi_media_models", "cliproxyapi_video_status",
      ]);
      assert.deepEqual(loaded.extensions.flatMap(extension => [...extension.commands.keys()]).sort(), [
        "cli:model", "cliproxyapi-refresh",
      ]);
      `,
    ],
    {
      cwd: directory,
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PI_CODING_AGENT_DIR: directory,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    },
  );
});
