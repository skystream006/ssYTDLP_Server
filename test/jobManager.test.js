import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';

beforeEach(async (testContext) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-job-db-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  testContext.after(() => {
    closeDatabases();
    return fs.rm(directory, { recursive: true, force: true });
  });
});

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

test('playlist metadata counts all songs independently of downloaded files', async () => {
  process.env.JOB_STORE_PATH = path.join(os.tmpdir(), `ssytdlp-metadata-${Date.now()}.json`);
  const { parsePlaylistMetadata } = await import(`../src/jobManager.js?metadata=${Date.now()}`);
  assert.deepEqual(parsePlaylistMetadata(JSON.stringify({ title: 'My playlist', playlist_count: 12, entries: [{ id: 'one' }] })), {
    folderName: 'My_playlist', playlistSongCount: 12
  });
  assert.equal(parsePlaylistMetadata(JSON.stringify({ entries: [{ id: 'one' }, null, { id: 'private' }] })).playlistSongCount, 3);
  assert.equal(parsePlaylistMetadata('{"entries":[]}').playlistSongCount, 0);
  assert.equal(parsePlaylistMetadata('{"playlist_count":0}').playlistSongCount, 0);
  for (const playlist_count of [null, -1, 1.5, '12']) {
    assert.equal(parsePlaylistMetadata(JSON.stringify({ playlist_count })).playlistSongCount, null);
  }
  assert.throws(() => parsePlaylistMetadata('not JSON'), SyntaxError);
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
    playlistSongCount: 12,
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
  assert.equal(job.playlistSongCount, 12);

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
    writeJob(openDatabase(), { ...manager.getJob('previous-job'), status });
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

async function assertRerunPreservesOutput(t, isPlaylist) {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-rerun-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?rerun=${Date.now()}`);
  const url = isPlaylist ? 'https://music.youtube.com/playlist?list=abc' : 'https://music.youtube.com/watch?v=abc';
  const job = await jobManager.createJob(url, {
    id: 'alice-id', name: 'Alice', role: 'admin'
  });
  assert.deepEqual(job.initiatedBy, { id: 'alice-id', name: 'Alice' });
  await waitForJobToFinish(job);
  const firstOutputDir = job.outputDir;
  const firstFolderName = job.folderName;
  await fs.writeFile(path.join(firstOutputDir, 'old-output.mp3'), 'old');
  const archivePath = path.join(firstOutputDir, '.download-archive.txt');
  await fs.writeFile(archivePath, 'youtube abc\n');
  job.files = ['old-output.mp3'];
  job.playlistSongCount = 99;
  writeJob(openDatabase(), job);

  await assert.rejects(jobManager.rerunJob(job.id, { id: 'bob-id', role: 'user' }), { statusCode: 403 });
  const rerun = await jobManager.rerunJob(job.id, { id: 'bob-id', name: 'Bob', role: 'admin' });

  assert.equal(rerun.playlistSongCount, null);
  assert.deepEqual(rerun.initiatedBy, { id: 'alice-id', name: 'Alice' });
  assert.equal(rerun.id, job.id);
  assert.notEqual(rerun, job);
  assert.equal(jobManager.getJob(job.id), rerun);
  assert.equal(rerun.outputDir, firstOutputDir);
  assert.equal(rerun.folderName, firstFolderName);
  assert.deepEqual(rerun.files, ['old-output.mp3']);
  assert.equal(await jobManager.rerunJob('missing-job'), null);

  await waitForJobToFinish(rerun);
  assert.equal(await fs.readFile(path.join(firstOutputDir, 'old-output.mp3'), 'utf8'), 'old');
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'youtube abc\n');
  assert.deepEqual(rerun.files, ['old-output.mp3']);
  assert.match(rerun.command, /--no-overwrites/);
  assert.ok(rerun.command.includes(`--download-archive ${archivePath.includes(' ') ? `"${archivePath}"` : archivePath}`));
  assert.match(rerun.command, /--ffmpeg-location/);
  assert.match(rerun.output, /^\[stderr\]/);
  assert.match(rerun.output, /bad option/);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
}

test('song reruns preserve the job folder, songs and download archive', (testContext) =>
  assertRerunPreservesOutput(testContext, false));

test('playlist reruns preserve the job folder, songs and download archive', (testContext) =>
  assertRerunPreservesOutput(testContext, true));

test('deleting a finished job removes its record and output', async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-delete-'));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = path.join(outputRoot, 'missing-yt-dlp');
  process.env.JOB_STORE_PATH = path.join(outputRoot, 'jobs.json');

  const jobManager = await import(`../src/jobManager.js?delete=${Date.now()}`);
  const job = await jobManager.createJob('https://music.youtube.com/watch?v=abc');
  await waitForJobToFinish(job);
  const jobOutputDir = job.outputDir;

  await assert.rejects(jobManager.deleteJob(job.id), { statusCode: 403 });
  await assert.rejects(jobManager.deleteJob(job.id, { id: 'other', role: 'user' }), { statusCode: 403 });
  assert.equal(await jobManager.deleteJob(job.id, { id: 'admin', role: 'admin' }), true);
  assert.equal(jobManager.getJob(job.id), undefined);
  await assert.rejects(fs.access(jobOutputDir));
  assert.equal(await jobManager.deleteJob('missing-job'), false);

  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });
});

test('individual song removal enforces ownership, validates paths and preserves the archive', async (testContext) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-song-delete-'));
  testContext.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  process.env.YTDLP_PATH = process.execPath;
  const manager = await import(`../src/jobManager.js?song-delete=${Date.now()}`);
  const owner = { id: 'owner', name: 'Owner', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const job = await manager.createJob('https://music.youtube.com/watch?v=songs', owner);
  await waitForJobToFinish(job);
  const songName = 'Song 100% #1.mp3';
  const archivePath = path.join(job.outputDir, '.download-archive.txt');
  await fs.writeFile(archivePath, 'youtube first\nyoutube second\n');
  await fs.writeFile(path.join(job.outputDir, songName), 'first');
  await fs.writeFile(path.join(job.outputDir, 'second.mp3'), 'second');
  job.files = [songName, 'second.mp3', 'missing.mp3'];
  writeJob(openDatabase(), job);

  for (const user of [null, { id: 'stranger', role: 'user' }]) {
    await assert.rejects(manager.deleteJobFile(job.id, songName, user), { statusCode: 403 });
    await assert.rejects(manager.deleteJob(job.id, user), { statusCode: 403 });
    await assert.rejects(manager.rerunJob(job.id, user), { statusCode: 403 });
  }
  assert.equal(await fs.readFile(path.join(job.outputDir, songName), 'utf8'), 'first');
  for (const status of ['queued', 'running']) {
    writeJob(openDatabase(), { ...job, status });
    for (const user of [owner, admin]) {
      await assert.rejects(manager.deleteJobFile(job.id, songName, user), { statusCode: 409 });
      await assert.rejects(manager.deleteJob(job.id, user), { statusCode: 409 });
      await assert.rejects(manager.rerunJob(job.id, user), { statusCode: 409 });
      await assert.rejects(manager.setJobContributors(job.id, [], user), { statusCode: 409 });
    }
  }
  writeJob(openDatabase(), job);
  for (const name of ['../outside.mp3', '..\\outside.mp3', '/outside.mp3', 'song.mp3:stream', '.download-archive.txt', '', '\0']) {
    await assert.rejects(manager.deleteJobFile(job.id, name, owner), { statusCode: 400 });
  }
  await assert.rejects(manager.deleteJobFile(job.id, 'unknown.mp3', owner), { statusCode: 404 });
  assert.equal(await manager.deleteJobFile('unknown', songName, owner), null);

  const removal = manager.deleteJobFile(job.id, songName, owner);
  await assert.rejects(manager.setJobContributors(job.id, [], owner), { statusCode: 409 });
  await assert.rejects(manager.rerunJob(job.id, owner), { statusCode: 409 });
  await assert.rejects(manager.deleteJob(job.id, admin), { statusCode: 409 });
  const updated = await removal;
  assert.deepEqual(updated.files, ['second.mp3', 'missing.mp3']);
  assert.deepEqual(updated.initiatedBy, { id: owner.id, name: owner.name });
  await assert.rejects(fs.access(path.join(job.outputDir, songName)));
  assert.equal(await fs.readFile(path.join(job.outputDir, 'second.mp3'), 'utf8'), 'second');
  await manager.deleteJobFile(job.id, 'second.mp3', admin);
  await manager.deleteJobFile(job.id, 'missing.mp3', owner);
  assert.deepEqual(manager.getJob(job.id).files, []);
  assert.equal(await fs.readFile(archivePath, 'utf8'), 'youtube first\nyoutube second\n');

  const rerun = await manager.rerunJob(job.id, owner);
  await waitForJobToFinish(rerun);
  assert.deepEqual(manager.getJob(job.id).files, []);
  assert.equal(await manager.deleteJob(job.id, owner), true);
});

test('legacy folders shared with another owner require an administrator to modify', async (testContext) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-shared-'));
  testContext.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  process.env.YTDLP_OUTPUT_ROOT = outputRoot;
  const manager = await import(`../src/jobManager.js?shared=${Date.now()}`);
  const folder = path.join(outputRoot, 'shared');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'song.mp3'), 'song');
  const job = {
    id: 'shared-one', url: 'https://music.youtube.com/watch?v=one', status: 'completed',
    outputDir: folder, files: ['song.mp3'], initiatedBy: { id: 'owner' }, createdAt: new Date().toISOString()
  };
  writeJob(openDatabase(), job);
  writeJob(openDatabase(), { ...job, id: 'shared-two', url: 'https://music.youtube.com/watch?v=two', initiatedBy: { id: 'other' } });
  const owner = { id: 'owner', role: 'user' };
  await assert.rejects(manager.rerunJob(job.id, owner), { statusCode: 403 });
  await assert.rejects(manager.deleteJob(job.id, owner), { statusCode: 403 });
  await assert.rejects(manager.deleteJobFile(job.id, 'song.mp3', owner), { statusCode: 403 });
  await manager.deleteJobFile(job.id, 'song.mp3', { id: 'admin', role: 'admin' });
  await assert.rejects(fs.access(path.join(folder, 'song.mp3')));
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
    const storedJob = openDatabase().prepare('SELECT status FROM jobs WHERE id = ?').get(createdJob.id);
    if (storedJob?.status === createdJob.status) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  closeDatabases();
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
