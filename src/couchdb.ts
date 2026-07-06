import PouchDB from "pouchdb";
import PouchHttp from "pouchdb-adapter-http";
import transformPouch from "transform-pouch";
import "pouchdb-mapreduce";
import "pouchdb-replication";
import "pouchdb-find";

PouchDB.plugin(PouchHttp);
PouchDB.plugin(transformPouch);

import { IDPrefixes } from "@lib/common/models/shared.const.behabiour";
import { EntryTypes } from "@lib/common/models/db.const";
import { decrypt as decryptHKDFImport, encrypt as encryptHKDFImport } from "octagonal-wheels/encryption/hkdf";
import type { DocumentID } from "@lib/common/models/db.type";
import { path2id_base } from "@lib/string_and_binary/path";
import crypto from "node:crypto";

export interface FileInfo {
  path: string;
  type: string;
  size: number;
  mtime: number;
  ctime: number;
}

export interface SearchResult {
  path: string;
  snippet: string;
  matchType: "filename" | "content";
  totalMatches: number;
}

export interface CouchDBOptions {
  cacheTtl?: number;
  requestTimeout?: number;
}

const ENCRYPTED_META_PREFIX = "/\\:";

function isEncryptedMetaPath(path: string): boolean {
  return path.startsWith(ENCRYPTED_META_PREFIX);
}

interface DecryptedMeta {
  path: string;
  children: string[];
  mtime: number;
  ctime: number;
  size: number;
}

export class CouchDBClient {
  private db: PouchDB.Database;
  private passphrase: string | undefined;
  private cacheTtl: number;
  private requestTimeout: number;
  private cachedSalt: Uint8Array<ArrayBuffer> | null = null;
  private decryptHKDF:
    | ((input: string, passphrase: string, salt: Uint8Array<ArrayBufferLike>) => Promise<string>)
    | null = decryptHKDFImport as any;
  private logger: any;

  constructor(url: string, passphrase?: string, options?: CouchDBOptions & { logger?: any }) {
    this.db = new PouchDB(url, { adapter: "http" });
    this.passphrase = passphrase;
    this.cacheTtl = options?.cacheTtl ?? 60;
    this.requestTimeout = options?.requestTimeout ?? 30000;
    this.logger = options?.logger;
  }

  private async getDecryptFn(): Promise<
    (input: string, passphrase: string, salt: Uint8Array<ArrayBufferLike>) => Promise<string>
  > {
    return this.decryptHKDF!;
  }

  private async getPbkdf2Salt(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.cachedSalt) return this.cachedSalt;
    try {
      const doc = await this.retry(() => this.db.get<any>("_local/obsidian_livesync_sync_parameters"));
      if (doc?.pbkdf2salt) {
        const salt = Uint8Array.from(Buffer.from(doc.pbkdf2salt, "base64"));
        this.cachedSalt = salt;
        return salt;
      }
    } catch {
      // fall through to default
    }
    const salt = Uint8Array.from(
      crypto
        .createHash("sha256")
        .update(this.passphrase || "")
        .digest(),
    );
    this.cachedSalt = salt;
    return salt;
  }

  /**
   * Decrypt an encrypted metadata path and return the full metadata object.
   * Returns null if decryption fails.
   */
  private async decryptMeta(doc: any): Promise<DecryptedMeta | null> {
    const filePath = doc.path;
    if (!filePath) return null;
    if (!isEncryptedMetaPath(filePath) || !this.passphrase) {
      // Not encrypted — use doc fields directly
      return {
        path: filePath,
        children: doc.children || [],
        mtime: doc.mtime || 0,
        ctime: doc.ctime || 0,
        size: doc.size || 0,
      };
    }
    try {
      const encrypted = filePath.slice(ENCRYPTED_META_PREFIX.length);
      const salt = await this.getPbkdf2Salt();
      const decrypt = await this.getDecryptFn();
      const decrypted = await decrypt(encrypted, this.passphrase, salt);
      const parsed = JSON.parse(decrypted);
      return {
        path: parsed.path,
        children: parsed.children || [],
        mtime: parsed.mtime || 0,
        ctime: parsed.ctime || 0,
        size: parsed.size || 0,
      };
    } catch (e: any) {
      this.logger?.debug?.("decryptMeta failed", { docId: doc._id, error: e?.message?.slice(0, 100) });
      return null;
    }
  }

  /**
   * Decrypt chunk data (h:+ encrypted chunks).
   */
  private async decryptChunkData(data: string): Promise<string> {
    if (!this.passphrase || !data.startsWith("%=")) return data;
    const salt = await this.getPbkdf2Salt();
    const decrypt = await this.getDecryptFn();
    return await decrypt(data, this.passphrase, salt);
  }

  async listFiles(prefix?: string): Promise<FileInfo[]> {
    // With E2EE, doc IDs are obfuscated hashes — we must scan all f: docs
    const result = await this.retry(() =>
      this.db.allDocs<any>({
        include_docs: true,
        startkey: "f:",
        endkey: "f:\uffff",
      }),
    );

    const files: FileInfo[] = [];
    const lowerPrefix = prefix?.toLowerCase();

    for (const row of result.rows) {
      if (!("doc" in row) || !row.doc || row.doc._deleted || row.doc.deleted) continue;
      const doc = row.doc;
      if (doc.type !== EntryTypes.NOTE_PLAIN && doc.type !== EntryTypes.NOTE_BINARY) continue;

      const meta = await this.decryptMeta(doc);
      if (!meta) continue;

      // Apply prefix filter on the decrypted path
      if (lowerPrefix && !meta.path.toLowerCase().startsWith(lowerPrefix)) continue;

      files.push({
        path: meta.path,
        type: doc.type,
        size: meta.size,
        mtime: meta.mtime,
        ctime: meta.ctime,
      });
    }
    return files;
  }

  async getFileContent(path: string): Promise<string | null> {
    // Find the doc — first try obfuscated ID, then scan
    const meta = await this.findDocByPath(path);
    if (!meta) return null;

    if (!meta.children || meta.children.length === 0) return "";

    // Fetch all chunks
    const chunks = await this.retry(() =>
      this.db.allDocs<any>({
        keys: meta.children,
        include_docs: true,
      }),
    );

    let content = "";
    for (const row of chunks.rows) {
      if (!("doc" in row) || !row.doc) continue;
      const data = row.doc.data || "";
      // Decrypt chunk if encrypted
      content += await this.decryptChunkData(data);
    }
    return content;
  }

  /**
   * Find doc metadata by path. Tries obfuscated ID lookup first,
   * falls back to scanning if needed.
   */
  private async findDocByPath(path: string): Promise<DecryptedMeta | null> {
    // Try direct lookup via obfuscated ID
    const docId = await this.pathToId(path);
    try {
      const doc = await this.retry(() => this.db.get<any>(docId));
      if (doc.deleted || doc._deleted) return null;
      const meta = await this.decryptMeta(doc);
      if (meta && meta.path.toLowerCase() === path.toLowerCase()) return meta;
    } catch (err: any) {
      if (err.status !== 404) throw err;
    }

    // Fallback: scan all f: docs to find by decrypted path
    const result = await this.retry(() =>
      this.db.allDocs<any>({
        include_docs: true,
        startkey: "f:",
        endkey: "f:\uffff",
      }),
    );

    for (const row of result.rows) {
      if (!("doc" in row) || !row.doc || row.doc._deleted || row.doc.deleted) continue;
      const doc = row.doc;
      if (doc.type !== EntryTypes.NOTE_PLAIN && doc.type !== EntryTypes.NOTE_BINARY) continue;
      const meta = await this.decryptMeta(doc);
      if (meta && meta.path.toLowerCase() === path.toLowerCase()) return meta;
    }

    return null;
  }

  async storeContent(path: string, content: string): Promise<boolean> {
    try {
      const docId = await this.pathToId(path);
      const chunkHash = crypto.createHash("sha256").update(content).digest("hex");
      const chunkId = this.passphrase ? `${IDPrefixes.EncryptedChunk}${chunkHash}` : `${IDPrefixes.Chunk}${chunkHash}`;

      let existingMeta: any = null;
      let oldChildren: string[] = [];
      try {
        existingMeta = await this.retry(() => this.db.get(docId));
        // Get old children from encrypted metadata
        const meta = await this.decryptMeta(existingMeta);
        oldChildren = meta?.children || [];
      } catch {
        // new file
      }

      // Store chunk (encrypted if E2EE is enabled)
      let chunkData = content;
      if (this.passphrase) {
        const salt = await this.getPbkdf2Salt();
        chunkData = await encryptHKDFImport(content, this.passphrase, salt);
      }

      const chunkBody: Record<string, any> = {
        _id: chunkId,
        type: EntryTypes.CHUNK,
        data: chunkData,
      };
      if (this.passphrase) chunkBody.e_ = true;

      try {
        await this.retry(() => this.db.get(chunkId));
      } catch {
        await this.retry(() => this.db.put(chunkBody));
      }

      // Build metadata
      const now = Date.now();
      const storeCtime = existingMeta ? (await this.decryptMeta(existingMeta))?.ctime || now : now;

      const metaPayload: DecryptedMeta = {
        path: path,
        children: [chunkId],
        ctime: storeCtime,
        mtime: now,
        size: Buffer.byteLength(content, "utf-8"),
      };

      // Encrypt metadata into path field
      let storedPath: string = path;
      if (this.passphrase) {
        const salt = await this.getPbkdf2Salt();
        const encrypted = await encryptHKDFImport(JSON.stringify(metaPayload), this.passphrase, salt);
        storedPath = ENCRYPTED_META_PREFIX + encrypted;
      }

      const entry: any = {
        _id: docId,
        type: EntryTypes.NOTE_PLAIN,
        path: this.passphrase ? storedPath : path,
        children: this.passphrase ? [] : [chunkId],
        ctime: this.passphrase ? 0 : storeCtime,
        mtime: this.passphrase ? 0 : now,
        size: this.passphrase ? 0 : metaPayload.size,
        ...(this.passphrase ? { eden: {} } : {}),
      };

      if (existingMeta) {
        entry._rev = existingMeta._rev;
      }

      await this.retry(() => this.db.put(entry));

      // Clean up old chunks
      for (const oldChunkId of oldChildren) {
        if (oldChunkId !== chunkId) {
          try {
            const oldChunk = await this.retry(() => this.db.get(oldChunkId));
            await this.retry(() => this.db.put({ ...oldChunk, _deleted: true }));
          } catch {
            // ignore
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(path: string): Promise<boolean> {
    try {
      const docId = await this.pathToId(path);
      const doc = await this.retry(() => this.db.get<any>(docId));
      if (doc._deleted || doc.deleted) return false;

      // Get real children from encrypted metadata
      const meta = await this.decryptMeta(doc);
      const children = meta?.children || [];

      for (const childId of children) {
        try {
          const chunk = await this.retry(() => this.db.get(childId));
          await this.retry(() => this.db.put({ ...chunk, _deleted: true }));
        } catch {
          // chunk may already be deleted
        }
      }

      await this.retry(() => this.db.put({ ...doc, _deleted: true }));
      return true;
    } catch (err: any) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<boolean> {
    const content = await this.getFileContent(oldPath);
    if (content === null) return false;

    // Check if target exists — try direct ID lookup
    const targetId = await this.pathToId(newPath);
    try {
      const targetDoc = await this.retry(() => this.db.get<any>(targetId));
      if (targetDoc && !targetDoc._deleted && !targetDoc.deleted) {
        throw new Error(`Target path already exists: ${newPath}`);
      }
    } catch (err: any) {
      if (err.message?.includes("Target path already exists")) throw err;
      // 404 = good, target doesn't exist
    }

    await this.storeContent(newPath, content);
    await this.deleteFile(oldPath);
    return true;
  }

  async search(query: string): Promise<{
    results: SearchResult[];
    truncated: boolean;
    totalCandidateCount: number;
  }> {
    // Only scan note docs (f: prefix) — avoids loading chunks/design docs into memory
    const allDocs = await this.retry(() =>
      this.db.allDocs<any>({
        include_docs: true,
        startkey: "f:",
        endkey: "f:\uffff",
      }),
    );

    const MAX_RESULTS = 20;
    const SNIPPET_LENGTH = 300;
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();
    let candidateCount = 0;

    for (const row of allDocs.rows) {
      if (!("doc" in row) || !row.doc || row.doc._deleted || row.doc.deleted) continue;
      const doc = row.doc;
      if (doc.type !== EntryTypes.NOTE_PLAIN && doc.type !== EntryTypes.NOTE_BINARY) continue;

      const meta = await this.decryptMeta(doc);
      if (!meta) continue;

      // Check filename match first (cheap — no chunk decryption needed)
      const fileNameMatch = meta.path.toLowerCase().includes(lowerQuery);
      if (fileNameMatch) {
        candidateCount++;
        if (results.length < MAX_RESULTS) {
          // Get content for snippet
          let snippet = "";
          try {
            if (meta.children.length > 0) {
              const chunks = await this.retry(() => this.db.allDocs<any>({ keys: meta.children, include_docs: true }));
              for (const r of chunks.rows) {
                if ("doc" in r && r.doc?.data) snippet += await this.decryptChunkData(r.doc.data);
              }
            }
          } catch {
            /* skip */
          }
          results.push({
            path: meta.path,
            snippet: snippet.slice(0, SNIPPET_LENGTH).replace(/\n/g, " "),
            matchType: "filename",
            totalMatches: 0,
          });
        }
        continue;
      }

      // Content search — need to decrypt chunks
      if (meta.children.length === 0) continue;

      let content = "";
      try {
        const chunks = await this.retry(() => this.db.allDocs<any>({ keys: meta.children, include_docs: true }));
        for (const r of chunks.rows) {
          if ("doc" in r && r.doc?.data) content += await this.decryptChunkData(r.doc.data);
        }
      } catch {
        continue;
      }

      const contentLines = content.split("\n");
      let contentMatch = false;
      let matchCount = 0;
      let firstSnippet = "";

      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].toLowerCase().includes(lowerQuery)) {
          matchCount++;
          if (!contentMatch) {
            contentMatch = true;
            firstSnippet = contentLines
              .slice(Math.max(0, i - 1), i + 3)
              .join("\n")
              .slice(0, SNIPPET_LENGTH);
          }
        }
      }

      if (contentMatch) {
        candidateCount++;
        if (results.length < MAX_RESULTS) {
          results.push({
            path: meta.path,
            snippet: firstSnippet.replace(/\n/g, " "),
            matchType: "content",
            totalMatches: matchCount,
          });
        }
      }
    }

    return {
      results,
      truncated: candidateCount > MAX_RESULTS,
      totalCandidateCount: candidateCount,
    };
  }

  private async pathToId(rawPath: string): Promise<DocumentID> {
    const caseInsensitive = true;
    if (this.passphrase) {
      return await path2id_base(rawPath as any, this.passphrase, caseInsensitive);
    }
    return await path2id_base(rawPath as any, false, caseInsensitive);
  }

  private async retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        if (err.status === 404 || err.status === 409 || i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 100));
      }
    }
    throw lastErr;
  }
}
