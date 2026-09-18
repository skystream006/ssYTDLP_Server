import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import * as plist from 'plist';

test('music imports validate media, preserve playlists and enforce ownership', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-import-test-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  process.env.AUTH_STORE_PATH = path.join(directory, 'auth.json');
  process.env.YTDLP_OUTPUT_ROOT = path.join(directory, 'output');
  const imports = await import('../src/libraryImport.js');
  const manager = await import('../src/jobManager.js');
  const { getLibrary, linkLibraryJob } = await import('../src/libraryStore.js');
  const { closeDatabases } = await import('../src/database.js');
  context.after(async () => { closeDatabases(); await fs.rm(directory, { recursive: true, force: true }); });
  const { registerUser } = await import('../src/authStore.js');
  const owner = await registerUser('Owner', 'Owner', { id: 'owner', publicKey: Buffer.from('owner'), counter: 0 });
  async function countUpload(fieldname, megabytes, extraBytes = 0, request = { importBytes: 0 }) {
    const chunk = Buffer.alloc(1024 ** 2);
    function* chunks() {
      for (let index = 0; index < megabytes; index++) yield chunk;
      if (extraBytes) yield Buffer.alloc(extraBytes);
    }
    await pipeline(Readable.from(chunks()), imports.createImportUploadCounter(request, fieldname),
      new Writable({ write(_chunk, _encoding, done) { done(); } }));
  }
  for (const [fieldname, megabytes] of [['xml', 20], ['files', 512], ['media', 2048]]) {
    await countUpload(fieldname, megabytes);
    await assert.rejects(countUpload(fieldname, megabytes, 1), { statusCode: 413 });
  }
  const aggregate = { importBytes: 2 * 1024 ** 3 - 1 };
  await countUpload('files', 0, 1, aggregate);
  await assert.rejects(countUpload('media', 0, 1, aggregate), { statusCode: 413 });
  const audio = Buffer.alloc(48);
  audio.write('RIFF');
  audio.writeUInt32LE(40, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(4, 40);
  const file = { name: 'Song.wav', path: path.join(directory, 'audio'), size: audio.length };
  await fs.writeFile(file.path, audio);

  const result = await imports.importUploadedFiles([file], { createNew: 'true', playlistTitle: 'Local music' }, owner);
  const job = result.jobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.source, 'files');
  assert.equal(getLibrary(owner.id, manager.getJobs()).entries[0].id, job.id);
  assert.deepEqual(await fs.readFile(path.join(job.outputDir, job.files[0])), audio);
  await assert.rejects(imports.importUploadedFiles([file], { createNew: 'false', playlistId: job.id }, { id: 'other' }), /existing playlists/);
  await assert.rejects(manager.importJobFiles({ files: [file], playlistId: job.id }, { id: 'other' }), { statusCode: 403 });
  const appended = await imports.importUploadedFiles([file], { createNew: 'false', playlistId: job.id }, owner);
  assert.deepEqual(appended.jobs[0].files, ['Song.wav', 'Song (2).wav']);
  await assert.rejects(manager.rerunJob(job.id, owner), /cannot be rerun/);
  await assert.rejects(imports.importUploadedFiles([file], { createNew: 'true', playlistTitle: ' ' }, owner), /Playlist name/);
  await assert.rejects(imports.importUploadedFiles([{ ...file, name: 'wrong.mp3' }], { createNew: 'true', playlistTitle: 'Invalid' }, owner), /mismatched audio/);
  await assert.rejects(imports.importUploadedFiles([], { createNew: 'true', playlistTitle: 'Empty' }, owner), /Select audio/);
  await assert.rejects(manager.importJobFiles({ files: [file, { name: 'Missing.wav', path: path.join(directory, 'missing') }], playlistId: job.id }, owner));
  assert.deepEqual((await fs.readdir(job.outputDir)).sort(), ['Song (2).wav', 'Song.wav']);
  const single = await manager.importJobFiles({ files: [file], playlistTitle: 'Single', individual: true }, owner);
  linkLibraryJob(owner.id, single, manager.getJobs());
  const singles = await imports.importUploadedFiles([file], { createNew: 'false', playlistId: 'individual-songs' }, owner);
  assert.ok(getLibrary(owner.id, manager.getJobs()).singleJobIds.includes(singles.jobs[0].id));

  const zip = new AdmZip();
  zip.addFile('Media/Artist/Album/Song.wav', audio);
  zip.addFile('Media/Artist/Album/Second.wav', audio);
  zip.addFile('Library.xml', Buffer.from('ignored'));
  const zipPath = path.join(directory, 'media.zip');
  await fs.writeFile(zipPath, zip.toBuffer());
  const media = await imports.extractImportMedia(zipPath, directory);
  assert.equal(media.length, 2);
  const document = { Tracks: {
    1: { 'Track ID': 1, Name: 'Song', Location: 'file://localhost/C:/Music/Artist/Album/Song.wav' },
    2: { 'Track ID': 2, Name: 'Second', Location: 'file:///Users/me/Music/Artist/Album/Second.wav' }
  }, Playlists: [
    { Name: 'Library', Master: true, 'Playlist Items': [{ 'Track ID': 1 }, { 'Track ID': 2 }] },
    { Name: 'Favorites', 'Playlist Items': [{ 'Track ID': 2 }, { 'Track ID': 1 }] },
    { Name: 'Shared song', 'Playlist Items': [{ 'Track ID': 1 }] }
  ] };
  const xml = plist.build(document);
  const storage = path.join(directory, 'import-storage');
  process.env.IMPORT_STORAGE_ROOT = storage;
  assert.deepEqual(await imports.listLocalImportFiles(), { xmlFiles: [], zipFiles: [] });
  await fs.mkdir(storage);
  await fs.writeFile(path.join(storage, 'Library.XML'), xml);
  await fs.copyFile(zipPath, path.join(storage, 'Media.zip'));
  await fs.writeFile(path.join(storage, 'ignored.txt'), 'ignored');
  await fs.mkdir(path.join(storage, 'folder.zip'));
  const localFiles = await imports.listLocalImportFiles();
  assert.deepEqual(localFiles.xmlFiles.map((item) => item.name), ['Library.XML']);
  assert.deepEqual(localFiles.zipFiles.map((item) => item.name), ['Media.zip']);
  assert.equal(localFiles.xmlFiles[0].size, Buffer.byteLength(xml));
  assert.equal((await imports.resolveLocalImportFile('Media.zip', '.zip')).path, path.join(await fs.realpath(storage), 'Media.zip'));
  for (const name of ['../media.zip', '..\\media.zip', '/media.zip', 'C:\\media.zip', 'Media.zip:stream', 'Library.XML', 'folder.zip']) {
    await assert.rejects(imports.resolveLocalImportFile(name, '.zip'), { statusCode: 400 });
  }
  await assert.rejects(imports.resolveLocalImportFile('missing.zip', '.zip'), { statusCode: 404 });
  const originalLstat = fs.lstat;
  const symlinkMock = context.mock.method(fs, 'lstat', async (...args) => {
    const stat = await originalLstat(...args);
    stat.isSymbolicLink = () => true;
    return stat;
  });
  try { await assert.rejects(imports.resolveLocalImportFile('Media.zip', '.zip'), { statusCode: 400 }); }
  finally { symlinkMock.mock.restore(); }
  const plans = imports.parseItunesImport(xml, media);
  assert.deepEqual(plans.map((plan) => plan.playlistTitle), ['Favorites', 'Shared song']);
  assert.deepEqual(plans[0].files.map((track) => track.name), ['Second.wav', 'Song.wav']);
  const largeXml = xml.replace('</plist>', `${' '.repeat(21 * 1024 ** 2)}</plist>`);
  assert.throws(() => imports.parseItunesImport(largeXml, media), { statusCode: 413 });
  assert.deepEqual(imports.parseItunesImport(largeXml, media, { local: true }), plans);
  const largeMedia = media.map((track) => ({ ...track, size: 5 * 1024 ** 3 }));
  assert.throws(() => imports.parseItunesImport(xml, largeMedia), { statusCode: 413 });
  assert.equal(imports.parseItunesImport(xml, largeMedia, { local: true }).length, 2);
  const manyTracks = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [index + 1,
    { 'Track ID': index + 1, Location: document.Tracks[1].Location }]));
  const manyPlaylists = Array.from({ length: 501 }, (_, index) => ({ Name: `Playlist ${index}`, 'Playlist Items': [{ 'Track ID': index + 1 }] }));
  const manyTracksXml = plist.build({ Tracks: manyTracks, Playlists: manyPlaylists });
  assert.throws(() => imports.parseItunesImport(manyTracksXml, media), { statusCode: 413 });
  const repeatedPlaylistsXml = plist.build({ Tracks: document.Tracks,
    Playlists: Array.from({ length: 501 }, () => document.Playlists[1]) });
  assert.throws(() => imports.parseItunesImport(repeatedPlaylistsXml, media), { statusCode: 413 });
  assert.equal(imports.parseItunesImport(repeatedPlaylistsXml, media, { local: true }).length, 501);
  const largePlans = imports.parseItunesImport(manyTracksXml, media, { local: true });
  assert.equal(largePlans.length, 502);
  assert.equal(largePlans.reduce((total, plan) => total + plan.files.length, 0), 2001);
  const originalStat = fs.stat;
  const statMock = context.mock.method(fs, 'stat', async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === file.path) stat.size = 3 * 1024 ** 3;
    return stat;
  });
  try {
    await assert.rejects(imports.validateImportAudio(file), { statusCode: 413 });
    assert.equal((await imports.validateImportAudio(file, { local: true })).size, 3 * 1024 ** 3);
  }
  finally { statMock.mock.restore(); }
  const imported = await imports.importItunesLibrary(xml, media, owner);
  assert.equal(imported.importedFiles, 3);
  assert.equal(imported.jobs[0].source, 'itunes');
  assert.deepEqual(getLibrary(owner.id, manager.getJobs()).songOrder[imported.jobs[0].id], ['Second.wav', 'Song.wav']);
  assert.throws(() => imports.parseItunesImport(xml, media.slice(1)), /Missing or ambiguous/);
  assert.throws(() => imports.parseItunesImport('<not-plist/>', media), /Invalid iTunes/);
  assert.throws(() => imports.parseItunesImport('<!DOCTYPE plist [<!ENTITY name "bad">]><plist/>', media), /entity declarations/);
  const ambiguous = [...media, { ...media[0], name: 'Other/Artist/Album/Song.wav' }];
  assert.throws(() => imports.parseItunesImport(xml, ambiguous), /Missing or ambiguous/);
  const ungrouped = imports.parseItunesImport(plist.build({ Tracks: document.Tracks }), media);
  assert.equal(ungrouped[0].playlistTitle, 'iTunes Library');
  const encoded = plist.build({ Tracks: { 1: { 'Track ID': 1, Location: 'file:///Music/A%20song%20%231.wav' } } });
  assert.equal(imports.parseItunesImport(encoded, [{ ...file, name: 'A song #1.wav' }])[0].files[0].name, 'A song #1.wav');
  const deepZip = new AdmZip();
  deepZip.addFile(`${'folder/'.repeat(33)}Song.wav`, audio);
  await fs.writeFile(zipPath, deepZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory), /unsafe/);
  const linkedZip = new AdmZip();
  linkedZip.addFile('Link.wav', audio);
  linkedZip.getEntry('Link.wav').attr = 0xa1ff0000;
  await fs.writeFile(zipPath, linkedZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory), /unsafe/);
  await fs.writeFile(zipPath, 'not a zip');
  await assert.rejects(imports.extractImportMedia(zipPath, directory), /Invalid media ZIP/);
  const largeZip = new AdmZip();
  for (let index = 0; index < 2001; index++) largeZip.addFile(`Music/Track ${index}.wav`, audio);
  for (let index = 0; index < 8000; index++) largeZip.addFile(`Ignored/${index}/`, Buffer.alloc(0));
  await fs.writeFile(zipPath, largeZip.toBuffer());
  await assert.rejects(imports.extractImportMedia(zipPath, directory), { statusCode: 413 });
  const extracted = await imports.extractImportMedia(zipPath, directory, { local: true });
  assert.equal(extracted.length, 2001);
});