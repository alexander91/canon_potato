import { useEffect, useRef, useState } from 'react'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Card } from './types'
import {
  isTranslatorInit,
  isTranslatorTokenRefresh,
  sendGameClose,
  sendGameReady,
} from './translatorBridge'
import type { TranslatorInit } from './translatorBridge'
import PotatoGame, { CardScore } from './game/PotatoGame'
import { DEV_CARDS } from './devCards'
import './App.css'

const MIN_CARDS = 4
const HANDSHAKE_TIMEOUT_MS = 3000

/** Normalize Unicode text to NFC so Armenian և (U+0587) stays a single glyph */
function nfc(s: string): string {
  return s.normalize('NFC')
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const TTS_BUCKET = 'words_tts_collection'
const TTS_URL_TTL_S = 3600

function rowToCard(row: Record<string, unknown>): Card {
  const wordId = toOptionalNumber(row['word_id'])
  const partOfSpeech = typeof row['part_of_speech'] === 'string' && row['part_of_speech']
    ? (row['part_of_speech'] as string)
    : undefined
  return {
    id: row['id'] as string,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
    wordId,
    languagePair: [row['source_lang'], row['target_lang']] as Card['languagePair'],
    translation: {
      id: row['id'] as string,
      wordId,
      partOfSpeech,
      englishWord: { id: crypto.randomUUID(), value: nfc(row['source_word'] as string), language: row['source_lang'] as Card['languagePair'][0] },
      foreignWord: { id: crypto.randomUUID(), value: nfc(row['target_word'] as string), language: row['target_lang'] as Card['languagePair'][0] },
      transliteration: (row['transliteration'] as string | null) ? nfc(row['transliteration'] as string) : undefined,
      ttsFile: (row['ttsfile'] as string) || undefined,
    },
    imageUrlSmall: row['img_url_small'] as string,
    imageUrlLarge: row['img_url_large'] as string,
    score: row['score'] as number | undefined,
  }
}

function App() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [devMode, setDevMode] = useState(false)

  // Token used as Bearer for Translator API calls. With Supabase it's the live
  // session token; with the emulator it's the plain accessToken from init.
  const supabaseRef = useRef<SupabaseClient | null>(null)
  const apiBaseRef = useRef('')
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    let initialized = false

    async function initOnce(init: TranslatorInit) {
      if (initialized) return
      initialized = true
      await initWithCredentials(init)
    }

    sendGameReady()

    function onMessage(e: MessageEvent) {
      if (isTranslatorInit(e.data)) {
        initOnce(e.data)
      }
      if (isTranslatorTokenRefresh(e.data)) {
        tokenRef.current = e.data.accessToken
        supabaseRef.current?.auth.setSession({
          access_token: e.data.accessToken,
          refresh_token: e.data.refreshToken,
        }).catch(err => console.warn('Failed to apply refreshed token in game:', err))
      }
    }
    window.addEventListener('message', onMessage)

    // No init arrived in time: fall back. Standalone (no parent) → dev sample deck.
    const timer = setTimeout(() => {
      if (initialized) return
      if (window.parent !== window) {
        setError('Open this game from the Translator app')
        setLoading(false)
        return
      }
      initialized = true
      setDevMode(true)
      setCards(DEV_CARDS)
      setLoading(false)
    }, HANDSHAKE_TIMEOUT_MS)

    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function initWithCredentials(init: TranslatorInit) {
    try {
      apiBaseRef.current = init.apiBase
      tokenRef.current = init.accessToken

      // Supabase path (real Translator): establish a session so token refresh works.
      // The emulator omits supabase fields and we just use the Bearer token directly.
      if (init.supabaseUrl && init.supabaseKey && init.accessToken && init.refreshToken) {
        const client = createClient(init.supabaseUrl, init.supabaseKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
        supabaseRef.current = client
        const { data, error: authErr } = await client.auth.setSession({
          access_token: init.accessToken,
          refresh_token: init.refreshToken,
        })
        if (authErr) throw authErr
        tokenRef.current = data.session?.access_token ?? init.accessToken
      }

      if (!tokenRef.current) {
        setError('Please log in to the Translator app first')
        return
      }

      const cardsRes = await fetch(`${init.apiBase}/api/cards`, {
        headers: { Authorization: `Bearer ${tokenRef.current}` },
      })
      if (!cardsRes.ok) {
        setError('Failed to load cards')
        return
      }
      const rawCards = await cardsRes.json()
      const all: Card[] = Array.isArray(rawCards) ? rawCards.map(rowToCard) : []
      const resolvedIds = init.cards?.length ? new Set(init.cards.map(c => c.cardId)) : null
      const eligible = resolvedIds ? all.filter(c => resolvedIds.has(c.id)) : all

      if (eligible.length < MIN_CARDS) {
        setError(resolvedIds
          ? 'Translator did not provide enough eligible cards for this game'
          : `You need at least ${MIN_CARDS} cards to play this game`)
        return
      }
      await resolveTtsUrls(eligible)
      setCards(eligible)
    } catch (err) {
      setError('Failed to initialize game: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // TTS files live in a private Supabase storage bucket as paths like
  // "tts/hy/apple.mp3" — a plain <audio src> can't fetch them. Swap each path
  // for a signed URL the game can play directly. Cards whose file can't be
  // signed (no client, error, pending TTS) end up with no ttsFile → silent.
  async function resolveTtsUrls(eligible: Card[]) {
    const client = supabaseRef.current
    const paths = [...new Set(
      eligible.map(c => c.translation.ttsFile).filter((p): p is string => !!p && !/^https?:\/\//i.test(p))
    )]
    const urlByPath = new Map<string, string>()
    if (client && paths.length) {
      try {
        const { data, error: signErr } = await client.storage
          .from(TTS_BUCKET)
          .createSignedUrls(paths, TTS_URL_TTL_S)
        if (signErr) throw signErr
        for (const item of data ?? []) {
          if (item.path && item.signedUrl && !item.error) urlByPath.set(item.path, item.signedUrl)
        }
      } catch (err) {
        console.warn('Failed to sign TTS URLs, game will be silent:', err)
      }
    }
    for (const c of eligible) {
      const tts = c.translation.ttsFile
      if (tts && !/^https?:\/\//i.test(tts)) {
        c.translation.ttsFile = urlByPath.get(tts)
      }
    }
    const withAudio = eligible.filter(c => c.translation.ttsFile).length
    console.log(
      `[canon-potato] TTS: ${withAudio}/${eligible.length} cards playable ` +
      `(paths in deck: ${paths.length}, signed: ${urlByPath.size}, supabase client: ${client ? 'yes' : 'NO'})`
    )
  }

  // Persist per-card hit counts back to Translator at game over (fire-and-forget).
  async function saveScores(scores: CardScore[]) {
    const updates = scores.filter(s => s.score > 0)
    if (devMode || !updates.length || !apiBaseRef.current) return
    let token = tokenRef.current
    if (supabaseRef.current) {
      const { data } = await supabaseRef.current.auth.getSession()
      token = data.session?.access_token ?? token
    }
    if (!token) return
    fetch(`${apiBaseRef.current}/api/cards/scores`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ scores: updates }),
    }).catch(err => console.warn('Score update request failed:', err))
  }

  function handleBack() {
    if (window.parent !== window) sendGameClose()
    else window.location.reload()
  }

  if (!error && loading) {
    return (
      <div className="screen">
        <div className="panel"><p>Loading Canon Potato…</p></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="screen">
        <div className="panel">
          <h1>Canon Potato</h1>
          <p className="error-message">{error}</p>
          <button onClick={handleBack} className="btn btn-primary">Back to Translator</button>
        </div>
      </div>
    )
  }

  return <PotatoGame cards={cards} onGameOver={saveScores} onExit={handleBack} devMode={devMode} />
}

export default App
