import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRightLeft, Check, ChevronDown, ChevronRight, Download, ExternalLink, Folder, FolderOpen, FolderPlus, GripVertical, Library, ListMusic, LockKeyhole, Music2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import MusicPlayer, { usePlayback } from './MusicPlayer.jsx';
import ImportMusic from './ImportMusic.jsx';
import { Upload } from 'lucide-react';
import { getPlaylistIds, songKey } from '../../src/library.js';
import { submitJobUrl } from './jobSubmission.js';
import { canManageJob, canModifyJob, MetadataDialog, TranscriptionDialog } from './SongActions.jsx';
import { allowDrop, leaveDrop } from './touchControls.js';
import { replaceURL } from './navigation.js';

export function ExportLibraryDialog({ onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const formatId = useId();
  const destinationId = useId();
  const instructionsId = useId();
  const destinationHelpId = useId();
  const downloadHelpId = useId();
  const [format, setFormat] = useState('itunes');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('select').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog export-library-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form action="/api/library/export" method="get" target="_blank" rel="noopener">
      <div className="folder-dialog-heading"><h2 id={headingId}>Export library</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close export library" onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={formatId}>Export format</label>
      <select id={formatId} name="format" value={format} aria-describedby={instructionsId} onChange={(event) => setFormat(event.target.value)}>
        <option value="itunes">iTunes XML</option>
        <option value="android">Android M3U8 (compatible players)</option>
      </select>
      <div id={instructionsId}>
        <p>Download a ZIP of your library. Song order within each playlist is retained.</p>
        <p hidden={format !== 'itunes'}>Extract the ZIP directly into the destination folder below, so <strong>Music/</strong> and <strong>Library.xml</strong> are at its root.
          Add the Music folder to your app library first, then use <strong>File &gt; Library &gt; Import Playlist</strong> to import Library.xml in iTunes or Music.</p>
        <p hidden={format !== 'android'}>Extract the whole ZIP and keep the root <strong>.m3u8</strong> playlists beside the <strong>Music/</strong> folder.
          Transfer that folder together to your Android device and open the playlists in a player supporting UTF-8 M3U8 with relative paths.
          This does not import into a universal Android system music database.</p>
      </div>
      <div hidden={format !== 'itunes'}>
        <label htmlFor={destinationId}>Absolute extraction folder on your computer</label>
        <input id={destinationId} name="destination" type="text" required={format === 'itunes'} disabled={format !== 'itunes'}
          pattern={String.raw`(?:[A-Za-z]:(?:\\|/)|/(?!/))[^\r\n]*`} aria-describedby={destinationHelpId}
          title="Enter an absolute local path, such as C:\Users\YourName\Music\Export or /Users/YourName/Music/Export. File URLs and network paths are not supported."
          placeholder={'C:\\Users\\YourName\\Music\\Export or /Users/YourName/Music/Export'} />
        <p id={destinationHelpId}>Enter the Windows drive path or macOS absolute path where you will extract the ZIP, not a server path or the Music subfolder.
          This is used to generate the correct file URLs in Library.xml; it does not select or create a folder.
          Do not use file URLs or UNC/network paths. If you move the extracted folder later, export again with the new destination.</p>
      </div>
      <p id={downloadHelpId}>Your browser downloads the ZIP directly. Export errors open in a separate tab; check that tab if no download starts.</p>
      <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" aria-describedby={downloadHelpId}><Download size={17} />Download ZIP</button></div>
    </form>
  </dialog>;
}

function AddPlaylistDialog({ user, request, confirm, onAdded, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const urlId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitJobUrl(url, { request, user, confirm, library: true });
      if (result) { await onAdded(result.job); onClose(); }
    } catch (submitError) { setError(submitError.message); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Add Playlist</h2><button className="music-icon-button" type="button" title="Close" aria-label="Close Add Playlist" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={urlId}>YouTube Music URL</label><input id={urlId} type="url" required autoFocus value={url} disabled={busy} placeholder="https://music.youtube.com/..." onChange={(event) => setUrl(event.target.value)} />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={busy || !url.trim()}>{busy ? <RefreshCw className="spin" size={17} /> : <Plus size={17} />}{busy ? 'Adding...' : 'Add Playlist'}</button></div>
    </form>
  </dialog>;
}

function MoveSongDialog({ track, playlists, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const destinationId = useId();
  const [destination, setDestination] = useState(playlists[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('select').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || !destination) return;
      setBusy(true);
      const result = await onSave(track, destination);
      if (result === true) onClose(); else setError(result || 'Unable to move song.');
      setBusy(false);
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Move song</h2><button className="music-icon-button" type="button" title="Close" aria-label="Close move song" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <p>{track.name}</p>
      <label htmlFor={destinationId}>Destination playlist</label><select id={destinationId} required value={destination} disabled={busy || !playlists.length} onChange={(event) => setDestination(event.target.value)}>
        {!playlists.length && <option value="">No other playlists</option>}
        {playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title}</option>)}
      </select>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={busy || !destination}>{busy ? <RefreshCw className="spin" size={17} /> : <ArrowRightLeft size={17} />}Move song</button></div>
    </form>
  </dialog>;
}

function RenamePlaylistDialog({ playlist, saving, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const nameId = useId();
  const [name, setName] = useState(playlist.playlistTitle || '');
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input').select();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (saving || !name.trim()) return;
      setError('');
      const result = await onSave(playlist.id, name.trim());
      if (result === true) onClose(); else setError(result || 'Unable to rename playlist.');
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Rename playlist</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close rename playlist" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={nameId}>Playlist name</label><input id={nameId} autoFocus required maxLength={200} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{saving ? 'Saving...' : 'Save name'}</button></div>
    </form>
  </dialog>;
}

function FolderDialog({ folder, parentId, folders, saving, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const nameId = useId();
  const parentInputId = useId();
  const [name, setName] = useState(folder?.name || '');
  const [location, setLocation] = useState(parentId || '');
  const [error, setError] = useState('');

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      const result = await onSave({ name: name.trim(), parentId: location || null });
      if (result === true) onClose();
      else setError(result || 'Unable to save folder.');
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>{folder ? 'Edit folder' : 'New playlist folder'}</h2>
        <button type="button" className="music-icon-button" title="Close" aria-label="Close folder dialog" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={nameId}>Folder name</label><input id={nameId} autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
      <label htmlFor={parentInputId}>Location</label><select id={parentInputId} value={location} onChange={(event) => setLocation(event.target.value)}>
        <option value="">Library</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}
      </select>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}Save folder</button></div>
    </form>
  </dialog>;
}

export default function MusicLibrary({ user, request, confirm }) {
  const playback = usePlayback();
  const [editingMetadata, setEditingMetadata] = useState(null);
  const [library, setLibrary] = useState(null);
  const [selectedId, setSelectedId] = useState(new URLSearchParams(window.location.search).get('playlist'));
  const [trackResult, setTrackResult] = useState(null);
  const [trackPage, setTrackPage] = useState(1);
  const [trackSearch, setTrackSearch] = useState('');
  const [debouncedTrackSearch, setDebouncedTrackSearch] = useState('');
  const [tracksLoading, setTracksLoading] = useState(true);
  const [error, setError] = useState('');
  const [trackError, setTrackError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [folderDialog, setFolderDialog] = useState(null);
  const [renamingPlaylist, setRenamingPlaylist] = useState(null);
  const [addingPlaylist, setAddingPlaylist] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingLibrary, setExportingLibrary] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [movingSong, setMovingSong] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [transcribingFile, setTranscribingFile] = useState(null);
  const [pendingTranscriptions, setPendingTranscriptions] = useState({});
  const [deletingFiles, setDeletingFiles] = useState({});
  const [actionError, setActionError] = useState('');
  const [transcriptionNotice, setTranscriptionNotice] = useState('');
  const [removedSong, setRemovedSong] = useState(null);
  const songMutations = useRef(new Set());
  const savingRef = useRef(false);
  const mutationRef = useRef(0);
  const entries = library?.entries || [];
  const jobs = library?.playlists || library?.jobs || [];
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const sourceJobMap = new Map((library?.jobs || []).map((job) => [job.id, job]));
  const selected = entryMap.get(selectedId);
  const selectedJob = sourceJobMap.get(selectedId);
  const title = selected?.type === 'folder' ? selected.name : selectedId ? jobMap.get(selectedId)?.playlistTitle || 'Preparing playlist' : 'All music';
  const allMusic = selectedId === null;
  const searchPending = allMusic && trackSearch !== debouncedTrackSearch;
  const tracks = trackResult?.selectedId === selectedId && (!allMusic
    || (trackResult.page === trackPage && trackResult.search === debouncedTrackSearch)) ? trackResult.files : null;
  const pagination = allMusic ? {
    page: trackPage, pageSize: 50, total: trackResult?.selectedId === null ? trackResult.total : 0,
    totalPages: trackResult?.selectedId === null ? trackResult.totalPages : 1,
    loading: tracksLoading || searchPending, onChange: setTrackPage
  } : null;
  const jobsRevision = JSON.stringify((library?.jobs || []).map((job) => [job.id, job.updatedAt, job.songCount]));

  useEffect(() => {
    if (trackSearch === debouncedTrackSearch) return;
    const timer = window.setTimeout(() => {
      setDebouncedTrackSearch(trackSearch);
      setTrackPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [trackSearch, debouncedTrackSearch]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const mutation = mutationRef.current;
      try {
        const result = await request('/api/library');
        if (active && !savingRef.current && mutation === mutationRef.current) {
          setLibrary((current) => current && current.version > result.version ? current : result);
          setError('');
        }
      } catch (loadError) { if (active) setError(loadError.message); }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, refresh]);

  useEffect(() => {
    if (!library) return;
    if (selectedId && !library.entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null);
      setTrackPage(1);
      return;
    }
    if (searchPending) return;
    let active = true;
    const controller = new AbortController();
    setTracksLoading(true);
    setTrackError('');
    const query = new URLSearchParams(selectedId ? { entryId: selectedId } : { page: trackPage, pageSize: 50, search: debouncedTrackSearch });
    request(`/api/library/tracks?${query}`, { signal: controller.signal }).then((result) => {
      if (active) {
        setTrackResult({ ...result, selectedId, search: debouncedTrackSearch });
        if (selectedId === null && result.page !== trackPage) setTrackPage(result.page);
      }
    }).catch((loadError) => { if (active) setTrackError(loadError.message); })
      .finally(() => { if (active) setTracksLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [request, selectedId, library?.version, jobsRevision, refresh, trackPage, debouncedTrackSearch, searchPending]);

  function selectEntry(id) {
    setSelectedId(id);
    setTrackPage(1);
    setSidebarOpen(false);
    const params = id ? `?${new URLSearchParams({ playlist: id })}` : '';
    replaceURL(`/${params}`);
  }

  function songState(track) {
    const job = sourceJobMap.get(track.jobId);
    const key = songKey(track);
    const transcription = pendingTranscriptions[key] || job?.transcriptions?.[track.name];
    const canModify = canModifyJob(user, job);
    return { canModify, transcription, deleting: Boolean(deletingFiles[key]),
      metadataBusy: Object.values(job?.transcriptions || {}).some((item) => item.status === 'sent')
        || [...songMutations.current].some((item) => JSON.parse(item)[0] === track.jobId),
      disabled: !canModify || ['queued', 'running'].includes(job?.status)
        || songMutations.current.has(key) || transcription?.status === 'sent' };
  }

  async function transcribe(track, options) {
    setTranscribingFile(null);
    if (songState(track).disabled) { setActionError('This song cannot be changed right now. Refresh and try again.'); return; }
    const key = songKey(track);
    songMutations.current.add(key);
    setPendingTranscriptions((current) => ({ ...current, [key]: { status: 'sent', requestedAt: new Date().toISOString() } }));
    setTranscriptionNotice('');
    setActionError('');
    try {
      await request(`/api/jobs/${encodeURIComponent(track.jobId)}/files/${encodeURIComponent(track.name)}/transcribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options)
      });
      setTranscriptionNotice(`Transcription complete: ${track.name}`);
    } catch (requestError) {
      setActionError(`Transcription request for ${track.name}: ${requestError.message}`);
    } finally {
      songMutations.current.delete(key);
      setPendingTranscriptions((current) => {
        const remaining = { ...current }; delete remaining[key]; return remaining;
      });
      setRefresh((value) => value + 1);
    }
  }

  async function removeSong(track) {
    if (songState(track).disabled) return;
    const key = songKey(track);
    songMutations.current.add(key);
    try {
      if (!await confirm({ title: 'Delete song?', message: `Permanently delete ${track.name} from its source job and all libraries?`, action: 'delete', label: 'Delete song' })) return;
      setDeletingFiles((current) => ({ ...current, [key]: true }));
      setActionError('');
      await request(`/api/jobs/${encodeURIComponent(track.jobId)}/files/${encodeURIComponent(track.name)}`, { method: 'DELETE' });
      setRemovedSong({ key });
      setTrackResult((current) => current ? { ...current, files: current.files.filter((file) => songKey(file) !== key) } : current);
    } catch (requestError) { setActionError(requestError.message); }
    finally {
      songMutations.current.delete(key);
      setDeletingFiles((current) => { const remaining = { ...current }; delete remaining[key]; return remaining; });
      setRefresh((value) => value + 1);
    }
  }

  async function persistLibrary(endpoint, method, body) {
    if (savingRef.current || !library) return 'A library change is already being saved.';
    savingRef.current = true;
    mutationRef.current += 1;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const result = await request(endpoint, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      setLibrary((current) => ({ ...current, ...result }));
      setSaved(true);
      setRefresh((value) => value + 1);
      return true;
    } catch (saveError) {
      setError(saveError.message);
      await request('/api/library').then(setLibrary).catch(() => {});
      return saveError.message;
    } finally { savingRef.current = false; setSaving(false); }
  }

  function saveEntry(changes) {
    return persistLibrary('/api/library/entries', 'POST', {
      version: library.version, ...changes
    });
  }

  async function renamePlaylist(id, playlistTitle) {
    if (savingRef.current) return 'A library change is already being saved.';
    savingRef.current = true;
    mutationRef.current += 1;
    setSaving(true);
    setSaved(false);
    try {
      const result = await request(`/api/jobs/${encodeURIComponent(id)}/title`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlistTitle })
      });
      const updateTitle = (items) => items?.map((item) => item.id === id
        ? { ...item, playlistTitle: result.playlistTitle, updatedAt: result.updatedAt } : item);
      setLibrary((current) => ({ ...current, jobs: updateTitle(current.jobs), playlists: updateTitle(current.playlists) }));
      setTrackResult((current) => current ? { ...current, files: current.files.map((track) => track.playlistId === id
        ? { ...track, playlistTitle: result.playlistTitle } : track) } : current);
      setSaved(true);
      return true;
    } catch (saveError) {
      return saveError.message;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setRefresh((value) => value + 1);
    }
  }

  async function playlistAdded(job) {
    mutationRef.current += 1;
    const result = await request('/api/library/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id })
    });
    const updated = await request('/api/library');
    setLibrary(updated);
    setSearch('');
    setCollapsed(new Set());
    selectEntry(result.selectedId);
    setRefresh((value) => value + 1);
  }

  function moveSong(track, playlistId) {
    if (!playlistId) { setMovingSong(track); return; }
    return persistLibrary('/api/library/songs/move', 'POST', {
      version: library.version, jobId: track.jobId, name: track.name, sourcePlaylistId: track.playlistId, playlistId
    });
  }

  function insideFolder(id, folderId) {
    let entry = entryMap.get(id);
    while (entry) {
      if (entry.id === folderId) return true;
      entry = entryMap.get(entry.parentId);
    }
    return false;
  }

  function folderPath(folder) {
    const names = [folder.name];
    let parent = entryMap.get(folder.parentId);
    while (parent) { names.unshift(parent.name); parent = entryMap.get(parent.parentId); }
    return names.join(' / ');
  }

  const folders = entries.filter((entry) => entry.type === 'folder').map((folder) => ({ ...folder, path: folderPath(folder) }));
  const possibleFolders = (id) => folders.filter((folder) => !insideFolder(folder.id, id));

  function moveEntry(id, parentId, targetId = null, after = false) {
    const entry = entryMap.get(id);
    if (savingRef.current || !entry || id === targetId || (entry.type === 'folder' && insideFolder(parentId, id))) return;
    if (parentId) setCollapsed((current) => { const updated = new Set(current); updated.delete(parentId); return updated; });
    void saveEntry({ action: 'move', id, parentId, targetId, after });
  }

  function reorderEntry(direction, id = selectedId) {
    const entry = entryMap.get(id);
    if (!entry || savingRef.current) return;
    const siblings = entries.filter((item) => item.parentId === entry.parentId);
    const index = siblings.findIndex((item) => item.id === entry.id);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    moveEntry(entry.id, entry.parentId, neighbor.id, direction > 0);
  }

  async function saveFolder(changes) {
    const folder = folderDialog.folder;
    const id = folder?.id || `folder-${crypto.randomUUID()}`;
    const result = await saveEntry({ action: folder ? 'update-folder' : 'create-folder', id,
      name: changes.name, parentId: changes.parentId });
    if (result === true) {
      setCollapsed(new Set());
      selectEntry(id);
    }
    return result;
  }

  async function removeFolder() {
    if (!selected || selected.type !== 'folder' || saving) return;
    if (!await confirm({ title: 'Delete folder?', message: `Delete "${selected.name}"? Its playlists and subfolders will move to ${selected.parentId ? entryMap.get(selected.parentId).name : 'your library'}. No music files will be deleted.`, action: 'delete', label: 'Delete folder' })) return;
    if (await saveEntry({ action: 'delete-folder', id: selected.id }) === true) selectEntry(selected.parentId);
  }

  function reorderSong(track, target) {
    if (!tracks || tracksLoading || allMusic || savingRef.current) return;
    const playlistTracks = tracks.filter((item) => item.playlistId === track.playlistId);
    const names = playlistTracks.map(songKey);
    const from = names.indexOf(songKey(track));
    const destination = typeof target === 'number' ? from + target : names.indexOf(target);
    if (from < 0 || destination < 0 || destination >= names.length || from === destination) return;
    void persistLibrary('/api/library/songs/reorder', 'POST', {
      version: library.version, playlistId: track.playlistId, jobId: track.jobId, name: track.name,
      target: names[destination], after: from < destination
    });
  }

  function entryTitle(entry) { return entry.type === 'folder' ? entry.name : jobMap.get(entry.id)?.playlistTitle || 'Preparing playlist'; }
  function matches(entry) {
    return entryTitle(entry).toLowerCase().includes(search.toLowerCase())
      || entries.some((child) => child.parentId === entry.id && matches(child));
  }

  function renderEntries(parentId = null, depth = 0) {
    const siblings = entries.filter((entry) => entry.parentId === parentId);
    return <ul className="library-tree">{siblings.filter((entry) => reordering || !search || matches(entry)).map((entry) => {
      const folder = entry.type === 'folder';
      const playlist = jobMap.get(entry.id);
      const open = !collapsed.has(entry.id) || Boolean(search);
      const count = folder ? getPlaylistIds(entries, entry.id).length : jobMap.get(entry.id)?.songCount || 0;
      const dropPosition = (event) => {
        if (event.dataTransfer.types.includes('application/x-ssmusic-song')) return 'inside';
        const bounds = event.currentTarget.getBoundingClientRect();
        const offset = (event.clientY - bounds.top) / bounds.height;
        if (folder && !reordering && offset >= .25 && offset <= .75) return 'inside';
        return offset < .5 ? 'before' : 'after';
      };
      const acceptEntry = (event) => {
        const allowed = !saving && (event.dataTransfer.types.includes('application/x-ssmusic-entry')
          || (!folder && event.dataTransfer.types.includes('application/x-ssmusic-song')));
        allowDrop(event, allowed);
        if (allowed) event.currentTarget.dataset.dropPosition = dropPosition(event);
      };
      return <li key={entry.id}>
        <div className={`library-entry ${selectedId === entry.id ? 'is-selected' : ''}`} style={{ paddingLeft: 8 + Math.min(depth, 4) * 12 }}
          draggable={!saving} onDragStart={(event) => { event.currentTarget.dataset.dragging = 'true'; event.dataTransfer.setData('application/x-ssmusic-entry', entry.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnter={acceptEntry} onDragOver={acceptEntry} onDragLeave={leaveDrop}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (saving) return;
            const songData = event.dataTransfer.getData('application/x-ssmusic-song');
            if (songData) {
              if (!folder) { try { void moveSong(JSON.parse(songData), entry.id); } catch {} }
              return;
            }
            const movedId = event.dataTransfer.getData('application/x-ssmusic-entry');
            const position = dropPosition(event);
            if (movedId !== entry.id) moveEntry(movedId, position === 'inside' ? entry.id : entry.parentId,
              position === 'inside' ? null : entry.id, position === 'after');
          }}>
          {folder ? <button className="folder-expander" type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} aria-expanded={open} title={open ? 'Collapse folder' : 'Expand folder'} onClick={() => setCollapsed((current) => {
            const updated = new Set(current); if (updated.has(entry.id)) updated.delete(entry.id); else updated.add(entry.id); return updated;
          })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="folder-expander" />}
          <button className="library-entry-select" type="button" aria-current={selectedId === entry.id ? 'true' : undefined} title={entryTitle(entry)} onClick={() => { if (!reordering) selectEntry(entry.id); }}>
            {folder ? open ? <FolderOpen size={18} /> : <Folder size={18} /> : <ListMusic size={18} />}<span>{entryTitle(entry)}</span>{entry.protected && <LockKeyhole size={12} aria-label="Permanent playlist" />}<small>{count}</small>
          </button>
          {!reordering && !folder && !entry.protected && canManageJob(user, playlist) && <button
            className="music-icon-button library-entry-rename" type="button" title={`Rename ${entryTitle(entry)}`} aria-label={`Rename playlist ${entryTitle(entry)}`}
            disabled={saving || ['queued', 'running'].includes(playlist.status)} onClick={() => setRenamingPlaylist(playlist)}><Pencil size={16} /></button>}
          {reordering && <button className="music-icon-button library-entry-drag" type="button" title={`Drag to reorder ${entryTitle(entry)}`}
            aria-label={`Reorder ${entryTitle(entry)}`} aria-keyshortcuts="ArrowUp ArrowDown" draggable={!saving} disabled={saving}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                reorderEntry(event.key === 'ArrowUp' ? -1 : 1, entry.id);
              }
            }}><GripVertical size={18} /></button>}
        </div>
        {folder && open && renderEntries(entry.id, depth + 1)}
      </li>;
    })}</ul>;
  }

  const sidebar = <aside className="library-sidebar" aria-label="Playlists">
    <div className="library-sidebar-heading"><h2>Playlists <small>{jobs.length}</small></h2>
      <div className="library-sidebar-tools"><button className="music-icon-button" type="button" title="Reorder playlists" aria-label="Reorder playlists" aria-pressed={reordering}
        disabled={!library || saving} onClick={() => setReordering((current) => !current)}><GripVertical size={19} /></button>
      <button className="music-icon-button" type="button" title="New playlist folder" aria-label="New playlist folder" disabled={!library || saving}
        onClick={() => setFolderDialog({ folder: null, parentId: selected?.type === 'folder' ? selected.id : selected?.parentId || null })}><FolderPlus size={19} /></button></div></div>
    <label className="queue-search"><Search size={15} /><input type="search" aria-label="Search playlists" placeholder="Find a playlist" value={search} disabled={reordering} onChange={(event) => setSearch(event.target.value)} /></label>
    <button className={`all-music ${selectedId === null ? 'is-selected' : ''}`} type="button" aria-current={selectedId === null ? 'true' : undefined} onClick={() => selectEntry(null)}><Library size={18} /><span>All music</span><small>{jobs.reduce((total, job) => total + job.songCount, 0)}</small></button>
    <div className="library-tree-scroll">{!library && !error ? <p className="music-empty" role="status">Loading playlists...</p> : renderEntries()}
      {library && !entries.length && <p className="music-empty">No playlists yet.</p>}
      {!reordering && search && !entries.some(matches) && <p className="music-empty">No matching playlists.</p>}</div>
    {selected && <div className="library-organize">
      <div className="library-organize-heading"><strong title={title}>{title}</strong><div>
        {selected.type === 'folder' ? <>
          <button className="music-icon-button" type="button" title="Edit folder" aria-label="Edit folder" disabled={saving} onClick={() => setFolderDialog({ folder: selected, parentId: selected.parentId })}><Pencil size={16} /></button>
          <button className="music-icon-button" type="button" title="Delete folder" aria-label="Delete folder" disabled={saving} onClick={removeFolder}><Trash2 size={16} /></button>
        </> : !selected.protected && <>
          {canManageJob(user, selectedJob) && <button className="music-icon-button" type="button" title="Rename playlist" aria-label="Rename playlist"
            disabled={saving || ['queued', 'running'].includes(selectedJob.status)} onClick={() => setRenamingPlaylist(selectedJob)}><Pencil size={16} /></button>}
          <a className="music-icon-button" href={`/job/${encodeURIComponent(selected.id)}`} title="Job details" aria-label="Open job details"><ExternalLink size={16} /></a>
        </>}
      </div></div>
      <label className="library-location">Location<select aria-label="Move selection to folder" value={selected.parentId || ''} disabled={saving}
        onChange={(event) => moveEntry(selected.id, event.target.value || null)}><option value="">Library</option>{possibleFolders(selected.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select></label>
    </div>}
  </aside>;

  return <div className={`music-home ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <header className="library-titlebar"><div><p className="eyebrow"><Music2 size={13} />Your music, collected</p><h1>{user.name}'s Music</h1></div>
      <div className="library-header-actions"><span className="library-save-status" role="status">{saving ? 'Saving...' : saved ? 'Saved' : `${jobs.length} playlists`}</span>
        <button className="music-icon-button" type="button" title="Refresh library" aria-label="Refresh library" disabled={saving} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={18} /></button>
        <button className="music-icon-button" type="button" title="Import media" aria-label="Import media" aria-haspopup="dialog" disabled={!library || saving} onClick={() => setImporting(true)}><Upload size={18} /></button>
        <button className="secondary-button compact-button library-export-button" type="button" title="Export library" aria-label="Export library" aria-haspopup="dialog" disabled={!library || saving} onClick={() => setExportingLibrary(true)}><Download size={17} />Export library</button>
        <button className="primary-button compact-button" type="button" title="Add Playlist" aria-label="Add Playlist" disabled={!library || saving} onClick={() => setAddingPlaylist(true)}><Plus size={17} />Add Playlist</button></div></header>
    {(error || trackError) && <div className="notice error library-notice" role="alert">{error || trackError}<button className="music-icon-button" type="button" title="Retry" aria-label="Retry loading library" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button></div>}
    {actionError && <div className="notice error library-notice" role="alert">{actionError}<button className="music-icon-button" type="button" title="Dismiss error" aria-label="Dismiss song error" onClick={() => setActionError('')}><X size={16} /></button></div>}
    {transcriptionNotice && <div className="notice success library-notice" role="status">{transcriptionNotice}<button className="music-icon-button" type="button" title="Dismiss" aria-label="Dismiss transcription notice" onClick={() => setTranscriptionNotice('')}><X size={16} /></button></div>}
    <div className="library-mobile-tabs" role="group" aria-label="Library view"><button type="button" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(true)}><Library size={16} />Playlists</button><button type="button" aria-pressed={!sidebarOpen} onClick={() => setSidebarOpen(false)}><Music2 size={16} />Songs</button></div>
    <MusicPlayer request={request} libraryView={{ sidebar, selectedId, title, type: selected?.type, tracks, loading: (tracksLoading || searchPending) && !trackError,
      pagination, error: trackError, queueScope: allMusic ? JSON.stringify(['all', trackPage, debouncedTrackSearch]) : selectedId,
      search: allMusic ? trackSearch : undefined, onSearch: allMusic ? setTrackSearch : undefined,
      songState, onTranscribe: setTranscribingFile, onDelete: removeSong, removedSong, onEditMetadata: setEditingMetadata,
      saving: saving || tracksLoading || searchPending, onReorder: reorderSong, onSelect: selectEntry, onMove: moveSong, onAdd: () => setAddingPlaylist(true) }} />
    {transcribingFile && <TranscriptionDialog file={transcribingFile} onClose={() => setTranscribingFile(null)} onSubmit={transcribe} />}
    {editingMetadata && <MetadataDialog file={editingMetadata} jobId={editingMetadata.jobId} request={request} onClose={() => setEditingMetadata(null)} onSaved={(result) => {
      playback.updateMetadata(editingMetadata.jobId, editingMetadata.name, result);
      setTrackResult((current) => current ? { ...current, files: current.files.map((track) => songKey(track) === songKey(editingMetadata)
        ? { ...track, title: result.title, artist: result.artist, album: result.album } : track) } : current);
      setRefresh((value) => value + 1);
    }} />}
    {folderDialog && <FolderDialog folder={folderDialog.folder} parentId={folderDialog.parentId} folders={possibleFolders(folderDialog.folder?.id)} saving={saving} onSave={saveFolder} onClose={() => setFolderDialog(null)} />}
    {renamingPlaylist && <RenamePlaylistDialog playlist={renamingPlaylist} saving={saving} onSave={renamePlaylist} onClose={() => setRenamingPlaylist(null)} />}
    {addingPlaylist && <AddPlaylistDialog user={user} request={request} confirm={confirm} onAdded={playlistAdded} onClose={() => setAddingPlaylist(false)} />}
    {importing && <ImportMusic request={request} initialPlaylistId={selected?.type === 'playlist' ? selectedId : ''} onClose={() => setImporting(false)} onImported={() => setRefresh((value) => value + 1)} />}
    {exportingLibrary && <ExportLibraryDialog onClose={() => setExportingLibrary(false)} />}
    {movingSong && <MoveSongDialog track={movingSong} playlists={entries.filter((entry) => entry.type === 'playlist' && entry.id !== movingSong.playlistId).map((entry) => ({
      id: entry.id, title: `${entry.parentId ? `${folderPath(entryMap.get(entry.parentId))} / ` : ''}${entryTitle(entry)}`
    }))} onSave={moveSong} onClose={() => setMovingSong(null)} />}
  </div>;
}