import { LOG_ROW_LIMIT, MESSAGE_HISTORY_LIMIT, NAV_ITEMS, ROUTE_NODES } from './demoData.mjs'

const KNOWN_ROUTES = new Set(NAV_ITEMS.map((item) => item.id))

export function normalizeHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].toLowerCase()
  if (!raw) return { id: 'status', known: true }
  if (KNOWN_ROUTES.has(raw)) return { id: raw, known: true }
  return { id: 'not-found', known: false, requested: raw.slice(0, 80) }
}

export function getRouteNodes(width, height) {
  const w = Math.max(1, Number(width) || 1)
  const h = Math.max(1, Number(height) || 1)
  const positions = w < 760
    ? (() => {
        const top = Math.max(330, h * 0.52)
        const bottom = top + 180
        return {
          dm: [0.17, top / h], bot: [0.5, top / h], model: [0.83, top / h],
          groups: [0.17, bottom / h], logs: [0.5, bottom / h], review: [0.83, bottom / h],
        }
      })()
    : {
        dm: [0.52, 0.27], groups: [0.52, 0.69], bot: [0.69, 0.46],
        model: [0.88, 0.23], review: [0.88, 0.68], logs: [0.69, 0.74],
      }
  return ROUTE_NODES.map((node) => ({
    ...node,
    x: Math.round(positions[node.id][0] * w),
    y: Math.round(positions[node.id][1] * h),
  }))
}

export function getCanvasLayout(width, height, devicePixelRatio) {
  const dpr = Math.min(2, Math.max(1, Number(devicePixelRatio) || 1))
  return {
    width: Math.max(1, Math.round((Number(width) || 0) * dpr)),
    height: Math.max(1, Math.round((Number(height) || 0) * dpr)),
    dpr,
  }
}

export function getMotionPlan({ live, paused, hidden, reduced, heroVisible }) {
  if (paused || hidden || reduced) return { mode: 'static', fps: 0, pointer: false }
  if (live && heroVisible) return { mode: 'live', fps: 60, pointer: true }
  return { mode: 'ambient', fps: 30, pointer: false }
}

export function stepSpring(spring, target, deltaMs) {
  const dt = Math.min(0.05, Math.max(0, Number(deltaMs) || 0) / 1000)
  const stiffness = 34
  const damping = 11.5
  const v = spring.v + ((target - spring.x) * stiffness - spring.v * damping) * dt
  return { x: spring.x + v * dt, v }
}

export function advancePointerFrame(pointer, springX, springY, deltaMs) {
  const nextX = stepSpring(springX, pointer.x, deltaMs)
  const nextY = stepSpring(springY, pointer.y, deltaMs)
  return { springX: nextX, springY: nextY, renderX: nextX.x, renderY: nextY.x }
}

export function resolveRouteCurve(from, to, pointer = { active: false }, bend = 0) {
  const mx = (from.x + to.x) / 2
  const my = (from.y + to.y) / 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const baseX = (-dy / length) * bend * 34
  const baseY = (dx / length) * bend * 34
  const distance = Math.hypot(pointer.x - mx, pointer.y - my)
  const influence = pointer.active ? Math.max(0, 1 - distance / 300) * 0.55 : 0
  const rawCx = mx + baseX + (pointer.active ? (pointer.x - mx) * influence : 0)
  const rawCy = my + baseY + (pointer.active ? (pointer.y - my) * influence : 0)
  return {
    cx: Math.min(Math.max(from.x, to.x) + 80, Math.max(Math.min(from.x, to.x) - 80, rawCx)),
    cy: Math.min(Math.max(from.y, to.y) + 80, Math.max(Math.min(from.y, to.y) - 80, rawCy)),
  }
}

export function pointOnCurve(from, curve, to, t) {
  const u = 1 - t
  return {
    x: u * u * from.x + 2 * u * t * curve.cx + t * t * to.x,
    y: u * u * from.y + 2 * u * t * curve.cy + t * t * to.y,
  }
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase()
}

export function filterLogEntries(entries, { fileId = 'errors', query = '', level = 'all' } = {}) {
  const needle = normalizeSearch(query)
  const wantedLevel = normalizeSearch(level)
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (entry.fileId !== fileId) return false
    if (wantedLevel !== 'all' && normalizeSearch(entry.level) !== wantedLevel) return false
    if (!needle) return true
    return `${entry.time} ${entry.level} ${entry.message}`.toLowerCase().includes(needle)
  })
}

export function appendLogLine(entries, line, { live = true, limit = LOG_ROW_LIMIT } = {}) {
  const rows = Array.isArray(entries) ? entries : []
  if (!live || !line) return rows
  const parsedLimit = Number(limit)
  const cap = Number.isFinite(parsedLimit) ? Math.max(0, Math.floor(parsedLimit)) : LOG_ROW_LIMIT
  let retainedForFile = 0
  return [line, ...rows].filter((entry) => {
    if (entry.fileId !== line.fileId) return true
    retainedForFile += 1
    return retainedForFile <= cap
  })
}

export function filterConversations(conversations, { kind = 'all', query = '' } = {}) {
  const needle = normalizeSearch(query)
  return (Array.isArray(conversations) ? conversations : []).filter((conversation) => {
    if (kind !== 'all' && conversation.kind !== kind) return false
    if (!needle) return true
    const history = conversation.messages.map((message) => `${message.body} ${message.media || ''}`).join(' ')
    return `${conversation.name} ${conversation.preview} ${history}`.toLowerCase().includes(needle)
  })
}

export function resolveSelectedConversation(conversations, selectedId) {
  const rows = Array.isArray(conversations) ? conversations : []
  return rows.find((conversation) => conversation.id === selectedId) || rows[0] || null
}

export function syncSelectedConversationId(selectedId, resolvedSelectedId) {
  return resolvedSelectedId || selectedId || null
}

export function appendIncomingMessage(conversations, conversationId, message, { limit = MESSAGE_HISTORY_LIMIT } = {}) {
  const rows = Array.isArray(conversations) ? conversations : []
  if (!message || !rows.some((conversation) => conversation.id === conversationId)) return rows
  const parsedLimit = Number(limit)
  const cap = Number.isFinite(parsedLimit) ? Math.max(0, Math.floor(parsedLimit)) : MESSAGE_HISTORY_LIMIT
  return rows.map((conversation) => {
    if (conversation.id !== conversationId) return conversation
    const messages = [...conversation.messages, message]
    return {
      ...conversation,
      messages: messages.slice(Math.max(0, messages.length - cap)),
      preview: message.body,
      time: message.time,
    }
  })
}

export function resolvePreviewState(requestedState, sourceCount) {
  if (['loading', 'empty', 'error'].includes(requestedState)) return requestedState
  return Number(sourceCount) > 0 ? 'ready' : 'empty'
}

export function recoverPreviewState() {
  return 'ready'
}
