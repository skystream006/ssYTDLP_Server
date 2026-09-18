import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let SongActions;
let TranscriptionDialog;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ SongActions, TranscriptionDialog } = await server.ssrLoadModule('/src/SongActions.jsx'));
});

after(async () => { await server?.close(); });

test('transcription dialog exposes upstream options with unchecked defaults', () => {
  const html = renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024 }, onClose() {}, onSubmit() {}
  }));
  for (const label of ['No Vocals', 'Viet Lyrics Fallback', 'Add lyrics']) {
    assert.ok(html.includes(`/>${label}</label>`));
  }
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes('<option value="" selected="">Auto-detect</option>'));
  assert.ok(html.includes('<option value="vi">Vietnamese</option>'));
});

test('transcription options have linked help buttons and descriptions', () => {
  const html = renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024 }, onClose() {}, onSubmit() {}
  }));
  for (const label of ['Language', 'No Vocals', 'Viet Lyrics Fallback', 'Add lyrics']) {
    const descriptionId = html.match(new RegExp(`type="button" aria-label="About ${label}" aria-describedby="([^"]+)"`))?.[1];
    assert.ok(descriptionId, `Missing help button for ${label}`);
    assert.ok(html.includes(`role="tooltip" id="${descriptionId}">`));
    assert.equal(html.split(`aria-describedby="${descriptionId}"`).length - 1, 2);
  }
  assert.match(html, /opening retry triggers/);
  assert.match(html, /Automatically selects Vietnamese/);
  assert.match(html, /\[NoVocals\] folder/);
});

function renderActions(canModify = true) {
  return renderToStaticMarkup(createElement(SongActions, { name: 'Song.mp3', className: 'song-order-actions' },
    canModify && createElement('button', { title: 'Edit song metadata', disabled: true }, 'Edit'),
    createElement('button', { title: 'Transcribe song' }, 'Transcribe'),
    canModify && createElement('button', { title: 'Delete song' }, 'Delete'),
    createElement('a', { title: 'Download song', href: '/download/song.mp3' }, 'Download')
  ));
}

test('song actions retain labels, disabled states and download URLs in both layouts', () => {
  const html = renderActions();
  assert.equal((html.match(/title="Edit song metadata" disabled=""/g) || []).length, 2);
  assert.equal((html.match(/href="\/download\/song.mp3"/g) || []).length, 2);
  for (const label of ['Edit song metadata', 'Transcribe song', 'Delete song', 'Download song']) {
    assert.ok(html.includes(`<span>${label}</span>`));
  }
});

test('song actions do not expose restricted controls in the overflow menu', () => {
  const html = renderActions(false);
  assert.ok(!html.includes('Edit song metadata'));
  assert.ok(!html.includes('Delete song'));
  assert.ok(html.includes('<span>Transcribe song</span>'));
  assert.ok(html.includes('<span>Download song</span>'));
});

test('song action trigger identifies its popover and starts collapsed', () => {
  const html = renderActions();
  const target = html.match(/popoverTarget="([^"]+)"/i)?.[1];
  assert.ok(target);
  assert.ok(html.includes(`id="${target}"`));
  assert.ok(html.includes(`aria-controls="${target}"`));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('popover="auto"'));
  assert.ok(html.includes('aria-label="Actions for Song.mp3"'));
});
