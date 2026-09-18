import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import NodeID3 from 'node-id3';
import { exportOptions, prepareLibraryExport } from '../src/libraryExport.js';
import { individualSongsId, songKey } from '../src/library.js';

async function fixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-export-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobs = [
    { id: 'first', playlistTitle: 'Mix / 同名', outputDir: path.join(root, 'first'), files: ['A #100%.mp3', 'B.mp3', 'notes.txt'] },
    { id: 'second', playlistTitle: 'Mix / 同名', outputDir: path.join(root, 'second'), files: ['A #100%.mp3', '[NoVocals]/B.mp3'] },
    { id: 'single', outputDir: path.join(root, 'single'), files: ['Single.mp3'] },
    { id: 'empty', playlistTitle: 'Empty', outputDir: path.join(root, 'empty'), files: [] }
  ];
  for (const job of jobs) {
    for (const name of job.files) {
      const target = path.join(job.outputDir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, NodeID3.write({
        title: `${job.id} ${name} & <世界> "🎵"\u0001`, artist: 'Artist\n#Injected', album: 'Album'
      }, Buffer.from(`audio ${job.id} ${name}`)));
    }
  }
  const library = {
    entries: [
      { id: 'folder', type: 'folder', parentId: null, name: 'Folder & <世界>' },
      { id: 'second', type: 'playlist', parentId: 'folder' },
      { id: 'first', type: 'playlist', parentId: null },
      { id: individualSongsId, type: 'playlist', parentId: null, name: 'Individual Songs' },
      { id: 'empty', type: 'playlist', parentId: null }
    ],
    songOrder: { second: ['[NoVocals]/B.mp3', 'A #100%.mp3'] },
    singleJobIds: ['single'],
    songMoves: [{ jobId: 'first', name: 'B.mp3', playlistId: 'second' }],
    playlistSongOrder: { second: [songKey({ jobId: 'first', name: 'B.mp3' }), songKey({ jobId: 'second', name: 'A #100%.mp3' })] }
  };
  return { root, library, jobs };
}

test('export format and absolute client destinations are validated and URL encoded', () => {
  for (const format of [undefined, 'zip', ['itunes'], {}]) {
    assert.throws(() => exportOptions(format, '/Music'), { statusCode: 400 });
  }
  for (const destination of [undefined, [], '', 'relative/path', '~/Music', 'file:///Music', '//server/share',
    '/Music/../Other', '/Music/./Other', 'C:Music', 'C:\\Bad?Name', '/Music\nInjected']) {
    assert.throws(() => exportOptions('itunes', destination), { statusCode: 400 });
  }
  assert.deepEqual(exportOptions('android'), { format: 'android' });
  assert.equal(exportOptions('itunes', 'C:\\Music\\A #100%\\').baseUrl, 'file:///C:/Music/A%20%23100%25/');
  assert.equal(exportOptions('itunes', '/Users/世界/Music/').baseUrl, 'file:///Users/%E4%B8%96%E7%95%8C/Music/');
  assert.equal(exportOptions('itunes', '/').baseUrl, 'file:///');
});

test('Android playlists retain moved songs, saved order, singles, empty lists and collision-free relative paths', async (context) => {
  const { library, jobs } = await fixture(context);
  const result = await prepareLibraryExport(library, jobs, exportOptions('android'));
  const playlists = result.documents.filter((document) => document.name.endsWith('.m3u8'));
  assert.equal(playlists.length, 4);
  assert.equal(new Set(playlists.map((document) => document.name.toLowerCase())).size, 4);
  assert.equal(result.files.length, 5);
  assert.equal(new Set(result.files.map((file) => file.archivePath.toLowerCase())).size, 5);
  const files = new Map(result.files.map((file) => [file.archivePath, file.filePath]));
  const references = (content) => content.split('\n').filter((line) => line && !line.startsWith('#'));
  const firstPlaylist = references(playlists[0].content);
  assert.deepEqual(firstPlaylist.map((name) => files.get(name)), [
    path.join(jobs[0].outputDir, 'B.mp3'),
    path.join(jobs[1].outputDir, 'A #100%.mp3'),
    path.join(jobs[1].outputDir, '[NoVocals]/B.mp3')
  ]);
  assert.equal(references(playlists[1].content).length, 1);
  assert.match(playlists[2].content, /#PLAYLIST:Individual Songs/);
  assert.deepEqual(references(playlists[3].content), []);
  for (const playlist of playlists) {
    assert.match(playlist.content, /^#EXTM3U\n/);
    assert.ok(!playlist.content.includes('\n#Injected'));
    for (const reference of references(playlist.content)) {
      assert.ok(files.has(reference), `Missing audio ${reference}`);
      assert.match(reference, /^Music\/\d+-[^/]+\.mp3$/);
      assert.ok(!reference.includes('%'));
    }
  }
});

test('iTunes XML maps ordered track IDs to included files and encodes locations, names and folder hierarchy', async (context) => {
  const { library, jobs } = await fixture(context);
  const options = exportOptions('itunes', '/Users/You/Music & More');
  const result = await prepareLibraryExport(library, jobs, options);
  const xml = result.documents.find((document) => document.name === 'Library.xml').content;
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<plist version="1.0">/);
  assert.match(xml, /&amp; &lt;世界&gt; &quot;🎵&quot;/);
  assert.ok(!xml.includes('\u0001'));
  assert.match(xml, /<key>Folder<\/key><true\/>/);
  assert.match(xml, /<key>Parent Persistent ID<\/key><string>[A-F0-9]{16}<\/string>/);
  const itemArrays = [...xml.matchAll(/<key>Playlist Items<\/key><array>(.*?)<\/array>/g)];
  assert.deepEqual(itemArrays.map((match) => [...match[1].matchAll(/<integer>(\d+)<\/integer>/g)].map((id) => Number(id[1]))),
    [[1, 2, 3], [4], [5], []]);
  const locations = [...xml.matchAll(/<key>Location<\/key><string>(.*?)<\/string>/g)].map((match) => match[1]);
  assert.equal(locations.length, result.files.length);
  for (const [index, location] of locations.entries()) {
    assert.equal(decodeURIComponent(new URL(location).pathname), `/Users/You/Music & More/${result.files[index].archivePath}`);
  }
  assert.match(result.documents.find((document) => document.name === 'IMPORT.txt').content, /add the extracted Music folder.*then use File > Library > Import Playlist/);
});

test('missing media, traversal, and symlinks outside a job fail without creating broken manifests', async (context) => {
  const { library, jobs, root } = await fixture(context);
  const exportLibrary = () => prepareLibraryExport(library, jobs, exportOptions('android'));
  const original = jobs[0].files;
  for (const name of ['../outside.mp3', path.join(root, 'outside.mp3'), 'missing.mp3']) {
    jobs[0].files = [name];
    await assert.rejects(exportLibrary, { statusCode: 409 });
  }
  const outside = path.join(root, 'outside.mp3');
  await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(jobs[0].outputDir, 'link.mp3'));
  jobs[0].files = ['link.mp3'];
  await assert.rejects(exportLibrary, { statusCode: 409 });
  await fs.symlink(jobs[1].outputDir, path.join(jobs[0].outputDir, 'external'));
  jobs[0].files = ['external/A #100%.mp3'];
  await assert.rejects(exportLibrary, { statusCode: 409 });
  jobs[0].files = original;
  await fs.unlink(path.join(jobs[0].outputDir, 'B.mp3'));
  await assert.rejects(exportLibrary, { statusCode: 409 });
});

test('empty libraries still produce importable documents and unsupported iTunes codecs fail explicitly', async (context) => {
  const empty = { entries: [], songOrder: {} };
  const result = await prepareLibraryExport(empty, [], exportOptions('itunes', 'C:\\Music'));
  assert.equal(result.files.length, 0);
  assert.match(result.documents[0].content, /<key>Tracks<\/key><dict><\/dict>/);
  const { library, jobs } = await fixture(context);
  jobs[0].files = ['Unsupported.opus'];
  await assert.rejects(() => prepareLibraryExport(library, jobs, exportOptions('itunes', '/Music')),
    { statusCode: 400, message: /iTunes cannot import/ });
});
