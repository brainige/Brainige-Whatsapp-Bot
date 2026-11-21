import { useId } from 'react'

export function PreviewStateControl({ value, onChange }) {
  const id = useId()
  return (
    <div className="control-field preview-state-field">
      <label htmlFor={id}>Preview data state</label>
      <select id={id} className="control-input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="ready">Ready</option>
        <option value="loading">Loading</option>
        <option value="empty">Empty</option>
        <option value="error">Error</option>
      </select>
    </div>
  )
}

export default function DataStatePanel({ state, title, description, actionLabel, onAction, skeletonRows = 4 }) {
  if (state === 'ready') return null
  const loading = state === 'loading'
  return (
    <div
      className={`data-state data-state--${state}`}
      role={state === 'error' ? 'alert' : 'status'}
      aria-busy={loading || undefined}
    >
      {loading && (
        <div className="data-skeleton" aria-hidden="true">
          {Array.from({ length: skeletonRows }, (_, index) => <span key={index} />)}
        </div>
      )}
      <div className="data-state-copy">
        <h2>{title}</h2>
        <p>{description}</p>
        {onAction && (
          <button className="button button--quiet" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}
