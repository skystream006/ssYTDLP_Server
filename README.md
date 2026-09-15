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

Copy `.env.example` to `.env`, then adjust its values for your server. `npm start`
loads `.env`, builds the React frontend, starts an HTTP redirect on `WEB_API_PORT`,
and serves the app and API over TLS on `HTTPS_WEB_PORT`.
For frontend development, run `npm run dev` while the API server is running.
To override either listener from the command line:

```bash
npm start -- --http-port 3000 --https-port 4000
```

The legacy `--port`, positional port, and standard `PORT` environment variable configure
the HTTP redirect listener. Command-line arguments take precedence over environment variables.

## Passkey access

The app and operational APIs require passkey authentication. On a new server, register
the first passkey to create the initial approved administrator. Later registrations are
saved as pending and cannot log in until an administrator approves them from **Admin**.
Administrators can approve or revoke access and assign user or admin roles.
Complete the first registration locally before exposing a new server to other users,
because the first verified passkey is intentionally trusted as the initial administrator.

Passkeys work on `localhost` without TLS, but other hosts require HTTPS. The server creates
`data/tls/server-key.pem` and `data/tls/server-cert.pem` when certificate paths are omitted.
Trust the generated certificate on each client before opening the app, or configure a trusted
certificate with `HTTPS_KEY_PATH` and `HTTPS_CERT_PATH`.

The passkey origin must include `HTTPS_WEB_PORT` when it is not the default port 443:

```bash
WEB_API_PORT=3000
HTTPS_WEB_PORT=4000
PASSKEY_RP_ID=music.example.com
PASSKEY_ORIGIN=https://music.example.com:4000
npm start
```

Do not use a raw IP address for `PASSKEY_RP_ID`; passkey clients require a domain-shaped
relying-party ID. For LAN-only use, configure a hostname in local DNS, or use a resolving
hostname such as `192-168-3-175.sslip.io` for the server at `192.168.3.175`:

```bash
PASSKEY_RP_ID=192-168-3-175.sslip.io
PASSKEY_ORIGIN=https://192-168-3-175.sslip.io:4000
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

- Open the HTTPS URL configured by `PASSKEY_ORIGIN`
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
