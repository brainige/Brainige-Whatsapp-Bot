import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConversationList from '../components/ConversationList.jsx'
import DataStatePanel, { PreviewStateControl } from '../components/DemoDataState.jsx'
import Icon from '../components/Icons.jsx'
import MessageThread from '../components/MessageThread.jsx'
import { DEMO_CONVERSATIONS, INCOMING_SAMPLE_TEXT } from '../data/demoData.mjs'
import {
  appendIncomingMessage,
  filterConversations,
  recoverPreviewState,
  resolvePreviewState,
  resolveSelectedConversation,
  syncSelectedConversationId,
} from '../data/demoLogic.mjs'

const INCOMING_INTERVAL_MS = 8000
const CONVERSATION_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'dm', label: 'DMs' },
  { id: 'group', label: 'Groups' },
]

function sampleTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function MessagesPage() {
  const [conversations, setConversations] = useState(DEMO_CONVERSATIONS)
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(DEMO_CONVERSATIONS[0].id)
  const [previewState, setPreviewState] = useState('ready')
  const [incomingLive, setIncomingLive] = useState(true)
  const [lastMessageId, setLastMessageId] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  const sampleIndexRef = useRef(0)

  const visibleConversations = useMemo(
    () => filterConversations(conversations, { kind, query }),
    [conversations, kind, query],
  )
  const selected = resolveSelectedConversation(visibleConversations, selectedId)
  const resolvedSelectedId = selected?.id || null
  const viewState = resolvePreviewState(previewState, conversations.length)
  const filtersActive = kind !== 'all' || Boolean(query.trim())
  const incomingRunning = incomingLive && previewState === 'ready' && Boolean(selected)

  useEffect(() => {
    const nextSelectedId = syncSelectedConversationId(selectedId, resolvedSelectedId)
    if (nextSelectedId !== selectedId) {
      setSelectedId(nextSelectedId)
      setLastMessageId(null)
    }
  }, [resolvedSelectedId, selectedId])

  const addIncoming = useCallback((announce = false) => {
    if (!selected) return
    const sequence = sampleIndexRef.current
    sampleIndexRef.current += 1
    const message = {
      id: `sample-incoming-${sequence + 1}`,
      direction: 'them',
      time: sampleTime(),
      body: INCOMING_SAMPLE_TEXT[sequence % INCOMING_SAMPLE_TEXT.length],
    }
    setConversations((current) => appendIncomingMessage(current, selected.id, message))
    setLastMessageId(message.id)
    if (announce) setAnnouncement(`Sample incoming message added to ${selected.name}.`)
  }, [selected])

  useEffect(() => {
    if (!incomingRunning) return undefined
    const timer = window.setInterval(() => addIncoming(false), INCOMING_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [incomingRunning, addIncoming])

  const toggleIncoming = () => {
    setIncomingLive((current) => !current)
    setAnnouncement(incomingLive ? 'Simulated incoming messages paused.' : 'Simulated incoming messages resumed.')
  }

  const focusSearch = () => {
    window.requestAnimationFrame(() => document.getElementById('conversation-search')?.focus())
  }

  const selectConversation = (conversationId) => {
    setSelectedId(conversationId)
    setLastMessageId(null)
  }

  const clearFilters = () => {
    setKind('all')
    setQuery('')
    focusSearch()
  }

  const retry = () => {
    setPreviewState(recoverPreviewState())
    setAnnouncement('Sample conversations recovered. Ready data is visible.')
    focusSearch()
  }

  let content
  if (viewState === 'loading') {
    content = <DataStatePanel state="loading" title="Loading sample conversations" description="Building synthetic conversation history locally." skeletonRows={5} />
  } else if (viewState === 'error') {
    content = <DataStatePanel state="error" title="Sample messages unavailable" description="This simulated local error did not change any conversation history." actionLabel="Retry sample load" onAction={retry} />
  } else if (viewState === 'empty') {
    content = <DataStatePanel state="empty" title="No sample conversations" description={previewState === 'empty' ? 'The empty preview is active. Choose Ready to restore the synthetic conversations.' : 'There are no synthetic conversations to display.'} />
  } else if (visibleConversations.length === 0) {
    content = <DataStatePanel state="empty" title="No conversations match" description="No synthetic name or message matches the current type and search filters." actionLabel="Clear conversation filters" onAction={clearFilters} />
  } else {
    content = (
      <div className="messages-workspace">
        <ConversationList conversations={visibleConversations} selectedId={resolvedSelectedId} onSelect={selectConversation} />
        <MessageThread conversation={selected} lastMessageId={lastMessageId} onAnimationComplete={() => setLastMessageId(null)} />
      </div>
    )
  }

  return (
    <section className="demo-page messages-page container" aria-labelledby="messages-title">
      <header className="demo-page-header">
        <div>
          <p className="eyebrow">Message operations · Slice 2 demo</p>
          <h1 id="messages-title">Incoming messages</h1>
          <p className="lead">Browse synthetic DM and group histories with local sample arrivals.</p>
        </div>
        <p className="demo-disclosure"><strong>Synthetic demo conversations.</strong> Names, messages and media notes are samples. No phone numbers, live chats or files are used.</p>
      </header>

      <section className="messages-controls" aria-label="Conversation controls">
        <div className="demo-toolbar">
          <div className="control-field">
            <span className="control-label" id="conversation-filter-label">Conversation type</span>
            <div className="filter-group" role="group" aria-labelledby="conversation-filter-label">
              {CONVERSATION_FILTERS.map((filter) => (
                <button key={filter.id} type="button" className="filter-chip" aria-pressed={kind === filter.id} onClick={() => setKind(filter.id)}>
                  {filter.label}
                </button>
              ))}
            </div>
          </div>
          <div className="control-field search-field">
            <label htmlFor="conversation-search">Search conversations</label>
            <input id="conversation-search" className="control-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sample names and messages" />
          </div>
          <PreviewStateControl value={previewState} onChange={setPreviewState} />
        </div>
        <div className="incoming-controls">
          <div className="incoming-actions">
            <button className="button button--quiet" type="button" onClick={toggleIncoming} disabled={previewState !== 'ready' || !selected}>
              <Icon name={incomingLive ? 'pause' : 'play'} size={16} />
              {incomingLive ? 'Pause sample incoming' : 'Resume sample incoming'}
            </button>
            <button className="button button--quiet" type="button" onClick={() => addIncoming(true)} disabled={previewState !== 'ready' || !selected}>
              Add sample incoming
            </button>
          </div>
          <p className="incoming-status" role="status">
            {incomingRunning
              ? `Live · one local message every 8 seconds in ${selected.name}`
              : viewState === 'ready' && !selected
                ? 'No conversation is visible. Clear the filters to choose a sample chat.'
                : incomingLive
                  ? 'Incoming simulation held during this preview state'
                  : 'Paused · automatic incoming messages stopped'}
          </p>
        </div>
      </section>

      <div className="messages-content">{content}</div>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  )
}
