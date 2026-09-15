import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaylistUrl, isYouTubeMusicUrl, sanitizeFolderName } from '../src/utils.js';

test('validates YouTube Music URL host', () => {
  assert.equal(isYouTubeMusicUrl('https://music.youtube.com/watch?v=abc'), true);
  assert.equal(isYouTubeMusicUrl('https://youtube.com/watch?v=abc'), false);
});

test('detects playlist URLs by path and list query parameter', () => {
  assert.equal(isPlaylistUrl('https://music.youtube.com/playlist?list=PL12345'), true);
  assert.equal(isPlaylistUrl('https://music.youtube.com/watch?v=abc&list=PL12345'), false);
});

test('sanitizes folder names for output directories', () => {
  assert.equal(sanitizeFolderName('My Playlist Name'), 'My_Playlist_Name');
  assert.equal(sanitizeFolderName('  bad:/\\name  '), 'bad_name');
});
