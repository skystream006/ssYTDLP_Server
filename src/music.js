import NodeID3 from 'node-id3';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';

const metadataFields = ['title', 'artist', 'album', 'performerInfo', 'genre', 'year', 'trackNumber', 'partOfSet'];

export async function updateSongMetadata(filePath, value) {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (path.extname(filePath).toLowerCase() !== '.mp3') invalid('Metadata editing is supported for MP3 files');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).length || Object.keys(value).some((key) => ![...metadataFields, 'artwork'].includes(key))) invalid('Invalid song metadata');
  const updates = {};
  for (const field of metadataFields) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'string' || value[field].length > 500 || /[\x00-\x1f\x7f]/.test(value[field])) invalid(`Invalid ${field}`);
    updates[field] = value[field].trim();
  }
  if (Object.hasOwn(value, 'artwork')) {
    if (value.artwork === null) updates.image = null;
    else {
      if (typeof value.artwork !== 'string' || value.artwork.length > 2800000) invalid('Artwork must be at most 2 MB');
      const match = value.artwork.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) invalid('Artwork must be a JPEG, PNG or WebP image');
      const imageBuffer = Buffer.from(match[2], 'base64');
      if (!imageBuffer.length || imageBuffer.length > 2 * 1024 * 1024 || imageBuffer.toString('base64') !== match[2]) invalid('Invalid artwork data or size');
      const type = await fileTypeFromBuffer(imageBuffer).catch(() => null);
      if (type?.mime !== match[1]) invalid('Artwork content does not match its image type');
      updates.image = { mime: type.mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer };
    }
  }
  const original = await fs.readFile(filePath);
  const result = NodeID3.update(updates, original);
  if (!Buffer.isBuffer(result)) throw new Error('Unable to update song metadata');
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, result, { flag: 'wx', mode: (await fs.stat(filePath)).mode });
    await fs.rename(temporary, filePath);
  } finally { await fs.rm(temporary, { force: true }); }
  return readSongMetadata(filePath);
}

export async function readSongMetadata(filePath) {
  const tags = path.extname(filePath).toLowerCase() === '.mp3'
    ? await NodeID3.Promise.read(filePath) : {};
  const frame = tags.synchronisedLyrics?.find((lyrics) => lyrics.timeStampFormat === 2 && lyrics.contentType === 1);
  const sylt = (frame?.synchronisedText || [])
    .filter((line) => Number.isFinite(line.timeStamp) && line.timeStamp >= 0 && typeof line.text === 'string')
    .map((line) => ({ time: line.timeStamp / 1000, text: line.text }))
    .sort((first, second) => first.time - second.time);
  const image = tags.image;
  const artwork = image && ['image/jpeg', 'image/png', 'image/webp'].includes(image.mime)
    && image.imageBuffer?.length <= 2 * 1024 * 1024
    ? `data:${image.mime};base64,${image.imageBuffer.toString('base64')}` : null;
  return {
    title: tags.title || path.basename(filePath, path.extname(filePath)),
    artist: tags.artist || '',
    album: tags.album || '',
    performerInfo: tags.performerInfo || '',
    genre: tags.genre || '',
    year: tags.year || '',
    trackNumber: tags.trackNumber || '',
    partOfSet: tags.partOfSet || '',
    artwork,
    sylt,
    uslt: tags.unsynchronisedLyrics?.text || ''
  };
}