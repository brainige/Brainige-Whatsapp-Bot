import assert from 'node:assert/strict'
import {
  ROUTE_DEFINITIONS,
  ROUTE_NODES,
  STATUS_SERVICES,
} from '../src/dashboard/web/src/data/demoData.mjs'
import {
  advancePointerFrame,
  getCanvasLayout,
  getMotionPlan,
  getRouteNodes,
  normalizeHash,
  resolveRouteCurve,
  stepSpring,
} from '../src/dashboard/web/src/data/demoLogic.mjs'
import * as slice2Data from '../src/dashboard/web/src/data/demoData.mjs'
import * as slice2Logic from '../src/dashboard/web/src/data/demoLogic.mjs'

const {
  DEMO_CONVERSATIONS,
  INCOMING_SAMPLE_TEXT,
  LOG_ENTRIES,
  LOG_FILES,
  LOG_ROW_LIMIT,
  LOG_TAIL_TEMPLATES,
} = slice2Data
const {
  appendIncomingMessage,
  appendLogLine,
  filterConversations,
  filterLogEntries,
  recoverPreviewState,
  resolvePreviewState,
  resolveSelectedConversation,
} = slice2Logic

let checks = 0
function test(name, run) {
  run()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

test('all five requested routes and the fallback resolve safely', () => {
  for (const route of ['status', 'console', 'messages', 'admin', 'review']) {
    assert.equal(normalizeHash(`#/${route}`).id, route)
    assert.equal(normalizeHash(`#/${route}`).known, true)
  }
  assert.equal(normalizeHash('').id, 'status')
  assert.equal(normalizeHash('#/does-not-exist').id, 'not-found')
  assert.equal(normalizeHash('#/does-not-exist').known, false)
})

test('route map has six product-specific nodes and only valid links', () => {
  assert.equal(ROUTE_NODES.length, 6)
  const ids = new Set(ROUTE_NODES.map((node) => node.id))
  assert.equal(ids.size, ROUTE_NODES.length)
  for (const route of ROUTE_DEFINITIONS) {
    assert.equal(ids.has(route.from), true)
    assert.equal(ids.has(route.to), true)
    assert.notEqual(route.from, route.to)
  }
})

test('desktop nodes remain inside the canvas and right of the status copy', () => {
  const nodes = getRouteNodes(1440, 900)
  assert.equal(nodes.length, 6)
  for (const node of nodes) {
    assert.equal(node.x >= 700, true)
    assert.equal(node.x <= 1360, true)
    assert.equal(node.y >= 120, true)
    assert.equal(node.y <= 820, true)
  }
})

test('mobile nodes remain inside the canvas with touch-sized separation', () => {
  const nodes = getRouteNodes(390, 844)
  for (const node of nodes) {
    assert.equal(node.x >= 44, true)
    assert.equal(node.x <= 346, true)
    assert.equal(node.y >= 380, true)
    assert.equal(node.y <= 800, true)
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const distance = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)
      assert.equal(distance >= 48, true)
    }
  }
})

test('desktop route nodes reserve clear space for the health rail', () => {
  const nodes = getRouteNodes(1440, 900)
  const reservedRailTop = 900 * 0.8
  for (const node of nodes) assert.equal(node.y + 22 <= reservedRailTop, true, `${node.id} enters the health-rail clearance zone`)
})

test('tablet route nodes also reserve the health rail', () => {
  const nodes = getRouteNodes(753, 1024)
  const reservedRailTop = 1024 * 0.78
  for (const node of nodes) assert.equal(node.y + 22 <= reservedRailTop, true, `${node.id} enters the tablet health-rail clearance zone`)
})

test('canvas backing store caps DPR at two and rounds safely', () => {
  assert.deepEqual(getCanvasLayout(390, 844, 3), { width: 780, height: 1688, dpr: 2 })
  assert.deepEqual(getCanvasLayout(1440, 900, 1), { width: 1440, height: 900, dpr: 1 })
  assert.deepEqual(getCanvasLayout(0, 0, 2), { width: 1, height: 1, dpr: 2 })
})

test('motion plan honours reduced motion, pause, visibility and subpages', () => {
  assert.deepEqual(getMotionPlan({ live: true, paused: false, hidden: false, reduced: false, heroVisible: true }), { mode: 'live', fps: 60, pointer: true })
  assert.deepEqual(getMotionPlan({ live: false, paused: false, hidden: false, reduced: false, heroVisible: true }), { mode: 'ambient', fps: 30, pointer: false })
  assert.deepEqual(getMotionPlan({ live: true, paused: false, hidden: false, reduced: false, heroVisible: false }), { mode: 'ambient', fps: 30, pointer: false })
  for (const flags of [
    { live: true, paused: true, hidden: false, reduced: false, heroVisible: true },
    { live: true, paused: false, hidden: true, reduced: false, heroVisible: true },
    { live: true, paused: false, hidden: false, reduced: true, heroVisible: true },
  ]) {
    assert.deepEqual(getMotionPlan(flags), { mode: 'static', fps: 0, pointer: false })
  }
})

test('pointer frame maps X and Y springs to the correct render coordinates', () => {
  const result = advancePointerFrame({ x: 120, y: 640 }, { x: 0, v: 0 }, { x: 0, v: 0 }, 50)
  assert.equal(result.renderX, result.springX.x)
  assert.equal(result.renderY, result.springY.x)
  assert.equal(result.renderX > 0, true)
  assert.equal(result.renderY > result.renderX, true)
})

test('spring integration clamps long frames and settles without NaN', () => {
  let spring = { x: 0, v: 0 }
  for (let i = 0; i < 600; i += 1) spring = stepSpring(spring, 320, 10)
  assert.equal(Number.isFinite(spring.x), true)
  assert.equal(Number.isFinite(spring.v), true)
  assert.equal(Math.abs(spring.x - 320) < 0.5, true)
  const clamped = stepSpring({ x: 0, v: 0 }, 100, 1000)
  assert.equal(clamped.x < 100, true)
})

test('route bends are bounded at the canvas edges', () => {
  const curve = resolveRouteCurve({ x: 40, y: 40 }, { x: 300, y: 300 }, { x: 10000, y: -10000, active: true })
  assert.equal(Number.isFinite(curve.cx), true)
  assert.equal(Number.isFinite(curve.cy), true)
  assert.equal(curve.cx >= -80 && curve.cx <= 380, true)
  assert.equal(curve.cy >= -80 && curve.cy <= 380, true)
})

test('sample status data is internally consistent and contains no private identifiers', () => {
  assert.equal(STATUS_SERVICES.length, 4)
  const serialized = JSON.stringify({ ROUTE_NODES, ROUTE_DEFINITIONS, STATUS_SERVICES })
  assert.equal(/knowledge\.json|review\.db|conversations\.db/.test(serialized), false)
  assert.equal(/\+?[1-9]\d{9,14}/.test(serialized), false)
  assert.equal(/\b\d{5,15}@(c|g)\.us\b/.test(serialized), false)
  assert.equal(/\b\d{5,15}@s\.whatsapp\.net\b/.test(serialized), false)
})

test('console exposes exactly the five approved synthetic log files', () => {
  assert.deepEqual(LOG_FILES.map((file) => file.fileName), [
    'errors.txt',
    'errors.old.txt',
    'admin.txt',
    'human_needed.txt',
    'misses.txt',
  ])
  assert.equal(new Set(LOG_FILES.map((file) => file.id)).size, 5)
  for (const entry of LOG_ENTRIES) {
    assert.equal(LOG_FILES.some((file) => file.id === entry.fileId), true)
    assert.equal(['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(entry.level), true)
    assert.equal(entry.synthetic, true)
    assert.equal(typeof entry.time, 'string')
    assert.equal(entry.message.length > 0, true)
  }
})

test('log filtering combines file, case-insensitive search and level', () => {
  const rows = [
    { id: 'a', fileId: 'errors', time: '10:00:00', level: 'ERROR', message: 'Sample model unavailable' },
    { id: 'b', fileId: 'errors', time: '10:00:01', level: 'INFO', message: 'Sample MODEL recovered' },
    { id: 'c', fileId: 'admin', time: '10:00:02', level: 'INFO', message: 'Sample model status requested' },
  ]
  assert.deepEqual(filterLogEntries(rows, { fileId: 'errors', query: 'model', level: 'all' }).map((row) => row.id), ['a', 'b'])
  assert.deepEqual(filterLogEntries(rows, { fileId: 'errors', query: 'RECOVERED', level: 'INFO' }).map((row) => row.id), ['b'])
  assert.deepEqual(filterLogEntries(rows, { fileId: 'errors', query: 'missing', level: 'all' }), [])
})

test('log tail pause, deterministic append and retention cap are pure', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const paused = appendLogLine(rows, { id: 'paused' }, { live: false, limit: 3 })
  assert.equal(paused, rows)
  const next = appendLogLine(rows, { id: 'new' }, { live: true, limit: 3 })
  assert.deepEqual(next.map((row) => row.id), ['new', 'a', 'b'])
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c'])
  assert.equal(Number.isInteger(LOG_ROW_LIMIT) && LOG_ROW_LIMIT > 0, true)
  assert.equal(appendLogLine([], { id: 'default-cap' }).length <= LOG_ROW_LIMIT, true)
})

test('conversation filtering handles DMs, groups and message-body search', () => {
  assert.equal(DEMO_CONVERSATIONS.some((conversation) => conversation.kind === 'dm'), true)
  assert.equal(DEMO_CONVERSATIONS.some((conversation) => conversation.kind === 'group'), true)
  assert.equal(filterConversations(DEMO_CONVERSATIONS, { kind: 'dm', query: '' }).every((conversation) => conversation.kind === 'dm'), true)
  assert.equal(filterConversations(DEMO_CONVERSATIONS, { kind: 'group', query: '' }).every((conversation) => conversation.kind === 'group'), true)
  const expected = DEMO_CONVERSATIONS[0]
  const bodyNeedle = expected.messages[0].body.split(' ').slice(0, 3).join(' ')
  assert.deepEqual(filterConversations(DEMO_CONVERSATIONS, { kind: 'all', query: bodyNeedle.toUpperCase() }).map((conversation) => conversation.id), [expected.id])
  assert.deepEqual(filterConversations(DEMO_CONVERSATIONS, { kind: 'all', query: 'no such sample conversation' }), [])
})

test('conversation selection falls back to the first visible result or null', () => {
  const selected = DEMO_CONVERSATIONS[1]
  assert.equal(resolveSelectedConversation(DEMO_CONVERSATIONS, selected.id).id, selected.id)
  assert.equal(resolveSelectedConversation(DEMO_CONVERSATIONS, 'not-visible').id, DEMO_CONVERSATIONS[0].id)
  assert.equal(resolveSelectedConversation([], 'anything'), null)
})

test('zero-result filters preserve the previous conversation selection', () => {
  assert.equal(slice2Logic.syncSelectedConversationId('sample-dm-arjun', null), 'sample-dm-arjun')
  assert.equal(slice2Logic.syncSelectedConversationId(null, null), null)
  assert.equal(slice2Logic.syncSelectedConversationId('hidden-id', 'sample-group-design'), 'sample-group-design')
})

test('incoming append preserves other conversations and never mutates history', () => {
  const target = DEMO_CONVERSATIONS[0]
  const beforeCount = target.messages.length
  const incoming = { id: 'sample-new', direction: 'them', time: '12:00', body: 'Sample incoming test message' }
  const next = appendIncomingMessage(DEMO_CONVERSATIONS, target.id, incoming)
  assert.equal(next.find((conversation) => conversation.id === target.id).messages.length, beforeCount + 1)
  assert.equal(next.find((conversation) => conversation.id === target.id).messages.at(-1), incoming)
  assert.equal(next.find((conversation) => conversation.id === target.id).preview, incoming.body)
  assert.equal(DEMO_CONVERSATIONS[0].messages.length, beforeCount)
  assert.equal(next[1], DEMO_CONVERSATIONS[1])
})

test('every sample conversation uses explicit THEM, BOT and YOU directions', () => {
  for (const conversation of DEMO_CONVERSATIONS) {
    assert.equal(conversation.synthetic, true)
    assert.equal(conversation.name.toLowerCase().includes('sample'), true)
    assert.deepEqual(new Set(conversation.messages.map((message) => message.direction)), new Set(['them', 'bot', 'you']))
    for (const message of conversation.messages) {
      assert.equal(message.body.length > 0, true)
      if (message.media) {
        assert.equal(typeof message.media, 'string')
        assert.equal(/https?:|www\.|href|\.jpe?g\b|\.png\b|\.mp4\b/i.test(message.media), false)
      }
    }
  }
})

test('slice 2 fixtures contain no private identifiers, real files or media links', () => {
  const serialized = JSON.stringify({ LOG_FILES, LOG_ENTRIES, LOG_TAIL_TEMPLATES, DEMO_CONVERSATIONS, INCOMING_SAMPLE_TEXT })
  assert.equal(/knowledge\.json|review\.db|conversations\.db|processed_ids|chat_memory|settings\.json|\.env/i.test(serialized), false)
  assert.equal(/\+?[1-9]\d{9,14}/.test(serialized), false)
  assert.equal(/\b\d{5,15}@(c|g)\.us\b/.test(serialized), false)
  assert.equal(/\b\d{5,15}@s\.whatsapp\.net\b/.test(serialized), false)
  assert.equal(/https?:\/\/|www\./i.test(serialized), false)
})

test('preview states expose loading, empty and error distinctly and retry recovers', () => {
  assert.equal(resolvePreviewState('ready', 3), 'ready')
  assert.equal(resolvePreviewState('ready', 0), 'empty')
  assert.equal(resolvePreviewState('empty', 3), 'empty')
  assert.equal(resolvePreviewState('loading', 3), 'loading')
  assert.equal(resolvePreviewState('error', 3), 'error')
  assert.equal(resolvePreviewState('unknown', 3), 'ready')
  assert.equal(recoverPreviewState(), 'ready')
})

test('log retention caps each file without erasing other files', () => {
  const seed = [
    { id: 'admin-kept', fileId: 'admin', time: '10:00:00', level: 'INFO', message: 'Keep this admin row.' },
    { id: 'error-old', fileId: 'errors', time: '10:01:00', level: 'ERROR', message: 'Old error row.' },
  ]
  const result = appendLogLine(seed, { id: 'error-new', fileId: 'errors', time: '10:02:00', level: 'ERROR', message: 'New error row.' }, { limit: 1 })
  assert.deepEqual(result.filter((entry) => entry.fileId === 'errors').map((entry) => entry.id), ['error-new'])
  assert.equal(result.some((entry) => entry.id === 'admin-kept'), true)
})

test('incoming history has a per-conversation retention boundary', () => {
  const result = appendIncomingMessage(DEMO_CONVERSATIONS, 'sample-dm-rina', {
    id: 'capped-incoming', direction: 'them', time: '23:59', body: 'Newest synthetic question.',
  }, { limit: 2 })
  const changed = result.find((conversation) => conversation.id === 'sample-dm-rina')
  assert.equal(changed.messages.length, 2)
  assert.equal(changed.messages.at(-1).id, 'capped-incoming')
  assert.equal(result.find((conversation) => conversation.id === 'sample-dm-arjun'), DEMO_CONVERSATIONS.find((conversation) => conversation.id === 'sample-dm-arjun'))
})

test('initial log fixtures are displayed newest first in every file', () => {
  for (const file of LOG_FILES) {
    const times = filterLogEntries(LOG_ENTRIES, { fileId: file.id }).map((entry) => entry.time)
    assert.deepEqual(times, [...times].sort().reverse(), file.fileName)
  }
})

console.log(`\n${checks} dashboard frontend checks passed.`)
