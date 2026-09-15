import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { isPlaylistUrl, sanitizeFolderName, randomSongFolderName } from './utils.js';

const jobs = new Map();
const outputRoot = process.env.YTDLP_OUTPUT_ROOT || path.resolve(process.cwd(), 'output');
const jobStorePath = process.env.JOB_STORE_PATH || path.resolve(process.cwd(), 'data', 'jobs.json');
let persistenceQueue = Promise.resolve();

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);
let runningJobsCount = 0;
const privateVideoPattern = /\b(?:private video|video is private)\b/i;

// Non-null while a maintenance update (yt-dlp -U / deno upgrade) is running.
// Jobs about to start wait on this promise so they queue behind the update.
let updateGate = null;

async function loadJobs() {
  let storedJobs;
  try {
    storedJobs = JSON.parse(await fs.readFile(jobStorePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Unable to load job history from ${jobStorePath}: ${error.message}`);
  }

  if (!Array.isArray(storedJobs)) {
    throw new Error(`Invalid job history in ${jobStorePath}`);
  }

  let updatedStoredJob = false;
  for (const job of storedJobs) {
    if (!job?.id || !job.url) continue;
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.error = 'Job was interrupted by a server restart';
      job.updatedAt = new Date().toISOString();
      updatedStoredJob = true;
    } else if (
      (job.status === 'failed' || job.status === 'warning')
      && isPrivateVideoOnlyOutput(job.output)
    ) {
      job.status = 'partially_completed';
      job.error = null;
      job.warning = 'One or more private videos were skipped.';
      updatedStoredJob = true;
    }
    jobs.set(job.id, job);
  }

  if (updatedStoredJob) {
    await persistJobs();
  }
}

function persistJobs() {
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(jobStorePath), { recursive: true });
    const temporaryPath = `${jobStorePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify([...jobs.values()], null, 2)}\n`);
    await fs.rename(temporaryPath, jobStorePath);
  });
  return persistenceQueue;
}

await loadJobs();

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

function resolveFfmpegLocation() {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  return path.resolve(process.cwd(), 'runtime', 'ffmpeg', 'bin');
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

    child.on('error', (error) => {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Command failed with exit code ${code}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function isPrivateVideoOnlyOutput(output = '') {
  const errorLines = output
    .split(/\r?\n/)
    .filter((line) => /^(?:ERROR|WARNING):/i.test(line.trim()));
  return errorLines.some((line) => privateVideoPattern.test(line))
    && !errorLines.some((line) => !privateVideoPattern.test(line));
}

export function classifyCommandOutput({ stdout = '', stderr = '' }) {
  const errorLines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .filter((line) => /^ERROR:/i.test(line.trim()));
  const hasPrivateVideoWarning = errorLines.some((line) => privateVideoPattern.test(line));
  const hasNonPrivateError = errorLines.some((line) => !privateVideoPattern.test(line));

  const normalize = (text) => text.split(/\r?\n/).map((line) => (
    /^ERROR:/i.test(line.trim()) && privateVideoPattern.test(line)
      ? line.replace(/ERROR:/i, 'WARNING:')
      : line
  )).join('\n');

  return {
    stdout: normalize(stdout),
    stderr: normalize(stderr),
    hasPrivateVideoWarning,
    hasNonPrivateError
  };
}

function formatCommandOutput(result) {
  const { stdout, stderr } = classifyCommandOutput(result);
  const sections = [];
  if (stdout.trim()) sections.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr.trim()) sections.push(`[stderr]\n${stderr.trimEnd()}`);
  return sections.join('\n\n');
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
    warning: null,
    folderName: null,
    outputDir: null,
    files: [],
    createdAt: now,
    updatedAt: now,
    command: null,
    output: null
  };

  jobs.set(id, job);
  return job;
}

function startJob(job) {
  executeJob(job).catch((error) => {
    job.status = 'failed';
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
    persistJobs().catch((persistError) => console.error('Unable to persist job:', persistError.message));
  });
}

function assertJobIsIdle(job, action) {
  if (job.status === 'queued' || job.status === 'running') {
    const error = new Error(`Cannot ${action} a job while it is ${job.status}`);
    error.statusCode = 409;
    throw error;
  }
}

async function removeJobOutput(job) {
  if (!job.outputDir) {
    return;
  }

  const relative = path.relative(outputRoot, job.outputDir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await fs.rm(job.outputDir, { recursive: true, force: true });
  }
}

async function executeJob(job) {
  // If a maintenance update is running (or about to run), queue behind it.
  await waitForUpdateGate();

  const denoPath = resolveDenoPath();
  const ytDlpPath = resolveYtDlpPath();
  const ffmpegLocation = resolveFfmpegLocation();

  runningJobsCount += 1;
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  await persistJobs();

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
    '--ffmpeg-location',
    ffmpegLocation,
    '--js-runtimes',
    `deno:${denoPath}`,
    '--output',
    path.join(job.outputDir, '%(title)s.%(ext)s')
  ];

  args.push(job.isPlaylist ? '--yes-playlist' : '--no-playlist');
  args.push(job.url);

  job.command = [ytDlpPath, ...args]
    .map((value) => (value.includes(' ') ? `"${value}"` : value))
    .join(' ');

  try {
    const result = await runCommand(ytDlpPath, args);
    const classification = classifyCommandOutput(result);
    job.output = formatCommandOutput(result) || 'Command completed without output.';
    job.files = await listDownloadedFiles(job.outputDir);
    job.status = classification.hasPrivateVideoWarning ? 'partially_completed' : 'completed';
    job.warning = classification.hasPrivateVideoWarning ? 'One or more private videos were skipped.' : null;
  } catch (error) {
    const classification = classifyCommandOutput(error);
    const privateVideosOnly = classification.hasPrivateVideoWarning && !classification.hasNonPrivateError;
    job.status = privateVideosOnly ? 'partially_completed' : 'failed';
    job.error = privateVideosOnly ? null : error.message;
    job.warning = privateVideosOnly ? 'One or more private videos were skipped.' : null;
    job.output = formatCommandOutput(error) || error.message;
    job.files = await listDownloadedFiles(job.outputDir);
  } finally {
    runningJobsCount = Math.max(0, runningJobsCount - 1);
    if (runningJobsCount === 0) {
      jobEvents.emit('idle');
    }
  }

  job.updatedAt = new Date().toISOString();
  await persistJobs();
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
  await persistJobs();
  startJob(job);
  return job;
}

export async function rerunJob(id) {
  const job = getJob(id);
  if (!job) {
    return null;
  }

  assertJobIsIdle(job, 'rerun');
  await removeJobOutput(job);

  job.status = 'queued';
  job.error = null;
  job.warning = null;
  job.folderName = null;
  job.outputDir = null;
  job.files = [];
  job.command = null;
  job.output = null;
  job.updatedAt = new Date().toISOString();

  await persistJobs();
  startJob(job);
  return job;
}

export async function deleteJob(id) {
  const job = getJob(id);
  if (!job) {
    return false;
  }

  assertJobIsIdle(job, 'delete');
  await removeJobOutput(job);
  jobs.delete(id);
  await persistJobs();
  return true;
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
