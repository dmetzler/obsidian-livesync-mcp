import { version } from "../package.json";
import type { Logger } from "./logger.js";

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  couchdb: "connected" | "error";
  version: string;
  uptime: number;
  error?: string;
}

const startTime = Date.now();

export async function checkHealth(couchdbBaseUrl: string, logger: Logger): Promise<HealthStatus> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(couchdbBaseUrl, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok || res.status === 401) {
      return {
        status: "ok",
        couchdb: "connected",
        version,
        uptime: Date.now() - startTime,
      };
    }
    return {
      status: "degraded",
      couchdb: "error",
      version,
      uptime: Date.now() - startTime,
      error: `CouchDB returned ${res.status}`,
    };
  } catch (err: any) {
    logger.error("Health check failed", { error: err.message });
    return {
      status: "error",
      couchdb: "error",
      version,
      uptime: Date.now() - startTime,
      error: err.message,
    };
  }
}
