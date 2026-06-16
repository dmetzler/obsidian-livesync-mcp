import PouchDB from "pouchdb";
import PouchHttp from "pouchdb-adapter-http";
import transformPouch from "transform-pouch";
import "pouchdb-mapreduce";
import "pouchdb-replication";
import "pouchdb-find";

PouchDB.plugin(PouchHttp);
PouchDB.plugin(transformPouch);

import { IDPrefixes, SALT_OF_PASSPHRASE } from "@lib/common/models/shared.const.behabiour";
import { EntryTypes } from "@lib/common/models/db.const";
import type { DocumentID } from "@lib/common/models/db.type";
import { path2id_base } from "@lib/string_and_binary/path";
import { enableEncryption } from "@lib/pouchdb/encryption";
import type { E2EEAlgorithm } from "@lib/common/types";
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

export class CouchDBClient {
  private db: PouchDB.Database;
  private passphrase: string | undefined;
  private cacheTtl: number;
  private requestTimeout: number;
  private cachedSalt: Uint8Array<ArrayBuffer> | null = null;

  constructor(url: string, passphrase?: string, options?: CouchDBOptions) {
    this.db = new PouchDB(url, { adapter: "http" });
    this.passphrase = passphrase;
    this.cacheTtl = options?.cacheTtl ?? 60;
    this.requestTimeout = options?.requestTimeout ?? 30000;

    if (this.passphrase) {
      enableEncryption(
        this.db as any,
        this.passphrase,
        false,
        false,
        () => this.getPbkdf2Salt(),
        "V2" as E2EEAlgorithm,
      );
    }
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

  async listFiles(prefix?: string): Promise<FileInfo[]> {
    const result = await this.retry(() =>
      this.db.allDocs<any>({
        include_docs: true,
        startkey: prefix ? prefix.toLowerCase() : undefined,
        endkey: prefix ? prefix.toLowerCase() + "\uffff" : undefined,
      }),
    );

    const files: FileInfo[] = [];
    for (const row of result.rows) {
      if (!("doc" in row) || !row.doc || row.doc._deleted || row.doc.deleted) continue;
      const doc = row.doc;
      if (doc.type !== EntryTypes.NOTE_PLAIN && doc.type !== EntryTypes.NOTE_BINARY) continue;

      const filePath = await this.resolvePath(doc);
      if (!filePath) continue;

      files.push({
        path: filePath,
        type: doc.type,
        size: doc.size || 0,
        mtime: doc.mtime || 0,
        ctime: doc.ctime || 0,
      });
    }
    return files;
  }

  async getFileContent(path: string): Promise<string | null> {
    const docId = await this.pathToId(path);
    try {
      const meta = await this.retry(() => this.db.get<any>(docId));
      if (meta.deleted || meta._deleted) return null;

      if (!meta.children || meta.children.length === 0) return "";

      const chunks = await this.retry(() =>
        this.db.allDocs<any>({
          keys: meta.children,
          include_docs: true,
        }),
      );

      let content = "";
      for (const row of chunks.rows) {
        if (!("doc" in row) || !row.doc) continue;
        if (row.doc.type !== EntryTypes.CHUNK) continue;

        const data = row.doc.data || "";
        content += data;
      }
      return content;
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async storeContent(path: string, content: string): Promise<boolean> {
    try {
      const docId = await this.pathToId(path);
      const chunkHash = crypto.createHash("sha256").update(content).digest("hex");

      const chunkId = this.passphrase ? `${IDPrefixes.EncryptedChunk}${chunkHash}` : `${IDPrefixes.Chunk}${chunkHash}`;

      let existingMeta: any = null;
      let oldChunkIds: string[] = [];
      try {
        existingMeta = await this.retry(() => this.db.get(docId));
        oldChunkIds = existingMeta.children || [];
      } catch {
        // new file
      }

      const chunkBody: Record<string, any> = {
        _id: chunkId,
        type: EntryTypes.CHUNK,
        data: content,
      };
      try {
        await this.retry(() => this.db.get(chunkId));
      } catch {
        await this.retry(() => this.db.put(chunkBody));
      }

      let storeCtime = Date.now();
      if (existingMeta) {
        storeCtime = existingMeta.ctime || storeCtime;
      }

      const entry: any = {
        _id: docId,
        type: EntryTypes.NOTE_PLAIN,
        path: path,
        children: [chunkId],
        ctime: storeCtime,
        mtime: Date.now(),
        size: Buffer.byteLength(content, "utf-8"),
      };

      if (existingMeta) {
        entry._rev = existingMeta._rev;
      }

      await this.retry(() => this.db.put(entry));

      for (const oldChunkId of oldChunkIds) {
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
      const meta = await this.retry(() => this.db.get<any>(docId));
      if (meta._deleted || meta.deleted) return false;

      const children = meta.children || [];
      for (const childId of children) {
        try {
          const chunk = await this.retry(() => this.db.get(childId));
          await this.retry(() => this.db.put({ ...chunk, _deleted: true }));
        } catch {
          // chunk may already be deleted
        }
      }

      await this.retry(() => this.db.put({ ...meta, _deleted: true }));
      return true;
    } catch (err: any) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<boolean> {
    const content = await this.getFileContent(oldPath);
    if (content === null) return false;

    const existing = await this.getFileContent(newPath);
    if (existing !== null) {
      throw new Error(`Target path already exists: ${newPath}`);
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
    const allDocs = await this.retry(() => this.db.allDocs<any>({ include_docs: true }));

    const MAX_RESULTS = 20;
    const SNIPPET_LENGTH = 300;
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();
    let candidateCount = 0;

    for (const row of allDocs.rows) {
      if (!("doc" in row) || !row.doc || row.doc._deleted || row.doc.deleted) continue;
      const doc = row.doc;
      if (doc.type !== EntryTypes.NOTE_PLAIN && doc.type !== EntryTypes.NOTE_BINARY) continue;

      const filePath = await this.resolvePath(doc);
      if (!filePath) continue;

      let content: string | null;
      try {
        content = await this.getFileContent(filePath);
      } catch {
        continue;
      }
      if (content === null) continue;

      const fileNameMatch = filePath.toLowerCase().includes(lowerQuery);
      if (fileNameMatch) {
        candidateCount++;
        if (results.length >= MAX_RESULTS) continue;
        results.push({
          path: filePath,
          snippet: content.slice(0, SNIPPET_LENGTH).replace(/\n/g, " "),
          matchType: "filename",
          totalMatches: 0,
        });
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
        if (results.length >= MAX_RESULTS) continue;
        results.push({
          path: filePath,
          snippet: firstSnippet.replace(/\n/g, " "),
          matchType: "content",
          totalMatches: matchCount,
        });
      }
    }

    return {
      results,
      truncated: candidateCount > MAX_RESULTS,
      totalCandidateCount: candidateCount,
    };
  }

  private async resolvePath(doc: any): Promise<string | null> {
    let filePath = doc.path;
    if (isEncryptedMetaPath(filePath) && this.passphrase) {
      try {
        const encrypted = filePath.slice(ENCRYPTED_META_PREFIX.length);
        const salt = await this.getPbkdf2Salt();
        const { decrypt: decryptHKDF } = await import("octagonal-wheels/encryption/hkdf");
        const decrypted = await decryptHKDF(encrypted, this.passphrase + SALT_OF_PASSPHRASE, salt);
        const parsed = JSON.parse(decrypted);
        filePath = parsed.path;
      } catch {
        return null;
      }
    }
    return filePath;
  }

  private async pathToId(rawPath: string): Promise<DocumentID> {
    const caseInsensitive = true;
    if (this.passphrase) {
      const obfuscatedId = await path2id_base(rawPath as any, this.passphrase, caseInsensitive);
      try {
        await this.db.get(obfuscatedId);
        return obfuscatedId;
      } catch {
        // fall through
      }
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
