import { createContext, StrictMode, useContext, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  Disc3,
  ExternalLink,
  FileAudio,
  Fingerprint,
  HardDrive,
  KeyRound,
  ListMusic,
  LogOut,
  MemoryStick,
  Music2,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  UserX,
  X
} from 'lucide-react';
import './styles.css';

const POLL_INTERVAL = 5000;
const AuthContext = createContext(null);

function ConfirmationDialog({ title, message, action, label, onAnswer }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const messageId = useId();
  const ActionIcon = action === 'delete' ? Trash2 : action === 'rerun' ? RotateCcw : ExternalLink;
  const actionLabel = label || (action === 'delete' ? 'Delete job' : action === 'rerun' ? 'Rerun job' : 'Open details');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby={titleId} aria-describedby={messageId}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onAnswer(false); } }}
    onCancel={(event) => { event.preventDefault(); onAnswer(false); }}>
    <h2 id={titleId}>{title}</h2>
    <p id={messageId}>{message}</p>
    <div className="dialog-actions">
      <button className="secondary-button" type="button" onClick={() => onAnswer(false)}>Cancel</button>
      <button className={action === 'delete' ? 'danger-button' : 'primary-button'} type="button" onClick={() => onAnswer(true)}>
        <ActionIcon size={17} />{actionLabel}
      </button>
    </div>
  </dialog>;
}

function useConfirmation() {
  const [options, setOptions] = useState(null);
  const answerRef = useRef(null);

  useEffect(() => () => {
    answerRef.current?.(false);
    answerRef.current = null;
  }, []);

  function confirm(options) {
    if (answerRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      answerRef.current = resolve;
      setOptions(options);
    });
  }

  function answer(value) {
    answerRef.current?.(value);
    answerRef.current = null;
    setOptions(null);
  }

  return { confirm, dialog: options && <ConfirmationDialog {...options} onAnswer={answer} /> };
}

async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text || 'Request failed' };
  }
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = response.status;
    error.code = body.code;
    error.existingJob = body.existingJob;
    throw error;
  }
  return body;
}

function usePolling(loader, interval = POLL_INTERVAL, pollingKey = 'default') {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await loader();
        if (active) {
          setData(result);
          setError('');
        }
      } catch (loadError) {
        if (active) setError(loadError.message);
      }
    };

    load();
    const timer = window.setInterval(load, interval);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [interval, pollingKey]);

  return { data, error };
}

const loadJobs = () => request('/api/jobs');
const loadHealth = () => request('/api/health');

function AppShell({ children, section = 'jobs' }) {
  const { user, logout } = useContext(AuthContext);
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="ssYTDLP jobs">
          <span className="brand-mark"><Music2 size={18} strokeWidth={2.5} /></span>
          <span>ssYTDLP</span>
        </a>
        <nav aria-label="Main navigation">
          <a className={section === 'jobs' ? 'active' : ''} href="/">
            <ListMusic size={17} /> Jobs
          </a>
          <a className={section === 'health' ? 'active' : ''} href="/health">
            <Activity size={17} /> Health
          </a>
          {user.role === 'admin' && <a className={section === 'admin' ? 'active' : ''} href="/admin">
            <Users size={17} /> Admin
          </a>}
        </nav>
        <div className="account-menu">
          <span><strong>{user.name}</strong><small>{user.role}</small></span>
          <a href="/settings" className={section === 'settings' ? 'active' : ''} aria-label="User settings" title="User settings"><Settings size={17} /></a>
          <button onClick={logout} type="button" aria-label="Log out" title="Log out"><LogOut size={17} /></button>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

function StatusBadge({ status }) {
  const icon = status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'partially_completed' ? <CircleAlert size={13} />
      : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  const label = status === 'partially_completed' ? 'partially completed' : status;
  return <span className={`status status-${status}`}>{icon}{label}</span>;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value));
}

function JobsPage() {
  const { user } = useContext(AuthContext);
  const { confirm, dialog } = useConfirmation();
  const { data: jobs, error: loadError } = usePolling(loadJobs);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobAction, setJobAction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [userFilter, setUserFilter] = useState(user.id);

  async function runJobAction(job, action) {
    if (jobAction || job.status === 'queued' || job.status === 'running') return;
    const message = action === 'rerun'
      ? `Rerun ${job.folderName || job.id}? Its existing downloaded files will be replaced.`
      : `Delete ${job.folderName || job.id} and all of its downloaded files?`;
    if (!await confirm({ title: action === 'rerun' ? 'Rerun job?' : 'Delete job?', message, action })) return;

    setJobAction({ id: job.id, action });
    setActionError('');
    try {
      const jobUrl = `/api/jobs/${encodeURIComponent(job.id)}`;
      if (action === 'rerun') {
        await request(`${jobUrl}/rerun`, { method: 'POST' });
        window.location.assign(`/job/${encodeURIComponent(job.id)}`);
      } else {
        await request(jobUrl, { method: 'DELETE' });
        window.location.reload();
      }
    } catch (error) {
      setActionError(error.message);
      setJobAction(null);
    }
  }

  async function submitJob(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      let job;
      try {
        job = await request('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
      } catch (error) {
        if (error.code !== 'JOB_ALREADY_EXISTS' || !error.existingJob) throw error;
        const previous = error.existingJob;
        const detailsUrl = `/job/${encodeURIComponent(previous.id)}`;
        if (previous.status === 'queued' || previous.status === 'running') {
          if (await confirm({ title: 'Job already active', message: 'This URL already has an active job. Open its details?', action: 'open' })) {
            window.location.assign(detailsUrl);
          }
          return;
        }
        if (!await confirm({ title: 'Job already exists', message: `This URL was used in job ${previous.folderName || previous.id}. Rerun it? Its existing downloaded files will be replaced.`, action: 'rerun' })) {
          return;
        }
        const reranJob = await request(`/api/jobs/${encodeURIComponent(previous.id)}/rerun`, { method: 'POST' });
        window.location.assign(`/job/${encodeURIComponent(reranJob.id)}`);
        return;
      }
      setUrl('');
      setMessage({ type: 'success', text: `Job ${job.id} was added to the queue.` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  const initiators = new Map([[user.id, user.name]]);
  for (const job of jobs || []) {
    const id = job.initiatedBy?.id || 'unknown';
    if (!initiators.has(id)) initiators.set(id, job.initiatedBy?.name || 'Unknown');
  }
  const userOptions = [...initiators].sort((left, right) => left[1].localeCompare(right[1]));
  const filteredJobs = (jobs || []).filter((job) => (
    userFilter === 'all' || (job.initiatedBy?.id || 'unknown') === userFilter
  ));
  const counts = filteredJobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});

  return (
    <AppShell>
      {dialog}
      <section className="page-heading">
        <div>
          <p className="eyebrow">Download queue</p>
          <h1>Music, ready when you are.</h1>
          <p>Send a YouTube Music track or playlist to your local archive.</p>
        </div>
        <div className="queue-summary" aria-label="Queue summary">
          <div><strong>{jobs ? filteredJobs.length : '-'}</strong><span>Total</span></div>
          <div><strong>{counts.running || 0}</strong><span>Active</span></div>
          <div><strong>{(counts.completed || 0) + (counts.partially_completed || 0)}</strong><span>Ready</span></div>
        </div>
      </section>

      <section className="create-panel" aria-labelledby="create-heading">
        <div className="panel-index">01</div>
        <div className="create-copy">
          <h2 id="create-heading">Start a download</h2>
          <p>Tracks become MP3 files. Playlist links download the complete list.</p>
        </div>
        <form onSubmit={submitJob}>
          <div className="url-field">
            <Music2 size={19} />
            <input
              aria-label="YouTube Music URL"
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://music.youtube.com/watch?v=..."
            />
          </div>
          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? <RefreshCw className="spin" size={18} /> : <Plus size={18} />}
            {submitting ? 'Adding' : 'Add job'}
          </button>
        </form>
        {message && <div className={`notice ${message.type}`} role="status">{message.text}</div>}
      </section>

      <section className="jobs-section">
        <div className="section-title">
          <div><span>02</span><h2>Recent jobs</h2></div>
          <span className="refresh-note"><RefreshCw size={13} /> Refreshes every 5 seconds</span>
        </div>
        <div className="jobs-filters">
          <label htmlFor="job-user-filter"><Users size={16} />Initiated by</label>
          <select id="job-user-filter" value={userFilter} onChange={(event) => setUserFilter(event.target.value)}>
            <option value="all">All users</option>
            {userOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            {userFilter !== 'all' && !initiators.has(userFilter) && <option value={userFilter}>Selected user (no jobs)</option>}
          </select>
        </div>
        {loadError && <div className="notice error"><CircleAlert size={16} />{loadError}</div>}
        {actionError && <div className="notice error" role="alert"><CircleAlert size={16} />{actionError}</div>}
        {jobs?.length === 0 && (
          <div className="empty-state"><Disc3 size={34} /><h3>No downloads yet</h3><p>Your first job will appear here.</p></div>
        )}
        {jobs?.length > 0 && filteredJobs.length === 0 && (
          <div className="empty-state"><Users size={34} /><h3>No jobs for this user</h3></div>
        )}
        {filteredJobs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Format</th><th>Status</th><th>Created</th><th>Songs</th><th>Files</th><th>Initiated by</th><th>Actions</th></tr></thead>
              <tbody>{filteredJobs.map((job) => (
                <tr key={job.id}>
                  <td><a className="job-name" href={`/job/${job.id}`}><span>{job.isPlaylist ? <ListMusic size={18} /> : <Music2 size={18} />}</span><div><strong>{job.folderName || 'Preparing download'}</strong><small>{job.id}</small></div></a></td>
                  <td>{job.isPlaylist ? 'Playlist' : 'Track'}</td>
                  <td><StatusBadge status={job.status} /></td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td>{job.isPlaylist ? (job.playlistSongCount ?? '-') : 1}</td>
                  <td>{job.files?.length ?? 0}</td>
                  <td><span className="job-initiator">{job.initiatedBy?.name || 'Unknown'}</span></td>
                  <td><div className="job-row-actions">
                    <a className="icon-link" href={`/job/${job.id}`} aria-label={`Open job ${job.id}`} title="Open job"><ExternalLink size={17} /></a>
                    <button className="icon-link" type="button" title="Rerun job" aria-label={`Rerun job ${job.id}`} disabled={Boolean(jobAction) || job.status === 'queued' || job.status === 'running'} onClick={() => runJobAction(job, 'rerun')}>
                      {jobAction?.id === job.id && jobAction.action === 'rerun' ? <RefreshCw className="spin" size={17} /> : <RotateCcw size={17} />}
                    </button>
                    <button className="icon-link row-delete" type="button" title="Delete job" aria-label={`Delete job ${job.id}`} disabled={Boolean(jobAction) || job.status === 'queued' || job.status === 'running'} onClick={() => runJobAction(job, 'delete')}>
                      {jobAction?.id === job.id && jobAction.action === 'delete' ? <RefreshCw className="spin" size={17} /> : <Trash2 size={17} />}
                    </button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function JobPage({ id }) {
  const { confirm, dialog } = useConfirmation();
  const loadJob = () => Promise.all([
    request(`/api/jobs/${id}`),
    request(`/api/jobs/${id}/files`).catch(() => null)
  ]);
  const { data, error } = usePolling(loadJob, POLL_INTERVAL, id);
  const [rerunning, setRerunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState('');
  const job = data?.[0];
  const files = data?.[1]?.files || [];
  const isActive = job?.status === 'queued' || job?.status === 'running';

  async function rerun() {
    if (!await confirm({ title: 'Rerun job?', message: `Rerun ${job.folderName || job.id}? Its existing downloaded files will be replaced.`, action: 'rerun' })) return;
    setRerunning(true);
    setActionError('');
    try {
      await request(`/api/jobs/${id}/rerun`, { method: 'POST' });
      window.location.reload();
    } catch (requestError) {
      setActionError(requestError.message);
      setRerunning(false);
    }
  }

  async function remove() {
    if (!await confirm({ title: 'Delete job?', message: 'Delete this job and all of its downloaded files?', action: 'delete' })) {
      return;
    }

    setDeleting(true);
    setActionError('');
    try {
      await request(`/api/jobs/${id}`, { method: 'DELETE' });
      window.location.assign('/');
    } catch (requestError) {
      setActionError(requestError.message);
      setDeleting(false);
    }
  }

  return (
    <AppShell>
      {dialog}
      <a className="back-link" href="/"><ArrowLeft size={17} /> Back to jobs</a>
      {error && <div className="notice error page-notice"><CircleAlert size={16} />{error}</div>}
      {!job && !error && <div className="loading"><RefreshCw className="spin" /> Loading job</div>}
      {job && <>
        <section className="detail-heading">
          <div>
            <p className="eyebrow">{job.isPlaylist ? 'Playlist download' : 'Track download'}</p>
            <h1>{job.folderName || 'Preparing download'}</h1>
            <div className="detail-meta"><StatusBadge status={job.status} /><span>Created {formatDate(job.createdAt)}</span></div>
          </div>
          <div className="detail-actions">
            <div className="record-art"><Disc3 size={70} strokeWidth={1.2} /></div>
            <button className="primary-button job-action-button" disabled={isActive || rerunning || deleting} onClick={rerun} type="button">
              {rerunning ? <RefreshCw className="spin" size={17} /> : <RotateCcw size={17} />}
              {rerunning ? 'Starting' : 'Rerun job'}
            </button>
            <button className="danger-button job-action-button" disabled={isActive || rerunning || deleting} onClick={remove} type="button">
              {deleting ? <RefreshCw className="spin" size={17} /> : <Trash2 size={17} />}
              {deleting ? 'Deleting' : 'Delete job'}
            </button>
          </div>
        </section>
        {actionError && <div className="notice error page-notice"><CircleAlert size={16} />{actionError}</div>}
        <div className="detail-grid">
          <section className="info-panel">
            <div className="section-title"><div><span>01</span><h2>Job details</h2></div></div>
            <dl>
              <dt>Source URL</dt><dd><a href={job.url} target="_blank" rel="noreferrer">{job.url}<ExternalLink size={14} /></a></dd>
              <dt>Job ID</dt><dd><code>{job.id}</code></dd>
              <dt>Initiated by</dt><dd>{job.initiatedBy?.name || 'Unknown'}</dd>
              <dt>Downloaded files</dt><dd>{data?.[1] ? files.length : 'Not available'}</dd>
              {job.isPlaylist && <><dt>Playlist songs</dt><dd>{job.playlistSongCount ?? 'Not available'}</dd></>}
              <dt>Output folder</dt><dd><code>{job.folderName || 'Pending'}</code></dd>
              <dt>Last updated</dt><dd>{formatDate(job.updatedAt)}</dd>
              <dt>Command</dt><dd><code className="command-code">{job.command || 'Pending'}</code></dd>
            </dl>
            {job.warning && <div className="notice warning"><CircleAlert size={16} />{job.warning}</div>}
            {job.error && <div className="notice error"><CircleAlert size={16} />{job.error}</div>}
          </section>
          <section className="files-panel">
            <div className="section-title">
              <div><span>02</span><h2>Files</h2></div>
              <div className="files-actions">
                <strong>{files.length}</strong>
                {files.length > 0 && <a className="download-all" href={`/api/jobs/${id}/download-all`}><ArrowDownToLine size={16} />Download all</a>}
              </div>
            </div>
            {files.length === 0 ? <div className="empty-files"><FileAudio size={29} /><p>No downloadable files yet.</p></div> : (
              <ul className="file-list">{files.map((file) => (
                <li key={file.name}><span className="file-icon"><FileAudio size={19} /></span><div><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)}</small></div><a href={file.downloadUrl} aria-label={`Download ${file.name}`}><ArrowDownToLine size={18} /></a></li>
              ))}</ul>
            )}
          </section>
        </div>
        <section className="output-panel">
          <div className="section-title"><div><span>03</span><h2>Process output</h2></div></div>
          <pre>{job.output || (isActive ? 'Waiting for process output...' : 'No process output was captured.')}</pre>
        </section>
      </>}
    </AppShell>
  );
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function Metric({ icon, label, value, detail, percent }) {
  return <article className="metric">
    <div className="metric-top"><span>{icon}</span><small>{label}</small></div>
    <strong>{value}</strong>
    <p>{detail}</p>
    {Number.isFinite(percent) && <div className="meter"><span style={{ width: `${Math.min(100, percent)}%` }} /></div>}
  </article>;
}

function HealthPage() {
  const { data: health, error } = usePolling(loadHealth, 3000);
  const memoryPercent = health ? health.memory.usedBytes / health.memory.totalBytes * 100 : 0;
  const diskUsed = health ? health.storage.totalBytes - health.storage.freeBytes : 0;
  const diskPercent = health ? diskUsed / health.storage.totalBytes * 100 : 0;

  return <AppShell section="health">
    <section className="page-heading health-heading">
      <div><p className="eyebrow">System monitor</p><h1>Runtime health.</h1><p>Live resource use from the host running your downloads.</p></div>
      {health && <div className="updated"><span /> Updated {new Date(health.timestamp).toLocaleTimeString()}</div>}
    </section>
    {error && <div className="notice error page-notice"><CircleAlert size={16} />{error}</div>}
    {!health && !error && <div className="loading"><RefreshCw className="spin" /> Reading system metrics</div>}
    {health && <>
      <section className="host-strip"><span><Server size={20} /></span><div><small>Host machine</small><strong>{health.hostname}</strong></div><div className="host-status"><span /> Operational</div></section>
      <section className="metrics-grid">
        <Metric icon={<Activity />} label="CPU usage" value={`${health.cpu.usagePercent.toFixed(1)}%`} detail="Current processor load" percent={health.cpu.usagePercent} />
        <Metric icon={<MemoryStick />} label="Memory" value={formatBytes(health.memory.usedBytes)} detail={`${formatBytes(health.memory.totalBytes)} total`} percent={memoryPercent} />
        <Metric icon={<HardDrive />} label="Storage free" value={formatBytes(health.storage.freeBytes)} detail={`${formatBytes(health.storage.totalBytes)} total`} percent={diskPercent} />
        <Metric icon={<Network />} label="Network in" value={`${formatBytes(health.network.rxSec)}/s`} detail={`${formatBytes(health.network.rxBytes)} received`} />
        <Metric icon={<Network />} label="Network out" value={`${formatBytes(health.network.txSec)}/s`} detail={`${formatBytes(health.network.txBytes)} sent`} />
      </section>
    </>}
  </AppShell>;
}

function LoginPage({ onLogin }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);

  async function login() {
    setBusy('login');
    setMessage(null);
    try {
      const ceremony = await request('/api/auth/login/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      const result = await request('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      onLogin(result.user);
    } catch (error) {
      setMessage({ type: error.code === 'ACCESS_PENDING' ? 'warning' : 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function register(event) {
    event.preventDefault();
    setBusy('register');
    setMessage(null);
    try {
      const ceremony = await request('/api/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const response = await startRegistration({ optionsJSON: ceremony.options });
      const result = await request('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      if (result.user.status === 'approved') {
        onLogin(result.user);
      } else {
        setName('');
        setMessage({ type: 'warning', text: 'Passkey registered. An administrator must approve your access before you can log in.' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  return <main className="auth-page">
    <section className="auth-intro">
      <span className="auth-mark"><Music2 size={28} /></span>
      <p className="eyebrow">Private music workspace</p>
      <h1>Open your archive.</h1>
      <p>Your passkey stays with your password manager or device. The server stores only the public credential needed to recognize you.</p>
    </section>
    <section className="auth-panel" aria-labelledby="access-heading">
      <div className="auth-panel-heading"><Fingerprint size={27} /><div><p>Secure access</p><h2 id="access-heading">Use a passkey</h2></div></div>
      <button className="primary-button auth-login" disabled={Boolean(busy)} onClick={login} type="button">
        {busy === 'login' ? <RefreshCw className="spin" size={18} /> : <Fingerprint size={18} />}
        Login with Passkey
      </button>
      <div className="auth-divider"><span>or register</span></div>
      <form onSubmit={register}>
        <label htmlFor="registration-name">Display name</label>
        <input id="registration-name" minLength="2" maxLength="64" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
        <button className="secondary-button" disabled={Boolean(busy)} type="submit">
          {busy === 'register' ? <RefreshCw className="spin" size={18} /> : <ShieldCheck size={18} />}
          Register with Passkey
        </button>
      </form>
      {message && <div className={`notice ${message.type}`} role="status">{message.text}</div>}
    </section>
  </main>;
}

function PatDialog({ pat, onClose }) {
  const dialogRef = useRef(null);
  const tokenRef = useRef(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(pat.token);
      setCopied(true);
      setError('');
    } catch {
      tokenRef.current.focus();
      tokenRef.current.select();
      setError('Clipboard unavailable. Copy the selected PAT manually.');
    }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog pat-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={titleId}>Private Access Token created</h2>
    <p className="pat-name">{pat.name}</p>
    <p>This secret is shown only once. Store it securely before closing.</p>
    <label className="sr-only" htmlFor={`${titleId}-token`}>Private Access Token</label>
    <textarea ref={tokenRef} id={`${titleId}-token`} readOnly value={pat.token} spellCheck={false} />
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="secondary-button" onClick={copyToken}><Copy size={17} />{copied ? 'Copied' : 'Copy PAT'}</button>
      <button type="button" className="primary-button" onClick={onClose}><Check size={17} />Done</button>
    </div>
    <span className="sr-only" role="status">{copied ? 'PAT copied to clipboard' : ''}</span>
  </dialog>;
}

function UserSettingsPage({ userId }) {
  const { user: currentUser } = useContext(AuthContext);
  const [details, setDetails] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const { confirm, dialog } = useConfirmation();
  const endpoint = userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/auth/pats';

  async function load() {
    try {
      const result = await request(endpoint);
      setDetails(result.user || currentUser);
      setTokens(result.tokens);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  useEffect(() => { load(); }, [endpoint]);

  async function generate(event) {
    event.preventDefault();
    setBusy('generate');
    setError('');
    try {
      const pat = await request('/api/auth/pats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      setSecret(pat);
      setTokens((previous) => [{ id: pat.id, name: pat.name, createdAt: pat.createdAt }, ...previous]);
      setName('');
    } catch (generateError) {
      setError(generateError.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(pat) {
    if (!await confirm({ title: 'Delete Private Access Token?', message: `Delete "${pat.name}"? Requests using this PAT will no longer be authenticated.`, action: 'delete', label: 'Delete PAT' })) return;
    setBusy(pat.id);
    setError('');
    try {
      const deleteEndpoint = userId ? `${endpoint}/pats/${pat.id}` : `${endpoint}/${pat.id}`;
      await request(deleteEndpoint, { method: 'DELETE' });
      setTokens((previous) => previous.filter((token) => token.id !== pat.id));
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy('');
    }
  }

  return <AppShell section={userId ? 'admin' : 'settings'}>
    {userId && <a className="settings-back" href="/admin"><ArrowLeft size={16} />All users</a>}
    <section className="page-heading settings-heading"><div><p className="eyebrow">Account</p><h1>{userId ? 'User details' : 'User settings'}</h1></div></section>
    {error && <div className="notice error" role="alert">{error}<button type="button" className="secondary-button compact-button" onClick={load} disabled={Boolean(busy)}><RefreshCw size={16} />Retry</button></div>}
    {!details && !error && <p role="status">Loading account...</p>}
    {details && <>
      <section className="settings-profile" aria-label="User details">
        <UserIdentity user={details} />
        <dl><div><dt>Role</dt><dd>{details.role}</dd></div><div><dt>Joined</dt><dd>{formatDate(details.createdAt)}</dd></div><div><dt>User ID</dt><dd>{details.id}</dd></div></dl>
      </section>
      <section className="pat-section" aria-labelledby="pat-heading">
        <div className="section-title"><div><KeyRound size={19} /><h2 id="pat-heading">Private Access Tokens</h2></div><strong>{tokens.length}</strong></div>
        {!userId && <form className="pat-form" onSubmit={generate}>
          <div><label htmlFor="pat-name">PAT name</label><input id="pat-name" required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Home automation" /></div>
          <button className="primary-button" type="submit" disabled={Boolean(busy) || !name.trim()}>{busy === 'generate' ? <RefreshCw size={17} className="spin" /> : <Plus size={17} />}Generate PAT</button>
        </form>}
        {tokens.length === 0 ? <div className="empty-state compact"><KeyRound size={28} /><h3>No Private Access Tokens</h3></div> : <ul className="pat-list">
          {tokens.map((pat) => <li key={pat.id}><KeyRound size={18} /><div><strong>{pat.name}</strong><small>Created {formatDate(pat.createdAt)}</small></div>
            <button className="danger-button pat-delete" type="button" title={`Delete ${pat.name}`} aria-label={`Delete ${pat.name}`} disabled={Boolean(busy)} onClick={() => remove(pat)}><Trash2 size={17} /></button>
          </li>)}
        </ul>}
      </section>
    </>}
    {secret && <PatDialog pat={secret} onClose={() => setSecret(null)} />}
    {dialog}
  </AppShell>;
}

function AdminPage() {
  const { user: currentUser } = useContext(AuthContext);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');

  async function loadUsers() {
    try {
      const result = await request('/api/admin/users');
      setUsers(result.users);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function changeUser(userId, changes) {
    setUpdating(userId);
    setError('');
    try {
      await request(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });
      await loadUsers();
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setUpdating('');
    }
  }

  const pending = users.filter((user) => user.status === 'pending');
  return <AppShell section="admin">
    <section className="page-heading admin-heading">
      <div><p className="eyebrow">Access control</p><h1>Allowed users.</h1><p>Review passkey registrations and control who can use this server.</p></div>
      <div className="pending-count"><strong>{pending.length}</strong><span>Awaiting approval</span></div>
    </section>
    {error && <div className="notice error page-notice"><CircleAlert size={16} />{error}</div>}
    <section className="users-section">
      <div className="section-title"><div><span>01</span><h2>Access requests</h2></div></div>
      {pending.length === 0 ? <div className="empty-state compact"><UserCheck size={30} /><h3>No pending requests</h3><p>New passkey registrations will appear here.</p></div> : (
        <div className="user-list">{pending.map((user) => <article className="user-row pending-user" key={user.id}>
          <UserIdentity user={user} />
          <button className="primary-button compact-button" disabled={updating === user.id} onClick={() => changeUser(user.id, { status: 'approved' })} type="button"><UserCheck size={16} />Approve</button>
        </article>)}</div>
      )}
    </section>
    <section className="users-section">
      <div className="section-title"><div><span>02</span><h2>All users</h2></div><strong>{users.length}</strong></div>
      <div className="user-list">{users.map((user) => <article className="user-row" key={user.id}>
        <a className="user-details-link" href={`/admin/users/${encodeURIComponent(user.id)}`} aria-label={`View ${user.name} details`}><UserIdentity user={user} /><ExternalLink size={16} /></a>
        <label className="role-control"><span>Role</span><select disabled={updating === user.id || user.id === currentUser.id} value={user.role} onChange={(event) => changeUser(user.id, { role: event.target.value })}><option value="user">User</option><option value="admin">Admin</option></select></label>
        {user.status === 'approved'
          ? <button className="danger-button compact-button" disabled={updating === user.id || user.id === currentUser.id} onClick={() => changeUser(user.id, { status: 'revoked' })} type="button"><UserX size={16} />Revoke</button>
          : <button className="secondary-button compact-button" disabled={updating === user.id} onClick={() => changeUser(user.id, { status: 'approved' })} type="button"><UserCheck size={16} />Allow</button>}
      </article>)}</div>
    </section>
  </AppShell>;
}

function UserIdentity({ user }) {
  return <div className="user-identity"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.status} · {user.credentialCount} passkey{user.credentialCount === 1 ? '' : 's'}</small></div></div>;
}

function Router({ user }) {
  const userMatch = window.location.pathname.match(/^\/admin\/users\/([^/]+)\/?$/);
  if (userMatch && user.role === 'admin') return <UserSettingsPage userId={decodeURIComponent(userMatch[1])} />;
  if (window.location.pathname === '/settings') return <UserSettingsPage />;
  const jobMatch = window.location.pathname.match(/^\/job\/([^/]+)\/?$/);
  if (jobMatch) return <JobPage id={decodeURIComponent(jobMatch[1])} />;
  if (window.location.pathname === '/health') return <HealthPage />;
  if (window.location.pathname === '/admin' && user.role === 'admin') return <AdminPage />;
  return <JobsPage />;
}

function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    request('/api/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null));
  }, []);

  async function logout() {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <div className="auth-loading"><Fingerprint className="spin" size={28} />Checking passkey session</div>;
  if (!user) return <LoginPage onLogin={setUser} />;
  return <AuthContext.Provider value={{ user, logout }}><Router user={user} /></AuthContext.Provider>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);