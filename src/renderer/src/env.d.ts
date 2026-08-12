/// <reference types="vite/client" />

import type { GitHistoryApi } from '../../shared/types'

declare global {
  const __APP_VERSION__: string

  interface Window {
    gitHistory: GitHistoryApi
  }
}

export {}
