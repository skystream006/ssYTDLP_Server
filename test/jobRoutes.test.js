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
import AdmZip from 'adm-zip';
import { closeDatabases, openDatabase, writeJob } from '../src/database.js';

test('job HTTP mutations enforce owner, contributor and admin access for sessions and PATs', { timeout: 30_000 }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssytdlp-job-http-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  await fs.mkdir(path.join(directory, 'public'));
  await fs.writeFile(path.join(directory, 'public', 'index.html'), '<!doctype html><title>Test app shell</title>');
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
  const mobileHeaders = {};
  for (const name of ['Admin', 'Owner', 'Other']) {
    const user = await store.registerUser(name, name, { id: name, publicKey: Buffer.from(name), counter: 0 });
    if (name !== 'Admin') await store.updateUser(user.id, { status: 'approved' }, users.Admin.id);
    users[name] = user;
    const session = await store.createSession(user.id);
    const pat = await store.createPrivateAccessToken(user.id, 'HTTP test');
    credentials[name] = [{ Cookie: `ssytdlp_session=${session.token}` }, { 'X-PAT': pat.token }];
    mobileHeaders[name] = { Authorization: `Bearer ${session.token}` };
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
      const chunks = [];
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        resolve({ status: response.statusCode, text, buffer, headers: response.headers,
          body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  async function waitForJob(id, headers) {
    let response;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await call(`/api/jobs/${id}`, 'GET', headers);
      assert.equal(response.status, 200, response.text);
    } while (['queued', 'running'].includes(response.body.status));
    return response;
  }
  for (const route of ['/', '/app-login', '/job', '/job/music', '/job/music/player']) {
    assert.equal((await call(route)).status, 200);
  }
  for (const route of ['/api/library', '/api/library/tracks', '/api/library/export?format=android', '/api/preferences']) {
    assert.equal((await call(route)).status, 401);
  }
  for (const route of ['/api/jobs', '/api/jobs/music/files', '/api/library', '/api/library/tracks', '/api/preferences']) {
    assert.equal((await call(route, 'GET', mobileHeaders.Owner)).status, 200);
  }
  const mobileStream = await call(`/api/jobs/owned/stream/${encodeURIComponent(songName)}`, 'GET', {
    ...mobileHeaders.Owner, Range: 'bytes=0-1'
  });
  assert.equal(mobileStream.status, 206);
  assert.equal(mobileStream.text, 'so');
  assert.equal((await call(`/api/jobs/owned/download/${encodeURIComponent(songName)}`, 'GET', mobileHeaders.Owner)).text, 'song');
  assert.equal((await call('/api/preferences', 'PUT', mobileHeaders.Owner, { theme: 'light', mode: 'light' })).status, 200);
  assert.equal((await call('/api/jobs/owned/title', 'PATCH', mobileHeaders.Other, { playlistTitle: 'Denied' })).status, 403);
  assert.equal((await call('/api/library', 'PUT', {}, {})).status, 401);
  assert.equal((await call('/api/library/links', 'POST', {}, { jobId: 'music' })).status, 401);
  assert.equal((await call('/api/library/songs/move', 'POST', {}, {})).status, 401);
  assert.equal((await call('/api/preferences', 'PUT', {}, { theme: 'black' })).status, 401);
  assert.deepEqual((await call('/api/preferences', 'PUT', credentials.Owner[0], { theme: 'royal-purple', userId: users.Other.id })).body,
    { theme: 'royal-purple', mode: 'light' });
  assert.deepEqual((await call('/api/preferences', 'PUT', credentials.Owner[1], { mode: 'dark' })).body, { theme: 'royal-purple', mode: 'dark' });
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Owner[1])).body, { theme: 'royal-purple', mode: 'dark' });
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Other[0])).body, { theme: 'light', mode: 'light' });
  assert.equal((await call('/api/preferences', 'PUT', credentials.Owner[0], { mode: 'invalid' })).status, 400);
  assert.equal((await call('/api/preferences', 'PUT', credentials.Owner[0], { theme: 'invalid' })).status, 400);
  const initialLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(initialLibrary.jobs.length, 3);
  assert.equal(initialLibrary.entries.some((entry) => entry.id === 'unowned'), false);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Other[0])).body.jobs, []);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Admin[0])).body.jobs, []);
  assert.equal((await call('/api/library/tracks?entryId=music', 'GET', credentials.Other[0])).status, 404);
  assert.equal((await call('/api/library/links', 'POST', credentials.Other[0], { jobId: 'music' })).status, 403);
  assert.equal(initialLibrary.jobs.find((job) => job.id === 'music').playlistTitle, 'music');
  assert.deepEqual(initialLibrary.jobs.find((job) => job.id === 'music').contributors, []);
  assert.deepEqual(initialLibrary.jobs.find((job) => job.id === 'music').transcriptions, {});
  const organized = {
    version: initialLibrary.version,
    entries: [
      { id: 'folder-mixes', type: 'folder', name: 'Mixes', parentId: null },
      { id: 'shared', type: 'playlist', parentId: 'folder-mixes' },
      { id: 'folder-live', type: 'folder', name: 'Live', parentId: 'folder-mixes' },
      { id: 'music', type: 'playlist', parentId: 'folder-live' },
      { id: 'owned', type: 'playlist', parentId: null }
    ],
    songOrder: { music: ['keep.mp3', songName, `[NoVocals]/${songName}`] }
  };
  const savedLibrary = await call('/api/library', 'PUT', credentials.Owner[1], organized);
  assert.equal(savedLibrary.status, 200);
  assert.equal((await call('/api/library/export?format=invalid', 'GET', credentials.Owner[0])).status, 400);
  assert.equal((await call('/api/library/export?format=itunes', 'GET', credentials.Owner[0])).status, 400);
  for (const headers of credentials.Owner) {
    const exported = await call('/api/library/export?format=android', 'GET', headers);
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-type'], /application\/zip/);
    assert.match(exported.headers['content-disposition'], /ssMusic-android\.zip/);
    assert.equal(exported.headers['cache-control'], 'no-store');
    const zip = new AdmZip(exported.buffer);
    assert.equal(zip.getEntries().filter((entry) => entry.entryName.startsWith('Music/')).length, 7);
    const playlist = zip.readAsText('2-music.m3u8');
    const paths = playlist.split('\n').filter((line) => line && !line.startsWith('#'));
    assert.equal(paths.length, 3);
    assert.equal(zip.readAsText(paths[0]), 'keep');
    assert.equal(zip.readAsText(paths[1]), 'song');
    assert.deepEqual(zip.readFile(paths[2]), taggedAudio);
    assert.ok(zip.getEntry('IMPORT.txt'));
  }
  for (const name of ['Other', 'Admin']) {
    const exported = await call('/api/library/export?format=android', 'GET', credentials[name][0]);
    assert.equal(exported.status, 200);
    assert.deepEqual(new AdmZip(exported.buffer).getEntries().map((entry) => entry.entryName), ['IMPORT.txt']);
  }
  const itunes = await call('/api/library/export?' + new URLSearchParams({
    format: 'itunes', destination: 'C:\\Music\\My Library'
  }), 'GET', credentials.Owner[1]);
  assert.equal(itunes.status, 200);
  const itunesZip = new AdmZip(itunes.buffer);
  assert.match(itunesZip.readAsText('Library.xml'), /file:\/\/\/C:\/Music\/My%20Library\/Music\//);
  assert.match(itunesZip.readAsText('Library.xml'), /<key>Parent Persistent ID<\/key>/);
  assert.deepEqual((await call('/api/library', 'GET', credentials.Owner[0])).body.entries, organized.entries);
  assert.equal((await call('/api/library', 'PUT', credentials.Owner[0], organized)).status, 409);
  assert.deepEqual((await call('/api/preferences', 'GET', credentials.Owner[0])).body, { theme: 'royal-purple', mode: 'dark' });
  const folderTracks = await call('/api/library/tracks?entryId=folder-mixes', 'GET', credentials.Owner[0]);
  const karaokeVersion = folderTracks.body.files.find((file) => file.jobId === 'music' && file.name === songName).noVocalsVersion;
  assert.equal(karaokeVersion.name, `[NoVocals]/${songName}`);
  assert.equal(karaokeVersion.jobId, 'music');
  assert.ok(karaokeVersion.streamUrl);
  assert.equal(folderTracks.body.files.find((file) => file.jobId === 'shared' && file.name === songName).noVocalsVersion, undefined);
  assert.deepEqual(folderTracks.body.files.map((file) => [file.jobId, file.name]), [
    ['shared', songName], ['shared', 'keep.mp3'],
    ['music', 'keep.mp3'], ['music', songName], ['music', `[NoVocals]/${songName}`]
  ]);
  assert.deepEqual((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files.map((file) => file.name), organized.songOrder.music);
  assert.deepEqual((await call('/api/jobs/music', 'GET', credentials.Owner[1])).body.files, organized.songOrder.music);
  assert.deepEqual((await call('/api/jobs/music/files', 'GET', credentials.Other[0])).body.files.map((file) => file.name),
    [songName, 'keep.mp3', `[NoVocals]/${songName}`]);
  assert.equal((await call('/api/library/tracks?entryId=folder-mixes', 'GET', credentials.Other[0])).status, 404);
  assert.equal((await call('/api/library/tracks?entryId=missing', 'GET', credentials.Owner[0])).status, 404);
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
  const metadataRoute = `/api/jobs/music/files/${encodedSong}/metadata`;
  const artwork = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  assert.equal((await call(metadataRoute, 'PATCH', {}, { title: 'Denied' })).status, 401);
  assert.equal((await call(metadataRoute, 'PATCH', credentials.Other[0], { title: 'Denied' })).status, 403);
  for (const body of [{ title: 7 }, { artist: 'bad\u0000tag' }, { unknown: 'field' }, { artwork: 'https://example.com/image.png' },
    { artwork: 'data:image/png;base64,aW52YWxpZA==' }, { artwork: artwork.replace('image/png', 'image/jpeg') }, { title: 'x'.repeat(501) }]) {
    assert.equal((await call(metadataRoute, 'PATCH', credentials.Owner[0], body)).status, 400);
  }
  const edited = await call(metadataRoute, 'PATCH', credentials.Owner[0], {
    title: 'Edited song', artist: 'Edited artist', album: 'New album', performerInfo: 'Album artist',
    genre: 'Jazz', year: '2026', trackNumber: '2/9', partOfSet: '1/2', artwork
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'Edited song');
  assert.equal(edited.body.artwork, artwork);
  assert.deepEqual(edited.body.sylt, lyrics.body.sylt);
  assert.equal(edited.body.uslt, lyrics.body.uslt);
  assert.equal((await call(lyricsRoute, 'GET', credentials.Owner[0])).body.performerInfo, 'Album artist');
  const changedFile = await fs.readFile(path.join(musicDir, '[NoVocals]', songName));
  assert.deepEqual(NodeID3.removeTagsFromBuffer(changedFile), NodeID3.removeTagsFromBuffer(taggedAudio));
  assert.equal(NodeID3.read(changedFile).trackNumber, '2/9');
  assert.equal((await call('/api/jobs/music/files', 'GET', credentials.Owner[0])).body.files.find((file) => file.name === `[NoVocals]/${songName}`).title, 'Edited song');
  const retainedArtwork = await call(metadataRoute, 'PATCH', credentials.Admin[1], { artist: '' });
  assert.equal(retainedArtwork.body.artist, '');
  assert.equal(retainedArtwork.body.artwork, artwork);
  assert.equal((await call(metadataRoute, 'PATCH', credentials.Owner[1], { artwork: null })).body.artwork, null);
  assert.equal((await call('/api/jobs/music/files/..%2Foutside.mp3/metadata', 'PATCH', credentials.Owner[0], { title: 'Bad' })).status, 400);
  assert.equal((await call('/api/jobs/music/files/missing.mp3/metadata', 'PATCH', credentials.Owner[0], { title: 'Missing' })).status, 404);
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
  assert.equal((await call(`/api/jobs/shared/files/${encodeURIComponent(songName)}/metadata`, 'PATCH', credentials.Other[0], { title: 'Contributor edit' })).status, 200);
  const actionLibrary = (await call('/api/library', 'GET', credentials.Other[0])).body;
  assert.deepEqual(actionLibrary.jobs.find((job) => job.id === 'shared').contributors, shared.body.contributors);
  assert.deepEqual(actionLibrary.jobs.map((job) => job.id), ['shared']);
  assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.jobs.find((job) => job.id === 'music').transcriptions[`[NoVocals]/${songName}`].status, 'failed');
  const persistedShared = JSON.parse(openDatabase().prepare('SELECT data FROM jobs WHERE id = ?').get('shared').data);
  assert.deepEqual(persistedShared.contributors, shared.body.contributors);
  closeDatabases();
  assert.equal(shared.body.initiatedBy.id, users.Owner.id);
  const titleRoute = '/api/jobs/shared/title';
  assert.equal((await call(titleRoute, 'PATCH', {}, { playlistTitle: 'Private edit' })).status, 401);
  assert.equal((await call(titleRoute, 'PATCH', credentials.Other[0], { playlistTitle: 'Contributor edit' })).status, 403);
  assert.equal((await call(titleRoute, 'PATCH', credentials.Owner[0], { playlistTitle: ' ' })).status, 400);
  const renamed = await call(titleRoute, 'PATCH', credentials.Owner[1], { playlistTitle: 'Shared favorites' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.playlistTitle, 'Shared favorites');
  assert.equal(renamed.body.folderName, 'shared');
  for (const headers of [credentials.Owner[0], credentials.Other[0]]) {
    const renamedLibrary = await call('/api/library', 'GET', headers);
    assert.equal(renamedLibrary.status, 200);
    assert.equal(renamedLibrary.body.playlists.find((playlist) => playlist.id === 'shared').playlistTitle, 'Shared favorites');
    assert.equal(renamedLibrary.body.jobs.find((job) => job.id === 'shared').playlistTitle, 'Shared favorites');
    const renamedTracks = await call('/api/library/tracks?entryId=shared', 'GET', headers);
    assert.equal(renamedTracks.status, 200);
    assert.ok(renamedTracks.body.files.length > 0);
    assert.ok(renamedTracks.body.files.every((track) => track.playlistTitle === 'Shared favorites'));
  }
  assert.equal((await call('/api/jobs/missing/title', 'PATCH', credentials.Owner[0], { playlistTitle: 'Missing' })).status, 404);
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
    assert.equal(rerun.body.playlistTitle, 'Shared favorites');
    assert.deepEqual(rerun.body.contributors, shared.body.contributors);
    await waitForJob('shared', headers);
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
  await waitForJob('owned', credentials.Owner[0]);
  assert.equal((await call('/api/jobs/owned', 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/jobs/owned', 'GET', credentials.Owner[0])).status, 404);

  const single = await call('/api/jobs', 'POST', credentials.Owner[0], { url: 'https://music.youtube.com/watch?v=individual' });
  assert.equal(single.status, 202);
  const singleId = single.body.id;
  const firstSingleLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(firstSingleLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').playlistTitle, 'Individual Songs');
  assert.equal(firstSingleLibrary.entries.some((entry) => entry.id === singleId), false);
  const current = await waitForJob(singleId, credentials.Owner[0]);
  await fs.writeFile(path.join(current.body.outputDir, 'single.mp3'), 'single song');
  writeJob(openDatabase(), { ...current.body, files: ['single.mp3'] });
  closeDatabases();
  const singlesLibrary = (await call('/api/library', 'GET', credentials.Owner[0])).body;
  assert.equal(singlesLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').playlistTitle, 'Individual Songs');
  assert.equal(singlesLibrary.playlists.find((playlist) => playlist.id === 'individual-songs').protected, true);
  assert.equal(singlesLibrary.entries.some((entry) => entry.id === singleId), false);
  const individualTracks = (await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Owner[0])).body.files;
  assert.equal(individualTracks[0].jobId, singleId);
  assert.equal(individualTracks[0].playlistId, 'individual-songs');
  assert.equal((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).status, 404);
  const move = { version: singlesLibrary.version, jobId: singleId, name: 'single.mp3', playlistId: 'folder-mixes' };
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[0], move)).status, 400);
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[1], { ...move, playlistId: 'music' })).status, 200);
  assert.equal((await call('/api/library/songs/move', 'POST', credentials.Owner[0], { ...move, playlistId: 'music' })).status, 409);
  const moved = (await call('/api/library/tracks?entryId=music', 'GET', credentials.Owner[0])).body.files.at(-1);
  assert.equal(moved.jobId, singleId);
  assert.equal(moved.playlistId, 'music');
  assert.equal((await call(moved.downloadUrl, 'GET', credentials.Owner[0])).text, 'single song');
  assert.equal((await call('/api/library/links', 'POST', credentials.Other[1], { jobId: singleId })).status, 403);
  assert.equal((await call(`/api/jobs/${singleId}/contributors`, 'PUT', credentials.Owner[0], { userIds: [users.Other.id] })).status, 200);
  const otherLink = await call('/api/library/links', 'POST', credentials.Other[1], { jobId: singleId });
  assert.equal(otherLink.status, 200);
  assert.equal(otherLink.body.selectedId, 'individual-songs');
  assert.equal((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).body.files[0].jobId, singleId);
  assert.equal((await call(`/api/jobs/${singleId}/contributors`, 'PUT', credentials.Owner[0], { userIds: [] })).status, 200);
  assert.deepEqual((await call('/api/library/tracks?entryId=individual-songs', 'GET', credentials.Other[0])).body.files, []);
  assert.equal((await call('/api/library/links', 'POST', credentials.Owner[0], { jobId: 'missing' })).status, 404);
  assert.equal((await call(`/api/jobs/${singleId}`, 'DELETE', credentials.Owner[0])).status, 204);
  assert.equal((await call('/api/library', 'GET', credentials.Owner[0])).body.entries.some((entry) => entry.id === 'individual-songs'), true);
});