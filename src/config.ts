import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Vault configuration schema ---

const VaultSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  hostname: z.string().url(),
  dbname: z.string().min(1),
  username: z.string().default(""),
  password: z.string().default(""),
  passphrase: z.string().default(""),
  allowedSubjects: z.array(z.string()).optional(),
});

export type VaultConfig = z.infer<typeof VaultSchema>;

// --- Auth configuration schema ---

const AuthSchema = z.object({
  enabled: z.boolean().default(false),
  issuer: z.string().url().optional(),
  jwksUri: z.string().url().optional(),
  audience: z.string().optional(),
  vaultsClaim: z.string().default("vaults"),
});

export type AuthConfig = z.infer<typeof AuthSchema>;

// --- Full configuration schema (JSON file mode) ---

const MultiVaultConfigSchema = z.object({
  vaults: z.array(VaultSchema).min(1),
  auth: AuthSchema.optional().default({ enabled: false }),
  server: z
    .object({
      transport: z.enum(["stdio", "sse", "http"]).default("http"),
      port: z.coerce.number().int().positive().default(3100),
      apiKey: z.string().default(""),
    })
    .optional()
    .default({}),
  logging: z
    .object({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    })
    .optional()
    .default({}),
  couchdb: z
    .object({
      cacheTtl: z.coerce.number().int().nonnegative().default(60),
      requestTimeout: z.coerce.number().int().positive().default(30000),
    })
    .optional()
    .default({}),
});

export type MultiVaultConfig = z.infer<typeof MultiVaultConfigSchema>;

// --- Legacy single-vault config (env vars) ---

const LegacyConfigSchema = z.object({
  hostname: z.string().url(),
  dbname: z.string().min(1),
  username: z.string().default(""),
  password: z.string().default(""),
  passphrase: z.string().default(""),
  mcpApiKey: z.string().default(""),
  mcpTransport: z.enum(["stdio", "sse", "http"]).default("stdio"),
  mcpPort: z.coerce.number().int().positive().default(3100),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  cacheTtl: z.coerce.number().int().nonnegative().default(60),
  requestTimeout: z.coerce.number().int().positive().default(30000),
});

// --- Unified config output ---

export interface AppConfig {
  vaults: VaultConfig[];
  auth: AuthConfig;
  server: {
    transport: "stdio" | "sse" | "http";
    port: number;
    apiKey: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  couchdb: {
    cacheTtl: number;
    requestTimeout: number;
  };
}

/**
 * Load configuration. Priority:
 * 1. VAULTS_CONFIG_FILE env var → JSON file (multi-vault mode)
 * 2. vaults.json in CWD (multi-vault mode)
 * 3. Legacy env vars (single-vault mode, backward compat)
 */
export function loadConfig(): AppConfig {
  // Try loading .env file
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file
  }

  // Check for JSON config file
  const configPath = process.env.VAULTS_CONFIG_FILE || findConfigFile();
  if (configPath) {
    return loadMultiVaultConfig(configPath);
  }

  // Fallback: legacy single-vault env vars
  return loadLegacyConfig();
}

function findConfigFile(): string | null {
  const candidates = [resolve(process.cwd(), "vaults.json"), resolve("/etc/obsidian-mcp/vaults.json")];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadMultiVaultConfig(filePath: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    throw new Error(`Failed to read config file ${filePath}: ${err.message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`Invalid JSON in config file ${filePath}: ${err.message}`);
  }

  const parsed = MultiVaultConfigSchema.safeParse(json);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed (${filePath}):\n${msgs}`);
  }

  const cfg = parsed.data;
  return {
    vaults: cfg.vaults,
    auth: cfg.auth,
    server: {
      transport: cfg.server.transport,
      port: cfg.server.port,
      apiKey: cfg.server.apiKey,
    },
    logging: { level: cfg.logging.level },
    couchdb: {
      cacheTtl: cfg.couchdb.cacheTtl,
      requestTimeout: cfg.couchdb.requestTimeout,
    },
  };
}

function loadLegacyConfig(): AppConfig {
  const parsed = LegacyConfigSchema.safeParse({
    hostname: getEnv("hostname"),
    dbname: getEnv("dbname"),
    username: getEnv("username"),
    password: getEnv("password"),
    passphrase: getEnv("passphrase") || getEnv("PASSPHRASE"),
    mcpApiKey: getEnv("MCP_API_KEY"),
    mcpTransport: getEnv("MCP_TRANSPORT") || "stdio",
    mcpPort: getEnv("MCP_PORT") || "3100",
    logLevel: getEnv("LOG_LEVEL") || "info",
    cacheTtl: getEnv("CACHE_TTL") || "60",
    requestTimeout: getEnv("REQUEST_TIMEOUT") || "30000",
  });

  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${msgs}`);
  }

  const cfg = parsed.data;

  // Convert single-vault env config to multi-vault format
  const vaultId = cfg.dbname.replace(/[^a-z0-9_-]/gi, "_");
  return {
    vaults: [
      {
        id: vaultId,
        hostname: cfg.hostname,
        dbname: cfg.dbname,
        username: cfg.username,
        password: cfg.password,
        passphrase: cfg.passphrase,
      },
    ],
    auth: { enabled: false, vaultsClaim: "vaults" },
    server: {
      transport: cfg.mcpTransport,
      port: cfg.mcpPort,
      apiKey: cfg.mcpApiKey,
    },
    logging: { level: cfg.logLevel },
    couchdb: {
      cacheTtl: cfg.cacheTtl,
      requestTimeout: cfg.requestTimeout,
    },
  };
}

function getEnv(key: string): string {
  return process.env[key] || "";
}
