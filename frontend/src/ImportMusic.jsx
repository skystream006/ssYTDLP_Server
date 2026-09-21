import { useEffect, useId, useRef, useState } from 'react';
import { Check, FileAudio, FileArchive, FileCode, HardDrive, RefreshCw, Upload, X } from 'lucide-react';
import { formatBytes } from './SongActions.jsx';
import { mediaAccept } from '../../src/media.js';

export default function ImportMusic({ request, onClose, onImported, initialPlaylistId = '' }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const [mode, setMode] = useState('files');
  const [playlists, setPlaylists] = useState(null);
  const [playlistId, setPlaylistId] = useState(initialPlaylistId);
  const [createNew, setCreateNew] = useState(false);
  const [playlistTitle, setPlaylistTitle] = useState('');
  const [files, setFiles] = useState([]);
  const [xml, setXml] = useState(null);
  const [media, setMedia] = useState(null);
  const [itunesSource, setItunesSource] = useState('upload');
  const [localFiles, setLocalFiles] = useState(null);
  const [localXml, setLocalXml] = useState('');
  const [localZip, setLocalZip] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState('');
  const [localRevision, setLocalRevision] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [importId, setImportId] = useState(null);
  const [importLogs, setImportLogs] = useState([]);
  const [logError, setLogError] = useState('');
  const logRef = useRef(null);
  const followLog = useRef(true);

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
      setPlaylistId((current) => available.some((playlist) => playlist.id === current) ? current : available[0]?.id || '');
      if (!available.length) setCreateNew(true);
    }).catch((failure) => { if (active) setLoadError(failure.message); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    if (mode !== 'itunes' || itunesSource !== 'local') return;
    let active = true;
    setLocalLoading(true);
    setLocalError('');
    request('/api/jobs/import/local').then((listing) => {
      if (!active) return;
      setLocalFiles(listing);
      setLocalXml((current) => listing.xmlFiles.some((file) => file.name === current) ? current : '');
      setLocalZip((current) => listing.zipFiles.some((file) => file.name === current) ? current : '');
    }).catch((failure) => { if (active) { setLocalError(failure.message); setLocalFiles(null); } })
      .finally(() => { if (active) setLocalLoading(false); });
    return () => { active = false; };
  }, [mode, itunesSource, localRevision]);

  useEffect(() => {
    if (!importId) return;
    let active = true;
    let timer;
    async function refreshLog() {
      try {
        const progress = await request(`/api/jobs/import/logs/${encodeURIComponent(importId)}`);
        if (!active) return;
        setImportLogs(progress.entries);
        setLogError('');
      } catch (failure) {
        if (active && (failure.status !== 404 || !submitting)) setLogError('Import log unavailable.');
      }
      if (active && submitting) timer = setTimeout(refreshLog, 2000);
    }
    void refreshLog();
    return () => { active = false; clearTimeout(timer); };
  }, [importId, submitting]);

  useEffect(() => {
    if (logRef.current && followLog.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [importLogs]);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    let options;
    if (mode === 'itunes' && itunesSource === 'local') {
      options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'itunes', source: 'local', xmlName: localXml, zipName: localZip }) };
    } else {
      const selected = mode === 'files' ? files : [xml, media].filter(Boolean);
      if (selected.reduce((total, file) => total + file.size, 0) > 2 * 1024 ** 3) {
        setError('The total upload must be no larger than 2 GB.');
        return;
      }
      if (mode === 'files' && (files.length > 1000 || files.some((file) => file.size > 512 * 1024 ** 2))) {
        setError('Select up to 1,000 audio or movie files, no larger than 512 MB each.');
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
      options = { method: 'POST', body };
    }
    const nextImportId = mode === 'itunes' ? crypto.randomUUID() : null;
    setImportId(nextImportId);
    setImportLogs([]);
    setLogError('');
    followLog.current = true;
    setSubmitting(true);
    try {
      const imported = await request(`/api/jobs/import${nextImportId ? `?importId=${nextImportId}` : ''}`, options);
      setResult(imported);
      onImported();
    } catch (failure) { setError(failure.message); }
    finally { setSubmitting(false); }
  }

  const ready = mode === 'files'
    ? files.length > 0 && (createNew ? Boolean(playlistTitle.trim()) : Boolean(playlistId))
    : itunesSource === 'local' ? Boolean(localXml && localZip && localFiles && !localLoading && !localError) : Boolean(xml && media);

  const logPanel = importId && <section className="import-log-panel" aria-label="Import diagnostics">
    <h3>Import log</h3>
    <small className="import-log-id">{importId}</small>
    <div className="import-log" role="log" aria-label="Import log" aria-live="off" tabIndex={0} ref={logRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followLog.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      }}>
      {!importLogs.length && <div>{submitting ? 'Waiting for server...' : 'Loading import log...'}</div>}
      {importLogs.map((entry, index) => <div key={`${entry.elapsedMs}-${index}`} className={entry.level === 'error' ? 'import-log-error' : undefined}>
        <time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString()}</time> [{entry.stage}] {entry.message}
        {Object.keys(entry.details).length > 0 && <span className="import-log-details">{Object.entries(entry.details).map(([key, value]) => `${key}: ${value}`).join(' | ')}</span>}
      </div>)}
    </div>
    {logError && <p className="notice error" role="status">{logError}</p>}
  </section>;

  return <dialog ref={dialogRef} className="confirmation-dialog import-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!submitting) onClose(); }}>
    <div className="folder-dialog-heading">
      <h2 id={headingId}>Import media</h2>
      <button className="music-icon-button" type="button" title="Close import" aria-label="Close import" disabled={submitting} onClick={onClose}><X size={18} /></button>
    </div>
    {result ? <>
      <p className="notice success" role="status"><Check size={18} />Imported {result.importedFiles} {result.importedFiles === 1 ? 'file' : 'files'} into {result.jobs.length} {result.jobs.length === 1 ? 'playlist' : 'playlists'}.</p>
      <ul className="import-results">{result.jobs.map((job) => <li key={job.id}><a href={`/job/${encodeURIComponent(job.id)}`}>{job.playlistTitle}</a></li>)}</ul>
      {logPanel}
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
          <label className="import-field import-upload"><span><FileAudio size={18} />Audio and movie files</span>
            <input key="files" type="file" accept={mediaAccept} multiple required onChange={(event) => setFiles([...event.target.files])} />
            {files.length > 0 && <small>{files.length} {files.length === 1 ? 'file' : 'files'} / {formatBytes(files.reduce((size, file) => size + file.size, 0))}</small>}
          </label>
        </div> : <div className="import-itunes-options">
          <div className="import-modes" role="group" aria-label="iTunes import location">
            <button type="button" aria-pressed={itunesSource === 'upload'} onClick={() => { if (itunesSource !== 'upload') { setItunesSource('upload'); setXml(null); setMedia(null); setError(''); } }}><Upload size={17} />Upload files</button>
            <button type="button" aria-pressed={itunesSource === 'local'} onClick={() => { setItunesSource('local'); setError(''); }}><HardDrive size={17} />Import from local</button>
          </div>
          {itunesSource === 'local' ? <>
            <div className="import-storage-heading"><span>Local storage</span>
              <button className="music-icon-button" type="button" title="Refresh local files" aria-label="Refresh local files" disabled={localLoading} onClick={() => setLocalRevision((value) => value + 1)}><RefreshCw className={localLoading ? 'spin' : undefined} size={17} /></button>
            </div>
            {localLoading && <span className="import-storage-status" role="status">Loading local files...</span>}
            {localError && <div className="notice error" role="alert">{localError}</div>}
            <label className="import-field"><span><FileCode size={18} />Local XML file</span>
              <select required disabled={localLoading || !localFiles?.xmlFiles.length} value={localXml} onChange={(event) => setLocalXml(event.target.value)}>
                <option value="">{localFiles && !localFiles.xmlFiles.length ? 'No XML files available' : 'Select XML file'}</option>
                {localFiles?.xmlFiles.map((file) => <option key={file.name} value={file.name}>{file.name} ({formatBytes(file.size)})</option>)}
              </select>
            </label>
            <label className="import-field"><span><FileArchive size={18} />Local ZIP file</span>
              <select required disabled={localLoading || !localFiles?.zipFiles.length} value={localZip} onChange={(event) => setLocalZip(event.target.value)}>
                <option value="">{localFiles && !localFiles.zipFiles.length ? 'No ZIP files available' : 'Select ZIP file'}</option>
                {localFiles?.zipFiles.map((file) => <option key={file.name} value={file.name}>{file.name} ({formatBytes(file.size)})</option>)}
              </select>
            </label>
          </> : <><label className="import-field import-upload"><span><FileCode size={18} />1. iTunes library XML</span>
            <input key="xml" type="file" accept=".xml,application/xml,text/xml" required onChange={(event) => setXml(event.target.files[0] || null)} />
            {xml && <small>{formatBytes(xml.size)}</small>}
          </label>
          <label className="import-field import-upload"><span><FileArchive size={18} />2. Media content ZIP</span>
            <input key="media" type="file" accept=".zip,application/zip" required onChange={(event) => setMedia(event.target.files[0] || null)} />
            {media && <small>{formatBytes(media.size)}</small>}
          </label></>}
        </div>}
      </fieldset>
      {error && <p className="notice error" role="alert">{error}</p>}
      {submitting && <p className="import-progress" role="status"><RefreshCw className="spin" size={17} />{mode === 'itunes' && itunesSource === 'local' ? 'Processing local library...' : 'Importing media...'}</p>}
      {logPanel}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={!ready || submitting}><Upload size={17} />{submitting ? 'Importing' : 'Import'}</button>
      </div>
    </form>}
  </dialog>;
}