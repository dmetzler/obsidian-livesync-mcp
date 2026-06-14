import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbGet = vi.fn();
const mockDbAllDocs = vi.fn();
const mockDbInstance: any = {
  get: mockDbGet,
  allDocs: mockDbAllDocs,
};

vi.mock("pouchdb", () => ({
  default: Object.assign(
    vi.fn(() => mockDbInstance),
    { plugin: vi.fn() },
  ),
  __esModule: true,
}));

vi.mock("pouchdb-adapter-http", () => ({ default: {}, __esModule: true }));

vi.mock("octagonal-wheels/encryption/hkdf", () => ({
  decrypt: vi.fn((data: string) => Promise.resolve(`decrypted:${data}`)),
  encrypt: vi.fn((data: string) => Promise.resolve(`%=encrypted:${data}`)),
}));

vi.mock("octagonal-wheels/encryption/encryption", () => ({
  decrypt: vi.fn((data: string) => Promise.resolve(`v1decrypted:${data}`)),
}));

describe("CouchDBClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe("construction", () => {
    it("constructs with URL and passphrase", async () => {
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      expect(client).toBeInstanceOf(CouchDBClient);
    });

    it("constructs without passphrase", async () => {
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db");
      expect(client).toBeInstanceOf(CouchDBClient);
    });

    it("accepts options", async () => {
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "phrase", {
        cacheTtl: 120,
        requestTimeout: 60000,
      });
      expect(client).toBeInstanceOf(CouchDBClient);
    });
  });

  describe("getPbkdf2Salt", () => {
    it("fetches salt from sync parameters document", async () => {
      mockDbGet.mockResolvedValue({
        _id: "_local/obsidian_livesync_sync_parameters",
        pbkdf2salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const salt = await (client as any).getPbkdf2Salt();
      expect(mockDbGet).toHaveBeenCalledWith("_local/obsidian_livesync_sync_parameters");
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(salt.length).toBe(32);
    });

    it("falls back to sha256 hash when sync params doc is not found", async () => {
      mockDbGet.mockRejectedValue({ status: 404 });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const salt = await (client as any).getPbkdf2Salt();
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(salt.length).toBe(32);
    });

    it("caches the salt after first fetch", async () => {
      mockDbGet.mockResolvedValue({
        _id: "_local/obsidian_livesync_sync_parameters",
        pbkdf2salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      await (client as any).getPbkdf2Salt();
      await (client as any).getPbkdf2Salt();
      expect(mockDbGet).toHaveBeenCalledTimes(1);
    });
  });

  describe("search", () => {
    it("returns empty results for empty vault", async () => {
      mockDbAllDocs.mockResolvedValue({ rows: [] });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const result = await client.search("anything");
      expect(result.results).toEqual([]);
    });

    it("matches by filename", async () => {
      const doc = {
        _id: "Some/Test note.md",
        type: "plain",
        path: "Some/Test note.md",
        children: [],
        deleted: false,
      };
      mockDbAllDocs.mockResolvedValue({ rows: [{ doc }] });
      mockDbGet.mockResolvedValue(doc);
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db");
      const result = await client.search("test");
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      const match = result.results.find((r) => r.path === doc._id);
      expect(match).toBeDefined();
      expect(match!.matchType).toBe("filename");
    });

    it("returns truncated results when more than 20 candidates", async () => {
      const docs = Array.from({ length: 25 }, (_, i) => ({
        _id: `Test note ${i}.md`,
        type: "plain",
        path: `Test note ${i}.md`,
        children: [],
        deleted: false,
      }));
      mockDbAllDocs.mockResolvedValue({ rows: docs.map((doc) => ({ doc })) });
      mockDbGet.mockResolvedValue(docs[0]);
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db");
      const result = await client.search("test");
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.truncated).toBe(true);
    });
  });

  describe("renameFile", () => {
    it("returns false for non-existent source", async () => {
      mockDbGet.mockRejectedValue({ status: 404 });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const result = await client.renameFile("nonexistent.md", "new.md");
      expect(result).toBe(false);
    });

    it("throws if target path already exists", async () => {
      const doc = {
        _id: "exists.md",
        type: "plain",
        path: "exists.md",
        children: [],
        deleted: false,
      };
      mockDbGet.mockResolvedValue(doc);
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      await expect(client.renameFile("old.md", "exists.md")).rejects.toThrow("Target path already exists");
    });
  });

  describe("getFileContent", () => {
    it("returns null for non-existent file", async () => {
      mockDbGet.mockRejectedValue({ status: 404 });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const content = await client.getFileContent("nonexistent.md");
      expect(content).toBeNull();
    });

    it("returns empty string for file with no children", async () => {
      mockDbGet.mockResolvedValue({
        _id: "test-note-md",
        type: "plain",
        path: "note.md",
        children: [],
        deleted: false,
      });
      const { CouchDBClient } = await import("./couchdb.js");
      const client = new CouchDBClient("http://localhost:5984/db", "testphrase");
      const content = await client.getFileContent("note.md");
      expect(content).toBe("");
    });
  });
});
