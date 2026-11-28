# Tauri migration architecture

- `src/renderer`: bundled local interface, virtualized rows, `window.qk` adapter. No API credentials or networking in the renderer.
- `src-tauri`: native windows, restricted IPC, login Cookie collection, native dialogs and graceful exit. Only the bundled main window can call `qk_call`; remote login content receives no capabilities.
- `crates/quark-core`: shell-independent HTTP/API, Cookie rotation, QCK2 encrypted session/settings, and optional opt-in author hub client (`hub.rs`: Ed25519 manifest verification + SHA-256 direct update download + X25519/AES-256-GCM encrypted sanitized telemetry & feedback; strictly zero network traffic when opted out).
- `crates/quark-transfer`: shell-independent event-driven scheduler, durable queue, adaptive 1–4 MiB multipart downloader (single shared handle + positional buffered I/O + single-pass inline hashing) and buffered SHA-1 prefix multipart uploader.

The original Electron/Node source is no longer part of the runtime. Neither Electron nor Node is shipped with the Tauri application. There is no Electron sidecar.

Upload parts use validated SHA-1 prefix contexts with user-configurable PUT concurrency and a sequential compatibility fallback. Restarted transfer tasks pause instead of automatically modifying cloud data.

A profile lock prevents two desktop processes from writing the same session/task store. Graceful exit cancels active executors and persists paused tasks. Forced termination recovers the last durable checkpoints. Only fully validated bytes are published, with no overwrite of an existing destination.

- `crates/quark-agent`: directory policy, 20 tools, content-bound plans, encrypted configuration, journal, chat and authenticated local gateway (Unix / Windows named pipe). Gated behind default-off `aiBetaEnabled` in Settings; MCP adapter source is embedded at compile time and installed by content hash. Chat turns and transfer enqueue/executors bind the login generation.

GUI → API whitelist → Tauri `qk_call` (trusted main window only) → Core / TransferManager / HubClient / AgentRuntime. Remote login content receives no capabilities.

Product requirements are in `PRODUCT.md`.
