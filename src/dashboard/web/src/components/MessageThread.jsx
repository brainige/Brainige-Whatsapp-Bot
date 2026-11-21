import { useEffect, useRef } from 'react'

const DIRECTION_LABELS = {
  them: 'THEM',
  bot: 'BOT',
  you: 'YOU',
}

export default function MessageThread({ conversation, lastMessageId, onAnimationComplete }) {
  const historyRef = useRef(null)
  const followLatestRef = useRef(true)
  const previousConversationRef = useRef(conversation.id)
  const latestMessageId = conversation.messages.at(-1)?.id

  useEffect(() => {
    const history = historyRef.current
    if (!history) return
    const selectionChanged = previousConversationRef.current !== conversation.id
    if (selectionChanged || followLatestRef.current) {
      history.scrollTop = history.scrollHeight
      followLatestRef.current = true
    }
    previousConversationRef.current = conversation.id
  }, [conversation.id, latestMessageId])

  const handleScroll = (event) => {
    const history = event.currentTarget
    followLatestRef.current = history.scrollHeight - history.scrollTop - history.clientHeight <= 48
  }

  return (
    <section className="message-detail" aria-labelledby="message-thread-title">
      <header className="message-detail-header">
        <p className="eyebrow">{conversation.kind === 'dm' ? 'Sample direct message' : 'Sample group'}</p>
        <h2 id="message-thread-title">{conversation.name}</h2>
        <p>Synthetic history only. No live chat or media is connected.</p>
      </header>
      <ol
        ref={historyRef}
        className="message-history"
        aria-label={`Synthetic message history for ${conversation.name}`}
        tabIndex={0}
        onScroll={handleScroll}
      >
        {conversation.messages.map((message) => (
          <li
            key={message.id}
            className={`message-item message-item--${message.direction} ${message.id === lastMessageId ? 'is-new' : ''}`}
            onAnimationEnd={message.id === lastMessageId ? onAnimationComplete : undefined}
          >
            <div className="message-meta">
              <span className={`message-direction message-direction--${message.direction}`}>
                {DIRECTION_LABELS[message.direction]}
              </span>
              <time>{message.time}</time>
            </div>
            <p className="message-body">{message.body}</p>
            {message.media && (
              <p className="message-media-note"><strong>Media note:</strong> {message.media}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
