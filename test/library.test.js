import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import { closeDatabases, openDatabase, writeUser } from '../src/database.js';
import { getPlaylistIds, getPlaylistTracks, individualSongsId, orderFiles, songKey, themes } from '../src/library.js';
import { addLibraryJobFiles, getLibrary, getPreferences, linkLibraryJob, moveLibrarySong, reorderLibrarySong, setLibrary, setTheme } from '../src/libraryStore.js';
import { submitJobUrl } from '../frontend/src/jobSubmission.js';

const jobs = [
  { id: 'jazz', files: ['First.mp3', 'Second.mp3', 'Third.mp3', 'notes.txt'] },
  { id: 'soul', files: ['Soul.mp3'] },
  { id: 'live', files: ['Live.mp3'] }
];

beforeEach(async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-library-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  context.after(() => {
    closeDatabases();
    return fs.rm(directory, { recursive: true, force: true });
  });
  for (const id of ['alice', 'bob']) {
    writeUser(openDatabase(), { id, name: id, userHandle: id, role: 'user', status: 'approved', credentials: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
});

test('each account retains its own color and light or dark mode across database restarts', () => {
  assert.deepEqual(getPreferences('alice'), { theme: 'light', mode: 'light' });
  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      assert.deepEqual(setTheme('alice', theme.id, mode), { theme: theme.id, mode });
      assert.deepEqual(getPreferences('bob'), { theme: 'light', mode: 'light' });
    }
  }
  assert.throws(() => setTheme('alice', 'unknown'), { statusCode: 400 });
  for (const mode of [null, '', 'unknown']) assert.throws(() => setTheme('alice', 'pink', mode), { statusCode: 400 });
  closeDatabases();
  assert.deepEqual(getPreferences('alice'), { theme: 'black', mode: 'dark' });
  assert.deepEqual(setTheme('alice', 'green'), { theme: 'green', mode: 'dark' });
  assert.deepEqual(setTheme('alice', undefined, 'light'), { theme: 'green', mode: 'light' });
});

test('existing themes keep their appearance when the mode column is introduced', () => {
  const database = openDatabase();
  database.prepare('INSERT INTO user_preferences (user_id, theme) VALUES (?, ?)').run('alice', 'black');
  database.prepare('INSERT INTO user_preferences (user_id, theme) VALUES (?, ?)').run('bob', 'royal-purple');
  database.exec('ALTER TABLE user_preferences DROP COLUMN theme_mode');
  closeDatabases();
  assert.deepEqual(getPreferences('alice'), { theme: 'black', mode: 'dark' });
  assert.deepEqual(getPreferences('bob'), { theme: 'royal-purple', mode: 'light' });
  openDatabase().prepare('UPDATE user_preferences SET theme = ? WHERE user_id = ?').run('midnight', 'alice');
  assert.deepEqual(getPreferences('alice'), { theme: 'midnight', mode: 'dark' });
});

test('nested folders aggregate playlists and songs in saved order', () => {
  const entries = [
    { id: 'folder-evening', type: 'folder', parentId: null, name: 'Evening' },
    { id: 'soul', type: 'playlist', parentId: 'folder-evening' },
    { id: 'folder-jazz', type: 'folder', parentId: 'folder-evening', name: 'Jazz' },
    { id: 'jazz', type: 'playlist', parentId: 'folder-jazz' },
    { id: 'live', type: 'playlist', parentId: null }
  ];
  const saved = setLibrary('alice', { version: 0, entries, songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, jobs);
  assert.deepEqual(getPlaylistIds(saved.entries), ['soul', 'jazz', 'live']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'folder-evening'), ['soul', 'jazz']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'folder-jazz'), ['jazz']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'soul'), ['soul']);
  assert.deepEqual(getPlaylistIds(saved.entries, 'missing'), []);
  assert.deepEqual(orderFiles(jobs[0].files, saved.songOrder.jazz), ['Third.mp3', 'First.mp3', 'Second.mp3', 'notes.txt']);
  assert.deepEqual(orderFiles([{ name: 'First.mp3' }, { name: 'Third.mp3' }], saved.songOrder.jazz), [
    { name: 'Third.mp3' }, { name: 'First.mp3' }
  ]);
  assert.deepEqual(getPlaylistIds(getLibrary('bob', jobs).entries), ['jazz', 'soul', 'live']);
  setTheme('alice', 'green');
  closeDatabases();
  assert.deepEqual(getLibrary('alice', jobs), saved);
  assert.deepEqual(getPreferences('alice'), { theme: 'green', mode: 'light' });
});

test('playlist reordering preserves folders and Individual Songs across reloads without changing another account', () => {
  const single = { id: 'single', isPlaylist: false, files: ['Single.mp3'] };
  const available = [...jobs, single];
  const initial = linkLibraryJob('alice', single, available);
  const individual = initial.entries.find((entry) => entry.id === individualSongsId);
  const folder = { id: 'folder-favorites', type: 'folder', parentId: null, name: 'Favorites' };
  const organized = setLibrary('alice', { ...initial, entries: [
    folder, { id: 'jazz', type: 'playlist', parentId: folder.id },
    { id: 'soul', type: 'playlist', parentId: folder.id },
    { id: 'live', type: 'playlist', parentId: null }, individual
  ] }, available);
  const byId = new Map(organized.entries.map((entry) => [entry.id, entry]));
  const reordered = setLibrary('alice', { ...organized,
    entries: [individualSongsId, 'live', folder.id, 'soul', 'jazz'].map((id) => byId.get(id))
  }, available);
  closeDatabases();
  const restored = getLibrary('alice', available);
  assert.deepEqual(restored, reordered);
  assert.deepEqual(getPlaylistIds(restored.entries), [individualSongsId, 'live', 'soul', 'jazz']);
  assert.deepEqual(getPlaylistIds(restored.entries, folder.id), ['soul', 'jazz']);
  assert.equal(restored.entries[0].protected, true);
  assert.deepEqual(restored.songOrder, organized.songOrder);
  assert.deepEqual(getPlaylistIds(getLibrary('bob', available).entries), ['jazz', 'soul', 'live', 'single']);
  assert.throws(() => setLibrary('alice', organized, available), { statusCode: 409 });
});

test('compact song reordering handles large playlists, preserves hidden songs and persists per account', () => {
  const files = Array.from({ length: 3000 }, (_, index) => `Track ${index} ${'long filename '.repeat(8)}.mp3`);
  const available = [...jobs, { id: 'large', files }];
  const initial = setLibrary('alice', { ...getLibrary('alice', available), songOrder: { large: files, soul: ['Soul.mp3'] } }, available);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 128 * 1024);
  const move = { version: initial.version, playlistId: 'large', jobId: 'large', name: files[0],
    target: songKey({ jobId: 'large', name: files[2] }), after: true };
  assert.ok(Buffer.byteLength(JSON.stringify(move)) < 1024);
  const saved = reorderLibrarySong('alice', move, available);
  assert.equal(saved.version, initial.version + 1);
  assert.deepEqual(saved.songOrder.large, [files[1], files[2], files[0], ...files.slice(3)]);
  assert.deepEqual(saved.songOrder.soul, initial.songOrder.soul);
  assert.deepEqual(saved.entries, initial.entries);
  assert.deepEqual(getPlaylistTracks(saved, available).get('large').map((track) => track.name), saved.songOrder.large);
  assert.deepEqual(getPlaylistTracks(getLibrary('bob', available), available).get('large').map((track) => track.name), files);
  closeDatabases();
  assert.deepEqual(getLibrary('alice', available), saved);
  const restored = reorderLibrarySong('alice', { ...move, version: saved.version,
    target: songKey({ jobId: 'large', name: files[1] }), after: false }, available);
  assert.deepEqual(restored.songOrder.large, files);
  assert.deepEqual(available.at(-1).files, files);
});

test('compact reorders support mixed source playlists and reject invalid or stale mutations', () => {
  const single = { id: 'single', isPlaylist: false, files: ['Single.mp3'] };
  const available = [...jobs, single];
  let library = linkLibraryJob('alice', single, available);
  library = moveLibrarySong('alice', { version: library.version, jobId: 'jazz', name: 'First.mp3', playlistId: individualSongsId }, available);
  const move = { version: library.version, playlistId: individualSongsId, jobId: 'jazz', name: 'First.mp3',
    target: songKey({ jobId: 'single', name: 'Single.mp3' }), after: false };
  const saved = reorderLibrarySong('alice', move, available);
  assert.deepEqual(getPlaylistTracks(saved, available).get(individualSongsId).map((track) => track.name), ['First.mp3', 'Single.mp3']);
  assert.deepEqual(saved.songMoves, library.songMoves);
  assert.deepEqual(saved.singleJobIds, library.singleJobIds);
  assert.throws(() => reorderLibrarySong('alice', move, available), { statusCode: 409 });
  for (const changes of [{ version: null }, { playlistId: 'missing' }, { jobId: 'other' }, { name: 'notes.txt' },
    { target: songKey({ jobId: 'soul', name: 'Soul.mp3' }) }, { target: null }, { after: 'true' }]) {
    assert.throws(() => reorderLibrarySong('alice', { ...move, version: saved.version, ...changes }, available), { statusCode: 400 });
  }
  assert.deepEqual(getLibrary('alice', available), saved);
  assert.deepEqual(reorderLibrarySong('alice', { ...move, version: saved.version, target: songKey(move) }, available), saved);
});

test('library reconciles new and deleted jobs and songs without changing saved order', () => {
  const initial = getLibrary('alice', jobs);
  setLibrary('alice', { ...initial, entries: [...initial.entries].reverse(), songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, jobs);
  const changed = [{ ...jobs[0], files: ['First.mp3', 'New.mp3'] }, jobs[2], { id: 'new', files: [] }];
  const reconciled = getLibrary('alice', changed);
  assert.deepEqual(getPlaylistIds(reconciled.entries), ['live', 'jazz', 'new']);
  assert.deepEqual(reconciled.songOrder.jazz, ['First.mp3']);
  assert.deepEqual(orderFiles(changed[0].files, reconciled.songOrder.jazz), ['First.mp3', 'New.mp3']);
});

test('individual links share one permanent personal playlist, even after every source job is deleted', () => {
  const first = { id: 'single-one', isPlaylist: false, files: ['First.mp3'] };
  const second = { id: 'single-two', isPlaylist: false, files: [] };
  const available = [...jobs, first, second];
  assert.equal(getLibrary('alice', available).entries.some((entry) => entry.id === individualSongsId), false);
  const linked = linkLibraryJob('alice', first, available);
  assert.equal(linked.entries.filter((entry) => entry.id === individualSongsId).length, 1);
  assert.equal(linked.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  assert.equal(linked.entries.find((entry) => entry.id === individualSongsId).protected, true);
  assert.equal(linked.entries.some((entry) => entry.id === first.id), false);
  assert.deepEqual(linkLibraryJob('alice', first, available), linked);
  const both = linkLibraryJob('alice', second, available);
  assert.equal(both.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  const downloaded = available.map((job) => job.id === second.id ? { ...job, files: ['Second.mp3'] } : job);
  assert.deepEqual(getPlaylistTracks(getLibrary('alice', downloaded), downloaded).get(individualSongsId).map((track) => track.name), ['First.mp3', 'Second.mp3']);
  assert.equal(getLibrary('bob', available).entries.some((entry) => entry.id === individualSongsId), false);
  const removed = setLibrary('alice', { ...both, entries: both.entries.filter((entry) => entry.id !== individualSongsId), singleJobIds: [] }, available);
  assert.equal(removed.entries.some((entry) => entry.id === individualSongsId), true);
  closeDatabases();
  const empty = getLibrary('alice', jobs);
  assert.equal(empty.entries.find((entry) => entry.id === individualSongsId).name, 'Individual Songs');
  assert.equal(empty.entries.find((entry) => entry.id === individualSongsId).protected, true);
  assert.deepEqual(getPlaylistTracks(empty, jobs).get(individualSongsId), []);
});

test('songs move between personal playlists without losing source identity or leaking to other users', () => {
  const single = { id: 'single', isPlaylist: false, files: ['First.mp3'] };
  const available = [...jobs, single];
  let library = linkLibraryJob('alice', single, available);
  library = moveLibrarySong('alice', { version: library.version, jobId: single.id, name: 'First.mp3', playlistId: 'jazz' }, available);
  assert.deepEqual(getPlaylistTracks(library, available).get(individualSongsId), []);
  const jazz = getPlaylistTracks(library, available).get('jazz');
  assert.equal(jazz.filter((track) => track.name === 'First.mp3').length, 2);
  assert.deepEqual(jazz.filter((track) => track.name === 'First.mp3').map((track) => track.jobId), ['jazz', 'single']);
  const reordered = [...jazz].filter((track) => track.name !== 'notes.txt').reverse().map(songKey);
  library = setLibrary('alice', { ...library, playlistSongOrder: { jazz: reordered } }, available);
  assert.equal(getPlaylistTracks(library, available).get('jazz')[0].jobId, 'single');
  library = moveLibrarySong('alice', { version: library.version, jobId: 'jazz', name: 'Third.mp3', playlistId: 'soul' }, available);
  assert.equal(getPlaylistTracks(library, available).get('jazz').some((track) => track.name === 'Third.mp3'), false);
  assert.equal(getPlaylistTracks(library, available).get('soul').at(-1).jobId, 'jazz');
  assert.equal(getPlaylistTracks(getLibrary('bob', available), available).get('jazz').some((track) => track.name === 'Third.mp3'), true);
  assert.deepEqual(jobs[0].files, ['First.mp3', 'Second.mp3', 'Third.mp3', 'notes.txt']);
  closeDatabases();
  assert.deepEqual(getLibrary('alice', available), library);
  const deletedTarget = available.filter((job) => job.id !== 'soul');
  assert.equal(getPlaylistTracks(getLibrary('alice', deletedTarget), deletedTarget).get('jazz').some((track) => track.name === 'Third.mp3'), true);
});

test('song moves reject folders, unavailable songs and stale versions', () => {
  const library = setLibrary('alice', { ...getLibrary('alice', jobs), entries: [
    ...getLibrary('alice', jobs).entries, { id: 'folder-target', name: 'Folder', type: 'folder', parentId: null }
  ] }, jobs);
  const move = { version: library.version, jobId: 'jazz', name: 'First.mp3', playlistId: 'soul' };
  for (const changes of [{ playlistId: 'folder-target' }, { playlistId: 'missing' }, { name: '../outside.mp3' }, { name: 'notes.txt' }, { jobId: 'missing' }]) {
    assert.throws(() => moveLibrarySong('alice', { ...move, ...changes }, jobs), { statusCode: 400 });
  }
  assert.throws(() => moveLibrarySong('alice', { ...move, version: 0 }, jobs), { statusCode: 409 });
  assert.throws(() => setLibrary('alice', { ...library, songMoves: [{ ...move, playlistId: 'folder-target' }] }, jobs), { statusCode: 400 });
  assert.throws(() => setLibrary('alice', { ...library, playlistSongOrder: { soul: [songKey(move)] } }, jobs), { statusCode: 400 });
  assert.deepEqual(getLibrary('alice', jobs), library);
});

test('all job media can be added atomically without removing source tracks or duplicating destination tracks', () => {
  const available = [{ ...jobs[0], files: [...jobs[0].files, 'Movie.mp4'] }, ...jobs.slice(1)];
  const initial = setLibrary('alice', { ...getLibrary('alice', available), songOrder: { jazz: ['Third.mp3', 'First.mp3'] } }, available);
  const result = addLibraryJobFiles('alice', { version: initial.version, jobId: 'jazz', playlistId: 'soul' }, available);
  assert.equal(result.addedCount, 4);
  assert.equal(result.version, initial.version + 1);
  const tracks = getPlaylistTracks(result, available);
  assert.equal(tracks.get('jazz').length, 5);
  assert.deepEqual(tracks.get('soul').map((track) => track.name), ['Soul.mp3', 'Third.mp3', 'First.mp3', 'Second.mp3', 'Movie.mp4']);
  assert.deepEqual(getPlaylistTracks(getLibrary('bob', available), available).get('soul').map((track) => track.name), ['Soul.mp3']);
  const repeat = addLibraryJobFiles('alice', { version: result.version, jobId: 'jazz', playlistId: 'soul' }, available);
  assert.equal(repeat.addedCount, 0);
  assert.equal(repeat.version, result.version);
  const saved = setLibrary('alice', { version: result.version, entries: result.entries, songOrder: result.songOrder }, available);
  closeDatabases();
  assert.deepEqual(getLibrary('alice', available), saved);
  assert.equal(getLibrary('alice', available.map((job) => job.id === 'jazz' ? { ...job, files: ['Movie.mp4'] } : job)).songAdds.length, 1);
  assert.equal(getLibrary('alice', available.filter((job) => job.id !== 'soul')).songAdds.length, 0);
});

test('moving an added entry preserves other memberships and never duplicates a destination entry', () => {
  let library = addLibraryJobFiles('alice', { version: 0, jobId: 'jazz', playlistId: 'soul' }, jobs);
  const move = { jobId: 'jazz', name: 'First.mp3', sourcePlaylistId: 'soul', playlistId: 'live' };
  library = moveLibrarySong('alice', { ...move, version: library.version }, jobs);
  const contains = (id) => getPlaylistTracks(library, jobs).get(id).filter((track) => track.jobId === 'jazz' && track.name === 'First.mp3').length;
  assert.equal(contains('jazz'), 1);
  assert.equal(contains('soul'), 0);
  assert.equal(contains('live'), 1);
  assert.throws(() => moveLibrarySong('alice', { ...move, version: library.version }, jobs), { statusCode: 400 });
  library = moveLibrarySong('alice', { ...move, version: library.version, sourcePlaylistId: 'jazz' }, jobs);
  assert.equal(contains('jazz'), 0);
  assert.equal(contains('live'), 1);
  assert.equal(library.songAdds.some((track) => track.name === 'First.mp3'), false);
  library = addLibraryJobFiles('alice', { version: library.version, jobId: 'jazz', playlistId: 'soul' }, jobs);
  library = moveLibrarySong('alice', { ...move, version: library.version }, jobs);
  assert.equal(contains('soul'), 0);
  assert.equal(contains('live'), 1);
});

test('bulk additions reject stale versions, folders, unavailable jobs and empty jobs without partial writes', () => {
  const available = [...jobs, { id: 'empty', files: ['notes.txt'] }];
  const initial = setLibrary('alice', { ...getLibrary('alice', available), entries: [
    ...getLibrary('alice', available).entries, { id: 'folder-target', type: 'folder', name: 'Folder', parentId: null }
  ] }, available);
  const value = { version: initial.version, jobId: 'jazz', playlistId: 'soul' };
  for (const changes of [{ playlistId: 'folder-target' }, { playlistId: 'missing' }, { jobId: 'empty' }, { version: null }]) {
    assert.throws(() => addLibraryJobFiles('alice', { ...value, ...changes }, available), { statusCode: 400 });
  }
  assert.throws(() => addLibraryJobFiles('alice', { ...value, jobId: 'missing' }, available), { statusCode: 404 });
  assert.throws(() => addLibraryJobFiles('alice', { ...value, version: 0 }, available), { statusCode: 409 });
  for (const songAdds of [null, [{ jobId: 'jazz', name: 'notes.txt', playlistId: 'soul' }], [{ jobId: 'jazz', name: 'First.mp3', playlistId: 'folder-target' }]]) {
    assert.throws(() => setLibrary('alice', { ...initial, songAdds }, available), { statusCode: 400 });
  }
  assert.deepEqual(getLibrary('alice', available), initial);
});

test('invalid library trees and song orders cannot overwrite saved data', () => {
  const initial = getLibrary('alice', jobs);
  const folder = { id: 'folder-one', type: 'folder', parentId: null, name: 'One' };
  const invalidValues = [
    null,
    { ...initial, version: -1 },
    { ...initial, entries: [initial.entries[0], initial.entries[0]] },
    { ...initial, entries: [{ ...folder, parentId: folder.id }] },
    { ...initial, entries: [{ ...folder, parentId: 'folder-two' }, { ...folder, id: 'folder-two', parentId: folder.id }] },
    { ...initial, entries: [{ ...folder, parentId: 'jazz' }, ...initial.entries] },
    { ...initial, entries: [{ ...folder, name: ' ' }] },
    { ...initial, entries: [{ id: 'unknown', type: 'playlist', parentId: null }] },
    { ...initial, songOrder: { jazz: ['First.mp3', 'First.mp3'] } },
    { ...initial, songOrder: { jazz: ['../outside.mp3'] } },
    { ...initial, songOrder: { jazz: ['notes.txt'] } },
    { ...initial, songOrder: { unknown: [] } }
  ];
  for (const value of invalidValues) {
    assert.throws(() => setLibrary('alice', value, jobs), { statusCode: 400 });
    assert.deepEqual(getLibrary('alice', jobs), initial);
  }
  const deeplyNested = Array.from({ length: 33 }, (_, index) => ({
    id: `folder-${index}`, type: 'folder', name: 'Nested', parentId: index ? `folder-${index - 1}` : null
  }));
  assert.throws(() => setLibrary('alice', { ...initial, entries: deeplyNested }, jobs), { statusCode: 400 });
});

test('playlist and job submission share creation, duplicate, cancellation and permission behavior', async () => {
  const user = { id: 'alice', role: 'user' };
  const job = { id: 'existing', status: 'completed', initiatedBy: user, contributors: [] };
  let calls = [];
  const create = async (url, options) => { calls.push([url, options]); return job; };
  const created = await submitJobUrl(' https://music.youtube.com/watch?v=one ', { user, request: create, confirm: async () => assert.fail('No confirmation needed') });
  assert.deepEqual(created, { job, created: true });
  assert.equal(JSON.parse(calls[0][1].body).url, 'https://music.youtube.com/watch?v=one');
  for (const library of [false, true]) {
    for (const accepted of [false, true]) {
      calls = [];
      const duplicate = async (url) => {
        calls.push(url);
        if (url === '/api/jobs') throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: job });
        return job;
      };
      const result = await submitJobUrl('url', { request: duplicate, user, library, confirm: async (options) => {
        assert.equal(options.action, 'rerun'); return accepted;
      } });
      assert.deepEqual(result, accepted ? { job, created: false } : null);
      assert.deepEqual(calls, accepted ? ['/api/jobs', '/api/jobs/existing/rerun'] : ['/api/jobs']);
    }
  }
  for (const previous of [{ ...job, status: 'running' }, { ...job, status: 'running', initiatedBy: { id: 'bob' }, contributors: [user] }]) {
    const result = await submitJobUrl('url', { user, library: true, request: async (url) => {
      assert.equal(url, '/api/jobs');
      throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: previous });
    }, confirm: async (options) => { assert.equal(options.action, 'open'); assert.equal(options.label, 'Add Playlist'); return true; } });
    assert.equal(result.job, previous);
  }
  for (const role of ['user', 'admin']) {
    await assert.rejects(submitJobUrl('url', { user: { ...user, role }, library: true, request: async () => {
      throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: { ...job, initiatedBy: { id: 'bob' } } });
    }, confirm: async () => assert.fail('An unrelated playlist must not be offered') }), /contributor/);
  }
  await assert.rejects(submitJobUrl('bad', { user, request: async () => { throw new Error('Invalid URL'); } }), /Invalid URL/);
});

test('metadata-only submission applies to creation and leaves duplicate reruns as media downloads', async () => {
  const user = { id: 'alice', role: 'user' };
  const job = { id: 'existing', status: 'completed', initiatedBy: user, contributors: [] };
  for (const metadataOnly of [undefined, false, true]) {
    const result = await submitJobUrl(' https://music.youtube.com/playlist?list=manual ', {
      user, metadataOnly, confirm: async () => assert.fail('No confirmation needed'),
      request: async (url, options) => {
        assert.equal(url, '/api/jobs');
        assert.deepEqual(JSON.parse(options.body), { url: 'https://music.youtube.com/playlist?list=manual', metadataOnly: metadataOnly === true });
        return job;
      }
    });
    assert.deepEqual(result, { job, created: true });
  }
  const calls = [];
  const result = await submitJobUrl('url', {
    user, metadataOnly: true,
    request: async (url, options) => {
      calls.push([url, options]);
      if (url === '/api/jobs') throw Object.assign(new Error('Duplicate'), { code: 'JOB_ALREADY_EXISTS', existingJob: job });
      assert.deepEqual(options, { method: 'POST' });
      return job;
    },
    confirm: async (options) => {
      assert.equal(options.action, 'rerun');
      assert.match(options.message, /downloading missing ones/);
      return true;
    }
  });
  assert.deepEqual(result, { job, created: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], '/api/jobs/existing/rerun');
});

test('stale saves are rejected and deleting an account removes its preferences', () => {
  const initial = getLibrary('alice', jobs);
  const saved = setLibrary('alice', initial, jobs);
  assert.equal(saved.version, 1);
  assert.throws(() => setLibrary('alice', initial, jobs), { statusCode: 409 });
  assert.deepEqual(getLibrary('alice', jobs), saved);
  openDatabase().prepare('DELETE FROM users WHERE id = ?').run('alice');
  assert.equal(openDatabase().prepare('SELECT count(*) AS count FROM user_preferences').get().count, 0);
});