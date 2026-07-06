import { loadConfig } from "./config.js";
import { Logger, setLogLevel } from "./logger.js";
import { VaultRegistry } from "./vault-registry.js";
import { MCPServer } from "./mcp-server.js";

let config;
try {
  config = loadConfig();
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

setLogLevel(config.logging.level);
const log = new Logger("main");

log.info("Config loaded", {
  vaults: config.vaults.map((v) => v.id),
  transport: config.server.transport,
  port: config.server.port,
  authEnabled: config.auth.enabled,
  logLevel: config.logging.level,
  nodeVersion: process.version,
});

const registry = new VaultRegistry(config.vaults, {
  cacheTtl: config.couchdb.cacheTtl,
  requestTimeout: config.couchdb.requestTimeout,
});

const server = new MCPServer({
  config,
  registry,
  logger: log.child("mcp"),
});

async function shutdown(signal: string) {
  log.info("Shutting down", { signal });
  await server.stop();
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.start(config.server.transport).catch((err) => {
  log.error("Failed to start server", { error: err.message });
  process.exit(1);
});
