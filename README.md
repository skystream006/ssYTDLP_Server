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

## Passkey access

The app and operational APIs require passkey authentication. On a new server, register
the first passkey to create the initial approved administrator. Later registrations are
saved as pending and cannot log in until an administrator approves them from **Admin**.
Administrators can approve or revoke access and assign user or admin roles.
Complete the first registration locally before exposing a new server to other users,
because the first verified passkey is intentionally trusted as the initial administrator.

Passkeys work on `localhost` without TLS. Other hosts must be served over HTTPS. When the
public address differs from the address seen by Express, configure both values explicitly:

```bash
PASSKEY_RP_ID=music.example.com
PASSKEY_ORIGIN=https://music.example.com
npm start
```

Users, public passkey credentials, access decisions, and hashed login sessions are stored
in `data/auth.json`. Set `AUTH_STORE_PATH` to use a different file. Private passkey keys
remain in the user's authenticator, such as Bitwarden, and are never sent to the server.

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

Jobs are persisted in `data/jobs.json` and restored after server restarts.
Set `JOB_STORE_PATH` to use a different history file. Jobs show
queued/running/completed/partially completed/failed status; any active job interrupted by a restart
is restored as failed so it can be rerun safely.
Private videos skipped by yt-dlp produce a partially completed job rather than a failed job.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.
Use **Download all** on a job with files to download its songs as a ZIP archive.
Job details include the command and complete captured stdout and stderr output.

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
