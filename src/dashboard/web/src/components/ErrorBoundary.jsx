import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error('Dashboard view render failed', error, info)
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="view-error" role="alert">
          <h1>This view could not be shown.</h1>
          <p>The rest of the demo is still available. No bot data or settings were changed.</p>
          <button className="button button--quiet" type="button" onClick={() => this.setState({ failed: false })}>
            Try this view again
          </button>
          <a className="text-link" href="#/status">Return to status</a>
        </section>
      )
    }
    return this.props.children
  }
}
