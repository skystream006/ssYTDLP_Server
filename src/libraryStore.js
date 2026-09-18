import { openDatabase } from './database.js';
import { getPlaylistTracks, individualSongsId, reconcileLibrary, songKey, themes } from './library.js';
import { isPlayableFile } from './media.js';

function invalid(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export function getPreferences(userId) {
  const row = openDatabase().prepare('SELECT theme, theme_mode FROM user_preferences WHERE user_id = ?').get(userId);
  const theme = row?.theme || 'light';
  return { theme, mode: row?.theme_mode || (['black', 'midnight'].includes(theme) ? 'dark' : 'light') };
}

export function setTheme(userId, theme, mode) {
  const current = getPreferences(userId);
  if (theme === undefined) theme = current.theme;
  if (mode === undefined) mode = current.mode;
  if (!themes.some((option) => option.id === theme)) invalid('Unknown theme');
  if (!['light', 'dark'].includes(mode)) invalid('Unknown theme mode');
  openDatabase().prepare(`INSERT INTO user_preferences (user_id, theme, theme_mode) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, theme_mode = excluded.theme_mode`).run(userId, theme, mode);
  return { theme, mode };
}

export function getLibrary(userId, jobs) {
  const row = openDatabase().prepare('SELECT library, library_version FROM user_preferences WHERE user_id = ?').get(userId);
  const library = row ? JSON.parse(row.library) : { entries: [], songOrder: {} };
  return { version: row?.library_version || 0, ...reconcileLibrary(library, jobs) };
}

function validateLibrary(value, jobs, current) {
  if (!value || !Number.isSafeInteger(value.version) || value.version < 0
    || !Array.isArray(value.entries) || value.entries.length > 5000
    || !value.songOrder || typeof value.songOrder !== 'object' || Array.isArray(value.songOrder)) {
    invalid('Invalid music library');
  }
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const entryMap = new Map();
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || entryMap.has(entry.id)
      || !['folder', 'playlist'].includes(entry.type)
      || !(entry.parentId === null || typeof entry.parentId === 'string')) invalid('Invalid or duplicate library entry');
    const result = { id: entry.id, type: entry.type, parentId: entry.parentId };
    if (entry.type === 'folder') {
      if (!/^folder-[A-Za-z0-9_-]{1,100}$/.test(entry.id) || jobMap.has(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 120) invalid('Invalid folder');
      result.name = entry.name.trim();
    } else if (entry.id === individualSongsId) {
      if (!current.singleJobIds.length) invalid('Individual Songs is created when a song is linked');
      result.name = 'Individual Songs';
      result.protected = true;
    } else if (!jobMap.has(entry.id)) invalid('Playlist is no longer available');
    entryMap.set(entry.id, result);
    return result;
  });
  for (const entry of entries) {
    const visited = new Set([entry.id]);
    let parentId = entry.parentId;
    while (parentId !== null) {
      const parent = entryMap.get(parentId);
      if (visited.has(parentId) || parent?.type !== 'folder') invalid('Folders must form a tree without cycles');
      visited.add(parentId);
      if (visited.size > 32) invalid('Folders can be nested up to 32 levels');
      parentId = parent.parentId;
    }
  }
  const songOrder = Object.fromEntries(Object.entries(value.songOrder).map(([jobId, names]) => {
    const job = jobMap.get(jobId);
    const files = new Set(job?.files || []);
    if (!job || !Array.isArray(names) || new Set(names).size !== names.length
      || names.some((name) => typeof name !== 'string' || !isPlayableFile(name) || !files.has(name))) invalid('Invalid song order');
    return [jobId, names];
  }));
  const playlistIds = new Set(entries.filter((entry) => entry.type === 'playlist').map((entry) => entry.id));
  if (current.singleJobIds.length) playlistIds.add(individualSongsId);
  for (const id of current.singleJobIds) playlistIds.delete(id);
  const moves = value.songMoves === undefined ? current.songMoves : value.songMoves;
  if (!Array.isArray(moves)) invalid('Invalid song placements');
  const movedKeys = new Set();
  const songMoves = moves.map((track) => {
    const key = track && songKey(track);
    const job = jobMap.get(track?.jobId);
    if (!job || typeof track.name !== 'string' || !isPlayableFile(track.name) || !job.files?.includes(track.name)
      || !playlistIds.has(track.playlistId) || movedKeys.has(key)) invalid('Songs can only be moved to available playlists');
    movedKeys.add(key);
    return { jobId: track.jobId, name: track.name, playlistId: track.playlistId };
  });
  const library = reconcileLibrary({ entries, songOrder, singleJobIds: current.singleJobIds, songMoves }, jobs);
  const orders = value.playlistSongOrder === undefined ? current.playlistSongOrder : value.playlistSongOrder;
  if (!orders || typeof orders !== 'object' || Array.isArray(orders)) invalid('Invalid playlist song order');
  const playlistTracks = getPlaylistTracks(library, jobs);
  library.playlistSongOrder = Object.fromEntries(Object.entries(orders).map(([id, keys]) => {
    const allowed = new Set((playlistTracks.get(id) || []).filter((track) => isPlayableFile(track.name)).map(songKey));
    if (!playlistIds.has(id) || !Array.isArray(keys) || new Set(keys).size !== keys.length
      || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) invalid('Invalid playlist song order');
    return [id, keys];
  }));
  return library;
}

function writeLibrary(userId, library, version) {
  openDatabase().prepare(`INSERT INTO user_preferences (user_id, library, library_version) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET library = excluded.library, library_version = excluded.library_version`)
    .run(userId, JSON.stringify(library), version);
}

export function linkLibraryJob(userId, job, jobs) {
  const database = openDatabase();
  return database.transaction(() => {
    const { version, ...current } = getLibrary(userId, jobs);
    if (job.isPlaylist === false && !current.singleJobIds.includes(job.id)) {
      current.singleJobIds.push(job.id);
      writeLibrary(userId, reconcileLibrary(current, jobs), version + 1);
    }
    return getLibrary(userId, jobs);
  }).immediate();
}

export function setLibrary(userId, value, jobs) {
  const database = openDatabase();
  return database.transaction(() => {
    const current = getLibrary(userId, jobs);
    const library = validateLibrary(value, jobs, current);
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    writeLibrary(userId, library, current.version + 1);
    return getLibrary(userId, jobs);
  }).immediate();
}

export function moveLibrarySong(userId, value, jobs) {
  const database = openDatabase();
  return database.transaction(() => {
    const current = getLibrary(userId, jobs);
    if (!value || !Number.isSafeInteger(value.version)) invalid('Invalid library version');
    if (current.version !== value.version) invalid('Your library changed in another tab. Refresh and try again.', 409);
    if (!current.entries.some((entry) => entry.id === value.playlistId && entry.type === 'playlist')) {
      invalid('Songs can only be moved to available playlists');
    }
    const job = jobs.find((item) => item.id === value.jobId);
    if (!job || typeof value.name !== 'string' || !isPlayableFile(value.name) || !job.files?.includes(value.name)) invalid('Song is no longer available');
    const key = songKey(value);
    const source = [...getPlaylistTracks(current, jobs).values()].flat().find((track) => songKey(track) === key);
    if (source?.playlistId === value.playlistId) return current;
    const destination = getPlaylistTracks(current, jobs).get(value.playlistId).filter((track) => isPlayableFile(track.name)).map(songKey);
    const songMoves = [...current.songMoves.filter((track) => songKey(track) !== key), { jobId: value.jobId, name: value.name, playlistId: value.playlistId }];
    const playlistSongOrder = Object.fromEntries(Object.entries(current.playlistSongOrder).map(([id, order]) => [id, order.filter((item) => item !== key)]));
    playlistSongOrder[value.playlistId] = [...destination, key];
    return setLibrary(userId, { ...current, songMoves, playlistSongOrder }, jobs);
  }).immediate();
}