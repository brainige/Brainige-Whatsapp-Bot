import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/host-grotesk'
import '@fontsource/atkinson-hyperlegible-mono'
import App from './App.jsx'
import './styles/app.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
