import NodeID3 from 'node-id3';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';

const metadataFields = ['title', 'artist', 'album', 'performerInfo', 'genre', 'year', 'trackNumber', 'partOfSet'];
const ratingBytes = [0, 1, 64, 128, 196, 255];
const summaryCache = new Map();

function songRating(tags) {
  const rating = tags.popularimeter?.rating;
  if (!Number.isInteger(rating) || rating <= 0) return 0;
  if (rating < 32) return 1;
  if (rating < 96) return 2;
  if (rating < 160) return 3;
  if (rating < 224) return 4;
  return 5;
}

export async function readSongSummary(filePath, stat) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') return {};
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = summaryCache.get(filePath);
  if (cached?.signature === signature) return cached.summary;
  const file = await fs.open(filePath, 'r');
  let tags = {};
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead === 10 && header.toString('ascii', 0, 3) === 'ID3' && header.subarray(6).every((byte) => byte < 128)) {
      const size = header.subarray(6).reduce((total, byte) => total * 128 + byte, 0) + 10;
      if (size <= stat.size && size <= 16 * 1024 ** 2) {
        const buffer = Buffer.alloc(size);
        const result = await file.read(buffer, 0, size, 0);
        if (result.bytesRead === size) tags = NodeID3.read(buffer, { include: ['TIT2', 'TPE1', 'TALB', 'POPM'] });
      }
    }
  } finally { await file.close(); }
  const summary = { rating: songRating(tags) };
  for (const field of ['title', 'artist', 'album']) if (typeof tags[field] === 'string') summary[field] = tags[field];
  if (summaryCache.size >= 1000) summaryCache.delete(summaryCache.keys().next().value);
  summaryCache.set(filePath, { signature, summary });
  return summary;
}

export async function updateSongMetadata(filePath, value) {
  const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (path.extname(filePath).toLowerCase() !== '.mp3') invalid('Metadata editing is supported for MP3 files');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).length || Object.keys(value).some((key) => ![...metadataFields, 'artwork', 'rating'].includes(key))) invalid('Invalid song metadata');
  if (Object.hasOwn(value, 'rating') && (!Number.isInteger(value.rating) || value.rating < 0 || value.rating > 5)) invalid('Rating must be an integer from 0 to 5');
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
  if (Object.hasOwn(value, 'rating')) {
    const popularity = NodeID3.read(original).popularimeter;
    updates.popularimeter = { email: popularity?.email || 'Windows Media Player 9 Series',
      counter: popularity?.counter || 0, rating: ratingBytes[value.rating] };
  }
  const result = NodeID3.update(updates, original);
  if (!Buffer.isBuffer(result)) throw new Error('Unable to update song metadata');
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, result, { flag: 'wx', mode: (await fs.stat(filePath)).mode });
    await fs.rename(temporary, filePath);
    summaryCache.delete(filePath);
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
    rating: songRating(tags),
    artwork,
    sylt,
    uslt: tags.unsynchronisedLyrics?.text || ''
  };
}