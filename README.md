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

## Docker

Install Docker Engine with the Compose plugin, or Docker Desktop using Linux containers.
No local Node.js, Deno, yt-dlp, or FFmpeg installation is needed. The image builds the
frontend and includes Node.js 24, Deno, Linux yt-dlp, FFmpeg, and ffprobe. Linux amd64
and arm64 are supported. The app runs as a non-root user.

For a new local installation, no `.env` file is required:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Open `https://localhost:4000`, trust the generated local certificate, and register
the first administrator passkey. HTTP on `http://localhost:3000` redirects to HTTPS.
Compose publishes both ports on `127.0.0.1` by default. Stop with `docker compose down`.

Compose reads settings from `.env` if present. An existing `.env` overrides the local
passkey defaults, so ensure its hostname and origin match the URL you use. For LAN
access, configure DNS and a trusted certificate as described under **Passkey access**,
then set these values in `.env` after registering the initial administrator:

```dotenv
DOCKER_BIND_ADDRESS=0.0.0.0
WEB_API_PORT=3123
HTTPS_WEB_PORT=4123
PASSKEY_RP_ID=music.example.com
PASSKEY_ORIGIN=https://music.example.com:4000
```

Passkeys are tied to the relying-party hostname. For a deployment hostname other than
`localhost`, configure that hostname before first registration and access it locally
using DNS or a hosts-file entry while ports are still bound to loopback. Changing the
hostname later requires registering passkeys for the new hostname. When changing
`HTTPS_WEB_PORT`, also update the port in `PASSKEY_ORIGIN`. Apply configuration changes
with `docker compose up -d`.

The `data` named volume preserves SQLite accounts, sessions, job history, and generated
TLS certificates; `output` preserves downloaded media and download archives. They
survive container recreation and `docker compose down`. **Do not use
`docker compose down -v` unless you intend to delete all stored data and downloads.**
Back up both volumes while the app is stopped. Local `data`, `output`, `.env`, and
runtime directories are not copied into the image; existing host data is not migrated
automatically. Container paths are fixed at `/app/data` and `/app/output` in this
Compose configuration.

For your own TLS certificate, add a read-only bind mount such as
`./certs:/app/certs:ro` to the app's `volumes` in `compose.yaml`, then set
`HTTPS_KEY_PATH=/app/certs/server-key.pem` and
`HTTPS_CERT_PATH=/app/certs/server-cert.pem` in `.env`. The files must be readable
by the container's `node` user (UID 1000). Host paths cannot be used directly.

For a transcription service running on the Docker host, use
`TRANSCRIPTION_ENDPOINT=http://host.docker.internal:4317/api/transcribe` in `.env`.
Inside the container, `localhost` refers to the container itself. On Linux, the host
service must listen on an interface reachable from Docker, with firewall access allowed.
For another Compose service, use its service name instead of `localhost`.

The container health check probes HTTPS with local certificate verification disabled
only for that probe. Daily yt-dlp and Deno self-updates remain enabled; runtime binaries
are writable by the app user. Those updates last until the container is recreated.
To refresh the base image, npm dependencies from the lockfile, and bundled runtimes:

```bash
docker compose build --pull --no-cache
docker compose up -d
```

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
WEB_API_PORT=3123
HTTPS_WEB_PORT=4123
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
    the most recent matching job. Confirming keeps its downloaded files and opens its
    details under the same job ID; cancelling leaves it unchanged. Active matches can
    be opened but cannot be rerun until they finish.
- Playlist URL (`/playlist?list=...`) runs with `--yes-playlist`
- Any other music URL runs with `--no-playlist`
- Open a finished job's details to view its command, rerun it under the same job ID,
  or delete the job and its downloaded files
- Use the trash button beside a song in job details to delete that individual file.
    Confirming updates the file list and ZIP contents; other songs are kept.

Approved users can view and download all jobs. Job owners can rerun their jobs,
delete songs, delete the job, and manage its contributors. In job details, use
**Manage contributors** beside **Contributors**, select approved users, and save.
Uncheck a user and save to remove their contributor access. Contributors can rerun
that job and delete individual songs, but cannot delete the job or manage contributors.
Contributor access is per job, not an account role.

Administrators retain full control over every job, including contributor management
and older jobs without a recorded owner. The original initiating user remains the
owner after any rerun. Permissions also apply to PAT requests. Queued/running jobs
cannot be modified, including their contributors, even by administrators.

The dashboard defaults to **My jobs (owned and contributing)** for every user,
including administrators. **All users** and individual initiator filters remain
available. Existing jobs start with no contributors; assignments are persisted in SQLite.

New playlist jobs use a title-and-job-ID folder name to avoid sharing files between
jobs with the same playlist title. Existing folders are preserved. If an older folder
is shared by multiple jobs, non-admin users need permission for the requested action
on every job sharing the folder.

Jobs are persisted in SQLite and restored after server restarts. Jobs show
queued/running/completed/partially completed/failed status; any active job interrupted by a restart
is restored as failed so it can be rerun safely.
Private videos skipped by yt-dlp produce a partially completed job rather than a failed job.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.
Use **Download all** on a job with files to download its songs as a ZIP archive.
Job details include the command and complete captured stdout and stderr output.

Reruns reuse the original output folder and pass `--no-overwrites` and
`--download-archive` to yt-dlp. Successfully downloaded video IDs are recorded in
`.download-archive.txt` inside that folder and skipped on subsequent runs; failed
downloads can be retried. The archive is excluded from the song list and ZIP downloads.
Songs removed from a playlist remain on disk. Downloads made before archive tracking
rely on existing filenames for protection until recorded in the archive. Keep the
archive with its songs: manually deleting a song does not remove its archive entry,
so yt-dlp will still skip it. Deleting a job still removes its folder and archive.
Deleting an individual song through the app also retains its archive entry, so tracked
songs stay skipped on reruns. Older songs not yet tracked may download again.

To remove an individual file via the API, send
`DELETE /api/jobs/:id/files/:name` with the URL-encoded filename. This returns the
updated job, or `403` for insufficient permissions, `404` for an unknown job or song,
and `409` when the job is active or another modification is in progress.

Owners and administrators can manage contributors with:

- `GET /api/jobs/:id/contributors/users`: available approved users, with IDs and names only.
- `PUT /api/jobs/:id/contributors` with `{ "userIds": ["USER_ID"] }`: replace the
    contributor list and return the updated job. Send an empty array to remove all
    contributors. Unknown, pending, revoked, and owner IDs are rejected with `400`;
    insufficient permissions return `403`, missing jobs return `404`, and active or
    busy jobs return `409`.

## Transcription and music player

Set `TRANSCRIPTION_ENDPOINT` in `.env` to the transcription service's complete URL,
for example `http://localhost:4317/api/transcribe`, then restart the server.
The server sends the selected audio from disk; the browser never uploads another copy
or contacts the transcription service directly.

In job details, select the microphone icon beside a song to open **Transcribe song**.
Optionally choose a **Language** from the dropdown. **Auto-detect** leaves the
language unspecified. A selection sends its short code as `language`, for example
`"language": "vi"` for Vietnamese. Language selection works with or without lyrics;
actual language support depends on the transcription service's selected backend.
Optionally enable **Add lyrics**, enter the lyrics, and select exactly one mode:

- **Prompt**: biases recognition toward known words.
- **Align**: maps authoritative lyric lines onto ASR timing.
- **Correct**: replaces recognized text while preserving ASR segment timing.

The info icons show these descriptions on hover or keyboard focus. **Cancel** closes
the dialog without sending anything. **Submit** waits for the result and refreshes
the files. Owners, contributors, and administrators can transcribe idle jobs.
Other modifications to that job are blocked while transcription is in progress.
Once submitted, transcription cannot be cancelled from the dialog.

`POST /api/jobs/:id/files/:name/transcribe` accepts JSON `{}` without lyrics or
`{ "lyrics": "Known lyric lines", "lyrics_mode": "align" }` with lyrics. URL-encode
the complete filename, including `[NoVocals]/` for accompaniment tracks. The server
forwards a multipart POST containing `file`, plus `lyrics`, `lyrics_mode`, and
`language` only when provided. Language codes must match an option in the dropdown.
Lyrics must be nonempty and at most 100,000 characters; the existing
128 KB JSON request limit also applies.

The service must return audio in the original format, or a ZIP containing the exact
original filename plus any accompaniment audio. The original song is replaced;
other audio files are placed in the job's `[NoVocals]` folder and persisted in its
file list. Non-audio ZIP entries are ignored. Invalid audio, unsafe or duplicate ZIP
names, and archives missing the original song are rejected before replacement.
Responses and expanded archives are limited to 512 MB, with at most 100 ZIP files.
Transcription requests have a one-hour timeout, including the response download.
Existing files are staged and restored if replacement or job persistence fails.
Failed upstream requests leave the original files unchanged. There is no automatic
retry, since a disconnected upstream service may still be processing the request.
Reverse proxies must permit long-running requests for this route.

Select a song's name or file icon to open `/job/:id/player` with that song selected.
The queue includes original and `[NoVocals]` tracks, with search, previous/next,
shuffle, repeat, and automatic next-track playback. Native audio controls provide
play/pause, seeking, and volume. Some browsers require pressing play after navigation.
Playback format support depends on the browser.

The **SYLT** selector shows embedded synchronized MP3 lyrics with millisecond
timestamps, highlights the current line, and allows seeking by selecting a line.
**USLT** displays the embedded plain-text lyrics. Untagged songs remain playable.
Title, artist, album and supported embedded cover artwork are read from MP3 tags.
Streaming uses authenticated, byte-range-enabled `/api/jobs/:id/stream/:name`;
metadata is available at `/api/jobs/:id/lyrics/:name`. All approved users can listen.
Accompaniment files also support individual downloads, deletion, ZIP downloads,
and are preserved across reruns.

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

Open `/health` on your configured HTTPS origin to view CPU, memory, network, disk,
and transcription-service status. The server probes `TRANSCRIPTION_ENDPOINT` with
a HEAD request and a two-second timeout on each health refresh; no audio is sent.
**Active** means the endpoint responded successfully or returned HTTP 405 (a
POST-only route). It does not verify model readiness or a successful transcription.
Other responses show **HTTP error** with the status code; connection failures and
timeouts show **Unreachable**. An unset endpoint shows **Not configured**.

## Tests

```bash
npm test
```
