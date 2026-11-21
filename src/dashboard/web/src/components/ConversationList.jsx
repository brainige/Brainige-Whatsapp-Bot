export default function ConversationList({ conversations, selectedId, onSelect }) {
  return (
    <aside className="conversation-sidebar" aria-label="Synthetic conversations">
      <p className="conversation-count" aria-live="polite">
        {conversations.length} sample {conversations.length === 1 ? 'conversation' : 'conversations'}
      </p>
      <ul className="conversation-list">
        {conversations.map((conversation) => {
          const selected = conversation.id === selectedId
          return (
            <li key={conversation.id}>
              <button
                type="button"
                className={selected ? 'is-selected' : ''}
                aria-pressed={selected}
                onClick={() => onSelect(conversation.id)}
              >
                <span className="conversation-item-topline">
                  <span className="conversation-kind">
                    {selected ? 'Selected · ' : ''}{conversation.kind === 'dm' ? 'DM' : 'Group'}
                  </span>
                  <time>{conversation.time}</time>
                </span>
                <strong className="conversation-name">{conversation.name}</strong>
                <span className="conversation-preview">{conversation.preview}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
