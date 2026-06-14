import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CouchDBClient } from "./couchdb.js";
import { checkHealth } from "./health.js";
import type { Logger } from "./logger.js";

interface MCPServerOptions {
  apiKey: string;
  port: number;
  couchdbUrl: string;
  logger: Logger;
}

const ALL_TOOLS: Tool[] = [
  {
    name: "list_files_in_vault",
    description: "List all files in the vault, optionally filtered by prefix",
    inputSchema: {
      type: "object",
      properties: {
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
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    name: "search",
    description:
      "Search file names and contents by query string. Returns up to 20 results with snippets. Searches both file paths and content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (case-insensitive, matched against filename and content)" },
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
        oldPath: { type: "string", description: "Current file path" },
        newPath: { type: "string", description: "New file path" },
      },
      required: ["oldPath", "newPath"],
    },
  },
];

export class MCPServer {
  private server: Server;
  private client: CouchDBClient;
  private opts: MCPServerOptions;
  private httpServer: any = null;
  private streamableTransport: any = null;

  constructor(client: CouchDBClient, opts: MCPServerOptions) {
    this.client = client;
    this.opts = opts;
    this.server = new Server({ name: "obsidian-livesync-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
    (this.server as any).oninitialized = () => {
      this.opts.logger.info("Client initialized");
    };
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ALL_TOOLS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const start = Date.now();
      try {
        this.opts.logger.debug("Tool call", { tool: name });

        let result: any;
        switch (name) {
          case "list_files_in_vault": {
            const prefix = args?.prefix as string | undefined;
            const files = await this.client.listFiles(prefix);
            result = { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
            break;
          }

          case "list_files_in_dir": {
            const path = args?.path as string;
            const prefix = path.endsWith("/") ? path : path + "/";
            const files = await this.client.listFiles(prefix);
            result = { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
            break;
          }

          case "get_file_contents": {
            const filePath = args?.path as string;
            const content = await this.client.getFileContent(filePath);
            if (content === null) {
              result = { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
            } else {
              result = { content: [{ type: "text", text: content }] };
            }
            break;
          }

          case "search": {
            const query = args?.query as string;
            const searchResult = await this.client.search(query);
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
            result = { content: [{ type: "text", text: lines.join("\n") }] };
            break;
          }

          case "create_note": {
            const createPath = args?.path as string;
            const createContent = args?.content as string;
            await this.client.storeContent(createPath, createContent);
            result = { content: [{ type: "text", text: `Created: ${createPath}` }] };
            break;
          }

          case "append_content": {
            const appendPath = args?.path as string;
            const appendContent = args?.content as string;
            const existing = await this.client.getFileContent(appendPath);
            if (existing === null) {
              await this.client.storeContent(appendPath, appendContent);
            } else {
              await this.client.storeContent(appendPath, existing + appendContent);
            }
            result = { content: [{ type: "text", text: `Content appended to: ${appendPath}` }] };
            break;
          }

          case "patch_content": {
            const patchPath = args?.path as string;
            const heading = args?.heading as string;
            const patchContent = args?.content as string;
            const operation = args?.operation as "replace" | "append" | "prepend";

            const existingContent = await this.client.getFileContent(patchPath);
            if (existingContent === null) {
              result = { content: [{ type: "text", text: `File not found: ${patchPath}` }], isError: true };
              break;
            }

            const headingRegex = new RegExp(`^(#{1,6})\\s+${escapeRegex(heading)}\\s*$`, "m");
            const match = existingContent.match(headingRegex);
            if (!match) {
              result = { content: [{ type: "text", text: `Heading not found: ${heading}` }], isError: true };
              break;
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
                existingContent.slice(0, afterHeading) +
                "\n" +
                patchContent +
                "\n" +
                existingContent.slice(afterHeading);
            }

            await this.client.storeContent(patchPath, newContent);
            result = { content: [{ type: "text", text: `Patched content under heading: ${heading}` }] };
            break;
          }

          case "delete_file": {
            const deletePath = args?.path as string;
            const deleted = await this.client.deleteFile(deletePath);
            if (!deleted) {
              result = { content: [{ type: "text", text: `File not found: ${deletePath}` }], isError: true };
            } else {
              result = { content: [{ type: "text", text: `Deleted: ${deletePath}` }] };
            }
            break;
          }

          case "rename_file": {
            const oldPath = args?.oldPath as string;
            const newPath = args?.newPath as string;
            const renamed = await this.client.renameFile(oldPath, newPath);
            if (!renamed) {
              result = { content: [{ type: "text", text: `File not found: ${oldPath}` }], isError: true };
            } else {
              result = { content: [{ type: "text", text: `Renamed: ${oldPath} → ${newPath}` }] };
            }
            break;
          }

          default:
            result = { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }

        this.opts.logger.info("Tool completed", { tool: name, durationMs: Date.now() - start });
        return result;
      } catch (err: any) {
        this.opts.logger.error("Tool failed", { tool: name, error: err.message, durationMs: Date.now() - start });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  async start(transport: "stdio" | "sse" | "http") {
    if (transport === "stdio") {
      const stdioTransport = new StdioServerTransport();
      stdioTransport.onerror = (err) => {
        this.opts.logger.error("Transport error", { error: err.message });
      };
      stdioTransport.onclose = () => {
        this.opts.logger.warn("Transport closed");
      };
      await this.server.connect(stdioTransport);
      this.opts.logger.info("Server started", { transport: "stdio" });
    } else {
      const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      const { createServer } = await import("node:http");
      const crypto = await import("node:crypto");

      this.streamableTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await this.server.connect(this.streamableTransport);

      this.httpServer = createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);
        const pathname = url.pathname;

        if (req.method === "GET" && pathname === "/health") {
          const status = await checkHealth(this.opts.couchdbUrl, this.opts.logger);
          const httpStatus = status.status === "ok" ? 200 : 503;
          res.writeHead(httpStatus, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
          return;
        }

        if (this.opts.apiKey && !this.authenticate(req)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        try {
          await this.streamableTransport.handleRequest(req, res);
        } catch (err: any) {
          this.opts.logger.error("Streamable HTTP handler error", { error: err.message });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });

      await new Promise<void>((resolve) => this.httpServer.listen(this.opts.port, resolve));
      this.opts.logger.info("Server started", {
        transport: "streamable-http",
        port: this.opts.port,
      });
    }
  }

  async stop() {
    this.opts.logger.info("Stopping server");
    if (this.streamableTransport) {
      await this.streamableTransport.close();
      this.streamableTransport = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
      this.httpServer = null;
    }
  }

  private authenticate(req: any): boolean {
    const auth = req.headers?.authorization || "";
    return auth === `Bearer ${this.opts.apiKey}`;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
