# Obsidian Vault Image Organizer

A single-page, client-side tool for auditing and cleaning up image references in an [Obsidian](https://obsidian.md) vault - no plugin install, no upload, everything stays on your machine.

It reads your vault directly from disk using the browser's File System Access API, so nothing is sent anywhere.

## Features

- **Audit** - read-only scan of every image reference in every note. Reports each one as clean, needing consolidation, broken, or an online link.
- **Repair** - finds broken image links and reconnects them to the matching file elsewhere in the vault. Exact filename matches are pre-ticked as *Fix*; anything less certain is offered as a *Possible match* with a thumbnail preview, and is never applied automatically.
- **Consolidate** - copies every referenced image into an `attachments/` folder next to its note and rewrites links to point there. Originals are copied, not moved.
- **Cleanup** - four sub-tools for what's left over:
  - **Orphans** - images no note references anymore.
  - **Leftover originals** - source images left behind after consolidating.
  - **Duplicates** - identical images (by SHA-256 hash) living at more than one path.
  - **Empty folders** - folders left empty after cleanup.

### Safety

- Every note is backed up to `.vault-organizer-backups/` before it's rewritten.
- A write is refused outright if it would shrink or empty a note.
- Repair only ever matches on filenames, never file contents - thumbnails let you confirm visually before anything is written.
- `.git`, `.obsidian`, and the backups folder are never scanned or touched.

Recommended order: **Audit → Repair → Consolidate → Audit → Cleanup**.

## Requirements

A recent desktop version of **Chrome, Edge, or Brave**. The File System Access API isn't supported in Firefox or Safari, and the vault picker won't work inside an embedded frame.

## Running it

The app is just static files (`index.html`, `styles.css`, `core.js`, `features.js`), but it needs to be served over `http://` (not opened directly as a `file://` URL) for the vault picker to work reliably.

**Windows:** double-click `start-server.bat`. It starts a local web server, opens the app in your browser automatically, and also prints a network URL so you can reach it from other devices on the same Wi-Fi/LAN.

**Manually (any OS):** run any static file server from the project folder, e.g.:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`.

> **Note:** the file-picker feature works fully on `localhost`. If you open the app from another device via the LAN IP, Chrome may block the picker because that origin isn't served over HTTPS. Use the network link for viewing/demo purposes; do vault editing from the machine running the server.

## License

MIT - see [LICENSE](LICENSE).
