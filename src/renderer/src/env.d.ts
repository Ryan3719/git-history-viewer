/// <reference types="vite/client" />

import type { GitHistoryApi } from '../../shared/types'

declare global {
  interface Window {
    gitHistory: GitHistoryApi
  }
}

export {}
