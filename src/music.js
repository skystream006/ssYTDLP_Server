import NodeID3 from 'node-id3';
import path from 'node:path';

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
    artwork,
    sylt,
    uslt: tags.unsynchronisedLyrics?.text || ''
  };
}