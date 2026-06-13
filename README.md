# obsidian-livesync-mcp

**A Model Context Protocol (MCP) server that gives AI agents and LLM tools full read/write access to your Obsidian LiveSync vaults — directly via CouchDB, with complete end-to-end encryption (E2EE) support.**

Connect Claude Desktop, Cursor, Cline, Continue.dev, opencode, or any other MCP-compatible client straight to your self-hosted Obsidian notes. No Obsidian process needs to be running. Changes appear in your vault instantly and are picked up by LiveSync on all your devices.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/badge/Docker-GHCR.io-blue?logo=docker)](https://ghcr.io)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green?logo=node.js)](https://nodejs.org)

---

## What is this?

[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) (the popular Obsidian community plugin by vrtmrz) lets you sync your Obsidian vault to a self-hosted [CouchDB](https://couchdb.apache.org/) instance using PouchDB under the hood. It features:

- True end-to-end encryption (E2EE) with a passphrase you control
- Efficient chunking + content-addressed deduplication (only changed pieces are stored/sent)
- Optional path obfuscation (filenames/paths are hashed so even the DB admin can't easily see your folder structure)
- Conflict detection and real-time-ish sync across devices

**obsidian-livesync-mcp** is the missing piece for AI: a lightweight, dedicated MCP server that speaks the LiveSync storage format natively.

It connects _directly_ to your CouchDB (using the PouchDB HTTP adapter + the official `livesync-commonlib` transforms), handles all decryption/encryption, path resolution, chunk assembly/disassembly, and metadata — exactly like the Obsidian plugin does — but exposes everything as a clean set of tools any MCP client can call.

### Why would you want this?

- Let your favorite LLM / coding agent search, read, create, append, patch, and delete notes in your actual second brain.
- Automate journal entries, meeting notes, project updates, daily reviews, etc.
- Build personal agents that _understand_ your notes because they can access them live.
- Run everything headless: the AI client talks to the MCP server, the MCP server talks to CouchDB. Obsidian can stay closed.
- Works with encrypted vaults. Your passphrase never leaves the MCP server (you supply it via environment variable).

It is **not** a replacement for Obsidian or the LiveSync plugin. It is a companion that lets AI participate in the same ecosystem.

---

## Architecture: Where It Fits In

The server sits between MCP-speaking AI clients and your existing CouchDB-backed LiveSync vault. It never talks to Obsidian itself.

### Visual Overview

```mermaid
flowchart TB
    subgraph Devices["Your Devices"]
        Obs[Obsidian<br/>Desktop + Mobile]
        LS[LiveSync Plugin<br/>E2EE + Chunks + Obfuscation]
    end

    subgraph DB["Self-hosted CouchDB"]
        Couch[(CouchDB<br/>LiveSync Vault DB)]
    end

    subgraph MCP["obsidian-livesync-mcp<br/>(this server)"]
        Tools[9 MCP Tools<br/>list / read / search / rename<br/>create / append / patch / delete]
        Crypto[E2EE Handling<br/>HKDF + legacy V1<br/>chunk assembly + path resolution]
    end

    subgraph AI["AI / MCP Clients"]
        Clients[Claude Desktop • Cursor<br/>Cline • Continue.dev<br/>opencode • custom agents]
    end

    Obs <-->|LiveSync sync| LS
    LS <-->|HTTP / WS| Couch
    Tools <--> Crypto
    Crypto <-->|PouchDB HTTP adapter<br/>+ transparent decrypt/encrypt| Couch
    Clients <-->|MCP (stdio / streamable-http)| Tools
```

**Key points**:

- Obsidian + LiveSync plugin continues to work exactly as before.
- The MCP server uses the **same** document model, chunk IDs (`h:...` / `h:+...`), metadata encryption, and path-to-ID logic as the plugin (via `livesync-commonlib`).
- Writes performed by AI clients become ordinary LiveSync documents. Your devices will sync the changes (and may show conflicts if there were simultaneous edits).
- Everything stays on your infrastructure. The only secret that ever enters the MCP process is the E2EE `PASSPHRASE` you explicitly supply.

The old simple ASCII version for reference:

```
opencode ──MCP──> obsidian-livesync-mcp ──HTTP──> CouchDB
                           │
                    E2EE decryption
                    (octagonal-wheels + livesync-commonlib)
```

The beauty of this architecture: the MCP server never needs the Obsidian desktop app, the LiveSync plugin UI, or a local PouchDB sync loop. It just understands the on-disk (in-CouchDB) format.

When the MCP server writes a note, LiveSync on your real devices will see the new/updated chunks and metadata on the next sync and pull them in (or push conflicts back if there was a concurrent edit).

---

## Features

- **Full fidelity access** — reads and writes are 100% compatible with LiveSync's document model, chunking, and E2EE.
- **E2EE everywhere** — supply your exact LiveSync passphrase; the server performs the same HKDF (current) and legacy V1 decryption that the plugin uses. Path metadata is also decrypted when obfuscation is enabled.
- **Smart writes** — content is hashed for deduplication. Existing files are updated in place (revision kept). Old chunks are tombstoned.
- **9 powerful tools** (see below) including heading-aware patching and file rename — perfect for "update the TODO list under this heading".
- **Multiple transports**:
- `stdio` — spawn the process locally (zero network exposure).
- `http` — run as a long-lived HTTP server (Docker-friendly) using the modern Streamable HTTP transport from the MCP SDK (SSE transport is deprecated upstream). Optional `MCP_API_KEY` Bearer auth.
- **Production-ready Docker** — multi-arch images published to GHCR on every main push. Healthcheck included.
- **Minimal dependencies** — no full Obsidian engine, no browser, just Node + the commonlib.
- **Observable** — JSON structured logs, configurable levels, uptime + CouchDB reachability in `/health`.
- **.env file support** — drop a `.env` next to the binary (or in the container) and it will be loaded automatically.

---

## Prerequisites

1. **A working LiveSync + CouchDB setup**
   - CouchDB 3.x (single node is fine; authentication recommended).
   - At least one Obsidian vault successfully syncing via the [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin.
   - You know:
     - The CouchDB base URL (e.g. `http://couch.example.com:5984` or `https://couch.example.com`)
     - The database name inside CouchDB (e.g. `my-obsidian-vault`)
     - CouchDB username/password (if you enabled HTTP auth — recommended)
     - (If E2EE is on) Your LiveSync **passphrase** (found in Obsidian → Settings → Community Plugins → Self-hosted LiveSync → Encryption section)

2. **For running the server**
   - Docker + Docker Compose (recommended), **or**
   - Node.js ≥ 22 + npm

3. **For remote HTTP access (optional but common with Docker)**
   - A strong random `MCP_API_KEY`
   - Ideally a reverse proxy terminating TLS (Caddy, Traefik, Nginx, Cloudflare Tunnel, etc.)

---

## Quick Start — Docker (Recommended)

### Using Docker Compose (easiest)

Create a `docker-compose.yml`:

```yaml
services:
  obsidian-livesync-mcp:
    # Option A: build locally (good for development / custom)
    build: .

    # Option B: use the official GHCR image (replace OWNER with your GitHub username or the repo owner)
    # image: ghcr.io/OWNER/obsidian-livesync-mcp:latest

    container_name: obsidian-livesync-mcp
    ports:
      - "${MCP_PORT:-3100}:3100"
    environment:
      # === REQUIRED ===
      hostname: ${COUCHDB_URL:?COUCHDB_URL is required} # e.g. http://192.168.1.50:5984 or https://couch.example.com
      dbname: ${DBNAME:?DBNAME is required} # e.g. my-obsidian-vault
      PASSPHRASE: ${PASSPHRASE:?PASSPHRASE is required} # Your LiveSync E2EE passphrase (or "" for unencrypted vaults)

      # === CouchDB auth (if you use it) ===
      username: ${COUCHDB_USER:-}
      password: ${COUCHDB_PASSWORD:-}

      # === Transport & networking (default is fine for most) ===
      MCP_TRANSPORT: http # or "stdio" (stdio rarely used in containers)
      MCP_PORT: "3100"
      MCP_API_KEY: ${MCP_API_KEY:-} # Strongly recommended for any remote access!

      # === Optional tuning ===
      LOG_LEVEL: ${LOG_LEVEL:-info}
      CACHE_TTL: ${CACHE_TTL:-60}
      REQUEST_TIMEOUT: ${REQUEST_TIMEOUT:-30000}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3100/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Create a `.env` file next to it (never commit this):

```env
COUCHDB_URL=http://192.168.1.42:5984
DBNAME=my-vault-db
COUCHDB_USER=admin
COUCHDB_PASSWORD=supersecret
PASSPHRASE="this is my long live sync e2ee passphrase from obsidian"
MCP_API_KEY="a-very-long-random-string-at-least-32-characters"
# MCP_PORT=3100
# LOG_LEVEL=debug
```

Then:

```bash
docker compose up -d
docker compose logs -f
```

The server will be listening on port 3100 (inside and outside the container).

### Plain `docker run`

```bash
docker run -d \
  --name obsidian-livesync-mcp \
  -p 3100:3100 \
  -e hostname=http://192.168.1.42:5984 \
  -e dbname=my-vault-db \
  -e username=admin \
  -e password=supersecret \
  -e PASSPHRASE="my e2ee passphrase" \
  -e MCP_API_KEY="random-key-here" \
  -e MCP_TRANSPORT=http \
  --restart unless-stopped \
  ghcr.io/OWNER/obsidian-livesync-mcp:latest
```

Replace `OWNER` with the GitHub owner of the image (or build locally with `docker build -t obsidian-livesync-mcp .` and use that name).

---

## Bare Metal / Local Node.js

```bash
git clone https://github.com/YOUR-ORG/obsidian-livesync-mcp.git
cd obsidian-livesync-mcp

# Important: livesync-commonlib is a git submodule
git submodule update --init --recursive

npm ci
npm run build
```

Create a `.env` file in the project root (or export variables):

```env
hostname=http://192.168.1.42:5984
dbname=my-vault-db
username=admin
password=supersecret
PASSPHRASE="my live sync e2ee passphrase"
MCP_API_KEY="random-key-for-http-access"
MCP_TRANSPORT=stdio          # or http
# MCP_PORT=3100
# LOG_LEVEL=info
```

Run it:

```bash
# stdio mode (great for local MCP clients that spawn a process)
node dist/index.cjs

# or HTTP mode
MCP_TRANSPORT=http node dist/index.cjs
```

For development (no rebuild needed on changes):

```bash
npm run dev
```

---

## Configuration Reference

All configuration is done via environment variables (or a `.env` file in the working directory). The server will validate on startup and exit with a clear error if required values are missing or invalid.

| Variable          | Required | Default | Description                                                                                                                                                                                                     |
| ----------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`        | **yes**  | —       | Base URL of your CouchDB **without** the database name. Must include protocol (`http://` or `https://`). Example: `https://couch.example.com:5984` or `http://10.0.0.5:5984`                                    |
| `dbname`          | **yes**  | —       | The CouchDB database name that contains your LiveSync vault (e.g. `obsidian` or `my-vault`).                                                                                                                    |
| `username`        | no       | (empty) | CouchDB basic auth username. Leave empty if your CouchDB is open or you use other auth (proxy, etc.).                                                                                                           |
| `password`        | no       | (empty) | CouchDB basic auth password.                                                                                                                                                                                    |
| `PASSPHRASE`      | no\*     | (empty) | Your LiveSync E2EE passphrase **exactly** as shown in the Obsidian plugin. If your vault has E2EE disabled, set this to an empty string or omit it. \*Some Docker Compose examples mark it required for safety. |
| `MCP_TRANSPORT`   | no       | `stdio` | `stdio` (local process) or `http` (starts a Streamable HTTP server on `MCP_PORT`). |
| `MCP_PORT`        | no       | `3100`  | TCP port the HTTP server listens on (only used when transport is not stdio).                                                                                                                                    |
| `MCP_API_KEY`     | no       | (empty) | If set, every HTTP request **must** include `Authorization: Bearer <this-key>`. Highly recommended for any exposure beyond localhost.                                                                           |
| `LOG_LEVEL`       | no       | `info`  | `debug`, `info`, `warn`, or `error`. Debug is very noisy (shows every tool call).                                                                                                                               |
| `CACHE_TTL`       | no       | `60`    | Reserved for future in-memory caching (seconds). Currently unused but accepted.                                                                                                                                 |
| `REQUEST_TIMEOUT` | no       | `30000` | CouchDB request timeout in milliseconds.                                                                                                                                                                        |

**Security note**: Never put real secrets in your shell history or commit `.env`. Use a secret manager or at least `chmod 600 .env`.

---

## MCP Tools

These are the tools the server registers with any connected MCP client. The AI can call them by name with the documented arguments. All responses come back as text (often pretty-printed JSON for structured data).

| Tool                  | Description                                                                                                                                                            | Required Args                                                                  | Optional                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `list_files_in_vault` | List every file (note) in the vault. Returns array of `{path, type, size, mtime, ctime}`.                                                                              | —                                                                              | `prefix` (e.g. `"Projects/"` or `"Daily/"`) |
| `list_files_in_dir`   | Convenience wrapper around the above for a specific directory.                                                                                                         | `path` (directory, with or without trailing `/`)                               | —                                           |
| `get_file_contents`   | Return the **full decrypted** text content of a single file.                                                                                                           | `path`                                                                         | —                                           |
| `search`              | Search both file paths and file contents. Returns up to 20 results with snippets (300 chars) and match count per file. Filename matches return the file start; content matches show context around the first hit. | `query`                                                                        | —                                           |
| `create_note`         | Create a brand new note (overwrites if the exact path already exists). Content is stored as a single content-hashed chunk.                                             | `path`, `content`                                                              | —                                           |
| `append_content`      | Read existing file (or create empty), concatenate `content`, and write back.                                                                                           | `path`, `content`                                                              | —                                           |
| `patch_content`       | Powerful structured edit: locate a markdown heading (e.g. `## TODO`), then `replace`, `append`, or `prepend` new content under it (until the next same-level heading). | `path`, `heading`, `content`, `operation` ("replace" \| "append" \| "prepend") | —                                           |
| `delete_file`         | Soft-delete the metadata document and all its chunks (tombstones). LiveSync will see the deletion.                                                                     | `path`                                                                         | —                                           |
| `rename_file`         | Rename or move a file. Reads content from `oldPath`, writes to `newPath`, then deletes `oldPath`. Fails if `newPath` already exists.                                   | `oldPath`, `newPath`                                                          | —                                           |

**Example of what the AI sees** (tool call result for `list_files_in_dir`):

```json
[
  {
    "path": "Projects/obsidian-livesync-mcp/PLAN.md",
    "type": "plain",
    "size": 18432,
    "mtime": 1712345678901,
    "ctime": 1712000000000
  },
  ...
]
```

The `patch_content` tool is especially useful for LLMs because it lets them make precise, non-destructive updates to long documents without having to regurgitate the entire file.

---

## Connecting to MCP Clients

### 1. Local stdio (most private & simple)

Many clients can launch the server as a child process.

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, similar on Windows/Linux):

```json
{
  "mcpServers": {
    "obsidian-livesync": {
      "command": "node",
      "args": ["/Users/you/path/to/obsidian-livesync-mcp/dist/index.cjs"],
      "env": {
        "hostname": "http://192.168.1.42:5984",
        "dbname": "my-vault-db",
        "username": "admin",
        "password": "supersecret",
        "PASSPHRASE": "my live sync e2ee passphrase",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

**Other stdio clients** (Cursor, Cline, etc.) usually have a similar `command` + `args` + `env` block.

**Tip**: Use an absolute path to `dist/index.cjs`. For development you can point at `tsx` + `src/index.ts` instead.

### 2. Remote Streamable HTTP (Docker / server deployments)

```json
{
  "mcpServers": {
    "obsidian-livesync": {
      "type": "streamable-http",
      "url": "http://your-server:3100",
      "headers": {
        "Authorization": "Bearer a-very-long-random-string-at-least-32-characters"
      }
    }
  }
}
```

Some clients also accept a `url` ending in `/mcp` or expect legacy SSE behavior — try the bare origin first (`http://host:port`). The server handles the Streamable HTTP protocol at the root.

#### opencode example (from the project)

```jsonc
{
  "mcp": {
    "obsidian-livesync": {
      "type": "remote",
      "url": "http://localhost:3100",
      "headers": {
        "Authorization": "Bearer your-mcp-api-key-here",
      },
    },
  },
}
```

#### Cursor / Windsurf / etc.

Look for `mcp.json` or settings under "MCP Servers". Choose "Streamable HTTP" / "SSE" transport and supply the URL + auth header.

**Security reminder**: When using HTTP transport, the `MCP_API_KEY` is the only thing standing between the internet (or your LAN) and your entire encrypted note vault. Use a long random value and put the endpoint behind HTTPS + additional auth if possible.

---

## Health & Observability

When running in HTTP mode the server exposes:

- `GET /health` — returns JSON like:
  ```json
  {
    "status": "ok",
    "couchdb": "connected",
    "version": "0.1.0",
    "uptime": 123456,
    "error": null
  }
  ```

Logs are emitted as single-line JSON to stderr:

```json
{
  "time": "2026-06-13T12:34:56.789Z",
  "level": "info",
  "logger": "mcp",
  "msg": "Tool completed",
  "tool": "get_file_contents",
  "durationMs": 42
}
```

Set `LOG_LEVEL=debug` to see every incoming tool call.

---

## Example Prompts You Can Give Your AI

- "List all markdown files under the `Projects/` folder."
- "Read `Daily/2026-06-13.md` and give me a 3-bullet summary plus any open action items."
- "Create a new note at `Inbox/ideas-from-claude.md` with the following content: ..."
- "Append today's wins to `Journal/2026-06.md` under the `## Wins` heading."
- "In the file `Projects/Website-Rewrite.md`, find the heading `## Open Questions` and append this new question under it."
- "Search for notes mentioning 'MCP' in their filename or content."
- "Delete the temporary note `tmp/test-123.md`."

Because the tools return real file contents (decrypted), the model has the full context of your actual notes.

---

## Updating

### Docker Compose

```bash
docker compose pull   # if using pre-built image
docker compose up -d
```

Or if building locally:

```bash
docker compose build --pull
docker compose up -d
```

### Local / Git

```bash
git pull
git submodule update --init --recursive
npm ci
npm run build
# restart your process or MCP client
```

The GHCR image is rebuilt and tagged `latest` automatically on every push to `main` (after tests pass).

---

## Development

```bash
# after clone + submodule init
npm install

npm run build       # production build to dist/
npm run dev         # tsx watch mode (great for iterating on tools)
npm run test        # vitest (unit tests for config, couchdb logic, health)
npm run test:watch
npm run typecheck   # tsc --noEmit
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

The test suite uses mocks for PouchDB so it can run without a real CouchDB. End-to-end testing is done manually against a real vault (see `PLAN.md` for a detailed harness using `curl` + the JSON-RPC wire protocol).

**Important for contributors**: The `lib/` directory is a git submodule pointing at https://github.com/vrtmrz/livesync-commonlib. Changes to the common library should be made upstream.

---

## Limitations & Known Behaviors

- **Search is file path + content** — The `search` tool now matches against both file paths and file contents, with snippets and match counts. It scans all docs in CouchDB client-side and decrypts each candidate, so it's not a full-text index — fine for personal vaults.
- **Single-chunk writes** — When creating or overwriting via the MCP tools we store the entire content as one chunk (content-hashed for dedup). This is simpler and works great for typical notes. The plugin's more sophisticated multi-chunk splitters (Rabin-Karp etc.) are used when Obsidian itself writes large files. Your vault will contain a mixture; everything remains readable.
- **No binary / attachment tools yet** — The current tool surface focuses on text notes (`plain` and `newnote` types). Binary files present in the vault can be listed but reading/writing them via MCP is not implemented.
- **No full-text index or advanced queries** — All listing and searching is done via CouchDB `_all_docs` + client-side filtering. Fine for personal vaults (< tens of thousands of notes).
- **Concurrent edits** — If you (or an agent) and a device edit the same note at the same time, LiveSync will surface a conflict in the Obsidian UI exactly as it does today. The MCP server does not attempt to merge.
- **Cache TTL currently unused** — The setting is accepted for forward compatibility.
- **Very large files** — Extremely large single notes may hit CouchDB document size limits or take a while to transfer. Same constraints as the LiveSync plugin itself.

---

## Security & Privacy Considerations

- The MCP server (when given the passphrase) can decrypt **everything** in the vault. Run it only on machines you trust.
- Treat the `PASSPHRASE` and `MCP_API_KEY` as highly sensitive secrets.
- When exposing the HTTP transport, use a strong `MCP_API_KEY` **and** put the service behind TLS + (ideally) another layer of authentication or network ACLs.
- The server performs no additional authorization — whoever can call the MCP tools can read/write any note the LiveSync user could.
- All decryption happens in-process in Node.js. The passphrase is only ever in memory and environment variables.
- Nothing is sent to any third-party LLM provider unless _you_ configure your MCP client to do so.

---

## Troubleshooting

- **"Config validation failed"** — Double-check that `hostname` includes the protocol and that `dbname` is just the database name, not a full path.
- **Authentication errors from CouchDB** — Verify `username`/`password` and that the user has read/write access to the specific database.
- **Decryption fails / garbage content** — You almost certainly have the wrong `PASSPHRASE` or the vault uses a different encryption version. Copy the exact value from Obsidian's LiveSync settings.
- **"File not found"** even though it exists in Obsidian — Path matching is case-sensitive in some places; try the exact casing shown by `list_files_in_vault`. Also check whether path obfuscation is enabled (the server tries both obfuscated and plain IDs automatically when a passphrase is supplied).
- **Healthcheck failing in Docker** — Make sure `wget` can reach the internal `http://localhost:3100/health` (the container's own network).
- **Client can't connect over HTTP** — Try the bare `http://host:port` first. Some clients default to appending `/sse` or `/mcp`; you may need to adjust the URL in the client config. Check server logs for incoming requests.
- **Submodule not checked out** — `git submodule update --init --recursive` is mandatory for local builds and some editors.

Enable `LOG_LEVEL=debug` for much more insight into what the server is doing on each tool call and CouchDB round-trip.

---

## Credits & Acknowledgments

- Built on top of the excellent [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) ecosystem and its shared library (`livesync-commonlib`).
- Heavy use of [octagonal-wheels](https://github.com/vrtmrz/octagonal-wheels) encryption primitives.
- Powered by the official [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol).
- PouchDB HTTP adapter for talking directly to CouchDB.
- Inspired by the clear, thorough documentation style of other excellent self-hosted projects (especially [changedetection.io](https://github.com/dgtlmoon/changedetection.io)).

Huge thanks to vrtmrz and the LiveSync community for making self-hosted, encrypted Obsidian sync a reality.

---

## License

MIT © 2026

See [LICENSE](LICENSE) for details.

---

## Contributing

Issues and PRs are welcome! Please:

1. Open an issue describing the problem or feature.
2. For code changes, run `npm run test && npm run typecheck && npm run lint` before submitting.
3. Large changes or new tools should probably be discussed first.

When working on the MCP tools themselves, remember that every change affects real users' vaults — be conservative and add good error handling.

---

**Star the repo if this unlocks new AI + Obsidian workflows for you!**

Questions? Open a GitHub issue or discussion.

---

*Built with AI assistance.*
