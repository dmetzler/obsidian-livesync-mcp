import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const ORIG_ENV = { ...process.env };

describe("Config loading", () => {
  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    // Remove any config file that tests might have created
    delete process.env.VAULTS_CONFIG_FILE;
    vi.resetModules();
  });

  describe("Legacy env vars (single-vault)", () => {
    it("loads config from env vars into multi-vault format", async () => {
      process.env.hostname = "https://test.example.com";
      process.env.dbname = "testdb";
      process.env.username = "user";
      process.env.password = "pass";
      process.env.PASSPHRASE = "secret";
      process.env.MCP_API_KEY = "apikey123";
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_PORT = "9999";
      process.env.LOG_LEVEL = "debug";
      process.env.CACHE_TTL = "120";
      process.env.REQUEST_TIMEOUT = "60000";
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();
      // Should have one vault derived from env
      expect(config.vaults).toHaveLength(1);
      expect(config.vaults[0].hostname).toBe("https://test.example.com");
      expect(config.vaults[0].dbname).toBe("testdb");
      expect(config.vaults[0].passphrase).toBe("secret");
      expect(config.server.apiKey).toBe("apikey123");
      expect(config.server.transport).toBe("http");
      expect(config.server.port).toBe(9999);
      expect(config.couchdb.cacheTtl).toBe(120);
    });

    it("falls back to PASSPHRASE env var", async () => {
      process.env.hostname = "https://test.example.com";
      process.env.dbname = "testdb";
      process.env.PASSPHRASE = "secret";
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();
      expect(config.vaults[0].passphrase).toBe("secret");
    });

    it("uses defaults for optional fields", async () => {
      process.env.hostname = "https://test.example.com";
      process.env.dbname = "testdb";
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();
      expect(config.server.transport).toBe("stdio");
      expect(config.server.port).toBe(3100);
      expect(config.logging.level).toBe("info");
      expect(config.couchdb.cacheTtl).toBe(60);
      expect(config.couchdb.requestTimeout).toBe(30000);
    });

    it("throws on missing required fields", async () => {
      delete process.env.hostname;
      delete process.env.dbname;
      const { loadConfig } = await import("./config.js");
      expect(() => loadConfig()).toThrow();
    });
  });

  describe("JSON config file (multi-vault)", () => {
    const configPath = resolve("/tmp/test-vaults.json");

    beforeEach(() => {
      try { unlinkSync(configPath); } catch { /* ignore */ }
    });

    it("loads multi-vault config from JSON file", async () => {
      const cfg = {
        vaults: [
          {
            id: "vault1",
            label: "Test Vault",
            hostname: "https://couch.example.com",
            dbname: "db1",
            username: "admin",
            password: "pw",
            passphrase: "passphrase1",
          },
          {
            id: "vault2",
            hostname: "https://couch.example.com",
            dbname: "db2",
          },
        ],
        server: { transport: "http", port: 4000 },
      };
      writeFileSync(configPath, JSON.stringify(cfg));
      process.env.VAULTS_CONFIG_FILE = configPath;
      const { loadConfig } = await import("./config.js");
      const config = loadConfig();
      expect(config.vaults).toHaveLength(2);
      expect(config.vaults[0].id).toBe("vault1");
      expect(config.vaults[0].passphrase).toBe("passphrase1");
      expect(config.vaults[1].id).toBe("vault2");
      expect(config.server.port).toBe(4000);
      expect(config.auth.enabled).toBe(false);
    });

    it("validates required vault fields", async () => {
      const cfg = {
        vaults: [{ id: "x" }], // missing hostname and dbname
      };
      writeFileSync(configPath, JSON.stringify(cfg));
      process.env.VAULTS_CONFIG_FILE = configPath;
      const { loadConfig } = await import("./config.js");
      expect(() => loadConfig()).toThrow("Config validation failed");
    });
  });
});
