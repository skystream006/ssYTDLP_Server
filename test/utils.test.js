import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaylistUrl, isYouTubeMusicUrl, sanitizeFolderName } from '../src/utils.js';

test('validates YouTube Music URL host', () => {
  assert.equal(isYouTubeMusicUrl('https://music.youtube.com/watch?v=abc'), true);
  assert.equal(isYouTubeMusicUrl('https://youtube.com/watch?v=abc'), false);
});

test('detects playlist URLs by list query parameter regardless of path', () => {
  assert.equal(isPlaylistUrl('https://music.youtube.com/playlist?list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=RTcsY6aIoEc&list=PLbMbcPGUE7ak'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?list=PL12345&v=abc'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/?list=PL12345'), true);
});

test('does not detect playlists without a list query parameter or a valid YouTube Music host', () => {
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=abc'), false);
  assert.equal(isPlaylistUrl('https://music.youtube.com/playlist'), false);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=abc#list=PL12345'), false);
  assert.equal(isPlaylistUrl('https://youtube.com/watch?v=abc&list=PL12345'), false);
  assert.equal(isPlaylistUrl('not a URL'), false);
});

test('sanitizes folder names for output directories', () => {
  assert.equal(sanitizeFolderName('My Playlist Name'), 'My_Playlist_Name');
  assert.equal(sanitizeFolderName('  bad:/\\name  '), 'bad_name');
});
