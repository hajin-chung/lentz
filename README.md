# Lentz

A small browser workspace for pi conversations and files on your server. Arrange tabs in resizable panes, save named workspaces, and open the same workspace on your phone.

## Run

Requires Node.js 22.13+ and `pi` on your PATH. The RPC integration has been checked against pi 1.4.0. Use your existing pi provider configuration and sign-ins.

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:4317**. Development serves the app and API from one port, with frontend hot reload. Restart the command after changing server code.

For Tailscale, bind to this machine's Tailscale IP:

```bash
npm run dev -- --host "$(tailscale ip -4)" --root "$HOME"
```

Open `http://<that-tailscale-ip>:4317` on your laptop or phone. Lentz deliberately has no login; binding specifically to the Tailscale address keeps it on your tailnet. Plain HTTP is supported.

For a production build:

```bash
npm run build
npm start -- --host "$(tailscale ip -4)" --root "$HOME"
```

Keep the server process running in tmux or a service if you want it to survive SSH disconnects. Browser disconnects do not stop agents. Restarting the Lentz server is different: transcripts persist, but automatic recovery of interrupted model/tool execution is not part of this version.

## Docker Compose

`Dockerfile` builds the frontend in a separate stage and runs the server as a non-root user on Node.js 24, with pi **1.4.0** installed. The runtime includes Bash, Git, curl, and ripgrep; tools installed only on the host are not automatically available inside the container. Add project-specific tools in a derived image as needed.

The example `docker-compose.yaml` follows the `~/compose` convention: `restart: unless-stopped`, UID/GID `1000:1000`, and the external `proxy` network for Caddy. From this repository:

```bash
# Only if the shared network does not already exist:
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy

docker compose up -d --build
docker compose logs -f lentz
```

Or keep the deployment under `~/compose/lentz`:

```bash
mkdir -p ~/compose/lentz
cp ~/projects/lentz/docker-compose.yaml ~/compose/lentz/docker-compose.yaml
cd ~/compose/lentz
printf 'LENTZ_SOURCE=../../projects/lentz\n' > .env
docker compose up -d --build
```

Optional Compose variables in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LENTZ_SOURCE` | `.` | Build context, relative to the Compose file |
| `LENTZ_HOME` | `/home/hajin` | Host home directory, mounted at the identical container path |
| `PI_VERSION` | `1.4.0` | Installed pi version; changing it requires a rebuild |
| `LENTZ_BIND_IP` | `127.0.0.1` | Used only if the commented `ports` mapping is enabled |

The same-path home mount is intentional: saved pi sessions contain absolute working directories. It also reuses `~/.pi` configuration, sign-ins, extensions, and native session files. Match `user` to the owner of the mounted files if your UID/GID differs; the image's writable directories and a new `lentz-data` volume are owned by `1000:1000` by default and need matching ownership if changed. Mount any additional directories needed by your sessions at their original absolute paths. Extensions or provider configuration that invoke host-only programs may need those programs installed in the image too. No credentials are copied into the image.

Workspace layouts/preferences persist in the `lentz-data` named volume at `/var/lib/lentz`, separate from pi transcripts in the mounted home. To reuse the native server's existing layouts instead, replace `lentz-data:/var/lib/lentz` with `/home/hajin/.local/share/lentz:/var/lib/lentz` and stop the native server before starting Compose. Do not share a data directory between running servers, or attach the same session with independent pi processes.

### Access through Caddy or Tailscale

No host port is published by default. Add a site to your existing Caddy configuration, using your own private hostname:

```caddyfile
lentz.example.com {
    reverse_proxy lentz:4317
}
```

Both containers must use the `proxy` network. Alternatively, uncomment the `ports` mapping in `docker-compose.yaml`, set `LENTZ_BIND_IP` to the host's Tailscale IPv4 address (`tailscale ip -4`), and recreate the service. Then open `http://<tailscale-ip>:4317`.

**Lentz has no authentication. Keep access restricted to your tailnet/trusted network; HTTPS alone is not access control.** The example grants the browser file API and pi access to your home, including sensitive files. Pi commands run inside the container as UID 1000, with read/write access to all bind-mounted files. Do not mount the Docker socket or run the container privileged.

If your provider uses environment-variable API keys instead of pi's saved sign-ins, explicitly pass the required variables in the service's `environment` section. Compose's `.env` file supplies interpolation values; it does not automatically pass every variable into the container.

Update with `docker compose up -d --build`. `docker compose down` preserves the named volume; **`docker compose down -v` deletes saved layouts/preferences**. Rebuilding/restarting does not resume interrupted model/tool execution. Inspect startup/health with `docker compose ps` and `docker compose logs lentz`.

After building, `npm run test:docker` verifies health, frontend serving, pi RPC session creation, paginated history/full-body retrieval, clean restart, and persistence across container recreation. It uses a temporary home and named volume, publishes only a random loopback port, and sends no model prompt or host credentials. Set `LENTZ_TEST_IMAGE` to test a different image tag.

## Startup options

Pass flags after `--` with either `npm start` or `npm run dev`.

| Flag            | Environment variable          | Default                                                     |
| --------------- | ----------------------------- | ----------------------------------------------------------- |
| `--root`        | `LENTZ_ROOT`                  | Your home directory                                         |
| `--host`        | `LENTZ_HOST`                  | `127.0.0.1`                                                 |
| `--port`        | `LENTZ_PORT`                  | `4317`                                                      |
| `--data-dir`    | `LENTZ_DATA_DIR`              | `~/.local/share/lentz`                                      |
| `--pi`          | `LENTZ_PI`                    | `pi`                                                        |
| `--session-dir` | `PI_CODING_AGENT_SESSION_DIR` | `~/.pi/agent/sessions` (under `PI_CODING_AGENT_DIR` if set) |

`--session-dir` selects the root to scan; new sessions go into project subdirectories beneath it, matching pi's default directory convention. Existing sessions retain their original path.

The file root confines browser file access and directory selection, including symlinks. **It is not a sandbox for pi's tools**: pi runs as your server user. One server may use a given data directory at a time.

## Workspace controls

- The **workspace name** at the left of the bottom strip opens workspace switching, creation, and new-tab actions. `Ctrl/⌘ K` also opens it.
- Each pane's **+** opens tab creation, horizontal/vertical splitting, maximize/restore, and close-pane actions.
- Drag tabs to reorder them, move them between panes, or dock them at an edge. Drag the space between panes to resize.
- **Chat**, **Files**, and **Settings** are ordinary tabs. No fixed sidebar or header is required.
- On screens up to 700px wide, a pane switcher shows one pane at a time with its own tabs. Switching back to desktop restores the existing proportions when the split structure has not changed.
- Workspaces and preferences save on the server. Device selection and unsent chat drafts stay in that browser. Layout edits are not live collaborative: a stale writer gets a conflict instead of silently overwriting another device's changes.
- Settings contains theme, accent color, text size, motion, hidden files, default directory, HTML script behavior, Enter-to-send, and workspace rename/removal.

## Chat tabs

A new Chat tab lists saved pi conversations inside the configured root. Pick one, or choose a directory and start a conversation. Tabs can use different directories.

Chat supports streamed text, thinking, expandable tool calls/results, model and thinking selection, Stop, and messages queued or steered during a run. Consecutive Pi messages share one label; reasoning and tool calls are grouped in a single collapsed Thinking section. Supported pi extension dialogs are shown inline.

Closing a chat tab, closing a pane, changing workspaces, or removing a workspace does **not** stop or delete the conversation. Reopening the conversation attaches to the same server-owned runtime. Multiple browser views of a conversation share one runtime.

Exit a native CLI session before resuming its saved conversation in Lentz. This version does not attach to a live terminal UI. Before returning a browser-owned session to the CLI, stop/release its runtime (the API exposes `POST /api/sessions/:id/release`), or shut down the Lentz server. Do not run two independent pi processes writing the same session file. Normal pi sessions stay in native JSONL format; Lentz does not rewrite their history.

## File tabs

A file tab begins with a directory tree. Click a folder name to enter it, its arrow to expand it, or type a path. Selecting a file replaces the tree; Back restores the directory. The row's external-arrow button opens a file in a new tab.

Every file has a **Text / Preview** toggle. Text mode bypasses format detection and is saved with that tab's layout. It displays up to the first **5 MB**, with an indicator when truncated. Binary or non-UTF-8 bytes are shown as a read-only approximation; this does not enable editing or rewrite the file. Readable source files take precedence over audio/video extension guesses, so TypeScript `.ts` and `.mts` files open as code while binary transport streams still open as video.

| Type                   | Behavior                                                               |
| ---------------------- | ---------------------------------------------------------------------- |
| UTF-8 text / code      | CodeMirror viewer, Edit, Save / Discard; syntax highlighting           |
| Markdown               | Rendered GFM, including local images; editable source                  |
| HTML                   | Sandboxed document preview with relative local assets; editable source |
| Images                 | Browser-native image rendering with zoom                               |
| Audio / video          | Browser-native playback and seeking, with HTTP range support           |
| PDF                    | PDF.js viewer with pages, selectable text, and zoom                    |
| CSV / TSV / XLS / XLSX | SheetJS table preview with worksheet selection and pagination          |

Text editing supports UTF-8 files up to **5 MB**. Saves compare the original content revision, then use an atomic replacement; if pi or another editor changes the file, the draft is retained and saving is refused. Drafts survive tab/workspace switches in browser session storage when available. Files beyond the limit remain downloadable.

Spreadsheet parsing runs in a worker, with a **25 MB** file limit and previews limited to **10,000 rows / 200 columns**. Tables display stored values; they do not edit spreadsheets or recalculate formulas. CSV/TSV can be edited as text.

HTML scripts are off by default and can be enabled in Settings. They run in a sandbox without access to the parent app; preview network fetches, forms, and nested frames are blocked. Inline scripts and local scripts/styles/images are supported; external CDN dependencies may need to be stored locally. Markdown raw HTML is not executed. Audio/video/image format support follows your browser; no transcoding is performed.

## Interface conventions

Shared visual values live in `src/tokens.css`. Use the 4, 8, 12, 16, 24, and 32 px spacing scale, with 16 px pane insets and 4 × 8 px toolbar insets. Interface type has three roles: UI labels/controls and text previews (12 px), body/editor text (14 px), and headings (16 px) at the default text-size setting; all follow the user's preference. Document headings retain their own hierarchy. Mobile text-entry fields have a 16 px minimum to avoid browser zoom, and touch rows are 44 px tall.

Use square corners, flat fills, and one-pixel dividers. Keep section labels in sentence case. Avoid component-specific spacing values, decorative shadows/gradients, and animated scaling. Use the system sans-serif font for interface text and monospace for code and paths.

## Development

```bash
npm run check       # TypeScript
npm test            # File boundaries, concurrent saves, persistence, HTTP, event reduction
npm run test:pi     # Installed pi RPC handshake; no model prompt or paid model request
npx playwright install chromium
npm run test:e2e    # Browser workflows against a deterministic pi fixture
npm run build
```

The browser tests use an isolated temporary root and session store. They do not send prompts to a real provider or modify your native pi sessions.

```text
server/
  app.ts           HTTP routes, streams, and runtime ownership
  files.ts         Root confinement, file metadata, revision-checked writes
  store.ts         Atomic workspace/preferences persistence
  pi/              Native pi RPC process adapter and session discovery
shared/            Shared protocol/view models and stream reducer
src/
  workspace.tsx    Dockview shell, workspace menu, mobile pane selection
  state.tsx        Preferences and serialized workspace saves
  tabs/            Chat, Files, Settings
  viewers/         Lazy-loaded file renderers and spreadsheet worker
  components/      Directory tree and shared UI
tests/             Unit, HTTP, RPC, and browser tests
```

The frontend uses React/TypeScript, Dockview, CodeMirror, react-markdown, react-pdf/PDF.js, and SheetJS. The backend uses Fastify and pi's JSONL RPC interface. Assets and viewers are bundled locally; interface fonts come from the operating system, and the browser does not need a CDN.

## Long conversation history

A chat initially loads at most **40 recent messages / 128 KiB of message data**, plus session metadata. **Load older messages** fetches the preceding page and keeps the visible message in place. Messages larger than **8 KiB** start as excerpts; **Load full message**, **Load full activity**, and **Load full result** fetch the original body explicitly. Closed thinking/tool disclosures do not render their contents.

Each runtime assigns an epoch, stable message ordinals, revisions, and global assistant-group IDs without changing native JSONL entries. Tool results reference their originating calls across page boundaries. Older pages merge by revision, so an in-flight page cannot replace newer streamed content. Views maintain independent page ranges. Reconnects receive a recent snapshot, revalidate their previously loaded range through bounded forward pages, and fill missed messages. A runtime restart or Pi context replacement creates a new epoch and resets stale cursors. Turn completion refreshes metadata only; it does not request or broadcast full history. Exceptional context changes, such as compaction, still retrieve a new authoritative history.

Pi's `get_messages` still returns the full conversation during cold startup. Lentz retains it server-side; pagination reduces browser transfer, parsing, and rendering, not Pi's initial disk/RPC work or server memory. Many manually loaded pages and explicitly expanded large bodies can still consume memory. Historical message groups are memoized; virtualization is deferred because the measured 1,002-group fixture took approximately 1 ms to render a small live update, while adding 40 older groups took 28 ms median in development mode.

To reproduce the native Pi measurement with a generated 322-message, 15.6 MiB session (no model prompt):

```bash
npm run build
npm run bench:history
```

The benchmark uses a temporary root and checks that all original JSONL bytes remain unchanged. Pi may append its own session metadata when resuming; Lentz's pagination never writes session files. `LENTZ_PI` can select a different Pi executable.

A local Chromium/production-build sample on November 10, 2026:

| Stage                                                                 | Measured time / size    |
| --------------------------------------------------------------------- | ----------------------- |
| Spawn to first RPC reply (startup proxy)                              | 532 ms                  |
| Initial `get_messages` request to complete reply, before Node parsing | 599 ms / 15.6 MiB       |
| Node RPC JSON parsing / history indexing                              | 22.7 ms / 0.74 ms       |
| Recent snapshot projection / serialization                            | 4.95 ms / 0.25 ms       |
| Initial SSE payload, including model catalog                          | 75 KiB                  |
| Full-history payload serialization baseline from the same fixture     | 32.3 ms / 15.7 MiB      |
| Browser JSON parsing: full baseline / recent snapshot, median of five | 32.8 ms / 0.2 ms        |
| Warm history-page HTTP request: headers / body read                   | 4.9 ms / 0.5 ms, 33 KiB |
| Snapshot receipt to React commit and layout                           | 24.4 ms                 |
| Snapshot receipt to next animation frame                              | 34.3 ms                 |
| Session click to visible recent answer, including cold Pi startup     | 895 ms                  |

These are separate observations, not additive stages: the initial RPC round trip overlaps startup and includes Pi serialization and pipe transfer. The first reply is a startup proxy, not an instrumented Pi-internal startup timer. HTTP timings are loopback measurements and do not predict Tailscale/mobile latency. The full-payload baseline measures serialization and parsing of the same fixture, not an end-to-end run of the previous app. Next-frame timing is a scheduling proxy, not a measurement of pixels painted. React's development Profiler supplies the separate loaded-group render measurements above.

`GET /api/sessions/:id/diagnostics` exposes server phase timings, RPC count, and snapshot bytes. Browser Performance entries named `lentz:<session-id>:parse`, `:commit`, and `:next-frame` measure initial SSE handling; `:react-render` is available in development. The history endpoint also reports projection/serialization through `Server-Timing`.
