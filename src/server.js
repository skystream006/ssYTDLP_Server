import express from 'express';
import rateLimit from 'express-rate-limit';
import { ZipArchive } from 'archiver';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createJob, deleteJob, getFilePath, getJob, getJobs, isFileInsideJobFolder, rerunJob } from './jobManager.js';
import { getSystemHealth } from './health.js';
import { isYouTubeMusicUrl } from './utils.js';
import { scheduleDailyMaintenance } from './scheduler.js';
import { attachUser, registerAuthRoutes, requireAuth } from './auth.js';
import { loadHttpsOptions } from './tls.js';

const app = express();
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
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json());
app.use('/api', apiLimiter);
app.use(express.static(path.resolve(process.cwd(), 'public')));
app.use(attachUser);
registerAuthRoutes(app);
app.use('/api/jobs', requireAuth);
app.use('/api/health', requireAuth);

app.get('/api/jobs', (_req, res) => {
  res.json(getJobs());
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

app.get('/api/jobs/:id/files', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const files = [];
  for (const fileName of job.files) {
    const absoluteFilePath = getFilePath(job, fileName);
    const stat = await fs.stat(absoluteFilePath).catch(() => null);
    if (stat?.isFile()) {
      files.push({
        name: fileName,
        sizeBytes: stat.size,
        downloadUrl: `/api/jobs/${job.id}/download/${encodeURIComponent(fileName)}`
      });
    }
  }

  return res.json({ jobId: job.id, files });
});

app.get('/api/jobs/:id/download/:name', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const decodedFileName = decodeURIComponent(req.params.name);
  if (
    !decodedFileName ||
    decodedFileName !== path.basename(decodedFileName) ||
    decodedFileName.includes(path.sep) ||
    !job.files.includes(decodedFileName)
  ) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  const filePath = getFilePath(job, decodedFileName);

  if (!isFileInsideJobFolder(job, filePath)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  return res.download(filePath, decodedFileName);
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

  const archiveName = `${String(job.folderName || job.id).replace(/[^a-z0-9._-]+/gi, '_')}.zip`;
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
    const job = await createJob(url);
    return res.status(202).json(job);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/jobs/:id/rerun', async (req, res) => {
  try {
    const job = await rerunJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.status(202).json(job);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const deleted = await deleteJob(req.params.id);
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

app.get('/admin', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

app.get('/job/:id', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

const httpsOrigin = process.env.PASSKEY_ORIGIN || `https://localhost:${httpsPort}`;
const httpsOptions = await loadHttpsOptions();

http.createServer((req, res) => {
  const location = new URL(req.url || '/', httpsOrigin);
  res.writeHead(308, { Location: location.toString() });
  res.end();
}).listen(httpPort, () => {
  console.log(`ssYTDLP HTTP redirect listening on http://localhost:${httpPort}`);
});

https.createServer(httpsOptions, app).listen(httpsPort, () => {
  console.log(`ssYTDLP HTTPS server listening on https://localhost:${httpsPort}`);
});

scheduleDailyMaintenance(3, 0);
