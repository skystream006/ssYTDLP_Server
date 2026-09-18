export const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma'];
export const videoExtensions = ['.mp4', '.m4v', '.webm', '.mov', '.ogv'];
export const mediaAccept = [...audioExtensions, ...videoExtensions].join(',');

export function mediaType(name) {
  const extension = `.${String(name).split(/[\\/]/).at(-1).split('.').at(-1).toLowerCase()}`;
  return videoExtensions.includes(extension) ? 'video' : audioExtensions.includes(extension) ? 'audio' : null;
}

export function isPlayableFile(name) {
  return mediaType(name) !== null;
}