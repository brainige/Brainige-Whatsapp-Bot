import { DEMO_META, STATUS_SERVICES } from '../data/demoData.mjs'
import MagneticLink from '../components/MagneticLink.jsx'

export default function StatusPage() {
  return (
    <div className="status-page">
      <section className="status-hero container" data-route-hero aria-labelledby="status-title">
        <div className="status-copy">
          <h1 id="status-title">Your bot is online.</h1>
          <p className="lead">Message flow, local services and review work in one view.</p>
          <div className="status-action">
            <MagneticLink href="#/messages">Open messages</MagneticLink>
          </div>
          <p className="sample-note">{DEMO_META.session}</p>
        </div>
        <div className="route-map-region" aria-label="Interactive sample message routes" />
        <dl className="service-rail" aria-label="Sample service health">
          {STATUS_SERVICES.map((service) => (
            <div key={service.id} className={`service-item service-item--${service.tone}`}>
              <dt>{service.label}</dt>
              <dd>{service.value}</dd>
              <dd className="service-detail">{service.detail}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
