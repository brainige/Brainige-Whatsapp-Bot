import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ROUTE_DEFINITIONS } from '../data/demoData.mjs'
import { advancePointerFrame, getCanvasLayout, getMotionPlan, getRouteNodes } from '../data/demoLogic.mjs'
import { drawRouteScene } from './routeRenderer.mjs'
import Icon from './Icons.jsx'

function readPalette() {
  const styles = getComputedStyle(document.documentElement)
  return {
    accent: styles.getPropertyValue('--color-accent').trim(),
    accentSoft: styles.getPropertyValue('--color-accent-soft').trim(),
    surface: styles.getPropertyValue('--color-paper-2').trim(),
    ruleStrong: styles.getPropertyValue('--color-rule-2').trim(),
  }
}

export default function RouteField({ live, paused }) {
  const hostRef = useRef(null)
  const canvasRef = useRef(null)
  const apiRef = useRef(null)
  const activeNodeRef = useRef('bot')
  const optionsRef = useRef({ live, paused, heroVisible: true })
  const [layout, setLayout] = useState({ width: 0, height: 0, nodes: [] })
  const [activeNode, setActiveNode] = useState('bot')
  const [heroVisible, setHeroVisible] = useState(true)

  useEffect(() => {
    optionsRef.current = { live, paused, heroVisible }
    apiRef.current?.sync()
  }, [live, paused, heroVisible])

  useEffect(() => {
    if (!live) { setHeroVisible(true); return undefined }
    const hero = document.querySelector('[data-route-hero]')
    if (!hero) return undefined
    const observer = new IntersectionObserver(([entry]) => setHeroVisible(entry.isIntersecting), { threshold: 0.12 })
    observer.observe(hero)
    return () => observer.disconnect()
  }, [live])

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const fineQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    const pointer = { x: 0, y: 0, renderX: 0, renderY: 0, active: false }
    const springX = { x: 0, v: 0 }
    const springY = { x: 0, v: 0 }
    let palette = readPalette()
    let sceneLayout = { width: 0, height: 0, nodes: [] }
    let frameId = 0
    let last = 0
    let time = 18
    let pointerAttached = false
    let disposed = false
    let hidden = document.hidden

    const draw = (mode) => {
      drawRouteScene(ctx, {
        ...sceneLayout,
        routes: ROUTE_DEFINITIONS,
        activeNodeId: activeNodeRef.current,
        pointer,
        time,
        mode,
        palette,
      })
    }

    const onPointerMove = (event) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      if (!pointer.active) {
        springX.x = pointer.x; springY.x = pointer.y
        pointer.renderX = pointer.x; pointer.renderY = pointer.y
      }
      pointer.active = true
    }
    const onPointerLeave = () => { pointer.active = false }

    const frame = (now) => {
      frameId = 0
      if (disposed) return
      const plan = getMotionPlan({ ...optionsRef.current, hidden, reduced: reducedQuery.matches })
      if (plan.fps === 0) { draw('static'); return }
      if (last && now - last < 1000 / plan.fps) { frameId = requestAnimationFrame(frame); return }
      const delta = last ? Math.min(50, now - last) : 16.7
      last = now
      time += delta / 1000
      if (pointer.active && plan.pointer) {
        const next = advancePointerFrame(pointer, springX, springY, delta)
        springX.x = next.springX.x; springX.v = next.springX.v
        springY.x = next.springY.x; springY.v = next.springY.v
        pointer.renderX = next.renderX; pointer.renderY = next.renderY
      }
      draw(plan.mode)
      frameId = requestAnimationFrame(frame)
    }

    const sync = () => {
      if (disposed) return
      const plan = getMotionPlan({ ...optionsRef.current, hidden, reduced: reducedQuery.matches })
      const shouldListen = plan.pointer && fineQuery.matches
      if (shouldListen && !pointerAttached) {
        window.addEventListener('pointermove', onPointerMove, { passive: true })
        document.documentElement.addEventListener('pointerleave', onPointerLeave)
        pointerAttached = true
      } else if (!shouldListen && pointerAttached) {
        window.removeEventListener('pointermove', onPointerMove)
        document.documentElement.removeEventListener('pointerleave', onPointerLeave)
        pointerAttached = false
        pointer.active = false
      }
      if (plan.fps === 0) {
        cancelAnimationFrame(frameId)
        frameId = 0
        last = 0
        draw('static')
      } else if (!frameId) {
        last = 0
        frameId = requestAnimationFrame(frame)
      }
    }

    const resize = () => {
      const width = host.clientWidth
      const height = host.clientHeight
      const backing = getCanvasLayout(width, height, window.devicePixelRatio)
      canvas.width = backing.width
      canvas.height = backing.height
      ctx.setTransform(backing.dpr, 0, 0, backing.dpr, 0, 0)
      sceneLayout = { width, height, nodes: getRouteNodes(width, height) }
      palette = readPalette()
      setLayout(sceneLayout)
      sync()
    }
    const onVisibility = () => { hidden = document.hidden; last = 0; sync() }
    const onMotionChange = () => sync()
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    document.addEventListener('visibilitychange', onVisibility)
    reducedQuery.addEventListener('change', onMotionChange)
    fineQuery.addEventListener('change', onMotionChange)
    apiRef.current = { sync }
    resize()

    return () => {
      disposed = true
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reducedQuery.removeEventListener('change', onMotionChange)
      fineQuery.removeEventListener('change', onMotionChange)
      if (pointerAttached) {
        window.removeEventListener('pointermove', onPointerMove)
        document.documentElement.removeEventListener('pointerleave', onPointerLeave)
      }
      apiRef.current = null
      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  const selectNode = (id) => {
    activeNodeRef.current = id
    setActiveNode(id)
    apiRef.current?.sync()
  }
  const onNodeKeyDown = (event, index) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    let next = index
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = layout.nodes.length - 1
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % layout.nodes.length
    else next = (index - 1 + layout.nodes.length) % layout.nodes.length
    const node = layout.nodes[next]
    selectNode(node.id)
    document.getElementById(`route-node-${node.id}`)?.focus()
  }

  const showNodes = live && heroVisible && layout.nodes.length > 0
  const active = layout.nodes.find((node) => node.id === activeNode)
  const activeRoutes = ROUTE_DEFINITIONS.filter((route) => route.from === activeNode || route.to === activeNode)

  return (
    <>
      <div ref={hostRef} className={`route-field ${live && heroVisible ? 'is-live' : 'is-ambient'}`} aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      {showNodes && createPortal(
        <div className="route-node-layer">
          <div className="route-readout" aria-live="polite">
            <span>{active?.label}</span>
            <p>{activeRoutes.length} sample paths. Move your pointer or focus a node.</p>
          </div>
          {layout.nodes.map((node, index) => (
            <button
              id={`route-node-${node.id}`}
              key={node.id}
              type="button"
              className={`route-node ${activeNode === node.id ? 'is-active' : ''}`}
              style={{ left: node.x, top: node.y }}
              aria-label={`${node.label}. ${node.description}. Show connected routes.`}
              aria-pressed={activeNode === node.id}
              onClick={() => selectNode(node.id)}
              onFocus={() => selectNode(node.id)}
              onPointerEnter={() => selectNode(node.id)}
              onKeyDown={(event) => onNodeKeyDown(event, index)}
            >
              <Icon name={node.icon} size={17} />
              <span>{node.shortLabel}</span>
            </button>
          ))}
          <ul className="visually-hidden" aria-label="Message route descriptions">
            {ROUTE_DEFINITIONS.map((route) => <li key={route.id}>{route.label}</li>)}
          </ul>
        </div>,
        document.body,
      )}
    </>
  )
}
