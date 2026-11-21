export default function PlaceholderPage({ title, slice }) {
  return (
    <section className="placeholder-page container">
      <h1>{title}</h1>
      <p>This screen is part of demo Slice {slice}. The Status screen and shared background are available now.</p>
      <p>No bot data or settings are connected.</p>
      <a className="text-link" href="#/status">Return to status</a>
    </section>
  )
}

export function NotFoundPage() {
  return (
    <section className="placeholder-page container" role="alert">
      <h1>Page not found.</h1>
      <p>This dashboard link does not match any of the five demo screens.</p>
      <a className="button button--quiet" href="#/status">Open bot status</a>
    </section>
  )
}
