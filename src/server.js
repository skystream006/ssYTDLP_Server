import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZipArchive } from 'archiver';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createJob, deleteJob, deleteJobFile, getAvailableContributors, getFilePath, getJob, getJobs, isFileInsideJobFolder, isValidJobFileName, rerunJob, setJobContributors, setJobTitle, setSongMetadata, transcribeJobFile } from './jobManager.js';
import { isSongFile } from './transcription.js';
import { isPlayableFile, mediaType } from './media.js';
import { readSongMetadata } from './music.js';
import { findNoVocals, getPlaylistIds, getPlaylistTracks, individualSongsId, orderFiles, songKey } from './library.js';
import { addLibraryJobFiles, getLibrary, getPreferences, linkLibraryJob, moveLibrarySong, moveLibraryPlaylists, mutateLibraryEntry, reorderLibrarySong, setLibrary, setTheme, transferLibrarySongs } from './libraryStore.js';
import { exportOptions, prepareLibraryExport, streamLibraryExport } from './libraryExport.js';
import { getImportProgress, handleLibraryImport, listLocalImportFiles } from './libraryImport.js';
import { getSystemHealth } from './health.js';
import { isYouTubeMusicUrl } from './utils.js';
import { scheduleDailyMaintenance } from './scheduler.js';
import { attachUser, registerAuthRoutes, requireAuth } from './auth.js';
import { loadHttpsOptions } from './tls.js';

const app = express();
if (process.env.TRUST_PROXY) {
  const trustProxy = /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy);
}
const { values: options, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    'http-port': { type: 'string' },
    'https-port': { type: 'string' }
  },
  allowPositionals: true
});
const httpPort = Number(options['http-port'] || options.port || positionals[0] || process.env.WEB_API_PORT || process.env.PORT || 3000);
const httpsPort = Number(options['https-port'] || process.env.HTTPS_WEB_PORT || 4000);

if (![httpPort, httpsPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
  throw new Error('HTTP and HTTPS ports must be integers between 1 and 65535');
}
if (httpPort === httpsPort) {
  throw new Error('WEB_API_PORT and HTTPS_WEB_PORT must use different ports');
}

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

function authLimiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many passkey requests. Please wait before trying again.' }
  });
}

const authLimiters = {
  registrationOptions: authLimiter(60 * 60_000, 5),
  registrationVerify: authLimiter(60 * 60_000, 10),
  loginOptions: authLimiter(10 * 60_000, 20),
  loginVerify: authLimiter(10 * 60_000, 20)
};

app.use('/api', apiLimiter);
app.use('/api/jobs/:id/files/:name/metadata', express.json({ limit: '3mb' }));
app.use(['/api/library/playlists/move', '/api/library/songs/transfer'], express.json({ limit: '3mb' }));
app.use(express.json({ limit: '128kb' }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.static(path.resolve(process.cwd(), 'public')));
app.use(attachUser);
registerAuthRoutes(app, authLimiters);
app.use(['/api/jobs', '/api/library', '/api/preferences'], requireAuth, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api/health', requireAuth);

app.get('/api/preferences', (req, res) => {
  res.json(getPreferences(req.user.id));
});

app.put('/api/preferences', (req, res) => {
  try {
    return res.json(setTheme(req.user.id, req.body?.theme, req.body?.mode));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

function getLibraryJobs(user) {
  return getJobs().filter((job) => job.initiatedBy?.id === user.id
    || job.contributors?.some((contributor) => contributor.id === user.id));
}

app.get('/api/library', (req, res) => {
  const jobs = getLibraryJobs(req.user);
  const library = getLibrary(req.user.id, jobs);
  const tracks = getPlaylistTracks(library, jobs);
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const playlists = library.entries.filter((entry) => entry.type === 'playlist').map((entry) => {
    const job = jobMap.get(entry.id);
    return { id: entry.id, jobId: job?.id || null, playlistTitle: entry.name || job?.playlistTitle,
      protected: Boolean(entry.protected), status: job?.status || 'completed', initiatedBy: job?.initiatedBy || req.user,
      updatedAt: job?.updatedAt, songCount: tracks.get(entry.id).filter((track) => isPlayableFile(track.name)).length };
  });
  res.json({ ...library, playlists, jobs: jobs.map((job) => ({
    id: job.id, isPlaylist: job.isPlaylist, playlistTitle: job.playlistTitle, status: job.status, initiatedBy: job.initiatedBy,
    contributors: job.contributors || [], transcriptions: job.transcriptions || {},
    updatedAt: job.updatedAt, songCount: (job.files || []).filter(isPlayableFile).length
  })) });
});

app.put('/api/library', (req, res) => {
  try {
    return res.json(setLibrary(req.user.id, req.body, getLibraryJobs(req.user)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/entries', (req, res) => {
  try {
    return res.json(mutateLibraryEntry(req.user.id, req.body, getLibraryJobs(req.user)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/library/export', async (req, res) => {
  try {
    const options = exportOptions(req.query.format, req.query.destination);
    const jobs = getLibraryJobs(req.user);
    const library = getLibrary(req.user.id, jobs);
    const prepared = await prepareLibraryExport(library, jobs, options);
    if (!res.destroyed) streamLibraryExport(res, prepared, options.format);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to export library.' });
  }
});

app.post('/api/library/links', (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string') return res.status(400).json({ error: 'A job ID is required' });
    const job = getJob(req.body.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const jobs = getLibraryJobs(req.user);
    if (!jobs.some((item) => item.id === job.id)) return res.status(403).json({ error: 'Only job owners and contributors can add this playlist' });
    const library = linkLibraryJob(req.user.id, job, jobs);
    return res.json({ ...library, selectedId: job.isPlaylist === false ? individualSongsId : job.id });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/jobs/add', (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string') return res.status(400).json({ error: 'A job ID is required' });
    const job = getJob(req.body.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const jobs = getLibraryJobs(req.user);
    if (!jobs.some((item) => item.id === job.id)) return res.status(403).json({ error: 'Only job owners and contributors can add these files' });
    return res.json(addLibraryJobFiles(req.user.id, req.body, jobs));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/songs/move', (req, res) => {
  try {
    return res.json(moveLibrarySong(req.user.id, req.body, getLibraryJobs(req.user)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/songs/reorder', (req, res) => {
  try {
    return res.json(reorderLibrarySong(req.user.id, req.body, getLibraryJobs(req.user)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/library/tracks', async (req, res) => {
  try {
    const jobs = getLibraryJobs(req.user);
    const library = getLibrary(req.user.id, jobs);
    const selectedId = req.query.entryId ?? null;
    if (selectedId !== null && typeof selectedId !== 'string') return res.status(400).json({ error: 'Invalid library selection' });
    if (selectedId !== null && !library.entries.some((entry) => entry.id === selectedId)) {
      return res.status(404).json({ error: 'Library selection not found' });
    }
    const paginated = selectedId === null || req.query.page !== undefined || req.query.pageSize !== undefined;
    const positiveInteger = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
    if ((req.query.page !== undefined && !positiveInteger(req.query.page))
      || (req.query.pageSize !== undefined && (!positiveInteger(req.query.pageSize) || Number(req.query.pageSize) > 100))
      || (req.query.search !== undefined && (typeof req.query.search !== 'string' || req.query.search.length > 200))) {
      return res.status(400).json({ error: 'Invalid track pagination or search' });
    }
    const search = (req.query.search || '').trim().toLowerCase();
    const jobMap = new Map(jobs.map((job) => [job.id, job]));
    const playlistTracks = getPlaylistTracks(library, jobs);
    const seen = new Set();
    const tracks = getPlaylistIds(library.entries, selectedId).flatMap((id) => playlistTracks.get(id)).filter((track) => {
      const key = songKey(track);
      if (!isPlayableFile(track.name) || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).filter((track) => {
      const metadata = jobMap.get(track.jobId)?.songMetadata?.[track.name];
      const playlistTitle = track.playlistId === individualSongsId ? 'Individual Songs' : jobMap.get(track.playlistId)?.playlistTitle;
      return `${metadata?.title || ''} ${metadata?.artist || ''} ${track.name} ${playlistTitle || ''}`.toLowerCase().includes(search);
    });
    const pageSize = Number(req.query.pageSize || 50);
    const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
    const page = Math.min(Number(req.query.page || 1), totalPages);
    const selectedTracks = paginated ? tracks.slice((page - 1) * pageSize, page * pageSize) : tracks;
    const sourceNames = new Map();
    for (const track of selectedTracks) {
      if (!sourceNames.has(track.jobId)) sourceNames.set(track.jobId, []);
      sourceNames.get(track.jobId).push(track.name);
    }
    const sourceFiles = await Promise.all([...sourceNames].map(async ([id, names]) => {
      const files = await listJobFiles(jobMap.get(id), undefined, names);
      return files.filter((file) => file.isPlayable).map((file) => [songKey({ jobId: id, name: file.name }), file]);
    }));
    const files = new Map(sourceFiles.flat());
    return res.json({ files: selectedTracks.filter((track) => files.has(songKey(track))).map((track) => ({
      ...files.get(songKey(track)), ...track,
      playlistTitle: track.playlistId === individualSongsId ? 'Individual Songs' : jobMap.get(track.playlistId)?.playlistTitle
    })), version: library.version, ...(paginated ? { page, pageSize, total: tracks.length, totalPages } : {}) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/library/playlists/move', (req, res) => {
  try { res.json(moveLibraryPlaylists(req.user.id, req.body, getLibraryJobs(req.user))); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/library/songs/transfer', (req, res) => {
  try { res.json(transferLibrarySongs(req.user.id, req.body, getLibraryJobs(req.user))); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/library/songs/remove', async (req, res) => {
  try {
    if (typeof req.body?.jobId !== 'string' || typeof req.body?.name !== 'string'
      || typeof req.body?.playlistId !== 'string') return res.status(400).json({ error: 'Invalid song membership' });
    const result = await deleteJobFile(req.body.jobId, req.body.name, req.user, req.body);
    if (!result) return res.status(404).json({ error: 'Job not found' });
    return res.json({ ...getLibrary(req.user.id, getLibraryJobs(req.user)), fileDeleted: result.fileDeleted });
  } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); }
});

app.post('/api/jobs/import', handleLibraryImport);

app.get('/api/jobs/import/logs/:importId', (req, res) => {
  const progress = getImportProgress(req.user.id, req.params.importId);
  if (!progress) return res.status(404).json({ error: 'Import log is no longer available' });
  res.json(progress);
});

app.get('/api/jobs/import/local', async (_req, res) => {
  try { res.json(await listLocalImportFiles()); }
  catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to list local import files' }); }
});

app.get('/api/jobs', (req, res) => {
  const jobs = getJobs();
  const library = getLibrary(req.user.id, jobs);
  res.json(jobs.map((job) => ({ ...job, files: orderFiles(job.files || [], library.songOrder[job.id]) })));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  const library = getLibrary(req.user.id, [job]);
  return res.json({ ...job, files: orderFiles(job.files || [], library.songOrder[job.id]) });
});

app.patch('/api/jobs/:id/title', async (req, res) => {
  try {
    const job = await setJobTitle(req.params.id, req.body?.playlistTitle, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/files', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const library = getLibrary(req.user.id, [job]);
    return res.json({ jobId: job.id, files: await listJobFiles(job, library.songOrder[job.id]) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

async function listJobFiles(job, order, names) {
  if (!job.outputDir) return [];
  const files = [];
  let selectedNames = job.files || [];
  if (names) {
    const available = (job.files || []).map((name) => ({ name, jobId: job.id }));
    const required = new Set(names);
    for (const name of names) {
      const version = findNoVocals({ name, jobId: job.id, noVocalsName: job.transcriptions?.[name]?.noVocalsName }, available);
      if (version) required.add(version.name);
    }
    selectedNames = [...required];
  }
  for (const fileName of orderFiles(selectedNames, order)) {
    if (!isValidJobFileName(fileName)) continue;
    const absoluteFilePath = getFilePath(job, fileName);
    const stat = await fs.stat(absoluteFilePath).catch(() => null);
    if (stat?.isFile()) {
      files.push({
        ...job.songMetadata?.[fileName],
        name: fileName,
        noVocalsName: job.transcriptions?.[fileName]?.noVocalsName,
        sizeBytes: stat.size,
        downloadUrl: `/api/jobs/${job.id}/download/${encodeURIComponent(fileName)}`,
        isSong: isSongFile(fileName),
        isPlayable: isPlayableFile(fileName),
        mediaType: mediaType(fileName),
        streamUrl: isPlayableFile(fileName) ? `/api/jobs/${job.id}/stream/${encodeURIComponent(fileName)}?v=${stat.mtimeMs}` : null
      });
    }
  }

  return files.map((file) => {
    const version = findNoVocals(file, files);
    return version ? { ...file, noVocalsVersion: { ...version, jobId: job.id, playlistTitle: job.playlistTitle } } : file;
  });
}

async function resolveRequestedFile(req, acceptsFile = null) {
  const job = getJob(req.params.id);
  if (!job) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  const name = req.params.name;
  if (!isValidJobFileName(name) || (acceptsFile && !acceptsFile(name))) {
    throw Object.assign(new Error('Invalid file path'), { statusCode: 400 });
  }
  if (!job.outputDir || !job.files.includes(name)) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
  const filePath = getFilePath(job, name);
  const realPath = await fs.realpath(filePath).catch(() => null);
  if (!realPath || !(await fs.stat(realPath)).isFile()) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
  if (!isFileInsideJobFolder({ outputDir: await fs.realpath(job.outputDir) }, realPath)) {
    throw Object.assign(new Error('Invalid file path'), { statusCode: 400 });
  }
  return filePath;
}

app.get('/api/jobs/:id/download/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req);
    return res.download(filePath, path.basename(req.params.name));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/stream/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req, isPlayableFile);
    res.set('Cache-Control', 'private, no-cache');
    if (/\.m4v$/i.test(filePath)) res.type('video/mp4');
    return res.sendFile(filePath);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/lyrics/:name', async (req, res) => {
  try {
    const filePath = await resolveRequestedFile(req, isSongFile);
    res.set('Cache-Control', 'no-store');
    return res.json(await readSongMetadata(filePath));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.patch('/api/jobs/:id/files/:name/metadata', async (req, res) => {
  try {
    const metadata = await setSongMetadata(req.params.id, req.params.name, req.body, req.user);
    if (!metadata) return res.status(404).json({ error: 'Job not found' });
    return res.json(metadata);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/files/:name/transcribe', async (req, res) => {
  try {
    const job = await transcribeJobFile(req.params.id, req.params.name, req.body || {}, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/jobs/:id/download-all', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const files = [];
  for (const fileName of job.files) {
    const filePath = getFilePath(job, fileName);
    if (!isFileInsideJobFolder(job, filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) files.push({ fileName, filePath });
  }

  if (files.length === 0) {
    return res.status(404).json({ error: 'Job has no downloadable files' });
  }

  const archiveName = `${String(job.playlistTitle || job.id).replace(/[^a-z0-9._-]+/gi, '_')}.zip`;
  res.attachment(archiveName);
  res.type('application/zip');

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('warning', (error) => console.warn('Archive warning:', error.message));
  const handleArchiveError = (error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  };
  archive.on('error', handleArchiveError);
  archive.pipe(res);
  for (const file of files) {
    archive.file(file.filePath, { name: file.fileName });
  }
  void archive.finalize().catch(handleArchiveError);
});

app.post('/api/jobs', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !isYouTubeMusicUrl(url)) {
    return res.status(400).json({
      error: 'Please provide a valid https://music.youtube.com URL'
    });
  }

  try {
    const job = await createJob(url, req.user, { metadataOnly: req.body?.metadataOnly });
    linkLibraryJob(req.user.id, job, getLibraryJobs(req.user));
    return res.status(202).json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message,
      code: error.code,
      existingJob: error.existingJob
    });
  }
});

app.get('/api/jobs/:id/contributors/users', (req, res) => {
  try {
    const users = getAvailableContributors(req.params.id, req.user);
    if (!users) return res.status(404).json({ error: 'Job not found' });
    return res.json({ users });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.put('/api/jobs/:id/contributors', async (req, res) => {
  try {
    const job = await setJobContributors(req.params.id, req.body?.userIds, req.user);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/rerun', async (req, res) => {
  try {
    const job = await rerunJob(req.params.id, req.user);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(202).json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/jobs/:id/files/:name', async (req, res) => {
  try {
    const job = await deleteJobFile(req.params.id, req.params.name, req.user);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const deleted = await deleteJob(req.params.id, req.user);
    if (!deleted) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(204).end();
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const data = await getSystemHealth();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get('/app-login', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get(['/admin', '/admin/users/:id', '/settings'], (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get(['/job', '/job/:id', '/job/:id/player'], (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body must contain valid JSON' });
  }
  return next(error);
});

const httpsOrigin = process.env.PASSKEY_ORIGIN || `https://localhost:${httpsPort}`;
const httpsOptions = await loadHttpsOptions();

function protectServer(server) {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = Number(process.env.MAX_CONNECTIONS || 500);
  return server;
}

protectServer(http.createServer((req, res) => {
  const location = new URL(req.url || '/', httpsOrigin);
  res.writeHead(308, { Location: location.toString() });
  res.end();
})).listen(httpPort, () => {
  console.log(`ssYTDLP HTTP redirect listening on http://localhost:${httpPort}`);
});

protectServer(https.createServer(httpsOptions, app)).listen(httpsPort, () => {
  console.log(`ssYTDLP HTTPS server listening on https://localhost:${httpsPort}`);
});

scheduleDailyMaintenance(3, 0);
