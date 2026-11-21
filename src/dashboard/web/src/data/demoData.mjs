export const DEMO_META = {
  label: 'Demo',
  detail: 'Sample data',
  session: 'Sample session. No connection to your bot.',
}

export const NAV_ITEMS = [
  { id: 'status', label: 'Status', title: 'Bot status', icon: 'status' },
  { id: 'console', label: 'Console', title: 'Console and operation logs', icon: 'console' },
  { id: 'messages', label: 'Messages', title: 'Incoming messages', icon: 'messages' },
  { id: 'admin', label: 'Admin', title: 'Admin commands', icon: 'admin' },
  { id: 'review', label: 'Review', title: 'Review queue', icon: 'review' },
]

export const ROUTE_NODES = [
  { id: 'dm', label: 'Direct messages', shortLabel: 'DMs', icon: 'messages', description: 'Incoming direct chats' },
  { id: 'groups', label: 'Groups', shortLabel: 'Groups', icon: 'groups', description: 'Incoming group chats' },
  { id: 'bot', label: 'Brainige bot', shortLabel: 'Bot', icon: 'status', description: 'Reply and decision path' },
  { id: 'model', label: 'Local model', shortLabel: 'Model', icon: 'model', description: 'Local fallback service' },
  { id: 'review', label: 'Review queue', shortLabel: 'Review', icon: 'review', description: 'Human approval gate' },
  { id: 'logs', label: 'Operation logs', shortLabel: 'Logs', icon: 'console', description: 'Local decision records' },
]

export const ROUTE_DEFINITIONS = [
  { id: 'dm-bot', from: 'dm', to: 'bot', label: 'Direct messages to bot', bend: 1 },
  { id: 'groups-bot', from: 'groups', to: 'bot', label: 'Groups to bot', bend: -1 },
  { id: 'bot-model', from: 'bot', to: 'model', label: 'Bot to local model', bend: -1 },
  { id: 'model-review', from: 'model', to: 'review', label: 'Local model to review queue', bend: 1 },
  { id: 'bot-review', from: 'bot', to: 'review', label: 'Bot to review queue', bend: 1 },
  { id: 'bot-logs', from: 'bot', to: 'logs', label: 'Bot to operation logs', bend: -1 },
  { id: 'groups-logs', from: 'groups', to: 'logs', label: 'Groups to operation logs', bend: 1 },
]

export const STATUS_SERVICES = [
  { id: 'whatsapp', label: 'WhatsApp', value: 'Connected', detail: 'Sample link healthy', tone: 'positive' },
  { id: 'model', label: 'Local model', value: 'Ready', detail: 'Sample service responding', tone: 'positive' },
  { id: 'knowledge', label: 'Knowledge base', value: 'Healthy', detail: 'Sample index available', tone: 'neutral' },
  { id: 'review', label: 'Review queue', value: '6 pending', detail: 'Sample entries waiting', tone: 'attention' },
]

export const LOG_ROW_LIMIT = 120
export const MESSAGE_HISTORY_LIMIT = 80

export const LOG_FILES = [
  { id: 'errors', fileName: 'errors.txt', label: 'Errors' },
  { id: 'errors-old', fileName: 'errors.old.txt', label: 'Previous errors' },
  { id: 'admin', fileName: 'admin.txt', label: 'Admin' },
  { id: 'human-needed', fileName: 'human_needed.txt', label: 'Human needed' },
  { id: 'misses', fileName: 'misses.txt', label: 'Misses' },
]

export const LOG_ENTRIES = [
  { id: 'log-e3', fileId: 'errors', time: '09:44:06', level: 'WARN', message: 'Sample response confidence fell below the demonstration threshold.', synthetic: true },
  { id: 'log-e2', fileId: 'errors', time: '09:42:18', level: 'INFO', message: 'Sample retry completed and the demo service recovered.', synthetic: true },
  { id: 'log-e1', fileId: 'errors', time: '09:41:02', level: 'ERROR', message: 'Sample local model timed out before generating a reply.', synthetic: true },
  { id: 'log-eo3', fileId: 'errors-old', time: '08:20:11', level: 'ERROR', message: 'Sample archived browser session ended unexpectedly.', synthetic: true },
  { id: 'log-eo2', fileId: 'errors-old', time: '08:18:44', level: 'DEBUG', message: 'Sample archived reconnect counter was reset for the demo.', synthetic: true },
  { id: 'log-eo1', fileId: 'errors-old', time: '08:15:20', level: 'INFO', message: 'Sample archived startup check completed without changes.', synthetic: true },
  { id: 'log-a3', fileId: 'admin', time: '10:05:12', level: 'WARN', message: 'Sample admin command was ignored because the demo sender was not authorized.', synthetic: true },
  { id: 'log-a2', fileId: 'admin', time: '10:03:37', level: 'DEBUG', message: 'Sample admin pause state was read for this demonstration.', synthetic: true },
  { id: 'log-a1', fileId: 'admin', time: '10:02:08', level: 'INFO', message: 'Sample admin status command was accepted.', synthetic: true },
  { id: 'log-h3', fileId: 'human-needed', time: '10:14:03', level: 'ERROR', message: 'Sample urgency check requested immediate owner attention.', synthetic: true },
  { id: 'log-h2', fileId: 'human-needed', time: '10:12:19', level: 'INFO', message: 'Sample handoff notice was added to the demonstration queue.', synthetic: true },
  { id: 'log-h1', fileId: 'human-needed', time: '10:11:42', level: 'WARN', message: 'Sample sensitive request was routed for a human decision.', synthetic: true },
  { id: 'log-m3', fileId: 'misses', time: '10:27:09', level: 'WARN', message: 'Sample question remains unanswered pending owner review.', synthetic: true },
  { id: 'log-m2', fileId: 'misses', time: '10:24:26', level: 'DEBUG', message: 'Sample lexical and semantic scores were both below the demo threshold.', synthetic: true },
  { id: 'log-m1', fileId: 'misses', time: '10:21:54', level: 'INFO', message: 'Sample unmatched question was recorded for demonstration.', synthetic: true },
]

export const LOG_TAIL_TEMPLATES = {
  errors: [
    { level: 'ERROR', message: 'Sample tail: the local model did not answer within the demo timeout.' },
    { level: 'INFO', message: 'Sample tail: the next demo health check passed.' },
  ],
  'errors-old': [
    { level: 'DEBUG', message: 'Sample tail: an archived diagnostic line was rotated into view.' },
    { level: 'WARN', message: 'Sample tail: the archived demo session reported a closed connection.' },
  ],
  admin: [
    { level: 'INFO', message: 'Sample tail: an admin status check completed locally.' },
    { level: 'DEBUG', message: 'Sample tail: the demo pause preference was inspected.' },
  ],
  'human-needed': [
    { level: 'WARN', message: 'Sample tail: a sensitive demo question needs a person.' },
    { level: 'INFO', message: 'Sample tail: the owner handoff notice remains active.' },
  ],
  misses: [
    { level: 'INFO', message: 'Sample tail: a new unmatched demo question was recorded.' },
    { level: 'DEBUG', message: 'Sample tail: no demo knowledge match crossed the threshold.' },
  ],
}

export const DEMO_CONVERSATIONS = [
  {
    id: 'sample-dm-rina',
    kind: 'dm',
    name: 'Sample DM · Rina',
    synthetic: true,
    preview: 'Sample owner note: confirm the holiday schedule before replying.',
    time: '09:16',
    messages: [
      { id: 'rina-1', direction: 'them', time: '09:12', body: 'Sample question about weekend opening hours.' },
      { id: 'rina-2', direction: 'bot', time: '09:13', body: 'Sample answer: weekend hours are ten in the morning until four in the afternoon.' },
      { id: 'rina-3', direction: 'you', time: '09:16', body: 'Sample owner note: confirm the holiday schedule before replying.' },
    ],
  },
  {
    id: 'sample-dm-arjun',
    kind: 'dm',
    name: 'Sample DM · Arjun',
    synthetic: true,
    preview: 'Sample media message with an attachment note.',
    time: '09:34',
    messages: [
      { id: 'arjun-1', direction: 'them', time: '09:28', body: 'Sample request for a price overview.' },
      { id: 'arjun-2', direction: 'bot', time: '09:29', body: 'Sample answer: the demo price list has three tiers.' },
      { id: 'arjun-3', direction: 'you', time: '09:31', body: 'Sample follow-up sent by the owner.' },
      { id: 'arjun-4', direction: 'them', time: '09:34', body: 'Sample media message with an attachment note.', media: 'Sample image attachment. Media content is not available in this demo.' },
    ],
  },
  {
    id: 'sample-group-design',
    kind: 'group',
    name: 'Sample group · Design club',
    synthetic: true,
    preview: 'Sample owner announcement: share the final agenda after review.',
    time: '09:48',
    messages: [
      { id: 'design-1', direction: 'them', time: '09:43', body: 'Sample group question about the next workshop.' },
      { id: 'design-2', direction: 'bot', time: '09:45', body: 'Sample group answer: the workshop agenda is still being prepared.' },
      { id: 'design-3', direction: 'you', time: '09:48', body: 'Sample owner announcement: share the final agenda after review.' },
    ],
  },
  {
    id: 'sample-group-volunteers',
    kind: 'group',
    name: 'Sample group · Volunteer planning',
    synthetic: true,
    preview: 'Sample owner reply: the checklist is ready for discussion.',
    time: '10:06',
    messages: [
      { id: 'volunteer-1', direction: 'them', time: '10:01', body: 'Sample group request for the meeting checklist.' },
      { id: 'volunteer-2', direction: 'bot', time: '10:03', body: 'Sample group answer: the sample checklist has four items.' },
      { id: 'volunteer-3', direction: 'you', time: '10:06', body: 'Sample owner reply: the checklist is ready for discussion.' },
    ],
  },
]

export const INCOMING_SAMPLE_TEXT = [
  'Sample incoming: a new question about today’s availability.',
  'Sample incoming: a follow-up asks for a concise summary.',
  'Sample incoming: the sender requests help choosing an option.',
]
