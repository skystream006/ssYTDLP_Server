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
  process.env.YTDLP_PATH = path.join(outputRoot, 'missing-yt-dlp');

  const jobManager = await import(`../src/jobManager.js?rerun=${Date.now()}`);
  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  await waitForJobToFinish(job);
  const firstOutputDir = job.outputDir;
  await fs.writeFile(path.join(firstOutputDir, 'old-output.mp3'), 'old');

  const rerun = await jobManager.rerunJob(job.id);

  assert.equal(rerun.id, job.id);
  assert.equal(rerun, job);
  assert.equal(jobManager.getJob(job.id), job);
  await assert.rejects(fs.access(firstOutputDir));
  assert.equal(await jobManager.rerunJob('missing-job'), null);

  await waitForJobToFinish(rerun);
  assert.match(rerun.command, /yt-dlp/);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('deleting a finished job removes its record and output', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-delete-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = path.join(outputRoot, 'missing-yt-dlp');

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
