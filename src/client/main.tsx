import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <h1>Orca Command Center</h1>
  </StrictMode>,
)
