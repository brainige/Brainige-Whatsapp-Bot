import { LOG_FILES } from '../data/demoData.mjs'

export default function LogFileTabs({ selectedId, onSelect }) {
  const selectAt = (index) => {
    const next = LOG_FILES[index]
    onSelect(next.id)
    document.getElementById(`log-tab-${next.id}`)?.focus()
  }

  const onKeyDown = (event, index) => {
    let nextIndex
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % LOG_FILES.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + LOG_FILES.length) % LOG_FILES.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = LOG_FILES.length - 1
    else return
    event.preventDefault()
    selectAt(nextIndex)
  }

  return (
    <div className="log-file-tabs" role="tablist" aria-label="Synthetic log files">
      {LOG_FILES.map((file, index) => {
        const selected = file.id === selectedId
        return (
          <button
            id={`log-tab-${file.id}`}
            key={file.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="console-log-panel"
            tabIndex={selected ? 0 : -1}
            className={selected ? 'is-selected' : ''}
            onClick={() => onSelect(file.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span>{file.label}</span>
            <code>{file.fileName}</code>
          </button>
        )
      })}
    </div>
  )
}
