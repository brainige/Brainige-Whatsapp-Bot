import { pointOnCurve, resolveRouteCurve } from '../data/demoLogic.mjs'

export function drawRouteScene(ctx, options) {
  const { width, height, nodes, routes, activeNodeId, pointer, time, mode, palette } = options
  ctx.clearRect(0, 0, width, height)
  if (!width || !height || nodes.length === 0) return

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const strength = mode === 'ambient' ? 0.26 : mode === 'static' ? 0.58 : 0.94
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const route of routes) {
    const from = byId.get(route.from)
    const to = byId.get(route.to)
    if (!from || !to) continue
    const curve = resolveRouteCurve(from, to, pointer, route.bend)
    const active = activeNodeId === route.from || activeNodeId === route.to

    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo(curve.cx, curve.cy, to.x, to.y)
    ctx.strokeStyle = active ? palette.accent : palette.ruleStrong
    ctx.globalAlpha = strength * (active ? 0.82 : 0.34)
    ctx.lineWidth = active ? 1.5 : 1
    ctx.stroke()

    const pulseCount = active ? 2 : 1
    for (let i = 0; i < pulseCount; i += 1) {
      const progress = (time * 0.075 + i * 0.48 + route.id.length * 0.037) % 1
      const point = pointOnCurve(from, curve, to, progress)
      ctx.beginPath()
      ctx.arc(point.x, point.y, active ? 2.2 : 1.5, 0, Math.PI * 2)
      ctx.fillStyle = palette.accent
      ctx.globalAlpha = strength * (active ? 0.9 : 0.46)
      ctx.fill()
    }
  }

  for (const node of nodes) {
    const active = node.id === activeNodeId
    ctx.beginPath()
    ctx.arc(node.x, node.y, active ? 10 : 7, 0, Math.PI * 2)
    ctx.fillStyle = active ? palette.accentSoft : palette.surface
    ctx.globalAlpha = strength * 0.92
    ctx.fill()
    ctx.strokeStyle = active ? palette.accent : palette.ruleStrong
    ctx.globalAlpha = strength * (active ? 0.95 : 0.55)
    ctx.lineWidth = 1
    ctx.stroke()
  }

  if (pointer.active && mode === 'live') {
    ctx.beginPath()
    ctx.arc(pointer.renderX, pointer.renderY, 11, 0, Math.PI * 2)
    ctx.strokeStyle = palette.accent
    ctx.globalAlpha = strength * 0.72
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(pointer.renderX, pointer.renderY, 2, 0, Math.PI * 2)
    ctx.fillStyle = palette.accent
    ctx.globalAlpha = strength * 0.9
    ctx.fill()
  }

  ctx.globalAlpha = 1
}
