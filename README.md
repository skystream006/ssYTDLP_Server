# ssYTDLP_Server

ssMusic Player is a personal music library backed by ssYTDLP download jobs from
`music.youtube.com` URLs.

## Import music

On **Jobs**, choose **Import music**.

- **Files:** select an existing playlist from your personal library, or check
    **Create New Playlist** and enter its name. Select audio files and choose
    **Import**. MP3, WAV, FLAC, M4A, AAC, OGG, Opus and WMA are accepted; playback
    depends on your browser's codec support. Existing files are never overwritten.
- **iTunes library:** upload an exported iTunes/Music library **XML** and a
    separate **ZIP** containing its local audio files. Both uploads are required.
    Keep artist/album folders in the ZIP so tracks with identical filenames can
    be matched. XML locations are matched against ZIP path suffixes, never read
    from the server or fetched from the network. Missing or ambiguous media fails
    the import. Nonempty playlists and their track order are recreated; folders
    and empty playlists are not imported. Unassigned tracks go into **iTunes Library**.
    Tracks in several playlists are copied into each playlist. Internet-only
    tracks are skipped; unsupported local formats must be converted first.

Original audio and embedded tags are preserved without transcoding. New imports
appear as completed jobs and in your music library; imported jobs cannot be
rerun. Imports into existing playlists require owner or contributor access.

Limits: 2 GB total upload, 512 MB per audio file, 20 MB XML, 1,000 directly
uploaded files, 2,000 ZIP audio files, 500 iTunes playlists, and 4 GB expanded
media (including playlist copies). Uploads use temporary disk storage, cleaned
after each request. Allow enough server disk space for temporary and final audio.
At most two imports run concurrently, with one per user.

The authenticated `POST /api/jobs/import` endpoint accepts multipart form data:
`mode=files`, `createNew=true`, `playlistTitle`, and repeated `files` fields;
or `createNew=false` with `playlistId` instead of `playlistTitle`.
For iTunes, send `mode=itunes`, `xml`, and `media`. Session cookies, PATs and
bearer tokens use the same authentication as the existing jobs API.

## Export your library

Choose **Export library** on the music page, then **iTunes** or **Android (M3U8)**.
The server downloads a ZIP containing your own and contributed library songs,
your personal playlists, and their saved song order (including moved songs and
Individual Songs). Export includes downloaded audio only, not pending downloads.
Original audio, embedded tags, lyrics and artwork are kept without transcoding.
The ZIP includes `IMPORT.txt` with import instructions. The download uses a
separate tab so large libraries do not need to be buffered in browser memory;
validation errors appear in that tab.

- **iTunes / Music:** enter the absolute local folder where you will extract the
  ZIP, such as `C:\Users\You\Music\ssMusic` or `/Users/you/Music/ssMusic`.
  Extract `Library.xml` and `Music/` directly into that folder. Add the extracted
  `Music/` folder to iTunes (Windows) or Music (macOS), then choose **File >
  Library > Import Playlist** and select `Library.xml`. The XML includes ordered
  playlists and folder relationships, with file URLs pointing to that extraction
  folder. If you move the files, export again with the new destination. Unsupported
  audio formats are rejected rather than creating unplayable iTunes entries.
- **Android:** extract the entire ZIP to one folder on the device, keeping the
  `.m3u8` playlists beside `Music/`. In a music player supporting UTF-8 M3U8
  playlists with relative paths, grant access to the folder, scan the audio and
  import the playlists. Playlist entries preserve song order; use playlist order
  rather than title/artist sorting and turn off shuffle. Android has **no universal
  library import format**: playlist import, empty playlists, names and codec
  support depend on the player. Playlist folder hierarchy is not imported.

The authenticated `GET /api/library/export?format=android` endpoint returns the
ZIP. For iTunes use `format=itunes` and a URL-encoded `destination` parameter.
Session cookies and the existing API token authentication are supported. The
destination is only written into the XML, never used as a server output path.
Missing or unsafe audio files fail the export instead of leaving broken playlist
references; refresh the library and retry.

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
Vite proxies `/api` to the configured local `HTTPS_WEB_PORT` (4000 by default).
Set `DEV_API_TARGET` to override the development API URL. Certificate verification
is relaxed only for loopback development API targets; remote targets are verified.
Passkey login still requires an origin matching the server's `PASSKEY_ORIGIN`.
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

## Android app integration

Android uses browser-based passkey login in a Chrome Custom Tab (or the system
browser), followed by a single-use authorization code exchange with S256 PKCE.
It uses the same account and passkey as the web UI, without a PAT, Google Play,
Digital Asset Links, app ID configuration, or signing-certificate fingerprints.
The previous native Credential Manager flow (`client: "android"`) is no longer
supported. `ANDROID_APP_ID` and `ANDROID_SHA256_CERT_FINGERPRINTS` can be removed
from existing environments; they are no longer read or passed through Compose.
The generated `/.well-known/assetlinks.json` endpoint has been removed.

Keep `PASSKEY_RP_ID` and `PASSKEY_ORIGIN` identical to your existing web login.
Open the browser login URL at that exact origin, including any port. Your phone
must resolve/reach the hostname and trust its HTTPS certificate in both the
browser and the app. Do not disable TLS validation. This flow does not require
standard port 443 or public domain-association hosting. Sideloaded/debug APKs
work with the same protocol; the passkey must be available in the browser's
credential provider. Use an external browser, not an embedded WebView.

### Login contract

1. Generate independent cryptographically random `codeVerifier` and `state`
   values for each login (32 random bytes each, base64url without padding).
   Retain them together with the chosen server origin in private app storage
   until the login finishes. Never send the verifier to the browser.
2. Compute `codeChallenge = BASE64URL(SHA256(ASCII(codeVerifier)))`, without
   padding. Open the following URL with correctly URL-encoded query values:

   ```text
   <PASSKEY_ORIGIN>/app-login?redirect_uri=com.ssytdlp.app%3A%2Foauth%2Fcallback&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=<STATE>
   ```

3. The user selects **Authorize with Passkey** and completes a fresh browser
   passkey confirmation, even if a browser session already exists. The page
   returns to `com.ssytdlp.app:/oauth/callback?code=<CODE>&state=<STATE>` and
   offers **Return to app** if automatic navigation is blocked. Cancel leaves
   the authorization page without issuing a code; closing the tab cancels too.
4. In the Android callback, require the exact scheme/path and expected `state`;
   reject unsolicited callbacks, mismatches, duplicate parameters, or an already
   completed login. Exchange only at the server origin saved in step 1, never
   an origin supplied by the callback. Send `POST /api/auth/app/token` with JSON:

   ```json
   {
     "code": "CODE_FROM_CALLBACK",
     "codeVerifier": "ORIGINAL_SECRET_VERIFIER",
     "redirectUri": "com.ssytdlp.app:/oauth/callback"
   }
   ```

   The response is `{ "user": { ... }, "session": { "token": "...",
   "tokenType": "Bearer", "expiresAt": "..." } }`. No cookie or existing
   login is required for this exchange; a correct code and verifier are required.
   Delete the temporary verifier/state after completion or cancellation.
5. Send `Authorization: Bearer <session.token>` on authenticated requests.
   Store the session using Android Keystore-backed storage, never URLs/logs.
   Sessions last 30 days without sliding expiry or refresh tokens and survive
   server restarts. On expiry or `401`, start a new browser login.

Register an exported callback Activity with a browsable `VIEW` intent filter
for scheme `com.ssytdlp.app`. The callback is a private-use URI with no host;
validate the complete URI path `/oauth/callback` in the Activity. The server
only accepts the exact redirect URI above; arbitrary redirects are rejected.

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.ssytdlp.app" />
</intent-filter>
```

Private-use schemes do not prove an app's identity: another installed app can
claim the scheme. PKCE prevents an interceptor redeeming a code without the
original verifier. Only authorize login requests you initiated from your app.

The browser page calls `POST /api/auth/login/options` with `client: "browser-app"`,
`redirectUri`, `codeChallenge`, `codeChallengeMethod: "S256"`, and `state`.
It then calls `/api/auth/login/verify` with `requestId` and the WebAuthn `response`.
That response contains only `redirectUrl`, never a bearer token. State must be
43-128 base64url characters; the verifier must be 43-128 RFC 7636 unreserved
characters. The callback and PKCE challenge are bound to the WebAuthn challenge;
changing them at verification cannot redirect or replace the authorization.

Passkey challenges expire after five minutes; authorization codes expire after
60 seconds and are consumed on the first exchange attempt, including invalid
attempts. Both are in memory, bounded, rate-limited, and cleared on restart.
An expired/used code or wrong verifier returns `400`; restart the login flow.
Account changes before exchange return `403` and require a fresh login.
Pending/revoked accounts cannot authorize; passkey verification returns `403`
with `ACCESS_PENDING` or `ACCESS_REVOKED`. Rate limiting returns `429`.

Normal web login remains cookie-based. The app flow neither reads nor replaces
the browser session. `GET /api/auth/me` returns the bearer session's user;
`POST /api/auth/logout` with that bearer header revokes only that session (`204`).
Account revocation invalidates all sessions. Send only one auth mechanism:
invalid Authorization headers do not fall back to cookies, `X-PAT` retains
precedence on general API routes, and PATs are not bearer sessions.
Register new accounts in the regular web UI and wait for approval before app login.

### Feature endpoints

Bearer sessions work with all existing `/api/jobs`, `/api/library`,
`/api/preferences`, `/api/health`, and authorized `/api/admin` routes, as well as
passkey-session-only PAT management. Existing owner/contributor/admin rules apply.
Use the library, metadata, transcription, and job API contracts documented below.
Both clients share server-side library layouts and preferences; on a library `409`
conflict, fetch the latest version before retrying the user's edit.

File listings and library tracks return relative `streamUrl` and `downloadUrl`
values. Resolve these against the server base URL and attach the bearer header to
media/download requests too. Configure the Android Media3/ExoPlayer HTTP data
source to send this header, including byte-range requests for seeking (`206`
responses). `/api/jobs/:id/lyrics/:name` supplies lyrics and artwork metadata.
Do not forward credentials when following redirects to another host. Native HTTP
clients do not need CORS changes; passkeys run in the external browser and
authenticated feature requests use native networking.

## Usage

- Open the HTTPS URL configured by `PASSKEY_ORIGIN` to use **ssMusic Player** at `/`.
- Select **Jobs** or **Add music** to open the download dashboard at `/job`.
- Paste a `https://music.youtube.com/...` URL.
- Submitting the same source URL (ignoring surrounding whitespace) prompts to rerun
    the most recent matching job. Confirming keeps its downloaded files and opens its
    details under the same job ID; cancelling leaves it unchanged. Active matches can
    be opened but cannot be rerun until they finish.
- Any music URL with a `list` query parameter (including `/playlist?list=...` and `/watch?v=...&list=...`) runs with `--yes-playlist`
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
Private or unavailable videos skipped by yt-dlp produce a partially completed job rather than a failed job.
Downloaded files are written under `./output/<job-folder>/` and can be downloaded from the job details page.
Use **Download all** on a job with files to download its songs as a ZIP archive.
Job details include the command and complete captured stdout and stderr output.
New jobs automatically fetch their YouTube playlist or video title before downloading
and record it as a separate `playlistTitle`, preserving spaces, punctuation, and
non-ASCII characters. Job creation does not wait for this lookup. If the lookup fails
or returns no title, downloads continue and the title falls back to the folder or
downloaded song name. Single-track jobs keep their random output folders.
The job list, details, music library, and ZIP name use this title.
Existing jobs receive readable titles derived from their folder or song names;
their output folders and download archives are not renamed or moved.
Owners and administrators can use the pencil beside **Playlist Title** in job
details to rename an idle job, or use the pencil beside a playlist in the Music
sidebar without selecting it. Row pencils are available outside reorder mode;
the selected playlist's details also retain **Rename playlist**. On mobile,
renaming keeps the Playlists view open. Save the new name or cancel
to leave it unchanged. Contributors cannot rename playlists, and the permanent
**Individual Songs** playlist cannot be renamed. Custom titles
survive reruns and never rename output directories. The API is
`PATCH /api/jobs/:id/title` with `{ "playlistTitle": "My favorites" }`;
titles must contain 1-200 characters without control characters.

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

## Personal music library

The main page (`/`) is titled **{USERNAME}'s Music**, including the browser tab.
It lists only jobs you initiated or contribute to, using their **Playlist Title**.
This personal-library rule also applies to administrators. The Jobs dashboard keeps
its existing broader access rules. Select a playlist on the left to browse its songs
on the right. Search playlists or songs independently.
The playback dock supports play/pause, previous/next, shuffle, repeat, seeking,
volume, a playback queue, embedded artwork, and synchronized or plain-text lyrics.
Lyrics open over a darkened page while the playback dock remains visible and
interactive. Close lyrics with the close button, the backdrop, or Escape.
Browsing another playlist or folder does not interrupt the playing queue.
The same dock and audio element stay active when navigating to Jobs, job details,
the job player, Health, Admin, or Settings, including browser Back/Forward.
Logging out stops playback. Reloading the browser or opening another tab starts a
new player session; playback is not transferred between tabs.
On narrow screens, switch between **Playlists** and **Songs**; volume controls are hidden.

**Add Playlist** opens a URL dialog for a YouTube Music playlist or individual
song. It uses the same validation, duplicate confirmation, and permitted reruns
as **Add job** on `/job`, without leaving the music library. Cancelling a duplicate
confirmation does not rerun or link it.
An existing URL owned by someone else cannot be added until its owner makes you a contributor.

The first individual-song link creates a permanent **Individual Songs** playlist
for that user. Later individual links share this playlist instead of creating
one library entry per song. It stays available when empty and cannot be deleted,
even if all its source jobs are removed. Contributors can link an existing
individual job to their own independent collection. Removing contributor access
removes that job's songs from their library.

Use **New playlist folder** to create a folder. A selected folder becomes the
default location for new subfolders. Folders support nesting up to 32 levels.
The selected item's **Location** menu moves it to any valid folder or back to
the library root. Drag a playlist onto the center of a folder to move it inside,
or onto the upper/lower half of another playlist to place it before/after that
playlist. Folders can be renamed; deleting a folder moves its
immediate contents to its parent without deleting any music.

Select **Reorder playlists** beside the Playlists heading to show drag grips
on every playlist and folder, including **Individual Songs**. Drag a row by its
grip or name to the insertion line above or below another row. In reorder mode,
dropping on a folder places the item beside it rather than inside it. Each move
saves automatically for your account. Moving a folder keeps its contents together.
On mobile, press and hold a grip or name, then drag; the Playlists view stays open.
Keyboard users can focus a grip and press Arrow Up or Arrow Down to reorder siblings.
Search is temporarily disabled and all entries are shown while reordering; toggle
**Reorder playlists** off to restore the normal list and search.

A selected folder plays all descendant playlists in their saved tree order, then
each playlist's songs in its saved song order. Drag a song within its playlist
to reorder it, including when browsing a folder. Job
details and the existing `/job/:id/player` view show the same saved song order.
New playlists appear at the library root; new songs append after saved song
positions. Deleted jobs and files are removed from the saved layout automatically.

On phones and tablets, press and hold a song's grip or a playlist/folder grip or name
for a moment, then drag to organize it. Valid drop targets are highlighted, and
dragging near the edge scrolls the list. Swipe normally to scroll without
reordering. On narrow screens, use **Move to playlist** to move songs between
the separate Songs and Playlists views. Touch controls have larger hit targets;
tap or drag the seek bar to change playback position. Use the device's volume
buttons for volume on touch devices.

Song rows offer the same transcription dialog, status, and delete confirmation as
job details. These actions use the source job's owner/contributor permissions and
busy state, including for moved songs. Deleting a song removes the source file
from every user's library, not just the current personal playlist.

Use a song's **Move to playlist** button, or drag it onto a playlist in the
sidebar, to move it between playlists. Songs cannot be placed directly in
playlist folders. Moves belong to your account; source audio, download archives,
job file lists, and other users' memberships stay intact. Songs retain their
source job ID, so identical filenames from different jobs remain distinct and
playable. If a destination job is deleted, surviving songs return to their
original playlist or Individual Songs. Reordering also updates the corresponding
source-job song order shown in job details.

Themes, folders, playlist order, and song order belong to the signed-in account
and persist in SQLite across browsers and server restarts. Organizing your library
does not change anyone else's layout or grant additional job-management access.
Choose the palette icon in the account bar or **User settings > Appearance** for
Porcelain, Midnight blue, Royal purple, Gold, Green, Pink, or Black. Every color
has **Light** and **Dark** counterparts. Color and mode are saved separately;
changing color keeps the chosen mode. Existing Black and Midnight blue users
retain dark mode on upgrade; the other existing themes retain light mode.

Authenticated library APIs (sessions and PATs):

- `GET /api/preferences` and `PUT /api/preferences` with `{ "theme": "royal-purple", "mode": "dark" }`.
    Theme IDs are `light`, `midnight`, `royal-purple`, `gold`, `green`, `pink`, and `black`.
    Either field can be updated independently; mode is `light` or `dark`.
- `GET /api/library`: returns `version`, `entries`, `songOrder`, `playlistSongOrder`,
    `songMoves`, `singleJobIds`, visible `playlists`, and source `jobs` summaries.
- `PUT /api/library`: saves `version`, `entries`, and `songOrder`. Playlist entries
    have `{ "id": "JOB_ID", "type": "playlist", "parentId": null }`; folder entries
    add `"name"` and use a unique `folder-`-prefixed ID. A `parentId` references a folder.
    Entries are ordered among siblings. `songOrder` maps job IDs to filename arrays.
    `playlistSongOrder` maps playlist IDs to ordered track keys, each key being
    `JSON.stringify([jobId, filename])`. `songMoves` contains `{ jobId, name, playlistId }`
    overrides. Omitted membership fields are preserved. `singleJobIds` is server-managed;
    omitting the protected `individual-songs` entry cannot delete the collection.
    Stale versions return `409`, so simultaneous tabs cannot silently overwrite changes.
- `POST /api/library/links` with `{ "jobId": "JOB_ID" }`: link an existing job,
    creating or updating Individual Songs for individual jobs. Normal `/api/jobs`
    submission also registers individual links automatically. Only owners and
    contributors can link a job; unrelated accounts receive `403`.
- `POST /api/library/songs/move` with `{ "version": 1, "jobId": "SOURCE_JOB_ID", "name": "song.mp3", "playlistId": "DESTINATION_ID" }`:
    move a song to a playlist, appending it after that playlist's current songs.
    Folder and unavailable destinations are rejected; stale versions return `409`.
- `GET /api/library/tracks?entryId=ENTRY_ID`: returns ordered playable files for a
    playlist or folder, including each file's source `jobId`, current `playlistId`, and `playlistTitle`. Omit
    `entryId` to retrieve all music in library order.

## Song metadata and artwork

The pencil beside an MP3 song opens **Edit song metadata** in the library or job
details. Edit title, artist, album, album artist, genre, year, track number, and disc
number. Choose or remove artwork; uploads must be JPEG, PNG, or WebP, at most 2 MB.
Other audio formats remain playable but do not offer the MP3 tag editor.

Edits update the source MP3, including for personally moved songs, and therefore
are visible to everyone using that source. Filenames, audio data, embedded lyrics,
and download archives are preserved. The playing dock's text and artwork update
without restarting the audio. Owners, contributors, and administrators can edit
idle jobs; active downloads and conflicting file mutations return `409`.

`PATCH /api/jobs/:id/files/:name/metadata` accepts a JSON object with any of
`title`, `artist`, `album`, `performerInfo` (album artist), `genre`, `year`,
`trackNumber`, and `partOfSet` (disc number). Text fields are limited to 500
characters. Include `artwork` as a base64 image data URL to replace it, `null` to
remove it, or omit it to preserve the current cover. The response contains the
updated song metadata. URL-encode the full filename, including `[NoVocals]/`.

## Transcription and job player

Set `TRANSCRIPTION_ENDPOINT` in `.env` to the transcription service's complete URL,
for example `http://localhost:4317/api/transcribe`, then restart the server.
The server sends the selected audio from disk; the browser never uploads another copy
or contacts the transcription service directly.

In job details, select the microphone icon beside a song to open **Transcribe song**.
Optionally choose a **Language** from the dropdown. **Auto-detect** leaves the
language unspecified. A selection sends its short code as `language`, for example
`"language": "vi"` for Vietnamese. Language selection works with or without lyrics;
actual language support depends on the transcription service's selected backend.
Enable **No Vocals** to request the transcribed song plus a no-vocals MP3; the
service enables vocal separation for this request. **Viet Lyrics Fallback** enables
the fallback pass when the service's opening retry triggers and automatically
selects Vietnamese, locking the language dropdown while enabled. Both options
start unchecked and explicitly send their enabled or disabled state.
Optionally enable **Add lyrics**, enter the lyrics, and select exactly one mode:

- **Prompt**: biases recognition toward known words.
- **Align**: maps authoritative lyric lines onto ASR timing.
- **Correct**: replaces recognized text while preserving ASR segment timing.

The info icons show these descriptions on hover or keyboard focus. **Cancel** closes
the dialog without sending anything. **Submit** closes the dialog immediately and
shows **Transcription request sent** beside the song while the request continues.
The page refreshes the song status and files when the request finishes; errors are
shown on the page. Owners, contributors, and administrators can transcribe idle jobs.
Job deletion, reruns, and contributor changes are blocked while transcription is
in progress. Individual songs can still be deleted unless that song has a pending
transcription or deletion. Deleting one song leaves other songs' buttons available;
file deletion and audio replacement steps are serialized to avoid conflicting writes.
Only the requested song's transcription button is disabled; other songs can still
be submitted. Requests for different songs in the same job are processed one at a
time to avoid conflicting audio replacements. Waiting songs also show
**Transcription request sent**. Duplicate requests for a pending song return `409`.
Once submitted, transcription cannot be cancelled from the app.

Each submitted song shows its latest transcription status beside its name:
**Transcription request sent**, **Transcribed**, **Transcription failed**, or
**Interrupted**. Statuses refresh automatically and persist across page refreshes
and server restarts. Hover over a status for request and finish times and any error.
**Transcribed** means the response was validated and the returned audio saved, not
merely that the service responded. Unfinished requests become **Interrupted** after
a server restart and are not retried automatically. Submitting again replaces the
song's latest status; songs without a tracked request have no status indicator.

`POST /api/jobs/:id/files/:name/transcribe` accepts JSON `{}` without lyrics or
`{ "lyrics": "Known lyric lines", "lyrics_mode": "align" }` with lyrics. URL-encode
the complete filename, including `[NoVocals]/` for accompaniment tracks. The server
forwards a multipart POST containing `file`, plus `lyrics`, `lyrics_mode`,
`language`, `NoVocals`, and `VietLyricsFallback` when provided. The two flags must
be JSON booleans and are forwarded as `true` or `false`. Omitting `NoVocals` uses
the service's default (`false`); omitting `VietLyricsFallback` retains its saved
endpoint setting. Enabling `VietLyricsFallback` forces `language` to `vi`.
Language codes must match an option in the dropdown.
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

The old `/api/auth/api-token` endpoint remains removed. Legacy API tokens are not
accepted; generate new PATs from User settings for automation. Bearer authentication
is reserved for passkey sessions, including the Android login flow above.

## Database storage

The app uses SQLite at `data/ssytdlp.sqlite`. Set `DATABASE_PATH` to choose another
location on a local disk. No separate database service is required. Users, credentials,
sessions, and per-user library preferences have separate tables; jobs are stored as individual records with indexed
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
**Active** means any HTTP response was received, including redirects and error
responses such as 404 or 500. It does not verify model readiness or a successful
transcription. Connection failures, timeouts, and an unset endpoint show **Inactive**.
The detail text includes the HTTP status or the reason no response was received.

## Tests

```bash
npm test
```
