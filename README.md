# ssYTDLP_Server

Minimal web app for starting background `yt-dlp` downloads from `music.youtube.com` URLs.

## Requirements

- Node.js 20+

## Setup

```bash
npm install
npm run setup:deno
npm run setup:ytdlp
npm run setup:ffmpeg
npm start
```

On Windows, `setup:deno` may print a PowerShell installation command. Run that
command before starting the server.

`npm start` builds the React frontend and starts the API at `http://localhost:3000`.
For frontend development, run `npm run dev` while the API server is running on port 3000.
To use another port, pass it after `--`:

```bash
npm start -- 4000
```

The `PORT` environment variable and direct `node src/server.js --port 4000` syntax
are also supported.

By default, the server expects Deno at `runtime/deno/bin/deno`.
You can override this with `DENO_PATH=/absolute/path/to/deno`.
It expects yt-dlp at `runtime/yt-dlp/yt-dlp.exe`; override this with
`YTDLP_PATH=/absolute/path/to/yt-dlp`.
FFmpeg and ffprobe are loaded from `runtime/ffmpeg/bin`; override this with
`FFMPEG_PATH=/absolute/path/to/ffmpeg/bin`.

## Usage

- Open `http://localhost:3000`
- Paste a `https://music.youtube.com/...` URL
- Playlist URL (`/playlist?list=...`) runs with `--yes-playlist`
- Any other music URL runs with `--no-playlist`
- Open a finished job's details to view its command, rerun it under the same job ID,
  or delete the job and its downloaded files

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
