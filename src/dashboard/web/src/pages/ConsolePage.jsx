import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DataStatePanel, { PreviewStateControl } from '../components/DemoDataState.jsx'
import LogFileTabs from '../components/LogFileTabs.jsx'
import Icon from '../components/Icons.jsx'
import {
  LOG_ENTRIES,
  LOG_FILES,
  LOG_ROW_LIMIT,
  LOG_TAIL_TEMPLATES,
} from '../data/demoData.mjs'
import {
  appendLogLine,
  filterLogEntries,
  recoverPreviewState,
  resolvePreviewState,
} from '../data/demoLogic.mjs'

const TAIL_INTERVAL_MS = 6000

function sampleTime() {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export default function ConsolePage() {
  const [rows, setRows] = useState(LOG_ENTRIES)
  const [fileId, setFileId] = useState(LOG_FILES[0].id)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [previewState, setPreviewState] = useState('ready')
  const [live, setLive] = useState(true)
  const [lastAddedId, setLastAddedId] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  const sampleIndexRef = useRef(0)

  const activeFile = LOG_FILES.find((file) => file.id === fileId)
  const visibleRows = useMemo(
    () => filterLogEntries(rows, { fileId, query, level }),
    [rows, fileId, query, level],
  )
  const sourceCount = useMemo(() => rows.filter((row) => row.fileId === fileId).length, [rows, fileId])
  const viewState = resolvePreviewState(previewState, sourceCount)
  const filtersActive = Boolean(query.trim()) || level !== 'all'
  const tailRunning = live && previewState === 'ready'

  const addSample = useCallback((announce = false) => {
    const sequence = sampleIndexRef.current
    sampleIndexRef.current += 1
    const templates = LOG_TAIL_TEMPLATES[fileId]
    const template = templates[sequence % templates.length]
    const line = {
      ...template,
      id: `sample-tail-${sequence + 1}`,
      fileId,
      time: sampleTime(),
      synthetic: true,
    }
    setRows((current) => appendLogLine(current, line, { live: true }))
    setLastAddedId(line.id)
    if (announce) {
      setAnnouncement(`Sample line added to ${activeFile.fileName}. Current filters may affect its visibility.`)
    }
  }, [fileId, activeFile.fileName])

  useEffect(() => {
    if (!tailRunning) return undefined
    const timer = window.setInterval(() => addSample(false), TAIL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [tailRunning, addSample])

  const toggleTail = () => {
    setLive((current) => !current)
    setAnnouncement(live ? 'Sample tail paused. Automatic additions stopped.' : 'Sample tail resumed.')
  }

  const focusSearch = () => {
    window.requestAnimationFrame(() => document.getElementById('log-search')?.focus())
  }

  const selectFile = (nextFileId) => {
    setFileId(nextFileId)
    setLastAddedId(null)
  }

  const clearFilters = () => {
    setQuery('')
    setLevel('all')
    focusSearch()
  }

  const retry = () => {
    setPreviewState(recoverPreviewState())
    setAnnouncement('Sample log view recovered. Ready data is visible.')
    focusSearch()
  }

  let panelContent
  if (viewState === 'loading') {
    panelContent = <DataStatePanel state="loading" title="Loading sample log lines" description="Preparing synthetic rows locally. No log file is being read." />
  } else if (viewState === 'error') {
    panelContent = <DataStatePanel state="error" title="Sample log unavailable" description="This simulated local error did not affect any bot data." actionLabel="Retry sample load" onAction={retry} />
  } else if (viewState === 'empty') {
    panelContent = <DataStatePanel state="empty" title="No sample lines in this file" description={previewState === 'empty' ? 'The empty preview is active. Choose Ready to restore the synthetic log view.' : 'This synthetic file has no retained rows.'} />
  } else if (visibleRows.length === 0) {
    panelContent = <DataStatePanel state="empty" title="No lines match these filters" description="Try a different level or search phrase. The synthetic rows are still retained." actionLabel="Clear log filters" onAction={clearFilters} />
  } else {
    panelContent = (
      <ol className="log-list" aria-label={`Synthetic rows from ${activeFile.fileName}`} tabIndex={0}>
        {visibleRows.map((row) => (
          <li
            key={row.id}
            className={`log-row ${row.id === lastAddedId ? 'is-new' : ''}`}
            onAnimationEnd={row.id === lastAddedId ? () => setLastAddedId(null) : undefined}
          >
            <time>{row.time}</time>
            <span className={`log-level log-level--${row.level.toLowerCase()}`}>{row.level}</span>
            <p>{row.message}</p>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <section className="demo-page console-page container" aria-labelledby="console-title">
      <header className="demo-page-header">
        <div>
          <p className="eyebrow">Local operations · Slice 2 demo</p>
          <h1 id="console-title">Console and operation logs</h1>
          <p className="lead">Inspect a simulated tail across five operational log views.</p>
        </div>
        <p className="demo-disclosure"><strong>Synthetic demo logs.</strong> Every line is generated in memory. No real log file is opened and no bot connection exists.</p>
      </header>

      <section className="workspace-panel" aria-label="Sample log explorer">
        <LogFileTabs selectedId={fileId} onSelect={selectFile} />
        <div className="demo-toolbar">
          <div className="control-field search-field">
            <label htmlFor="log-search">Search log messages</label>
            <input id="log-search" className="control-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search synthetic text" />
          </div>
          <div className="control-field">
            <label htmlFor="log-level">Level</label>
            <select id="log-level" className="control-input" value={level} onChange={(event) => setLevel(event.target.value)}>
              <option value="all">All levels</option>
              <option value="ERROR">Error</option>
              <option value="WARN">Warning</option>
              <option value="INFO">Info</option>
              <option value="DEBUG">Debug</option>
            </select>
          </div>
          <PreviewStateControl value={previewState} onChange={setPreviewState} />
        </div>

        <div className="tail-controls">
          <div className="tail-actions">
            <button className="button button--quiet" type="button" onClick={toggleTail} disabled={previewState !== 'ready'}>
              <Icon name={live ? 'pause' : 'play'} size={16} />
              {live ? 'Pause sample tail' : 'Resume sample tail'}
            </button>
            <button className="button button--quiet" type="button" onClick={() => addSample(true)} disabled={previewState !== 'ready'}>
              Add sample line
            </button>
          </div>
          <p className="tail-status" role="status">
            {tailRunning ? 'Live · one local line every 6 seconds' : live ? 'Tail held during this preview state' : 'Paused · automatic additions stopped'}
            <span> · newest first · {LOG_ROW_LIMIT}-row cap per file</span>
          </p>
        </div>

        <div id="console-log-panel" className="log-panel" role="tabpanel" aria-labelledby={`log-tab-${fileId}`} tabIndex={0}>
          <div className="log-summary">
            <span>{activeFile.fileName}</span>
            <span>{visibleRows.length} visible · {sourceCount} retained in this view</span>
          </div>
          {panelContent}
        </div>
      </section>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  )
}
