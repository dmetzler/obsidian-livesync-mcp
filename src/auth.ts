import type { IncomingMessage } from "node:http";
import type { AuthConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface AuthContext {
  authenticated: boolean;
  subject?: string;
  allowedVaults?: string[];
}

/**
 * Authenticator supporting:
 * - Bearer API key (simple static token)
 * - Bearer JWT (Keycloak OIDC with JWKS validation)
 * - No auth (when disabled)
 */
export class Authenticator {
  private config: AuthConfig;
  private apiKey: string;
  private logger: Logger;
  private jwksClient: any = null;
  private cachedKeys: Map<string, any> = new Map();

  constructor(config: AuthConfig, apiKey: string, logger: Logger) {
    this.config = config;
    this.apiKey = apiKey;
    this.logger = logger;
  }

  /**
   * Authenticate an incoming HTTP request.
   * Returns AuthContext with the user's identity and allowed vaults.
   */
  async authenticate(req: IncomingMessage): Promise<AuthContext> {
    // If auth is completely disabled and no API key set
    if (!this.config.enabled && !this.apiKey) {
      return { authenticated: true };
    }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return { authenticated: false };
    }

    const token = authHeader.slice(7);

    // Try API key first (fast path)
    if (this.apiKey && token === this.apiKey) {
      // API key gives access to all vaults
      return { authenticated: true, subject: "_apikey" };
    }

    // If Keycloak auth is enabled, try JWT validation
    if (this.config.enabled && this.config.jwksUri) {
      return this.validateJwt(token);
    }

    return { authenticated: false };
  }

  /**
   * Check if auth is required for requests.
   */
  isAuthRequired(): boolean {
    return this.config.enabled || !!this.apiKey;
  }

  private async validateJwt(token: string): Promise<AuthContext> {
    try {
      const { createPublicKey, createVerify } = await import("node:crypto");

      const [headerB64, payloadB64, signatureB64] = token.split(".");
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
      const kid = header.kid;

      // Get signing key (JWK)
      const jwk = await this.getSigningJwk(kid);
      if (!jwk) {
        this.logger.warn("JWT validation failed: unknown kid", { kid });
        return { authenticated: false };
      }

      // Create key object from JWK and verify signature
      const keyObject = createPublicKey({ key: jwk, format: "jwk" });
      const data = `${headerB64}.${payloadB64}`;

      const alg = header.alg === "RS384" ? "RSA-SHA384" : "RSA-SHA256";
      const verify = createVerify(alg);
      verify.update(data);
      const valid = verify.verify(keyObject, signatureB64, "base64url");

      if (!valid) {
        this.logger.warn("JWT signature invalid");
        return { authenticated: false };
      }

      // Decode payload
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        this.logger.warn("JWT expired", { sub: payload.sub, exp: payload.exp });
        return { authenticated: false };
      }

      // Check issuer
      if (this.config.issuer && payload.iss !== this.config.issuer) {
        this.logger.warn("JWT issuer mismatch", { expected: this.config.issuer, got: payload.iss });
        return { authenticated: false };
      }

      // Check audience
      if (this.config.audience) {
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!aud.includes(this.config.audience)) {
          this.logger.warn("JWT audience mismatch", { expected: this.config.audience, got: payload.aud });
          return { authenticated: false };
        }
      }

      // Extract vaults claim
      const vaultsClaim = this.config.vaultsClaim || "vaults";
      const allowedVaults = payload[vaultsClaim] as string[] | undefined;

      return {
        authenticated: true,
        subject: payload.sub,
        allowedVaults: Array.isArray(allowedVaults) ? allowedVaults : undefined,
      };
    } catch (err: any) {
      this.logger.error("JWT validation error", { error: err.message });
      return { authenticated: false };
    }
  }

  private async getSigningJwk(kid: string): Promise<any | null> {
    if (this.cachedKeys.has(kid)) {
      return this.cachedKeys.get(kid);
    }

    if (!this.config.jwksUri) return null;

    try {
      const response = await fetch(this.config.jwksUri);
      if (!response.ok) {
        this.logger.error("JWKS fetch failed", { status: response.status });
        return null;
      }

      const jwks = (await response.json()) as { keys: any[] };
      for (const key of jwks.keys) {
        if (key.kid) {
          this.cachedKeys.set(key.kid, key);
        }
      }

      return this.cachedKeys.get(kid) || null;
    } catch (err: any) {
      this.logger.error("JWKS fetch error", { error: err.message });
      return null;
    }
  }
}
