import { CouchDBClient } from "./couchdb.js";
import type { VaultConfig } from "./config.js";

export interface VaultEntry {
  id: string;
  label: string;
  client: CouchDBClient;
  config: VaultConfig;
}

export class VaultRegistry {
  private vaults: Map<string, VaultEntry> = new Map();

  constructor(
    vaultConfigs: VaultConfig[],
    options: { cacheTtl: number; requestTimeout: number },
  ) {
    for (const vc of vaultConfigs) {
      const url = this.buildCouchUrl(vc);
      const client = new CouchDBClient(url, vc.passphrase || undefined, {
        cacheTtl: options.cacheTtl,
        requestTimeout: options.requestTimeout,
      });
      this.vaults.set(vc.id, {
        id: vc.id,
        label: vc.label || vc.id,
        client,
        config: vc,
      });
    }
  }

  /**
   * Get a vault by ID.
   */
  get(vaultId: string): VaultEntry | undefined {
    return this.vaults.get(vaultId);
  }

  /**
   * Get all vault entries.
   */
  all(): VaultEntry[] {
    return Array.from(this.vaults.values());
  }

  /**
   * List vault IDs and labels (safe to expose to clients).
   */
  list(): { id: string; label: string }[] {
    return this.all().map((v) => ({ id: v.id, label: v.label }));
  }

  /**
   * Resolve which vault to use given an optional explicit vault parameter
   * and the list of vaults the user is authorized to access.
   *
   * Returns the CouchDBClient or throws with a helpful error.
   */
  resolve(explicitVault?: string, allowedVaults?: string[]): VaultEntry {
    // Filter to only allowed vaults
    const available = allowedVaults
      ? this.all().filter((v) => allowedVaults.includes(v.id))
      : this.all();

    if (available.length === 0) {
      throw new Error("No vaults available for your account.");
    }

    // Explicit vault specified
    if (explicitVault) {
      const entry = available.find((v) => v.id === explicitVault);
      if (!entry) {
        const ids = available.map((v) => v.id).join(", ");
        throw new Error(
          `Vault "${explicitVault}" not found or not authorized. Available: ${ids}`,
        );
      }
      return entry;
    }

    // Single vault available → use it implicitly
    if (available.length === 1) {
      return available[0];
    }

    // Ambiguous — multiple vaults, none specified
    const ids = available.map((v) => `${v.id} (${v.label})`).join(", ");
    throw new Error(
      `Multiple vaults available. Please specify which vault to use with the "vault" parameter. Available: ${ids}`,
    );
  }

  /**
   * Get the CouchDB health URL for a vault (without credentials).
   */
  getHealthUrl(vaultId: string): string | null {
    const entry = this.vaults.get(vaultId);
    if (!entry) return null;
    return entry.config.hostname;
  }

  private buildCouchUrl(vc: VaultConfig): string {
    const protocol = vc.hostname.startsWith("https://") ? "https" : "http";
    const baseHost = vc.hostname.replace(/^https?:\/\//, "");
    const credentials = vc.username
      ? `${vc.username}:${encodeURIComponent(vc.password)}@`
      : "";
    return `${protocol}://${credentials}${baseHost}/${vc.dbname}`;
  }
}
