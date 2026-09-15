import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  Disc3,
  ExternalLink,
  FileAudio,
  HardDrive,
  ListMusic,
  MemoryStick,
  Music2,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  X
} from 'lucide-react';
import './styles.css';

const POLL_INTERVAL = 5000;

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
    throw new Error(body.error || 'Request failed');
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
        </nav>
        <div className="service-state"><span /> Service online</div>
      </header>
      <main>{children}</main>
    </div>
  );
}

function StatusBadge({ status }) {
  const icon = status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  return <span className={`status status-${status}`}>{icon}{status}</span>;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value));
}

function JobsPage() {
  const { data: jobs, error: loadError } = usePolling(loadJobs);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitJob(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const job = await request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      setUrl('');
      setMessage({ type: 'success', text: `Job ${job.id} was added to the queue.` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  const counts = (jobs || []).reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});

  return (
    <AppShell>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Download queue</p>
          <h1>Music, ready when you are.</h1>
          <p>Send a YouTube Music track or playlist to your local archive.</p>
        </div>
        <div className="queue-summary" aria-label="Queue summary">
          <div><strong>{jobs?.length ?? '-'}</strong><span>Total</span></div>
          <div><strong>{counts.running || 0}</strong><span>Active</span></div>
          <div><strong>{counts.completed || 0}</strong><span>Ready</span></div>
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
        {loadError && <div className="notice error"><CircleAlert size={16} />{loadError}</div>}
        {jobs?.length === 0 && (
          <div className="empty-state"><Disc3 size={34} /><h3>No downloads yet</h3><p>Your first job will appear here.</p></div>
        )}
        {jobs?.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Format</th><th>Status</th><th>Created</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>{jobs.map((job) => (
                <tr key={job.id}>
                  <td><a className="job-name" href={`/job/${job.id}`}><span>{job.isPlaylist ? <ListMusic size={18} /> : <Music2 size={18} />}</span><div><strong>{job.folderName || 'Preparing download'}</strong><small>{job.id}</small></div></a></td>
                  <td>{job.isPlaylist ? 'Playlist' : 'Track'}</td>
                  <td><StatusBadge status={job.status} /></td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td><a className="icon-link" href={`/job/${job.id}`} aria-label={`Open job ${job.id}`}><ExternalLink size={17} /></a></td>
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
  const loadJob = () => Promise.all([
    request(`/api/jobs/${id}`),
    request(`/api/jobs/${id}/files`).catch(() => ({ files: [] }))
  ]);
  const { data, error } = usePolling(loadJob, POLL_INTERVAL, id);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState('');
  const job = data?.[0];
  const files = data?.[1]?.files || [];

  async function rerun() {
    setRerunning(true);
    setRerunError('');
    try {
      const newJob = await request(`/api/jobs/${id}/rerun`, { method: 'POST' });
      window.location.assign(`/job/${newJob.id}`);
    } catch (requestError) {
      setRerunError(requestError.message);
      setRerunning(false);
    }
  }

  return (
    <AppShell>
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
            <button className="primary-button rerun-button" disabled={rerunning} onClick={rerun} type="button">
              {rerunning ? <RefreshCw className="spin" size={17} /> : <RotateCcw size={17} />}
              {rerunning ? 'Starting' : 'Rerun job'}
            </button>
          </div>
        </section>
        {rerunError && <div className="notice error page-notice"><CircleAlert size={16} />{rerunError}</div>}
        <div className="detail-grid">
          <section className="info-panel">
            <div className="section-title"><div><span>01</span><h2>Job details</h2></div></div>
            <dl>
              <dt>Source URL</dt><dd><a href={job.url} target="_blank" rel="noreferrer">{job.url}<ExternalLink size={14} /></a></dd>
              <dt>Job ID</dt><dd><code>{job.id}</code></dd>
              <dt>Output folder</dt><dd><code>{job.folderName || 'Pending'}</code></dd>
              <dt>Last updated</dt><dd>{formatDate(job.updatedAt)}</dd>
            </dl>
            {job.error && <div className="notice error"><CircleAlert size={16} />{job.error}</div>}
          </section>
          <section className="files-panel">
            <div className="section-title"><div><span>02</span><h2>Files</h2></div><strong>{files.length}</strong></div>
            {files.length === 0 ? <div className="empty-files"><FileAudio size={29} /><p>No downloadable files yet.</p></div> : (
              <ul className="file-list">{files.map((file) => (
                <li key={file.name}><span className="file-icon"><FileAudio size={19} /></span><div><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)}</small></div><a href={file.downloadUrl} aria-label={`Download ${file.name}`}><ArrowDownToLine size={18} /></a></li>
              ))}</ul>
            )}
          </section>
        </div>
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

function Router() {
  const jobMatch = window.location.pathname.match(/^\/job\/([^/]+)\/?$/);
  if (jobMatch) return <JobPage id={decodeURIComponent(jobMatch[1])} />;
  if (window.location.pathname === '/health') return <HealthPage />;
  return <JobsPage />;
}

createRoot(document.getElementById('root')).render(<StrictMode><Router /></StrictMode>);