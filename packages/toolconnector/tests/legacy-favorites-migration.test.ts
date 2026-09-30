/**
 * Boot-migration test for the removed `manage_favorites` tool.
 *
 * The tool and its `favorites.json` store are gone, so a config dir written by
 * an older install now holds a file nothing reads. `removeLegacyFavoritesFile`
 * drops it once at boot; this locks that it actually deletes the file, stays
 * silent/idempotent when there is nothing to clean, and never throws.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "../src/config.js";
import { removeLegacyFavoritesFile } from "../src/index.js";

const logger = new Logger("error"); // keep test output quiet

let configDir: string;
const favoritesPath = () => join(configDir, "favorites.json");

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("removeLegacyFavoritesFile: boot migration", () => {
  before(async () => {
    configDir = await mkdtemp(join(tmpdir(), "toolconnector-favmigration-"));
  });

  after(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  test("deletes a favorites.json left behind by an older install", async () => {
    await writeFile(
      favoritesPath(),
      JSON.stringify([{ mcpNameOrUrl: "http://localhost:8080/mcp", savedAt: "2026-01-01" }]),
      "utf-8",
    );
    assert.equal(await exists(favoritesPath()), true, "precondition: file exists");

    const removed = await removeLegacyFavoritesFile(configDir, logger);

    assert.equal(removed, true, "expected the migration to report a removal");
    assert.equal(await exists(favoritesPath()), false, "favorites.json should be gone");
  });

  test("is idempotent — a second call on a clean dir removes nothing and does not throw", async () => {
    assert.equal(await exists(favoritesPath()), false, "precondition: already clean");

    const removed = await removeLegacyFavoritesFile(configDir, logger);

    assert.equal(removed, false, "nothing to remove should report false");
  });

  test("leaves every other config-dir file untouched", async () => {
    const credentials = join(configDir, "credentials.json");
    const engines = join(configDir, "search-engines.json");
    await writeFile(credentials, JSON.stringify({ api_key: "sk-test" }), "utf-8");
    await writeFile(engines, JSON.stringify([]), "utf-8");

    // A second stale favorites.json, to prove the migration is not over-eager.
    await writeFile(favoritesPath(), "[]", "utf-8");
    await removeLegacyFavoritesFile(configDir, logger);

    assert.equal(await readFile(credentials, "utf-8"), JSON.stringify({ api_key: "sk-test" }));
    assert.equal(await readFile(engines, "utf-8"), JSON.stringify([]));
  });
});
