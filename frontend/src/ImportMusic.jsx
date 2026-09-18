import { useEffect, useId, useRef, useState } from 'react';
import { Check, FileAudio, FileArchive, FileCode, RefreshCw, Upload, X } from 'lucide-react';
import { formatBytes } from './SongActions.jsx';

const audioTypes = '.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus,.wma';

export default function ImportMusic({ request, onClose, onImported }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const [mode, setMode] = useState('files');
  const [playlists, setPlaylists] = useState(null);
  const [playlistId, setPlaylistId] = useState('');
  const [createNew, setCreateNew] = useState(false);
  const [playlistTitle, setPlaylistTitle] = useState('');
  const [files, setFiles] = useState([]);
  const [xml, setXml] = useState(null);
  const [media, setMedia] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadError('');
    request('/api/library').then((library) => {
      if (!active) return;
      const available = library.playlists.filter((playlist) => !['running', 'queued'].includes(playlist.status));
      setPlaylists(available);
      setPlaylistId((current) => current || available[0]?.id || '');
      if (!available.length) setCreateNew(true);
    }).catch((failure) => { if (active) setLoadError(failure.message); });
    return () => { active = false; };
  }, [revision]);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const selected = mode === 'files' ? files : [xml, media].filter(Boolean);
    if (selected.reduce((total, file) => total + file.size, 0) > 2 * 1024 ** 3) {
      setError('The total upload must be no larger than 2 GB.');
      return;
    }
    if (mode === 'files' && (files.length > 1000 || files.some((file) => file.size > 512 * 1024 ** 2))) {
      setError('Select up to 1,000 audio files, no larger than 512 MB each.');
      return;
    }
    if (mode === 'itunes' && xml?.size > 20 * 1024 ** 2) {
      setError('The XML file must be no larger than 20 MB.');
      return;
    }
    const body = new FormData();
    body.set('mode', mode);
    if (mode === 'files') {
      body.set('createNew', String(createNew));
      if (createNew) body.set('playlistTitle', playlistTitle.trim());
      else body.set('playlistId', playlistId);
      files.forEach((file) => body.append('files', file));
    } else {
      body.set('xml', xml);
      body.set('media', media);
    }
    setSubmitting(true);
    try {
      const imported = await request('/api/jobs/import', { method: 'POST', body });
      setResult(imported);
      onImported();
    } catch (failure) { setError(failure.message); }
    finally { setSubmitting(false); }
  }

  const ready = mode === 'files'
    ? files.length > 0 && (createNew ? Boolean(playlistTitle.trim()) : Boolean(playlistId))
    : Boolean(xml && media);

  return <dialog ref={dialogRef} className="confirmation-dialog import-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!submitting) onClose(); }}>
    <div className="folder-dialog-heading">
      <h2 id={headingId}>Import music</h2>
      <button className="music-icon-button" type="button" title="Close import" aria-label="Close import" disabled={submitting} onClick={onClose}><X size={18} /></button>
    </div>
    {result ? <>
      <p className="notice success" role="status"><Check size={18} />Imported {result.importedFiles} {result.importedFiles === 1 ? 'file' : 'files'} into {result.jobs.length} {result.jobs.length === 1 ? 'playlist' : 'playlists'}.</p>
      <ul className="import-results">{result.jobs.map((job) => <li key={job.id}><a href={`/job/${encodeURIComponent(job.id)}`}>{job.playlistTitle}</a></li>)}</ul>
      <div className="dialog-actions"><button className="primary-button" type="button" onClick={onClose}><Check size={17} />Done</button></div>
    </> : <form onSubmit={submit}>
      <fieldset className="import-fields" disabled={submitting}>
        <div className="import-modes" role="group" aria-label="Import source">
          <button type="button" aria-pressed={mode === 'files'} onClick={() => { if (mode !== 'files') { setMode('files'); setFiles([]); setError(''); } }}><FileAudio size={17} />Files</button>
          <button type="button" aria-pressed={mode === 'itunes'} onClick={() => { if (mode !== 'itunes') { setMode('itunes'); setXml(null); setMedia(null); setError(''); } }}><FileArchive size={17} />iTunes library</button>
        </div>
        {mode === 'files' ? <div className="import-file-options">
          {loadError && <div className="notice error" role="alert">{loadError}<button className="music-icon-button" type="button" aria-label="Reload playlists" title="Reload playlists" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button></div>}
          <label className="import-checkbox"><input type="checkbox" checked={createNew} onChange={(event) => setCreateNew(event.target.checked)} />Create New Playlist</label>
          {createNew ? <label className="import-field">Playlist name
            <input type="text" required maxLength={200} value={playlistTitle} onChange={(event) => setPlaylistTitle(event.target.value)} />
          </label> : <label className="import-field">Playlist
            <select required value={playlistId} disabled={playlists === null} onChange={(event) => setPlaylistId(event.target.value)}>
              <option value="">{playlists === null ? 'Loading playlists...' : playlists.length ? 'Select playlist' : 'No existing playlists'}</option>
              {playlists?.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.playlistTitle}</option>)}
            </select>
          </label>}
          <label className="import-field import-upload"><span><FileAudio size={18} />Audio files</span>
            <input key="audio" type="file" accept={audioTypes} multiple required onChange={(event) => setFiles([...event.target.files])} />
            {files.length > 0 && <small>{files.length} {files.length === 1 ? 'file' : 'files'} / {formatBytes(files.reduce((size, file) => size + file.size, 0))}</small>}
          </label>
        </div> : <div className="import-itunes-options">
          <label className="import-field import-upload"><span><FileCode size={18} />1. iTunes library XML</span>
            <input key="xml" type="file" accept=".xml,application/xml,text/xml" required onChange={(event) => setXml(event.target.files[0] || null)} />
            {xml && <small>{formatBytes(xml.size)}</small>}
          </label>
          <label className="import-field import-upload"><span><FileArchive size={18} />2. Media content ZIP</span>
            <input key="media" type="file" accept=".zip,application/zip" required onChange={(event) => setMedia(event.target.files[0] || null)} />
            {media && <small>{formatBytes(media.size)}</small>}
          </label>
        </div>}
      </fieldset>
      {error && <p className="notice error" role="alert">{error}</p>}
      {submitting && <p className="import-progress" role="status"><RefreshCw className="spin" size={17} />Importing music...</p>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={!ready || submitting}><Upload size={17} />{submitting ? 'Importing' : 'Import'}</button>
      </div>
    </form>}
  </dialog>;
}