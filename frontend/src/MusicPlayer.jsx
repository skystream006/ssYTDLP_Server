import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Disc3, ListMusic, Music2, RefreshCw, Repeat, Search, Shuffle, SkipBack, SkipForward } from 'lucide-react';

function timeLabel(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function MusicPlayer({ id, request }) {
  const [job, setJob] = useState(null);
  const [songs, setSongs] = useState(null);
  const [selected, setSelected] = useState(new URLSearchParams(window.location.search).get('song'));
  const [metadata, setMetadata] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [lyricError, setLyricError] = useState('');
  const [playError, setPlayError] = useState('');
  const [mode, setMode] = useState('sylt');
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState('');
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const audioRef = useRef(null);
  const lyricRef = useRef(null);
  const autoPlayRef = useRef(new URLSearchParams(window.location.search).get('play') === '1');
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const index = songs?.findIndex((song) => song.name === selected) ?? -1;
  const song = songs?.[index];
  const lines = metadata?.sylt || [];
  const activeLine = lines.findLastIndex((line) => line.time <= position);
  const lyricsText = mode === 'sylt' ? lines.map((line) => line.text).join('\n') : metadata?.uslt || '';
  const currentCopy = copyResult?.song === selected && copyResult?.mode === mode ? copyResult : null;

  async function copyLyrics() {
    if (copying || !lyricsText.trim()) return;
    setCopying(true);
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(lyricsText);
      setCopyResult({ song: selected, mode, message: 'Lyrics copied.', error: false });
    } catch {
      setCopyResult({ song: selected, mode, message: 'Unable to copy lyrics. Check clipboard permissions and try again.', error: true });
    } finally {
      setCopying(false);
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([request(`/api/jobs/${encodeURIComponent(id)}`), request(`/api/jobs/${encodeURIComponent(id)}/files`)])
      .then(([loadedJob, result]) => {
        if (!active) return;
        const tracks = result.files.filter((file) => file.isSong);
        setJob(loadedJob);
        setSongs(tracks);
        setSelected((current) => tracks.some((file) => file.name === current) ? current : tracks[0]?.name);
      }).catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [id, request]);

  useEffect(() => {
    let active = true;
    setMetadata(null);
    setLyricError('');
    setPlayError('');
    setPosition(0);
    setPlaying(false);
    if (song) {
      const params = new URLSearchParams({ song: song.name });
      window.history.replaceState(null, '', `/job/${encodeURIComponent(id)}/player?${params}`);
      request(`/api/jobs/${encodeURIComponent(id)}/lyrics/${encodeURIComponent(song.name)}`)
        .then((result) => { if (active) setMetadata(result); })
        .catch((error) => { if (active) setLyricError(error.message); });
    }
    return () => { active = false; };
  }, [id, song, request]);

  useEffect(() => {
    const container = lyricRef.current;
    const line = container?.querySelector('[aria-current="true"]');
    if (line) container.scrollTo({
      top: line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  }, [activeLine, mode]);

  function selectSong(name) {
    autoPlayRef.current = true;
    if (selected === name) {
      audioRef.current?.play().catch(() => setPlayError('Playback could not start. Use the audio play control to retry.'));
    } else setSelected(name);
  }

  function nextSong(ended = false) {
    if (!songs?.length) return;
    if (shuffle && songs.length > 1) {
      const others = songs.filter((track) => track.name !== selected);
      selectSong(others[Math.floor(Math.random() * others.length)].name);
    } else if (index + 1 < songs.length) selectSong(songs[index + 1].name);
    else if (repeat) {
      if (songs.length === 1 && audioRef.current) audioRef.current.currentTime = 0;
      selectSong(songs[0].name);
    } else if (ended) setPlaying(false);
  }

  function previousSong() {
    if (audioRef.current?.currentTime > 3 || index === 0) audioRef.current.currentTime = 0;
    else if (index > 0) selectSong(songs[index - 1].name);
  }

  return <div className="music-workspace">
    <a className="back-link" href={`/job/${encodeURIComponent(id)}`}><ArrowLeft size={17} />Back to job</a>
    <header className="music-heading"><div><p className="eyebrow">Music player</p><h1>{job?.folderName || 'Job music'}</h1></div>
      {songs && <span>{songs.length} songs</span>}
    </header>
    {loadError && <div className="notice error" role="alert">{loadError}</div>}
    {!songs && !loadError && <div className="loading"><RefreshCw className="spin" />Loading songs</div>}
    {songs?.length === 0 && <div className="empty-files"><Music2 size={24} />No songs available.</div>}
    {song && <>
      <section className="now-playing" aria-label="Now playing">
        <div className={`music-artwork ${playing ? 'is-playing' : ''}`}>
          {metadata?.artwork ? <img src={metadata.artwork} alt={`${metadata.album || metadata.title} cover`} /> : <div className="record-art"><Disc3 size={60} strokeWidth={1.2} /></div>}
        </div>
        <div className="playback-main">
          <div className="track-heading"><div><span>{song.name.startsWith('[NoVocals]/') ? 'NoVocals' : 'Original'}</span>
            <h2>{metadata?.title || song.name.split('/').at(-1)}</h2>
            {metadata?.artist && <p>{metadata.artist}{metadata.album ? ` / ${metadata.album}` : ''}</p>}
          </div><span className="track-position">{index + 1} / {songs.length}</span></div>
          <audio key={song.streamUrl} ref={audioRef} src={song.streamUrl} controls autoPlay={autoPlayRef.current} preload="metadata"
            aria-label={`Play ${song.name}`}
            onLoadedMetadata={(event) => { event.currentTarget.volume = volumeRef.current; event.currentTarget.muted = mutedRef.current; }}
            onVolumeChange={(event) => { volumeRef.current = event.currentTarget.volume; mutedRef.current = event.currentTarget.muted; }}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => { setPlaying(true); setPlayError(''); }} onPause={() => setPlaying(false)}
            onEnded={() => nextSong(true)} onError={() => setPlayError('This song could not be played. The file may be unavailable or its format unsupported by this browser.')} />
          <div className="transport-actions">
            <button type="button" title="Previous song" aria-label="Previous song" onClick={previousSong}><SkipBack size={19} /></button>
            <button type="button" title="Next song" aria-label="Next song" disabled={!repeat && !shuffle && index === songs.length - 1} onClick={() => nextSong()}><SkipForward size={19} /></button>
            <button type="button" title="Shuffle" aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}><Shuffle size={18} /></button>
            <button type="button" title="Repeat job" aria-label="Repeat job" aria-pressed={repeat} onClick={() => setRepeat(!repeat)}><Repeat size={18} /></button>
          </div>
          {playError && <div className="notice error" role="alert">{playError}</div>}
        </div>
      </section>
      <div className="music-columns">
        <section className="music-queue" aria-label="Job songs">
          <div className="section-title"><div><ListMusic size={18} /><h2>Queue</h2></div></div>
          <label className="queue-search"><Search size={16} /><input type="search" aria-label="Search songs" placeholder="Search songs" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="queue-tracks">
            {[false, true].map((noVocals) => {
              const group = songs.filter((track) => track.name.startsWith('[NoVocals]/') === noVocals && track.name.toLowerCase().includes(search.toLowerCase()));
              return group.length > 0 && <div key={String(noVocals)}><h3>{noVocals ? '[NoVocals]' : 'Originals'}</h3>
                <ol>{group.map((track) => <li key={track.name}><button type="button" aria-current={track.name === selected ? 'true' : undefined} onClick={() => selectSong(track.name)}>
                  <Music2 size={17} /><span>{track.name.split('/').at(-1)}</span>
                  {track.name === selected && <span className="queue-indicator" aria-label={playing ? 'Playing' : 'Selected'} />}
                </button></li>)}</ol>
              </div>;
            })}
            {!songs.some((track) => track.name.toLowerCase().includes(search.toLowerCase())) && <p className="music-empty">No matching songs.</p>}
          </div>
        </section>
        <section className="music-lyrics" aria-label="Lyrics">
          <div className="section-title"><div><h2>Lyrics</h2></div>
            <div className="lyrics-actions">
              <div className="lyrics-tabs" role="group" aria-label="Lyrics type">
                <button type="button" aria-pressed={mode === 'sylt'} onClick={() => setMode('sylt')}>SYLT</button>
                <button type="button" aria-pressed={mode === 'uslt'} onClick={() => setMode('uslt')}>USLT</button>
              </div>
              <button className="lyrics-copy" type="button" title={currentCopy && !currentCopy.error ? 'Lyrics copied' : 'Copy lyrics'} aria-label="Copy lyrics"
                disabled={copying || !lyricsText.trim()} onClick={copyLyrics}>
                {copying ? <RefreshCw className="spin" size={17} /> : currentCopy && !currentCopy.error ? <Check size={17} /> : <Copy size={17} />}
              </button>
            </div>
          </div>
          {currentCopy && <div className={currentCopy.error ? 'notice error' : 'sr-only'} role={currentCopy.error ? 'alert' : 'status'}>{currentCopy.message}</div>}
          <div ref={lyricRef} className="lyric-timeline" tabIndex={0} aria-label={mode === 'sylt' ? 'Synchronized lyrics' : 'Unsynchronized lyrics'}>
            {lyricError ? <p className="notice error" role="alert">{lyricError}</p> : !metadata ? <p className="music-empty" role="status">Loading lyrics...</p>
              : mode === 'uslt' ? (metadata.uslt ? <p className="plain-lyrics">{metadata.uslt}</p> : <p className="music-empty">No USLT lyrics embedded.</p>)
                : lines.length > 0 ? <ol>{lines.map((line, lineIndex) => <li key={lineIndex}><button type="button"
                  aria-current={activeLine === lineIndex ? 'true' : undefined}
                  aria-label={`${timeLabel(line.time)} ${line.text}`}
                  onClick={() => { if (audioRef.current) audioRef.current.currentTime = line.time; }}>
                  <time>{timeLabel(line.time)}</time><span>{line.text}</span>
                </button></li>)}</ol> : <p className="music-empty">No SYLT lyrics embedded.</p>}
          </div>
        </section>
      </div>
    </>}
  </div>;
}