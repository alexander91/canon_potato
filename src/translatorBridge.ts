export interface TranslatorResolvedCard {
  cardId: string
  wordId?: number
}

export interface TranslatorInit {
  type: 'translator:init'
  apiBase: string
  accessToken: string | null
  // Real Translator sends these for Supabase session + token refresh.
  // The local emulator omits them and just provides a Bearer `accessToken`.
  refreshToken?: string | null
  supabaseUrl?: string
  supabaseKey?: string
  cards?: TranslatorResolvedCard[]
}

export interface TranslatorTokenRefresh {
  type: 'translator:token_refresh'
  accessToken: string
  refreshToken: string
}

export function isTranslatorInit(data: unknown): data is TranslatorInit {
  if (!data || typeof data !== 'object') return false
  return (data as { type?: unknown }).type === 'translator:init'
}

export function isTranslatorTokenRefresh(data: unknown): data is TranslatorTokenRefresh {
  if (!data || typeof data !== 'object') return false
  return (data as { type?: unknown }).type === 'translator:token_refresh'
}

export function sendGameReady(): void {
  window.parent.postMessage({ type: 'game:ready' }, '*')
}

export function sendGameClose(): void {
  window.parent.postMessage({ type: 'game:close' }, '*')
}
