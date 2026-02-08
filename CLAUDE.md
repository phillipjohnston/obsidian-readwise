# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A custom fork of the official Readwise Obsidian plugin (`readwise-phillip`). Syncs Readwise highlights to an Obsidian vault. This fork adds a book cache system, filename collision handling, direct API sync, and various diagnostic commands not in the upstream plugin.

## Build Commands

```bash
npm install          # Install dependencies
npm run build        # Production build (outputs main.js via Rollup)
npm run dev          # Dev build with watch mode
npm run dist         # Build + copy main.js, manifest.json, styles.css to dist/
```

There are no tests or linting configured.

## Architecture

Single-plugin architecture. All source is in `src/`, bundled by Rollup into `main.js` (CJS format, `obsidian` is external).

### Source Files

- **`src/main.ts`** (~2700 lines) - The entire plugin: `ReadwisePlugin` class (extends Obsidian `Plugin`), `ReadwiseSettingTab`, interfaces, and all command registrations. This is a large monolithic file.
- **`src/logger.ts`** - `Logger` class with configurable `LogLevel` (ERROR/WARN/INFO/DEBUG). Prefixes all output with `"Readwise:"`.
- **`src/status.ts`** - `StatusBar` class for the Obsidian status bar. Message queue with timeout-based display.

### Key Data Structures

- **`data.json`** (managed by Obsidian's `saveData`/`loadData`) - Plugin settings including `booksIDsMap` (file path -> book ID mapping), `booksToRefresh`, `failedBooks`, sync state.
- **`cache.json`** (managed separately via `vault.adapter`) - Book metadata cache with dual indexes: `byId` for O(1) lookup, `byCategory` for filtered queries. Version 1 format. Stale after 7 days.

### Sync Flow

1. `syncBookHighlights()` is the entry point for all sync operations
2. If there are books to refresh, it calls `refresh_book_export` API (chunked at 500 items)
3. Then `queueExport()` requests an archive build from Readwise
4. `getExportStatus()` polls until the export is ready (intelligent polling: 2-5s intervals)
5. `downloadArtifact()` downloads ZIP archives, extracts JSON entries, and writes `.md` files
6. Files are tracked in `booksIDsMap`; MD5 hashing detects local modifications before overwriting

### Book ID Encoding

Two ID formats coexist: plain numeric IDs for Readwise books, and `readerdocument:{id}` for Reader documents. See `encodeReadwiseBookId()`, `encodeReaderDocumentId()`, `decodeReaderDocumentId()`.

### API Endpoints Used

- `readwise.io/api/obsidian/init` - Kick off export
- `readwise.io/api/get_export_status` - Poll export progress
- `readwise.io/api/v2/download_artifact/{id}` - Download ZIP archive
- `readwise.io/api/obsidian/sync_ack` - Acknowledge sync completion
- `readwise.io/api/refresh_book_export` - Request specific books in next export
- `readwise.io/api/v2/books/` - Paginated book listing (for cache building)
- `readwise.io/api/v2/books/{id}/` and `.../highlights/` - Direct book/highlight fetch
- `readwise.io/api/v2/export/?updatedAfter=` - Incremental cache updates

### Important Behaviors

- **Filename collisions**: `resolveFilenameCollision()` appends `(ID-{bookId})` to filenames when titles collide
- **Rate limiting**: `fetchWithRetry()` handles 429 responses with Retry-After header, exponential backoff for other errors
- **Zero-highlight filtering**: Items with 0 highlights are excluded from missing-item detection and sync
- **File rename tracking**: Plugin listens to Obsidian's `rename` and `delete` vault events to keep `booksIDsMap` current

### Plugin Version

`pluginVersion` constant in `main.ts` must stay in sync with `manifest.json` version.

## Release

GitHub Actions workflow (`.github/workflows/release.yml`) builds on tag push and creates a draft release with `main.js`, `manifest.json`, `styles.css`.

## Tools

`tools/readwise-recovery.sh` - Interactive bash script for diagnosing and resetting sync state via `data.json` manipulation. Hardcoded to the `readwise-official` plugin path (not this fork's path).
