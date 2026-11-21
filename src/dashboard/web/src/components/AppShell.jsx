import { DEMO_META, NAV_ITEMS } from '../data/demoData.mjs'
import Icon, { BrandMark } from './Icons.jsx'

export default function AppShell({ routeId, paused, reduced, onToggleMotion, children }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <a className="brand" href="#/status" aria-label="Brainige dashboard home">
          <BrandMark />
          <span className="brand-name">Brainige</span>
          <span className="brand-scope">Local bot console</span>
        </a>
        <nav className="primary-nav" aria-label="Dashboard pages">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.id}>
                <a href={`#/${item.id}`} aria-current={routeId === item.id ? 'page' : undefined}>
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="header-actions">
          <span className="demo-badge"><strong>{DEMO_META.label}</strong><span>{DEMO_META.detail}</span></span>
          <span className="local-note"><Icon name="local" size={16} />Local only</span>
          <button className="motion-toggle" type="button" onClick={onToggleMotion} disabled={reduced} aria-label={reduced ? 'Background animation reduced by system preference' : paused ? 'Play background animation' : 'Pause background animation'}>
            <Icon name={paused || reduced ? 'play' : 'pause'} size={16} />
            <span>{reduced ? 'Reduced motion' : paused ? 'Play background' : 'Pause background'}</span>
          </button>
        </div>
      </header>
      {children}
    </div>
  )
}
