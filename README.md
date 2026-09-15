# ssYTDLP_Server

Minimal web app for starting background `yt-dlp` downloads from `music.youtube.com` URLs.

## Requirements

- Node.js 20+
- `yt-dlp` available in PATH

## Setup

```bash
npm install
npm run setup:deno
npm start
```

By default, the server expects Deno at `runtime/deno/bin/deno`.
You can override this with `DENO_PATH=/absolute/path/to/deno`.

## Usage

- Open `http://localhost:3000`
- Paste a `https://music.youtube.com/...` URL
- Playlist URL (`/playlist?list=...`) runs with `--yes-playlist`
- Any other music URL runs with `--no-playlist`

Jobs are tracked in-memory and show running/completed/failed status.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.

## Scheduled maintenance

Every day at 03:00 (server local time) the server runs `yt-dlp -U` and `deno upgrade`
to keep both runtimes current. Before the update starts, it waits for any
jobs currently in progress to finish; new jobs submitted during (or just
before) the update are queued and automatically resume once the update
completes.

## System health

Open `http://localhost:3000/health` to view CPU, memory, network, and disk metrics.

## Tests

```bash
npm test
```
