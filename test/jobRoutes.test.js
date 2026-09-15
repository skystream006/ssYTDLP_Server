import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';

test('job HTTP mutations enforce owner, contributor and admin access for sessions and PATs', { timeout: 30_000 }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-job-http-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  const store = await import('../src/authStore.js');
  let server;
  context.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    closeDatabases();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const users = {};
  const credentials = {};
  for (const name of ['Admin', 'Owner', 'Other']) {
    const user = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name !== 'Admin') await store.updateUser(user.id, { status: 'approved' }, users.Admin.id);
    users[name] = user;
    const session = await store.createSession(user.id);
    const pat = await store.createPrivateAccessToken(user.id, 'HTTP test');
    credentials[name] = [{ Cookie: `ssytdlp_session=${session.token}` }, { 'X-PAT': pat.token }];
  }

  for (const name of ['Pending', 'Revoked']) {
    users[name] = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name === 'Revoked') await store.updateUser(users[name].id, { status: 'revoked' }, users.Admin.id);
  }

  const outputRoot = path.join(directory, 'output');
  const songName = 'Song 100% #1.mp3';
  for (const id of ['owned', 'unowned', 'shared', 'music']) {
    const outputDir = path.join(outputRoot, id);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, songName), 'song');
    await fs.writeFile(path.join(outputDir, 'keep.mp3'), 'keep');
    await fs.writeFile(path.join(outputDir, '.download-archive.txt'), 'youtube song\nyoutube keep\n');
    writeJob(openDatabase(), {
      id, url: `https://music.youtube.com/watch?v=${id}`, status: 'completed',
      initiatedBy: id !== 'unowned' ? { id: users.Owner.id, name: 'Owner' } : null,
      outputDir, folderName: id, files: [songName, 'keep.mp3'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  }
  const musicDir = path.join(outputRoot, 'music');
  await fs.mkdir(path.join(musicDir, '[NoVocals]'));
  const taggedAudio = NodeID3.write({ title: 'A song', artist: 'An artist',
    unsynchronisedLyrics: { language: 'eng', text: 'First line\nSecond line' },
    synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
      synchronisedText: [{ text: 'First line', timeStamp: 1000 }, { text: 'Second line', timeStamp: 2500 }] }]
  }, Buffer.from('audio fixture'));
  await fs.writeFile(path.join(musicDir, '[NoVocals]', songName), taggedAudio);
  const musicJob = JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get('music').data);
  writeJob(openDatabase(), { ...musicJob, files: [...musicJob.files, `[NoVocals]/${songName}`] });
  closeDatabases();

  const listeners = [net.createServer(), net.createServer()];
  await Promise.all(listeners.map((listener) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  })));
  const [httpPort, httpsPort] = listeners.map((listener) => listener.address().port);
  await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
  server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)),
    '--http-port', String(httpPort), '--https-port', String(httpsPort)], {
    cwd: directory,
    env: { ...process.env, YTDLP_OUTPUT_ROOT: outputRoot, YTDLP_PATH: process.execPath,
      HTTPS_KEY_PATH: '', HTTPS_CERT_PATH: '', PASSKEY_RP_ID: 'localhost',
      PASSKEY_ORIGIN: `https://localhost:${httpsPort}`, TRUST_PROXY: '', TRANSCRIPTION_ENDPOINT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Test server exited with ${code}: ${output}`)));
    server.stderr.on('data', (chunk) => { output += chunk; });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ssYTDLP HTTPS server listening')) resolve();
    });
  });

  const call = (route, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: httpsPort, path: route,
      method, headers: { ...headers, 'Content-Type': 'application/json' }, rejectUnauthorized: false }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text,
        body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const encodedSong = encodeURIComponent(`[NoVocals]/${songName}`);
  const streamRoute = `/api/jobs/music/stream/${encodedSong}`;
  const lyricsRoute = `/api/jobs/music/lyrics/${encodedSong}`;
  assert.equal((await call(streamRoute)).status, 401);
  assert.equal((await call(lyricsRoute)).status, 401);
  const streamed = await call(streamRoute, 'GET', { ...credentials.Other[0], Range: 'bytes=0-2' });
  assert.equal(streamed.status, 206);
  assert.equal(streamed.text, 'ID3');
  const lyrics = await call(lyricsRoute, 'GET', credentials.Other[1]);
  assert.equal(lyrics.status, 200);
  assert.equal(lyrics.body.title, 'A song');
  assert.equal(lyrics.body.uslt, 'First line\nSecond line');
  assert.deepEqual(lyrics.body.sylt, [{ time: 1, text: 'First line' }, { time: 2.5, text: 'Second line' }]);
  assert.equal((await call('/api/jobs/music/stream/..%2Foutside.mp3', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call(`/api/jobs/owned/download/${encodeURIComponent(songName)}`, 'GET', credentials.Other[0])).text, 'song');
  const transcribeRoute = `/api/jobs/music/files/${encodedSong}/transcribe`;
  assert.equal((await call(transcribeRoute, 'POST')).status, 401);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Other[1])).status, 403);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[0], { lyrics: 'words', lyrics_mode: 'bad' })).status, 400);
  assert.equal((await call(transcribeRoute, 'POST', credentials.Owner[1], {})).status, 503);
  const contributorRoute = '/api/jobs/shared/contributors';
  assert.equal((await call(`${contributorRoute}/users`)).status, 401);
  assert.equal((await call(contributorRoute, 'PUT', {}, { userIds: [] })).status, 401);
  for (const headers of credentials.Other) {
    assert.equal((await call(`${contributorRoute}/users`, 'GET', headers)).status, 403);
    assert.equal((await call(contributorRoute, 'PUT', headers, { userIds: [users.Other.id] })).status, 403);
  }
  const available = await call(`${contributorRoute}/users`, 'GET', credentials.Owner[0]);
  assert.equal(available.status, 200);
  assert.deepEqual(available.body.users, [users.Admin, users.Other].map(({ id, name }) => ({ id, name })));
  for (const userIds of [null, 'invalid', [42], ['unknown'], [users.Owner.id], [users.Pending.id], [users.Revoked.id]]) {
    assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds })).status, 400);
  }
  const shared = await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds: [users.Other.id, users.Other.id] });
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.contributors, [{ id: users.Other.id, name: 'Other' }]);
  const persistedShared = JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get('shared').data);
  assert.deepEqual(persistedShared.contributors, shared.body.contributors);
  closeDatabases();
  assert.equal(shared.body.initiatedBy.id, users.Owner.id);
  assert.deepEqual((await call('/api/jobs/shared', 'GET', credentials.Other[0])).body.contributors, shared.body.contributors);
  assert.deepEqual((await call('/api/jobs', 'GET', credentials.Other[0])).body.find((job) => job.id === 'shared').contributors, shared.body.contributors);
  const sharedDuplicate = await call('/api/jobs', 'POST', credentials.Other[0], { url: 'https://music.youtube.com/watch?v=shared' });
  assert.deepEqual(sharedDuplicate.body.existingJob.contributors, shared.body.contributors);
  for (const [index, headers] of credentials.Other.entries()) {
    assert.equal((await call('/api/jobs/shared', 'DELETE', headers)).status, 403);
    assert.equal((await call(contributorRoute, 'PUT', headers, { userIds: [] })).status, 403);
    assert.equal((await call(`${contributorRoute}/users`, 'GET', headers)).status, 403);
    const name = index === 0 ? songName : 'keep.mp3';
    assert.equal((await call(`/api/jobs/shared/files/${encodeURIComponent(name)}`, 'DELETE', headers)).status, 200);
    const rerun = await call('/api/jobs/shared/rerun', 'POST', headers);
    assert.equal(rerun.status, 202);
    assert.equal(rerun.body.initiatedBy.id, users.Owner.id);
    assert.deepEqual(rerun.body.contributors, shared.body.contributors);
    let current;
    do {
      current = await call('/api/jobs/shared', 'GET', headers);
    } while (['queued', 'running'].includes(current.body.status));
  }
  assert.equal((await call(contributorRoute, 'PUT', credentials.Admin[1], { userIds: [] })).status, 200);
  for (const headers of credentials.Other) {
    assert.equal((await call('/api/jobs/shared/rerun', 'POST', headers)).status, 403);
    assert.equal((await call('/api/jobs/shared/files/keep.mp3', 'DELETE', headers)).status, 403);
  }
  assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[1], { userIds: [users.Other.id] })).status, 200);
  assert.equal((await call(contributorRoute, 'PUT', credentials.Owner[0], { userIds: [] })).status, 200);
  assert.equal((await call('/api/jobs/missing/contributors', 'PUT', credentials.Owner[0], { userIds: [] })).status, 404);
  assert.equal((await call('/api/jobs/missing/contributors/users', 'GET', credentials.Owner[0])).status, 404);

  const songRoute = `/api/jobs/owned/files/${encodeURIComponent(songName)}`;
  const mutations = [[songRoute, 'DELETE'], ['/api/jobs/owned/rerun', 'POST'], ['/api/jobs/owned', 'DELETE']];
  for (const [route, method] of mutations) {
    assert.equal((await call(route, method)).status, 401);
    for (const headers of credentials.Other) assert.equal((await call(route, method, headers)).status, 403);
  }
  assert.equal((await call('/api/jobs/owned', 'GET', credentials.Other[0])).status, 200);
  assert.equal((await call('/api/jobs/owned/download/keep.mp3', 'GET', credentials.Other[1])).text, 'keep');
  const duplicate = await call('/api/jobs', 'POST', credentials.Other[0], { url: 'https://music.youtube.com/watch?v=owned' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.existingJob.initiatedBy.id, users.Owner.id);
  assert.equal((await call('/api/jobs/owned/files/..%2Foutside.mp3', 'DELETE', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/jobs/owned/files/.download-archive.txt', 'DELETE', credentials.Owner[1])).status, 400);

  const deleted = await call(songRoute, 'DELETE', credentials.Owner[1]);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.files, ['keep.mp3']);
  assert.equal(deleted.body.initiatedBy.id, users.Owner.id);
  assert.deepEqual((await call('/api/jobs/owned/files', 'GET', credentials.Owner[0])).body.files.map((file) => file.name), ['keep.mp3']);
  assert.equal((await call(songRoute, 'DELETE', credentials.Owner[0])).status, 404);
  assert.equal(await fs.readFile(path.join(outputRoot, 'owned', '.download-archive.txt'), 'utf8'), 'youtube song\nyoutube keep\n');
  assert.equal((await call('/api/jobs/owned/files/keep.mp3', 'DELETE', credentials.Admin[0])).status, 200);
  assert.equal((await call('/api/jobs/unowned', 'DELETE', credentials.Owner[0])).status, 403);
  assert.equal((await call('/api/jobs/unowned', 'DELETE', credentials.Admin[1])).status, 204);

  const rerun = await call('/api/jobs/owned/rerun', 'POST', credentials.Admin[1]);
  assert.equal(rerun.status, 202);
  assert.equal(rerun.body.initiatedBy.id, users.Owner.id);
  let current;
  do {
    current = await call('/api/jobs/owned', 'GET', credentials.Owner[0]);
  } while (['queued', 'running'].includes(current.body.status));
  assert.equal((await call('/api/jobs/owned', 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/jobs/owned', 'GET', credentials.Owner[0])).status, 404);
});