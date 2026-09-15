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
in SQLite alongside job history (see **Database storage** below). Private passkey keys
remain in the user's authenticator, such as Bitwarden, and are never sent to the server.

Passkey registration and login endpoints have stricter per-client rate limits than the
authenticated API. WebAuthn challenge storage is bounded and expired challenges are removed,
JSON request bodies are size-limited, and both listeners enforce connection and request
timeouts. Set `MAX_CONNECTIONS` to adjust each listener's simultaneous connection ceiling.
For an internet-facing deployment, retain these application controls behind a reverse proxy
or managed DDoS service; one Node.js process cannot absorb a volumetric network attack alone.
When a trusted reverse proxy is the only route to the app, set `TRUST_PROXY` to its hop count
or subnet so per-client limits use the forwarded address. Do not enable it when clients can
connect directly, because untrusted forwarding headers can be spoofed.

By default, the server expects Deno at `runtime/deno/bin/deno`.
You can override this with `DENO_PATH=/absolute/path/to/deno`.
It expects yt-dlp at `runtime/yt-dlp/yt-dlp.exe`; override this with
`YTDLP_PATH=/absolute/path/to/yt-dlp`.
FFmpeg and ffprobe are loaded from `runtime/ffmpeg/bin`; override this with
`FFMPEG_PATH=/absolute/path/to/ffmpeg/bin`.

## Usage

- Open the HTTPS URL configured by `PASSKEY_ORIGIN`
- Paste a `https://music.youtube.com/...` URL
- Submitting the same source URL (ignoring surrounding whitespace) prompts to rerun
    the most recent matching job. Confirming replaces its downloaded files and opens its
    details under the same job ID; cancelling leaves it unchanged. Active matches can
    be opened but cannot be rerun until they finish.
- Playlist URL (`/playlist?list=...`) runs with `--yes-playlist`
- Any other music URL runs with `--no-playlist`
- Open a finished job's details to view its command, rerun it under the same job ID,
  or delete the job and its downloaded files

Jobs are persisted in SQLite and restored after server restarts. Jobs show
queued/running/completed/partially completed/failed status; any active job interrupted by a restart
is restored as failed so it can be rerun safely.
Private videos skipped by yt-dlp produce a partially completed job rather than a failed job.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.
Use **Download all** on a job with files to download its songs as a ZIP archive.
Job details include the command and complete captured stdout and stderr output.

## API URL submission

Sign in with an approved user's passkey and open **User settings** using the gear button
in the header. Enter a **PAT name**, then select **Generate PAT**. The dialog displays the
Private Access Token exactly once; use **Copy PAT** and store it securely before closing.
The server stores only its SHA-256 hash. Tokens are never recoverable from listings,
including administrator views. Multiple named PATs can be active at the same time.

Submit a YouTube Music URL using the `X-PAT` header (not `Authorization: Bearer`):

```bash
curl --request POST "https://localhost:4000/api/jobs" \
    --header "X-PAT: ssyt_pat_REPLACE_WITH_YOUR_PAT" \
    --header "Content-Type: application/json" \
    --data '{"url":"https://music.youtube.com/watch?v=VIDEO_ID"}'
```

PowerShell 7 example, with the PAT already in the `SSYTDLP_PAT` environment variable:

```powershell
Invoke-RestMethod -Method Post -Uri 'https://localhost:4000/api/jobs' `
        -Headers @{ 'X-PAT' = $env:SSYTDLP_PAT } `
        -ContentType 'application/json' `
        -Body (@{ url = 'https://music.youtube.com/watch?v=VIDEO_ID' } | ConvertTo-Json)
```

Use HTTPS with a trusted certificate. For local testing with the generated self-signed
certificate only, curl accepts `--insecure` and PowerShell 7 accepts `-SkipCertificateCheck`.
Successful submission returns `202 Accepted` and the job, including its ID. The job is
attributed to the PAT owner. Missing or invalid credentials return `401`, invalid URLs
return `400`, and duplicate URLs return `409` with the existing job.

PATs inherit their owner's current API permissions and do not expire automatically.
Use the trash button in **User settings** to delete a PAT immediately. Administrators
can open **Admin**, select a user in **All users**, and remove that user's PATs from
**User details**. Revoking user access deletes all their PATs; reapproval does not restore them.

PAT management requires a logged-in passkey session, not a PAT:

- `GET /api/auth/pats`: list your PAT IDs, names and creation dates.
- `POST /api/auth/pats` with `{ "name": "Home automation" }`: create a PAT; the response
    includes `id`, `name`, `createdAt`, and the one-time `token` value.
- `DELETE /api/auth/pats/:tokenId`: delete your PAT.
- `GET /api/admin/users/:id`: administrator-only user details and secret-free PAT list.
- `DELETE /api/admin/users/:id/pats/:tokenId`: administrator-only PAT deletion.

The old `/api/auth/api-token` endpoint and bearer authentication have been removed.
Existing old tokens are discarded on upgrade; generate new PATs from User settings.

## Database storage

The app uses SQLite at `data/ssytdlp.sqlite`. Set `DATABASE_PATH` to choose another
location on a local disk. No separate database service is required. Users, credentials,
and sessions have separate tables; jobs are stored as individual records with indexed
URLs, statuses, and creation dates. Flexible job metadata is encoded as JSON within
each row, rather than rewriting a single JSON file containing the entire history.
Only active jobs are retained in memory. Writes are transactional, with WAL journaling
and a five-second busy timeout.

On the first start with a new database, existing `data/auth.json` and `data/jobs.json`
are imported automatically in one transaction. `AUTH_STORE_PATH` and `JOB_STORE_PATH`
now specify only the legacy JSON import locations. IDs, public credentials, session
hashes, job metadata, file paths, and existing duplicate jobs are preserved. Interrupted
jobs are marked failed as before. An invalid import stops startup and rolls back the
transaction; fix the source data and restart to retry.

Stop the old server before the first database-backed start. Back up both JSON files
first, then run `npm start`. The original JSON files are left untouched, are no longer
updated, and are not re-imported on subsequent starts. Editing them will no longer
change application state. Verify the migrated data before archiving those backups.
Private passkey keys remain in the authenticator; existing sessions continue to work.

For a database backup, stop the app cleanly and copy the database together with any
adjacent `-wal` and `-shm` files. Do not copy only the main database while the app is
running. Protect the database and backups with the same filesystem permissions as
the old authentication store, and keep them outside the public directory.

This supports a growing history on a single app server. Dashboard responses still
list all jobs; very large dashboards may eventually need pagination. SQLite does not
make the download scheduler, WebAuthn challenges, or rate limits multi-instance safe.
Do not share this database over a network filesystem or run multiple app servers
against it; horizontal scaling requires a shared database and worker coordination.

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
