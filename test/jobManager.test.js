import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function makeFakeBin(dir, name, { delayMs = 0 } = {}) {
  const scriptPath = path.join(dir, name);
  const script = `#!/bin/sh\nsleep ${delayMs / 1000}\nexit 0\n`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

async function waitForJobToFinish(job) {
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('private video errors are classified as warnings', async () => {
  process.env.JOB_STORE_PATH = path.join(os.tmpdir(), `ssytdlp-classify-${Date.now()}.json`);
  const { classifyCommandOutput } = await import(`../src/jobManager.js?classify=${Date.now()}`);
  const privateOnly = classifyCommandOutput({
    stderr: 'ERROR: [youtube] abc: Private video. Sign in if you have been granted access'
  });
  const mixed = classifyCommandOutput({
    stderr: 'ERROR: [youtube] abc: Video is private\nERROR: Unable to download webpage'
  });

  assert.equal(privateOnly.hasPrivateVideoWarning, true);
  assert.equal(privateOnly.hasNonPrivateError, false);
  assert.match(privateOnly.stderr, /^WARNING:/);
  assert.equal(mixed.hasPrivateVideoWarning, true);
  assert.equal(mixed.hasNonPrivateError, true);
  assert.match(mixed.stderr, /ERROR: Unable to download webpage/);

  await fs.rm(process.env.JOB_STORE_PATH, { force: true });
});

test('persisted private video failures become partially completed', async (t) => {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-private-'));
  const jobStorePath = path.join(storeRoot, 'jobs.json');
  process.env.JOB_STORE_PATH = jobStorePath;
  await fs.writeFile(jobStorePath, JSON.stringify([{
    id: 'private-video-job',
    url: 'https://music.youtube.com/watch?v=magykigZvfE',
    status: 'failed',
    error: 'Command failed with exit code 1',
    warning: null,
    output: '[stderr]\nERROR: [youtube] magykigZvfE: Private video',
    files: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]));

  const jobManager = await import(`../src/jobManager.js?private=${Date.now()}`);
  const job = jobManager.getJob('private-video-job');

  assert.equal(job.status, 'partially_completed');
  assert.equal(job.error, null);
  assert.equal(job.warning, 'One or more private videos were skipped.');

  t.after(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
  });
});

test('duplicate source URLs return the previous job without creating another record', async (testContext) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-duplicate-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  process.env.YTDLP_OUTPUT_ROOT = directory;
  const url = 'https://music.youtube.com/watch?v=existing';
  await fs.writeFile(process.env.JOB_STORE_PATH, JSON.stringify([{
    id: 'previous-job', url, status: 'completed', files: [],
    initiatedBy: { id: 'alice-id', name: 'Alice' },
    createdAt: new Date().toISOString()
  }]));
  const manager = await import(`../src/jobManager.js?duplicate=${Date.now()}`);
  for (const status of ['completed', 'failed', 'partially_completed', 'queued', 'running']) {
    manager.getJob('previous-job').status = status;
    await assert.rejects(manager.createJob(` ${url} `, { id: 'bob-id', name: 'Bob' }), (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'JOB_ALREADY_EXISTS');
      assert.equal(error.existingJob.id, 'previous-job');
      assert.equal(error.existingJob.status, status);
      return true;
    });
    assert.equal(manager.getJobs().length, 1);
    assert.deepEqual(manager.getJob('previous-job').initiatedBy, { id: 'alice-id', name: 'Alice' });
  }
});

test('jobManager queues jobs around a maintenance update', {
  skip: process.platform === 'win32' && 'requires POSIX executable test fixtures'
}, async (t) => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-bin-'));
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-out-'));

  const fakeYtDlp = await makeFakeBin(binDir, 'yt-dlp', { delayMs: 300 });
  const fakeDeno = await makeFakeBin(binDir, 'deno', { delayMs: 0 });

  process.env.YTDLP_PATH = fakeYtDlp;
  process.env.DENO_PATH = fakeDeno;
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?t=${Date.now()}`);

  const events = [];

  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  events.push('job-created');

  // Wait until the job actually starts running before triggering the update.
  while (jobManager.getJob(job.id).status !== 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const updatePromise = jobManager.runMaintenanceUpdate().then(() => events.push('update-finished'));
  assert.equal(jobManager.isUpdateInProgress(), true, 'update should be pending until running job finishes');

  // A job created while the update is pending must not start until the update completes.
  const queuedJob = await jobManager.createJob('https://music.youtube.com/watch?v=def');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    jobManager.getJob(queuedJob.id).status,
    'queued',
    'new job should stay queued while update is pending/running'
  );

  await updatePromise;
  events.push('after-update-await');

  while (jobManager.getJob(job.id).status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  while (jobManager.getJob(queuedJob.id).status === 'queued') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(jobManager.isUpdateInProgress(), false);
  assert.ok(events.indexOf('update-finished') > -1);
  assert.notEqual(jobManager.getJob(queuedJob.id).status, 'queued');

  t.after(async () => {
    await fs.rm(binDir, { recursive: true, force: true });
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('rerunning overwrites a finished job while preserving its ID', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-rerun-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?rerun=${Date.now()}`);
  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc', {
    id: 'alice-id', name: 'Alice', role: 'admin'
  });
  assert.deepEqual(job.initiatedBy, { id: 'alice-id', name: 'Alice' });
  await waitForJobToFinish(job);
  const firstOutputDir = job.outputDir;
  await fs.writeFile(path.join(firstOutputDir, 'old-output.mp3'), 'old');

  const rerun = await jobManager.rerunJob(job.id, { id: 'bob-id', name: 'Bob' });

  assert.deepEqual(rerun.initiatedBy, { id: 'bob-id', name: 'Bob' });
  assert.equal(rerun.id, job.id);
  assert.equal(rerun, job);
  assert.equal(jobManager.getJob(job.id), job);
  await assert.rejects(fs.access(firstOutputDir));
  assert.equal(await jobManager.rerunJob('missing-job'), null);

  await waitForJobToFinish(rerun);
  assert.match(rerun.command, /--ffmpeg-location/);
  assert.match(rerun.output, /^\[stderr\]/);
  assert.match(rerun.output, /bad option/);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('deleting a finished job removes its record and output', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-delete-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = path.join(outputRoot, 'missing-yt-dlp');
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?delete=${Date.now()}`);
  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  await waitForJobToFinish(job);
  const jobOutputDir = job.outputDir;

  assert.equal(await jobManager.deleteJob(job.id), true);
  assert.equal(jobManager.getJob(job.id), undefined);
  await assert.rejects(fs.access(jobOutputDir));
  assert.equal(await jobManager.deleteJob('missing-job'), false);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('job history is restored after a manager restart', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-persist-'));
  const jobStorePath = path.join(outputRoot, 'jobs.json');
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  process.env.JOB_STORE_PATH = jobStorePath;

  const firstManager = await import(`../src/jobManager.js?persist-write=${Date.now()}`);
  const createdJob = await firstManager.createJob('https://music.youtube.com/watch?v=persist', {
    id: 'alice-id', name: 'Alice'
  });
  await waitForJobToFinish(createdJob);

  while (true) {
    const storedJobs = JSON.parse(await fs.readFile(jobStorePath, 'utf8'));
    if (storedJobs[0]?.status === createdJob.status) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const secondManager = await import(`../src/jobManager.js?persist-read=${Date.now()}`);
  const restoredJob = secondManager.getJob(createdJob.id);

  assert.equal(restoredJob.id, createdJob.id);
  assert.equal(restoredJob.url, createdJob.url);
  assert.deepEqual(restoredJob.initiatedBy, { id: 'alice-id', name: 'Alice' });
  assert.equal(restoredJob.status, createdJob.status);
  assert.equal(restoredJob.command, createdJob.command);
  assert.equal(restoredJob.output, createdJob.output);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});
