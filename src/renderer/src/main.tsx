import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const App = lazy(() => import('./App'))

function StartupScreen(): React.JSX.Element {
  return (
    <main className="boot-screen" aria-live="polite" aria-label="正在启动 Git History Viewer">
      <div className="boot-status"><span className="boot-spinner" aria-hidden="true" /><span>正在启动...</span></div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<StartupScreen />}>
      <App />
    </Suspense>
  </StrictMode>
)
