import crypto from 'node:crypto';

const INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

export function isYouTubeMusicUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'music.youtube.com';
  } catch {
    return false;
  }
}

export function isPlaylistUrl(value) {
  if (!isYouTubeMusicUrl(value)) {
    return false;
  }

  const parsed = new URL(value);
  return parsed.searchParams.has('list');
}

export function sanitizeFolderName(name) {
  return String(name || 'playlist')
    .trim()
    .replace(/\s+/g, '_')
    .replace(INVALID_FOLDER_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'playlist';
}

export function randomSongFolderName() {
  return `song_${crypto.randomUUID()}`;
}
