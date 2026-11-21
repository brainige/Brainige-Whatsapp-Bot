import { useEffect, useRef, useState } from 'react'
import AppShell from './components/AppShell.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import RouteField from './components/RouteField.jsx'
import StatusPage from './pages/StatusPage.jsx'
import ConsolePage from './pages/ConsolePage.jsx'
import MessagesPage from './pages/MessagesPage.jsx'
import PlaceholderPage, { NotFoundPage } from './pages/PlaceholderPage.jsx'
import { NAV_ITEMS } from './data/demoData.mjs'
import { normalizeHash } from './data/demoLogic.mjs'

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

export default function App() {
  const [route, setRoute] = useState(() => normalizeHash(window.location.hash))
  const previousRouteRef = useRef(route.id)
  const reduced = useReducedMotion()
  const [paused, setPaused] = useState(() => {
    try { return window.localStorage.getItem('brainige-demo-motion-paused') === 'true' } catch { return false }
  })

  useEffect(() => {
    const onHashChange = () => setRoute(normalizeHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const item = NAV_ITEMS.find((entry) => entry.id === route.id)
    document.title = `${item ? item.title : 'Page not found'} | Brainige Dashboard`
    if (previousRouteRef.current !== route.id) {
      previousRouteRef.current = route.id
      document.getElementById('main-content')?.focus()
    }
  }, [route.id])

  useEffect(() => {
    try { window.localStorage.setItem('brainige-demo-motion-paused', String(paused)) } catch { /* preference storage is optional */ }
  }, [paused])

  let page
  if (route.id === 'status') page = <StatusPage />
  else if (route.id === 'console') page = <ConsolePage />
  else if (route.id === 'messages') page = <MessagesPage />
  else if (route.id === 'admin') page = <PlaceholderPage title="Admin commands" slice={3} />
  else if (route.id === 'review') page = <PlaceholderPage title="Review queue" slice={3} />
  else page = <NotFoundPage />

  const announcement = route.id === 'not-found' ? 'Page not found' : `${NAV_ITEMS.find((item) => item.id === route.id)?.title} page`

  return (
    <AppShell routeId={route.id} paused={paused} reduced={reduced} onToggleMotion={() => setPaused((value) => !value)}>
      <RouteField live={route.id === 'status'} paused={paused || reduced} />
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
      <main id="main-content" className={`app-main ${route.id === 'status' ? 'app-main--status' : ''}`} tabIndex={-1}>
        <ErrorBoundary key={route.id}>{page}</ErrorBoundary>
      </main>
    </AppShell>
  )
}
