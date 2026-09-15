import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { isPlaylistUrl, sanitizeFolderName, randomSongFolderName } from './utils.js';

const jobs = new Map();
const outputRoot = process.env.YTDLP_OUTPUT_ROOT || path.resolve(process.cwd(), 'output');

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);
let runningJobsCount = 0;

// Non-null while a maintenance update (yt-dlp -U / deno upgrade) is running.
// Jobs about to start wait on this promise so they queue behind the update.
let updateGate = null;

function waitForUpdateGate() {
  return updateGate || Promise.resolve();
}

function waitForNoJobsInProgress() {
  if (runningJobsCount === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onIdle = () => {
      if (runningJobsCount === 0) {
        jobEvents.off('idle', onIdle);
        resolve();
      }
    };
    jobEvents.on('idle', onIdle);
  });
}

function resolveDenoPath() {
  const fromEnv = process.env.DENO_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  return path.resolve(process.cwd(), 'runtime', 'deno', 'bin', exe);
}

function resolveYtDlpPath() {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.resolve(process.cwd(), 'runtime', 'yt-dlp', executable);
}

async function ensureOutputRoot() {
  await fs.mkdir(outputRoot, { recursive: true });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function listDownloadedFiles(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function getPlaylistFolderName(url, denoPath) {
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--skip-download',
    '--ignore-errors',
    '--yes-playlist',
    '--js-runtimes',
    `deno:${denoPath}`,
    url
  ];

  const { stdout } = await runCommand(resolveYtDlpPath(), args);
  const parsed = JSON.parse(stdout);
  return sanitizeFolderName(parsed.title || 'playlist');
}

function newJob(url) {
  const id = randomSongFolderName();
  const now = new Date().toISOString();
  const job = {
    id,
    url,
    isPlaylist: isPlaylistUrl(url),
    status: 'queued',
    error: null,
    folderName: null,
    outputDir: null,
    files: [],
    createdAt: now,
    updatedAt: now,
    command: null
  };

  jobs.set(id, job);
  return job;
}

async function executeJob(job) {
  // If a maintenance update is running (or about to run), queue behind it.
  await waitForUpdateGate();

  const denoPath = resolveDenoPath();

  runningJobsCount += 1;
  job.status = 'running';
  job.updatedAt = new Date().toISOString();

  const folderName = job.isPlaylist
    ? await getPlaylistFolderName(job.url, denoPath).catch(() => randomSongFolderName())
    : randomSongFolderName();

  job.folderName = folderName;
  job.outputDir = path.join(outputRoot, folderName);

  await fs.mkdir(job.outputDir, { recursive: true });

  const args = [
    '--ignore-errors',
    '--format',
    'bestaudio',
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '160K',
    '--js-runtimes',
    `deno:${denoPath}`,
    '--output',
    path.join(job.outputDir, '%(title)s.%(ext)s')
  ];

  args.push(job.isPlaylist ? '--yes-playlist' : '--no-playlist');
  args.push(job.url);

  job.command = `yt-dlp ${args.map((value) => (value.includes(' ') ? `"${value}"` : value)).join(' ')}`;

  try {
    await runCommand(resolveYtDlpPath(), args);
    job.files = await listDownloadedFiles(job.outputDir);
    job.status = 'completed';
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.files = await listDownloadedFiles(job.outputDir);
  } finally {
    runningJobsCount = Math.max(0, runningJobsCount - 1);
    if (runningJobsCount === 0) {
      jobEvents.emit('idle');
    }
  }

  job.updatedAt = new Date().toISOString();
}

/**
 * Runs `yt-dlp -U` and `deno upgrade` to keep the runtimes up to date.
 * Waits for any jobs currently in progress to finish, then blocks new jobs
 * from starting until the update completes.
 */
export async function runMaintenanceUpdate() {
  if (updateGate) {
    return updateGate;
  }

  let releaseGate;
  updateGate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  try {
    await waitForNoJobsInProgress();

    try {
      await runCommand(resolveYtDlpPath(), ['-U']);
    } catch (error) {
      console.error('yt-dlp update failed:', error.message);
    }

    try {
      await runCommand(resolveDenoPath(), ['upgrade']);
    } catch (error) {
      console.error('Deno upgrade failed:', error.message);
    }
  } finally {
    const release = releaseGate;
    updateGate = null;
    release();
  }
}

export function isUpdateInProgress() {
  return updateGate !== null;
}

export async function createJob(url) {
  await ensureOutputRoot();
  const job = newJob(url);
  executeJob(job).catch((error) => {
    job.status = 'failed';
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
  });
  return job;
}

export function getJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id) {
  return jobs.get(id);
}

export function getFilePath(job, fileName) {
  return path.resolve(job.outputDir, fileName);
}

export function isFileInsideJobFolder(job, filePath) {
  const relative = path.relative(job.outputDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
