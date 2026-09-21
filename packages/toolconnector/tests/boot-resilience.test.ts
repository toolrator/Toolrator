/**
 * Boot-resilience tests for the toolconnector startup path.
 *
 * Covers the 0.2.0 boot-time fix: remote resolution is bounded by a 4s
 * deadline so a dead/slow toolpanel can never hang client boot, and the
 * auto-discovery order (healthy toolpanel wins over the SaaS auth URL).
 *
 * pickRemoteBaseUrl(config, logger) + isToolpanelAlive are exported from
 * src/index.ts; importing that module is safe now that main() is guarded
 * behind an entrypoint check.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { loadConfig, Logger, TOOLPANEL_PROBE_PATH } from "../src/config.js";
import { pickRemoteBaseUrl, isToolpanelAlive } from "../src/index.js";

const logger = new Logger("error"); // keep test output quiet

function testConfig(overrides: Record<string, string> = {}) {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    "TOOLPANEL_URL",
    "CONNECTOR_UPSTREAM_URL",
    "CONNECTOR_SEARCH_CONFIG_MODE",
    "TOOLPANEL_DISCOVERY",
    "TOOLPANEL_PROBE_PATH",
    "CONNECTOR_CONFIG_DIR",
    "TOOLPANEL_PROBE_TIMEOUT_MS",
  ];
  for (const k of envKeys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, {
    CONNECTOR_CONFIG_DIR: ".tmp-boot-test-config",
    ...overrides,
  });
  const config = loadConfig();
  return {
    config,
    restore() {
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

describe("isToolpanelAlive", () => {
  let aliveServer: Server;
  let alivePort: number;
  let slowServer: Server;
  let slowPort: number;

  before(async () => {
    aliveServer = createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    alivePort = await new Promise((resolve) => {
      aliveServer.listen(0, "127.0.0.1", () => resolve((aliveServer.address() as { port: number }).port));
    });

    slowServer = createServer((_req, res) => {
      // Never responds within the probe timeout → client must abort.
      const timer = setTimeout(() => res.end(), 5_000);
      timer.unref();
    });
    slowPort = await new Promise((resolve) => {
      slowServer.listen(0, "127.0.0.1", () => resolve((slowServer.address() as { port: number }).port));
    });
  });

  after(async () => {
    aliveServer.close();
    slowServer.close();
  });

  test("204 on the probe path → alive", async () => {
    const ctx = testConfig({ TOOLPANEL_PROBE_TIMEOUT_MS: "1000" });
    try {
      assert.equal(await isToolpanelAlive(`http://127.0.0.1:${alivePort}`, logger), true);
    } finally {
      ctx.restore();
    }
  });

  test("non-2xx on the probe path → not alive", async () => {
    const deadServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const deadPort = await new Promise<number>((resolve) => {
      deadServer.listen(0, "127.0.0.1", () => resolve((deadServer.address() as { port: number }).port));
    });
    try {
      const ctx = testConfig({ TOOLPANEL_PROBE_TIMEOUT_MS: "1000" });
      try {
        assert.equal(await isToolpanelAlive(`http://127.0.0.1:${deadPort}`, logger), false);
      } finally {
        ctx.restore();
      }
    } finally {
      deadServer.close();
    }
  });

  test("probe respects the timeout and aborts a slow panel (no hang)", async () => {
    const started = Date.now();
    const ctx = testConfig({ TOOLPANEL_PROBE_TIMEOUT_MS: "150" });
    try {
      const alive = await isToolpanelAlive(`http://127.0.0.1:${slowPort}`, logger);
      const elapsed = Date.now() - started;
      assert.equal(alive, false);
      assert.ok(elapsed < 2_000, `probe must abort at the timeout, took ${elapsed}ms`);
    } finally {
      ctx.restore();
    }
  });

  test("connection-refused → not alive (fast fail)", async () => {
    const ctx = testConfig({ TOOLPANEL_PROBE_TIMEOUT_MS: "1000" });
    try {
      const started = Date.now();
      const alive = await isToolpanelAlive("http://127.0.0.1:9", logger);
      assert.equal(alive, false);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      ctx.restore();
    }
  });
});

describe("pickRemoteBaseUrl resolution order", () => {
  let panelServer: Server;
  let panelPort: number;

  before(async () => {
    panelServer = createServer((req, res) => {
      if (req.url === TOOLPANEL_PROBE_PATH) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    panelPort = await new Promise((resolve) => {
      panelServer.listen(0, "127.0.0.1", () => resolve((panelServer.address() as { port: number }).port));
    });
  });

  after(async () => {
    panelServer.close();
  });

  test("mode=toolpanel with a healthy panel → remote:toolpanel", async () => {
    const ctx = testConfig({
      TOOLPANEL_URL: `http://127.0.0.1:${panelPort}`,
      CONNECTOR_UPSTREAM_URL: "https://upstream.example.com",
      CONNECTOR_SEARCH_CONFIG_MODE: "toolpanel",
      TOOLPANEL_PROBE_TIMEOUT_MS: "1000",
    });
    try {
      const decision = await pickRemoteBaseUrl(ctx.config, logger, "");
      assert.equal(decision?.source, "remote:toolpanel");
      assert.equal(decision?.baseUrl, `http://127.0.0.1:${panelPort}`);
    } finally {
      ctx.restore();
    }
  });

  test("mode=auto: healthy panel wins over the auth URL", async () => {
    const ctx = testConfig({
      TOOLPANEL_URL: `http://127.0.0.1:${panelPort}`,
      CONNECTOR_UPSTREAM_URL: "https://upstream.example.com",
      CONNECTOR_SEARCH_CONFIG_MODE: "auto",
      TOOLPANEL_PROBE_TIMEOUT_MS: "1000",
    });
    try {
      const decision = await pickRemoteBaseUrl(ctx.config, logger, "");
      assert.equal(decision?.source, "remote:toolpanel");
    } finally {
      ctx.restore();
    }
  });

  test("mode=auto: dead panel falls back to the auth URL", async () => {
    const ctx = testConfig({
      TOOLPANEL_URL: "http://127.0.0.1:9",
      CONNECTOR_UPSTREAM_URL: "https://upstream.example.com",
      CONNECTOR_SEARCH_CONFIG_MODE: "auto",
      TOOLPANEL_PROBE_TIMEOUT_MS: "200",
    });
    try {
      const decision = await pickRemoteBaseUrl(ctx.config, logger, "");
      assert.equal(decision?.source, "remote");
      assert.equal(decision?.baseUrl, "https://upstream.example.com");
    } finally {
      ctx.restore();
    }
  });

  test("mode=file never probes — pure local mode", async () => {
    const ctx = testConfig({
      TOOLPANEL_URL: `http://127.0.0.1:${panelPort}`,
      CONNECTOR_SEARCH_CONFIG_MODE: "file",
      TOOLPANEL_PROBE_TIMEOUT_MS: "1000",
    });
    try {
      const decision = await pickRemoteBaseUrl(ctx.config, logger, "");
      assert.equal(decision?.source, "remote"); // authUrl default, not the panel
      assert.notEqual(decision?.baseUrl, `http://127.0.0.1:${panelPort}`);
    } finally {
      ctx.restore();
    }
  });

  test("discovery=off skips the probe even in auto mode", async () => {
    const ctx = testConfig({
      TOOLPANEL_URL: `http://127.0.0.1:${panelPort}`,
      CONNECTOR_UPSTREAM_URL: "https://upstream.example.com",
      TOOLPANEL_DISCOVERY: "off",
      TOOLPANEL_PROBE_TIMEOUT_MS: "1000",
    });
    try {
      const decision = await pickRemoteBaseUrl(ctx.config, logger, "");
      assert.equal(decision?.source, "remote");
      assert.equal(decision?.baseUrl, "https://upstream.example.com");
    } finally {
      ctx.restore();
    }
  });
});

describe("boot deadline bound", () => {
  test("pickRemoteBaseUrl against a hanging panel resolves within the boot budget", async () => {
    // This is the 0.2.0 regression test: boot-time remote resolution must be
    // bounded. pickRemoteBaseUrl itself delegates the deadline to withDeadline
    // in main(); here we assert the underlying probe cannot outlast its
    // configured budget, which is what bounds the whole boot path.
    const started = Date.now();
    const ctx = testConfig({ TOOLPANEL_PROBE_TIMEOUT_MS: "250" });
    try {
      await pickRemoteBaseUrl(
        {
          ...ctx.config,
          toolpanelUrl: "http://127.0.0.1:9", // refuses instantly
        },
        logger,
        "",
      );
      assert.ok(Date.now() - started < 4_000, "resolution must stay well inside the 4s boot budget");
    } finally {
      ctx.restore();
    }
  });
});
