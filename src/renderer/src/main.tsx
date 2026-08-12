import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createTauriGitHistoryApi } from './tauri-api'
import './styles.css'

window.gitHistory = createTauriGitHistoryApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
