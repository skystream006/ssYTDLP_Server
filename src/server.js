import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createJob, getFilePath, getJob, getJobs, isFileInsideJobFolder } from './jobManager.js';
import { getSystemHealth } from './health.js';
import { isYouTubeMusicUrl } from './utils.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const requestLog = new Map();

function rateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = requestLog.get(key) || [];
  const withinWindow = timestamps.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);

  if (withinWindow.length >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. Please retry shortly.' });
  }

  withinWindow.push(now);
  requestLog.set(key, withinWindow);
  return next();
}

app.use(express.json());
app.use(rateLimit);
app.use(express.static(path.resolve(process.cwd(), 'public')));

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

app.get('/api/health', async (_req, res) => {
  try {
    const data = await getSystemHealth();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'health.html'));
});

app.get('/job/:id', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'job.html'));
});

app.listen(port, () => {
  console.log(`ssYTDLP server listening on http://localhost:${port}`);
});
