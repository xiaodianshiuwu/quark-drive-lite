# Tauri migration architecture

- `src/renderer`: bundled local interface, virtualized rows, `window.qk` adapter. No API credentials or networking in the renderer.
- `src-tauri`: native windows, restricted IPC, login Cookie collection, native dialogs and graceful exit. Only the bundled main window can call `qk_call`; remote login content receives no capabilities.
- `crates/quark-core`: shell-independent HTTP/API, Cookie rotation, QCK2 encrypted session and settings.
- `crates/quark-transfer`: shell-independent scheduler, durable queue and upload/download checkpoints; bounded streaming and transfer verification.

The original Electron/Node source is reference material during migration. Neither Electron nor Node is shipped with the Tauri application. There is no Electron sidecar. Existing third-party reference code is not newly copied into Rust; Rust request shapes follow documented protocol evidence.

Upload parts use validated SHA-1 prefix contexts with controlled PUT concurrency and a sequential compatibility fallback. Restarted transfer tasks pause instead of automatically modifying cloud data; backup recovery is explicitly started by the user. A shared rate limiter bounds backup PUT bodies across files and parts.

A profile lock prevents two desktop processes from writing the same session/task store. Graceful exit cancels active executors and persists paused tasks. Forced termination recovers the last durable checkpoints. Only fully validated bytes are published, with no overwrite of an existing destination.

- `crates/quark-agent`: directory policy, 20 tools, content-bound plans, encrypted configuration, journal, chat and authenticated local gateway (Unix / Windows named pipe). MCP adapter source is embedded at compile time and installed by content hash. Chat turns and transfer enqueue/executors bind the login generation.
- `crates/quark-backup`: streaming scanner, SQLite task/issue store, fixed worker pool, durable identity, backlog backpressure, controlled cancellation and bounded verification/export. `src-tauri/src/backup_host.rs` only re-exports its host-independent manager.

GUI → API whitelist → Tauri `qk_call` (trusted main window only) → Core / TransferManager / AgentRuntime / BackupManager. Remote login content receives no capabilities. Backup operations use the Core profile and authoritative login binding; logout, login replacement and app shutdown stop backup workers before changing sessions or exiting.

Product requirements are in `PRODUCT.md`, backup behavior in `BACKUP.md`. Historical Electron source is retained for reference and is excluded from the Tauri runtime/build.
