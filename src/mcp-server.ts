import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { version } from "../package.json";
import { checkHealth } from "./health.js";
import type { Logger } from "./logger.js";
import type { VaultRegistry } from "./vault-registry.js";
import { Authenticator, type AuthContext } from "./auth.js";
import type { AppConfig } from "./config.js";
import { randomUUID } from "node:crypto";

interface MCPServerOptions {
  config: AppConfig;
  registry: VaultRegistry;
  logger: Logger;
}

interface SessionState {
  transport: import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
  server: Server;
  authContext?: AuthContext;
}

// --- Tool definitions ---

const VAULT_PARAM = {
  vault: {
    type: "string",
    description: "Vault ID (optional if user has access to only one vault)",
  },
} as const;

const ALL_TOOLS: Tool[] = [
  {
    name: "list_vaults",
    description: "List available vaults the current user has access to",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_files_in_vault",
    description: "List all files in the vault, optionally filtered by prefix",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        prefix: { type: "string", description: "Optional path prefix to filter by" },
      },
    },
  },
  {
    name: "list_files_in_dir",
    description: "List files in a specific directory",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_file_contents",
    description: "Get the contents of a file",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    name: "search",
    description:
      "Search file names and contents by query string. Returns up to 20 results with snippets.",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        query: {
          type: "string",
          description: "Search query (case-insensitive)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note with content",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_content",
    description: "Append content to an existing file",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch_content",
    description: "Patch content in a file under a specific heading",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "File path" },
        heading: { type: "string", description: "Heading to patch under" },
        content: { type: "string", description: "New content" },
        operation: {
          type: "string",
          enum: ["replace", "append", "prepend"],
          description: "What to do with the content under the heading",
        },
      },
      required: ["path", "heading", "content", "operation"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    name: "rename_file",
    description: "Rename or move a file to a new path",
    inputSchema: {
      type: "object",
      properties: {
        ...VAULT_PARAM,
        oldPath: { type: "string", description: "Current file path" },
        newPath: { type: "string", description: "New file path" },
      },
      required: ["oldPath", "newPath"],
    },
  },
];

export class MCPServer {
  private registry: VaultRegistry;
  private auth: Authenticator;
  private opts: MCPServerOptions;
  private httpServer: any = null;
  private sessions: Map<string, SessionState> = new Map();

  constructor(opts: MCPServerOptions) {
    this.registry = opts.registry;
    this.opts = opts;
    this.auth = new Authenticator(
      opts.config.auth,
      opts.config.server.apiKey,
      opts.logger.child("auth"),
    );
  }

  private createServer(authContext?: AuthContext): Server {
    const server = new Server(
      { name: "obsidian-livesync-mcp", version },
      { capabilities: { tools: {}, logging: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ALL_TOOLS,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const start = Date.now();
      try {
        this.opts.logger.debug("Tool call", { tool: name });
        const result = await this.handleTool(name, args || {}, authContext);
        this.opts.logger.info("Tool completed", { tool: name, durationMs: Date.now() - start });
        return result;
      } catch (err: any) {
        this.opts.logger.error("Tool failed", { tool: name, error: err.message, durationMs: Date.now() - start });
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, err.message);
      }
    });

    return server;
  }

  private async handleTool(name: string, args: Record<string, any>, authContext?: AuthContext) {
    const vaultParam = args.vault as string | undefined;
    const allowedVaults = authContext?.allowedVaults;

    // list_vaults doesn't need vault resolution
    if (name === "list_vaults") {
      const allVaults = this.registry.list();
      const filtered = allowedVaults
        ? allVaults.filter((v) => allowedVaults.includes(v.id))
        : allVaults;
      return {
        content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }],
      };
    }

    // Resolve vault for all other tools
    const entry = this.registry.resolve(vaultParam, allowedVaults);
    const client = entry.client;

    switch (name) {
      case "list_files_in_vault": {
        const prefix = args.prefix as string | undefined;
        const files = await client.listFiles(prefix);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "list_files_in_dir": {
        const path = args.path as string;
        const prefix = path.endsWith("/") ? path : path + "/";
        const files = await client.listFiles(prefix);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "get_file_contents": {
        const filePath = args.path as string;
        const content = await client.getFileContent(filePath);
        if (content === null) {
          return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
        }
        return { content: [{ type: "text", text: content }] };
      }

      case "search": {
        const query = args.query as string;
        const searchResult = await client.search(query);
        const lines: string[] = [];
        if (searchResult.results.length === 0) {
          lines.push("No matches found.");
        } else {
          for (const r of searchResult.results) {
            const tag = r.matchType === "filename" ? "filename" : "content";
            lines.push(`[${tag}] ${r.path}`);
            if (r.matchType === "content") {
              lines.push(`       ${r.totalMatches} match(es) — snippet: ${r.snippet}`);
            } else {
              lines.push(`       ${r.snippet}`);
            }
          }
          if (searchResult.truncated) {
            lines.push(
              `\n(${searchResult.totalCandidateCount} total candidates — results truncated to ${searchResult.results.length})`,
            );
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "create_note": {
        const createPath = args.path as string;
        const createContent = args.content as string;
        await client.storeContent(createPath, createContent);
        return { content: [{ type: "text", text: `Created: ${createPath}` }] };
      }

      case "append_content": {
        const appendPath = args.path as string;
        const appendContent = args.content as string;
        const existing = await client.getFileContent(appendPath);
        if (existing === null) {
          await client.storeContent(appendPath, appendContent);
        } else {
          await client.storeContent(appendPath, existing + appendContent);
        }
        return { content: [{ type: "text", text: `Content appended to: ${appendPath}` }] };
      }

      case "patch_content": {
        const patchPath = args.path as string;
        const heading = args.heading as string;
        const patchContent = args.content as string;
        const operation = args.operation as "replace" | "append" | "prepend";

        const existingContent = await client.getFileContent(patchPath);
        if (existingContent === null) {
          return { content: [{ type: "text", text: `File not found: ${patchPath}` }], isError: true };
        }

        const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegex(heading)}\\s*$`, "m");
        const match = existingContent.match(headingRegex);
        if (!match) {
          return { content: [{ type: "text", text: `Heading not found: ${heading}` }], isError: true };
        }

        const headingLine = match[0];
        const headingLevel = match[1].length;
        const headingIndex = match.index!;
        const afterHeading = headingIndex + headingLine.length;
        const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s`, "m");
        const nextMatch = existingContent.slice(afterHeading).match(nextHeadingRegex);
        const sectionEnd = nextMatch ? afterHeading + nextMatch.index! : existingContent.length;

        let newContent: string;
        if (operation === "replace") {
          newContent =
            existingContent.slice(0, afterHeading) + "\n" + patchContent + "\n" + existingContent.slice(sectionEnd);
        } else if (operation === "append") {
          newContent = existingContent.slice(0, sectionEnd) + "\n" + patchContent + "\n";
        } else {
          newContent =
            existingContent.slice(0, afterHeading) + "\n" + patchContent + "\n" + existingContent.slice(afterHeading);
        }

        await client.storeContent(patchPath, newContent);
        return { content: [{ type: "text", text: `Patched content under heading: ${heading}` }] };
      }

      case "delete_file": {
        const deletePath = args.path as string;
        const deleted = await client.deleteFile(deletePath);
        if (!deleted) {
          return { content: [{ type: "text", text: `File not found: ${deletePath}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Deleted: ${deletePath}` }] };
      }

      case "rename_file": {
        const oldPath = args.oldPath as string;
        const newPath = args.newPath as string;
        const renamed = await client.renameFile(oldPath, newPath);
        if (!renamed) {
          return { content: [{ type: "text", text: `File not found: ${oldPath}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Renamed: ${oldPath} → ${newPath}` }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  }

  async start(transport: "stdio" | "sse" | "http") {
    if (transport === "stdio") {
      const server = this.createServer();
      const stdioTransport = new StdioServerTransport();
      stdioTransport.onerror = (err) => {
        this.opts.logger.error("Transport error", { error: err.message });
      };
      stdioTransport.onclose = () => {
        this.opts.logger.warn("Transport closed");
      };
      await server.connect(stdioTransport);
      this.opts.logger.info("Server started", { transport: "stdio" });
    } else {
      const { createServer } = await import("node:http");
      const port = this.opts.config.server.port;

      this.httpServer = createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Health check — no auth required
        if (req.method === "GET" && pathname === "/health") {
          const firstVault = this.registry.all()[0];
          const healthUrl = firstVault ? this.registry.getHealthUrl(firstVault.id) : null;
          const status = await checkHealth(healthUrl || "", this.opts.logger);
          const httpStatus = status.status === "ok" ? 200 : 503;
          res.writeHead(httpStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
          return;
        }

        // Authentication
        let authContext: AuthContext = { authenticated: true };
        if (this.auth.isAuthRequired()) {
          authContext = await this.auth.authenticate(req);
          if (!authContext.authenticated) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        try {
          if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (!session) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session not found" }));
              return;
            }
            await session.transport.handleRequest(req, res);
          } else if (req.method === "POST") {
            const { StreamableHTTPServerTransport } =
              await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

            const server = this.createServer(authContext);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid: string) => {
                this.opts.logger.info("Session initialized", { sessionId: sid, subject: authContext.subject });
                this.sessions.set(sid, { transport, server, authContext });
              },
            });
            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && this.sessions.has(sid)) {
                this.opts.logger.info("Session closed", { sessionId: sid });
                this.sessions.delete(sid);
              }
            };
            transport.onerror = (err: Error) => {
              this.opts.logger.error("Transport error", { error: err.message });
            };

            await server.connect(transport);
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad Request: No session ID provided" }));
          }
        } catch (err: any) {
          this.opts.logger.error("HTTP handler error", { error: err.message });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });

      await new Promise<void>((resolve) => this.httpServer.listen(port, resolve));
      this.opts.logger.info("Server started", {
        transport: "streamable-http",
        port,
        vaults: this.registry.list().map((v) => v.id),
        authEnabled: this.auth.isAuthRequired(),
      });
    }
  }

  async stop() {
    this.opts.logger.info("Stopping server");
    for (const [, session] of this.sessions) {
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.sessions.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
