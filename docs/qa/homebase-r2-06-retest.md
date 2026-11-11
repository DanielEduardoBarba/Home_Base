# HB-R2-06 retest (terminal copy/paste) on v1.17.7

- **When:** 2026-11-11, ~2:10–2:12 AM America/New_York (EST).
- **Build:** `development_grok` 1c307eb (PR #10); `/api/health` reports 1.17.7.
- **Bundle confirmed:**
  - `/work/shell` serves `page-67e2e9fb45a84d03.js`.
  - `_next/static/chunks/20.3589faa7b8b52286.js` (terminal) returns 200.
- **How:** `~/APP_PROJECTS/qa/e2e/homebase-r2-06.mjs`, headless Chrome 1280x800 with clipboard read/write granted. Results in `~/APP_PROJECTS/qa/reports/homebase-r2-06-retest.json`.
- **Rerun note:** the first run showed both pastes as failing. The test pressed Enter before the async clipboard read finished. With a 600 ms wait before Enter, both pass. This was a test timing issue, not an app bug.

## Verdict: HB-R2-06 fixed-verified

| Check | Result | Evidence |
|---|---|---|
| Drag-select output | Pass | Selection highlight shown (`desktop-r206-selected.png`) |
| Copy button | Pass | Clipboard = `QA_COPY_ME` |
| Ctrl+Shift+C | Pass | Clipboard = `QA_COPY_ME` |
| Ctrl+C with selection | Pass | Copies; no interrupt sent |
| Ctrl+C with no selection | Pass | Interrupts `sleep 30; echo QA_SLEEP_DONE` (the echo never ran); the next command runs |
| Ctrl+Shift+V | Pass | Pasted `echo QA_PASTE_CSV` ran |
| Paste button | N/A | No Paste button in the toolbar (only Copy); keyboard paste works |
| Right-click a word | Pass | Selects the word; Copy gives `QA_WORD_TARGET` |
| Cmd+C (Mac emulated: Mac user agent + `navigator.platform=MacIntel`) | Pass | Clipboard = `QA_MAC_COPY` |
| Cmd+V (Mac emulated) | Pass | Pasted `echo QA_MAC_PASTE` ran |
| Phone key bar (iPhone 14) | Unchanged | Up, Down, Left, Right, Pipe, Tilde, Slash and Dash each present once; no horizontal overflow (`phone-r206-keys.png`) |

## Chunk 431 tracking
5 cold loads of `/work/shell`, each in a fresh browser context. I watched for ChunkLoadError, "Loading chunk" and 431 messages, any `_next/static` response of 400 or higher, and failed `_next/static` requests.

**Result: 0/5 failed on first load**, so no reload was needed and HB-R2-07 was not filed. Across all R1 and R2 runs (4+4 cold loads on 1.17.5, 5 on 1.17.7), chunk 431 has never reproduced here.

## Cleanup
6 QA shell sessions (2:10–2:12 AM) deleted, and none remain. Nothing else created.
