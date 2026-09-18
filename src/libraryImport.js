import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import multer from 'multer';
import * as plist from 'plist';
import yauzl from 'yauzl';
import { fileTypeFromFile } from 'file-type';
import { deleteJob, getJobs, importJobFiles } from './jobManager.js';
import { getLibrary, linkLibraryJob, setLibrary } from './libraryStore.js';
import { individualSongsId } from './library.js';
import { isSongFile } from './transcription.js';

const maxUploadBytes = 2 * 1024 ** 3;
const maxExpandedBytes = 4 * 1024 ** 3;
const maxAudioBytes = 512 * 1024 ** 2;
const maxXmlBytes = 20 * 1024 ** 2;
const activeImports = new Set();
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const libraryJobs = (user) => getJobs().filter((job) => job.initiatedBy?.id === user.id
  || job.contributors?.some((contributor) => contributor.id === user.id));

const upload = multer({
  storage: {
    _handleFile(req, file, callback) {
      const filePath = path.join(req.importDirectory, randomUUID());
      let size = 0;
      const limit = file.fieldname === 'xml' ? maxXmlBytes : file.fieldname === 'media' ? maxUploadBytes : maxAudioBytes;
      const counter = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        req.importBytes += chunk.length;
        done(size > limit || req.importBytes > maxUploadBytes ? failure('Import upload exceeds the size limit', 413) : null, chunk);
      } });
      pipeline(file.stream, counter, createWriteStream(filePath, { flags: 'wx' }))
        .then(() => callback(null, { path: filePath, size }), callback);
    },
    _removeFile(_req, file, callback) { fs.rm(file.path, { force: true }).then(() => callback(null), callback); }
  },
  limits: { files: 1000, fields: 4, parts: 1004, fieldSize: 1024, fileSize: maxUploadBytes }
}).fields([{ name: 'files', maxCount: 1000 }, { name: 'xml', maxCount: 1 }, { name: 'media', maxCount: 1 }]);

export async function validateImportAudio(file) {
  const extension = path.extname(file.name).toLowerCase();
  if (!isSongFile(file.name)) throw failure(`Unsupported audio file: ${file.name}`);
  const type = await fileTypeFromFile(file.path).catch(() => null);
  const expected = { '.m4a': ['m4a', 'mp4'], '.wma': ['asf'], '.opus': ['opus', 'ogg'] }[extension] || [extension.slice(1)];
  if (!type || !expected.includes(type.ext)) throw failure(`Invalid or mismatched audio: ${file.name}`);
  const { size } = await fs.stat(file.path);
  if (!size || size > maxAudioBytes) throw failure(`Audio file exceeds the 512 MB limit: ${file.name}`, 413);
  return { ...file, size };
}

export async function extractImportMedia(zipPath, directory) {
  const archive = await new Promise((resolve, reject) => yauzl.open(zipPath,
    { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(failure('Invalid media ZIP')) : resolve(zip)));
  return new Promise((resolve, reject) => {
    const files = [];
    let count = 0;
    let total = 0;
    const fail = (error) => { archive.close(); reject(error.statusCode ? error : failure('Invalid or damaged media ZIP')); };
    archive.on('error', fail);
    archive.on('end', () => resolve(files));
    archive.on('entry', (entry) => {
      void (async () => {
        if (++count > 10000) throw failure('The ZIP contains too many entries', 413);
        if (entry.fileName.length > 2048 || entry.fileName.split('/').length > 32
          || entry.fileName.split('/').some((part) => part === '..') || /^[\\/]|^[a-z]:/i.test(entry.fileName)
          || /[\\\x00]/.test(entry.fileName) || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          || entry.isEncrypted()) throw failure('The ZIP contains an unsafe or encrypted entry');
        if (!entry.fileName.endsWith('/') && !entry.fileName.startsWith('__MACOSX/') && isSongFile(entry.fileName)) {
          total += entry.uncompressedSize;
          if (files.length >= 2000 || entry.uncompressedSize > maxAudioBytes || total > maxExpandedBytes) {
            throw failure('The media ZIP exceeds the import limits', 413);
          }
          const filePath = path.join(directory, randomUUID());
          const stream = await new Promise((done, failStream) => archive.openReadStream(entry, (error, value) => error ? failStream(error) : done(value)));
          await pipeline(stream, createWriteStream(filePath, { flags: 'wx' }));
          files.push(await validateImportAudio({ name: entry.fileName, path: filePath }));
        }
        archive.readEntry();
      })().catch(fail);
    });
    archive.readEntry();
  });
}

export function parseItunesImport(xml, media) {
  if (Buffer.byteLength(xml) > maxXmlBytes) throw failure('The XML exceeds the 20 MB limit', 413);
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(xml)) throw failure('XML entity declarations are not supported');
  let library;
  try { library = plist.parse(xml); } catch { throw failure('Invalid iTunes library XML'); }
  if (!library?.Tracks || typeof library.Tracks !== 'object' || Array.isArray(library.Tracks)
    || (library.Playlists !== undefined && !Array.isArray(library.Playlists))) throw failure('Select an iTunes library XML export');
  const suffixes = new Map();
  for (const file of media) {
    const parts = file.name.normalize('NFC').toLowerCase().split('/');
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('/');
      suffixes.set(suffix, suffixes.has(suffix) ? null : file);
    }
  }
  const tracks = new Map();
  for (const [key, track] of Object.entries(library.Tracks)) {
    if (track?.['Track Type'] === 'URL') continue;
    if (tracks.size >= 2000) throw failure('The library contains too many tracks', 413);
    let location;
    try {
      if (typeof track.Location !== 'string' || track.Location.length > 4096) throw new Error();
      const url = new URL(track.Location);
      if (url.protocol !== 'file:') throw new Error();
      location = decodeURIComponent(url.pathname).replaceAll('\\', '/').normalize('NFC').toLowerCase();
    } catch { throw failure(`Missing local media location for track ${key}`); }
    const parts = location.split('/').filter(Boolean);
    let match;
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('/');
      if (suffixes.has(suffix)) {
        match = suffixes.get(suffix);
        break;
      }
    }
    if (!match) throw failure(`Missing or ambiguous media for ${track.Name || key}`);
    const id = String(track['Track ID'] ?? key);
    if (tracks.has(id)) throw failure('Duplicate iTunes track ID');
    tracks.set(id, { ...match, name: path.posix.basename(match.name) });
  }
  if (!tracks.size) throw failure('No local audio tracks found in the iTunes library');
  const playlists = [];
  const included = new Set();
  for (const playlist of library.Playlists || []) {
    if (playlist?.Folder || playlist?.Master || playlist?.Distinguished) continue;
    if (!Array.isArray(playlist?.['Playlist Items'])) continue;
    const ids = [...new Set(playlist['Playlist Items'].map((item) => String(item?.['Track ID'])))].filter((id) => tracks.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => included.add(id));
    playlists.push({ playlistTitle: String(playlist.Name || 'Imported playlist').slice(0, 200), files: ids.map((id) => tracks.get(id)) });
  }
  const remaining = [...tracks].filter(([id]) => !included.has(id)).map(([, file]) => file);
  if (remaining.length) playlists.push({ playlistTitle: 'iTunes Library', files: remaining });
  if (playlists.length > 500 || playlists.reduce((total, playlist) => total + playlist.files.reduce((size, file) => size + file.size, 0), 0) > maxExpandedBytes) {
    throw failure('The imported playlists exceed the import limits', 413);
  }
  return playlists;
}

export async function importUploadedFiles(files, options, user) {
  const jobs = libraryJobs(user);
  const library = getLibrary(user.id, jobs);
  if (options.createNew !== 'true' && options.createNew !== 'false') throw failure('Choose an existing or new playlist');
  const createNew = options.createNew === 'true';
  if (!createNew && !library.entries.some((entry) => entry.id === options.playlistId && entry.type === 'playlist')) {
    throw failure('Select one of your existing playlists');
  }
  if (createNew && library.entries.length >= 5000) throw failure('The library contains too many entries', 413);
  if (!files.length) throw failure('Select audio files to import');
  const validated = [];
  for (const file of files) validated.push(await validateImportAudio(file));
  const individual = !createNew && options.playlistId === individualSongsId;
  const job = await importJobFiles({ files: validated, playlistId: createNew || individual ? undefined : options.playlistId,
    playlistTitle: individual ? 'Imported songs' : options.playlistTitle, individual }, user);
  if (individual) {
    try { linkLibraryJob(user.id, job, libraryJobs(user)); }
    catch (error) { await deleteJob(job.id, user); throw error; }
  }
  return { jobs: [job], importedFiles: files.length };
}

export async function importItunesLibrary(xml, media, user) {
  const plans = parseItunesImport(xml, media);
  if (getLibrary(user.id, libraryJobs(user)).entries.length + plans.length > 5000) throw failure('The library contains too many entries', 413);
  const created = [];
  try {
    for (const plan of plans) created.push(await importJobFiles({ ...plan, source: 'itunes' }, user));
    const jobs = libraryJobs(user);
    const library = getLibrary(user.id, jobs);
    for (const job of created) library.songOrder[job.id] = job.files;
    setLibrary(user.id, library, jobs);
    return { jobs: created, importedFiles: created.reduce((total, job) => total + job.files.length, 0) };
  } catch (error) {
    for (const job of created) await deleteJob(job.id, user);
    throw error;
  }
}

export async function handleLibraryImport(req, res) {
  if (activeImports.has(req.user.id) || activeImports.size >= 2) return res.status(409).json({ error: 'Another import is in progress. Try again shortly.' });
  activeImports.add(req.user.id);
  let result;
  let status = 201;
  try {
    req.importDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-import-'));
    req.importBytes = 0;
    await new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));
    if (req.body?.mode === 'files' && !req.files?.xml && !req.files?.media) {
      const files = (req.files?.files || []).map((file) => {
        const bytes = Buffer.from(file.originalname, 'latin1');
        const name = /^[\x00-\xff]*$/.test(file.originalname) && isUtf8(bytes) ? bytes.toString('utf8') : file.originalname;
        return { name, path: file.path };
      });
      result = await importUploadedFiles(files, req.body, req.user);
    } else if (req.body?.mode === 'itunes' && req.files?.xml?.length === 1 && req.files?.media?.length === 1 && !req.files?.files) {
      const xml = await fs.readFile(req.files.xml[0].path, 'utf8');
      const media = await extractImportMedia(req.files.media[0].path, req.importDirectory);
      result = await importItunesLibrary(xml, media, req.user);
    } else throw failure('Choose files, or upload both an iTunes XML and a media ZIP');
  } catch (error) {
    status = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : error.statusCode || 500;
    result = { error: status === 500 ? 'Unable to import music' : error.message };
  } finally {
    if (req.importDirectory) await fs.rm(req.importDirectory, { recursive: true, force: true }).catch(() => {});
    activeImports.delete(req.user.id);
  }
  if (!res.destroyed) res.status(status).json(result);
}