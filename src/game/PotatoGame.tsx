import { useEffect, useRef, useState, useCallback } from 'react'
import { Card } from '../types'

export interface CardScore {
  cardId: string
  score: number
}

interface PotatoGameProps {
  cards: Card[]
  onGameOver: (scores: CardScore[]) => void
  onExit: () => void
  devMode?: boolean
}

/** Normalize Unicode text to NFC so Armenian և (U+0587) stays a single glyph */
function nfc(s: string): string {
  return s.normalize('NFC')
}

// ----- Playfield geometry (SVG viewBox units) -----
const VIEW_W = 1000
const VIEW_H = 600
const PIVOT_X = VIEW_W / 2
const PIVOT_Y = 545
const BARREL_LEN = 130
const OVAL_RX = 92
const OVAL_RY = 52
const OVAL_Y = 120

// ----- Tuning -----
const MAX_ANGLE = 72          // degrees from vertical, each side
const ROT_SPEED = 95          // deg / second while a key is held
const SHOT_SPEED = 1100       // units / second
const POTATO_R = 18
const ROUND_TIME = 12         // seconds per word
const RELOAD_TIME = 3.3       // seconds to reload after every shot
const MAX_OVALS = 5

type Phase = 'ready' | 'playing' | 'over'

interface Oval {
  cardId: string
  word: string
  correct: boolean
  x: number
  y: number
}

interface Projectile {
  x: number
  y: number
  vx: number
  vy: number
}

interface GameModel {
  phase: Phase
  angleDeg: number
  ovals: Oval[]
  english: string
  pos?: string
  projectile: Projectile | null
  timeLeft: number
  loaded: boolean
  reloadLeft: number
  score: number
  scoreMap: Record<string, number>
  flash: { x: number; y: number; t: number } | null
  recentTargetId: string | null
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Build a fresh round: pick a target card + distractor ovals. */
function buildRound(cards: Card[], avoidId: string | null): {
  ovals: Oval[]
  english: string
  pos?: string
  targetId: string
} {
  const pool = cards.length > 1 && avoidId ? cards.filter(c => c.id !== avoidId) : cards
  const target = pool[Math.floor(Math.random() * pool.length)]
  const count = Math.min(MAX_OVALS, cards.length)

  const distractors = shuffle(cards.filter(c => c.id !== target.id)).slice(0, count - 1)
  const chosen = shuffle([target, ...distractors])

  // Spread ovals evenly across the top, leaving margins.
  const margin = OVAL_RX + 20
  const span = VIEW_W - margin * 2
  const ovals: Oval[] = chosen.map((c, i) => ({
    cardId: c.id,
    word: nfc(c.translation.foreignWord.value),
    correct: c.id === target.id,
    x: count === 1 ? VIEW_W / 2 : margin + (span * i) / (count - 1),
    y: OVAL_Y,
  }))

  return {
    ovals,
    english: target.translation.englishWord.value,
    pos: target.translation.partOfSpeech,
    targetId: target.id,
  }
}

function pointInOval(px: number, py: number, o: Oval): boolean {
  const dx = (px - o.x) / (OVAL_RX + POTATO_R)
  const dy = (py - o.y) / (OVAL_RY + POTATO_R)
  return dx * dx + dy * dy <= 1
}

/** Gun-tip position for the current angle. */
function barrelTip(angleDeg: number, pivotY = PIVOT_Y): { x: number; y: number } {
  const r = (angleDeg * Math.PI) / 180
  return {
    x: PIVOT_X + BARREL_LEN * Math.sin(r),
    y: pivotY - BARREL_LEN * Math.cos(r),
  }
}

export default function PotatoGame({ cards, onGameOver, onExit, devMode }: PotatoGameProps) {
  const [, forceRender] = useState(0)
  const tick = useCallback(() => forceRender(v => (v + 1) & 0xffff), [])

  const svgRef = useRef<SVGSVGElement | null>(null)
  const keys = useRef({ left: false, right: false })
  const fireReq = useRef(false)
  const skipNextTouchUp = useRef(false)

  // Portrait letterboxes the 1000x600 playfield, centering it vertically and
  // leaving empty bands top/bottom. Keep the ovals where they are (xMidYMid) but
  // nudge the gun down into the lower band — by HALF the gap between the centered
  // and bottom-anchored positions — so it sits lower without dragging the ovals.
  const [gunDy, setGunDy] = useState(0)
  const pivotYRef = useRef(PIVOT_Y)
  useEffect(() => {
    function measure() {
      const svg = svgRef.current
      const portrait = window.matchMedia('(orientation: portrait)').matches
      if (!svg || !portrait) { pivotYRef.current = PIVOT_Y; setGunDy(0); return }
      const rect = svg.getBoundingClientRect()
      const scale = rect.width / VIEW_W            // meet → fit width in portrait
      const freeSpace = rect.height - VIEW_H * scale // empty band, screen px
      // Half the center→bottom shift, converted from screen px to viewBox units.
      const dy = (freeSpace / 4) / scale
      pivotYRef.current = PIVOT_Y + dy
      setGunDy(dy)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [])
  const rafRef = useRef<number | null>(null)
  const lastTs = useRef<number | null>(null)
  const reportedOver = useRef(false)

  const model = useRef<GameModel>({
    phase: 'ready',
    angleDeg: 0,
    ovals: [],
    english: '',
    pos: undefined,
    projectile: null,
    timeLeft: ROUND_TIME,
    loaded: true,
    reloadLeft: 0,
    score: 0,
    scoreMap: {},
    flash: null,
    recentTargetId: null,
  })

  const newRound = useCallback(() => {
    const m = model.current
    const r = buildRound(cards, m.recentTargetId)
    m.ovals = r.ovals
    m.english = r.english
    m.pos = r.pos
    m.recentTargetId = r.targetId
    m.projectile = null
    m.timeLeft = ROUND_TIME
  }, [cards])

  const fire = useCallback(() => {
    const m = model.current
    // One potato chambered at a time: must be loaded and have no shot in flight.
    if (m.phase !== 'playing' || m.projectile || !m.loaded) return
    const tip = barrelTip(m.angleDeg, pivotYRef.current)
    const r = (m.angleDeg * Math.PI) / 180
    m.projectile = {
      x: tip.x,
      y: tip.y,
      vx: SHOT_SPEED * Math.sin(r),
      vy: -SHOT_SPEED * Math.cos(r),
    }
    // Firing empties the gun — start reloading immediately.
    m.loaded = false
    m.reloadLeft = RELOAD_TIME
  }, [])

  const finish = useCallback(() => {
    const m = model.current
    m.phase = 'over'
    m.projectile = null
    if (!reportedOver.current) {
      reportedOver.current = true
      const scores = Object.entries(m.scoreMap).map(([cardId, score]) => ({ cardId, score }))
      onGameOver(scores)
    }
  }, [onGameOver])

  // Main loop.
  useEffect(() => {
    function step(ts: number) {
      const m = model.current
      if (lastTs.current == null) lastTs.current = ts
      let dt = (ts - lastTs.current) / 1000
      lastTs.current = ts
      if (dt > 0.05) dt = 0.05 // clamp after tab-switch / hitches

      if (m.phase === 'playing') {
        // Rotate
        if (keys.current.left) m.angleDeg -= ROT_SPEED * dt
        if (keys.current.right) m.angleDeg += ROT_SPEED * dt
        if (m.angleDeg < -MAX_ANGLE) m.angleDeg = -MAX_ANGLE
        if (m.angleDeg > MAX_ANGLE) m.angleDeg = MAX_ANGLE

        if (fireReq.current) {
          fireReq.current = false
          fire()
        }

        // Reload after each shot.
        if (!m.loaded) {
          m.reloadLeft -= dt
          if (m.reloadLeft <= 0) {
            m.reloadLeft = 0
            m.loaded = true
          }
        }

        // Round timer
        m.timeLeft -= dt
        if (m.timeLeft <= 0) {
          m.timeLeft = 0
          finish()
        }

        // Projectile
        const p = m.projectile
        if (p) {
          p.x += p.vx * dt
          p.y += p.vy * dt
          let resolved = false
          for (const o of m.ovals) {
            if (pointInOval(p.x, p.y, o)) {
              resolved = true
              if (o.correct) {
                m.score += 1
                m.scoreMap[o.cardId] = (m.scoreMap[o.cardId] || 0) + 1
                m.flash = { x: o.x, y: o.y, t: 0.4 }
                newRound() // advance; reload (if any) continues into the new word
              } else {
                m.projectile = null // wrong oval: shot wasted, keep playing
              }
              break
            }
          }
          if (!resolved && (p.y < -40 || p.x < -40 || p.x > VIEW_W + 40)) {
            m.projectile = null // flew off screen: shot wasted
          }
        }
      }

      if (m.flash) {
        m.flash.t -= dt
        if (m.flash.t <= 0) m.flash = null
      }

      tick()
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      lastTs.current = null
    }
  }, [fire, finish, newRound, tick])

  // Keyboard controls.
  useEffect(() => {
    function down(e: KeyboardEvent) {
      const m = model.current
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.current.left = true
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.current.right = true
      else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (m.phase === 'ready') startPlaying()
        else if (m.phase === 'playing') fireReq.current = true
      } else return
      e.preventDefault()
    }
    function up(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keys.current.left = false
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keys.current.right = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startPlaying() {
    const m = model.current
    newRound()
    m.score = 0
    m.scoreMap = {}
    m.angleDeg = 0
    m.loaded = true
    m.reloadLeft = 0
    m.flash = null
    reportedOver.current = false
    m.phase = 'playing'
  }

  function restart() {
    startPlaying()
  }

  // Aim the gun at a screen point (clamped to the allowed arc).
  function aimAt(clientX: number, clientY: number) {
    const m = model.current
    if (m.phase !== 'playing' || !svgRef.current) return
    // Map the screen point into viewBox coordinates exactly — getBoundingClientRect
    // ignores letterboxing from preserveAspectRatio="meet", which skewed the aim.
    const ctm = svgRef.current.getScreenCTM()
    if (!ctm) return
    const pt = svgRef.current.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const loc = pt.matrixTransform(ctm.inverse())
    const x = loc.x
    const y = loc.y
    let ang = (Math.atan2(x - PIVOT_X, -(y - pivotYRef.current)) * 180) / Math.PI
    if (ang < -MAX_ANGLE) ang = -MAX_ANGLE
    if (ang > MAX_ANGLE) ang = MAX_ANGLE
    m.angleDeg = ang
  }

  // Mouse follows the cursor in real time; click fires.
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    aimAt(e.clientX, e.clientY)
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const m = model.current
    if (m.phase === 'ready') {
      startPlaying()
      // The release of this same gesture must not fire a shot.
      if (e.pointerType === 'touch') skipNextTouchUp.current = true
      return
    }
    aimAt(e.clientX, e.clientY)
    // Touch: aim on press/drag, fire on release. Mouse: click fires immediately.
    if (e.pointerType !== 'touch') fireReq.current = true
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType !== 'touch') return
    const m = model.current
    if (m.phase !== 'playing') return
    if (skipNextTouchUp.current) { skipNextTouchUp.current = false; return }
    aimAt(e.clientX, e.clientY)
    fireReq.current = true
  }

  const m = model.current
  const secs = Math.ceil(m.timeLeft)
  const lowTime = m.timeLeft <= 5

  return (
    <div className="screen game-screen">
      {/* HUD */}
      <div className="hud">
        <div className="hud-item">
          <span className="hud-label">SCORE</span>
          <span className="hud-value">{m.score}</span>
        </div>
        <div className={`hud-item timer${lowTime ? ' timer-low' : ''}`}>
          <span className="hud-label">TIMER</span>
          <span className="hud-value">{secs}</span>
        </div>
        {devMode && <span className="dev-badge">DEV</span>}
        <button className="btn btn-exit" onClick={onExit}>✕</button>
      </div>

      <div className="playfield-wrap">
        <svg
          ref={svgRef}
          className="playfield"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          {/* Ovals (target words in study language) */}
          {m.ovals.map((o, i) => {
            const len = o.word.length
            const fontSize = len > 14 ? 18 : len > 9 ? 24 : 30
            return (
              <g key={`${o.cardId}-${i}`}>
                <ellipse
                  cx={o.x}
                  cy={o.y}
                  rx={OVAL_RX}
                  ry={OVAL_RY}
                  className="oval"
                />
                <text
                  x={o.x}
                  y={o.y}
                  className="oval-text"
                  fontSize={fontSize}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {o.word}
                </text>
              </g>
            )
          })}

          {/* Hit flash */}
          {m.flash && (
            <circle
              cx={m.flash.x}
              cy={m.flash.y}
              r={OVAL_RX * (1.4 - m.flash.t)}
              className="hit-flash"
              opacity={m.flash.t / 0.4}
            />
          )}

          {/* Aim guide (shifted with the gun in portrait) */}
          {m.phase === 'playing' && (
            <line
              x1={PIVOT_X}
              y1={PIVOT_Y}
              x2={PIVOT_X + (BARREL_LEN + 600) * Math.sin((m.angleDeg * Math.PI) / 180)}
              y2={PIVOT_Y - (BARREL_LEN + 600) * Math.cos((m.angleDeg * Math.PI) / 180)}
              className="aim-line"
              transform={`translate(0 ${gunDy})`}
            />
          )}

          {/* Projectile potato */}
          {m.projectile && (
            <g transform={`translate(${m.projectile.x} ${m.projectile.y})`}>
              <ellipse rx={POTATO_R} ry={POTATO_R * 0.82} className="potato" />
              <ellipse cx={-5} cy={-3} rx={2} ry={2.6} className="potato-eye" />
              <ellipse cx={5} cy={-3} rx={2} ry={2.6} className="potato-eye" />
            </g>
          )}

          {/* Pistol — top-down view, rotates as a single piece around the grip */}
          <g
            transform={`translate(0 ${gunDy}) rotate(${m.angleDeg} ${PIVOT_X} ${PIVOT_Y})`}
            className={`pistol${m.loaded ? ' loaded' : ' reloading'}`}
          >
            {/* grip (behind everything) */}
            <rect x={PIVOT_X - 25} y={PIVOT_Y + 2} width={50} height={50} rx={18} className="pistol-grip" />
            <line x1={PIVOT_X - 14} y1={PIVOT_Y + 16} x2={PIVOT_X + 14} y2={PIVOT_Y + 16} className="pistol-line" />
            <line x1={PIVOT_X - 14} y1={PIVOT_Y + 28} x2={PIVOT_X + 14} y2={PIVOT_Y + 28} className="pistol-line" />
            <line x1={PIVOT_X - 14} y1={PIVOT_Y + 40} x2={PIVOT_X + 14} y2={PIVOT_Y + 40} className="pistol-line" />
            {/* trigger guard ring at the slide/grip junction */}
            <circle cx={PIVOT_X} cy={PIVOT_Y + 6} r={14} className="pistol-guard" />
            {/* slide / barrel */}
            <rect x={PIVOT_X - 18} y={PIVOT_Y - BARREL_LEN} width={36} height={BARREL_LEN + 8} rx={11} className="pistol-slide" />
            {/* ejection port */}
            <rect x={PIVOT_X - 6} y={PIVOT_Y - 62} width={12} height={24} rx={3} className="pistol-port" />
            {/* rear-slide serrations */}
            <line x1={PIVOT_X - 11} y1={PIVOT_Y - 14} x2={PIVOT_X + 11} y2={PIVOT_Y - 14} className="pistol-serration" />
            <line x1={PIVOT_X - 11} y1={PIVOT_Y - 6} x2={PIVOT_X + 11} y2={PIVOT_Y - 6} className="pistol-serration" />
            {/* front sight + muzzle bore */}
            <rect x={PIVOT_X - 4} y={PIVOT_Y - BARREL_LEN + 1} width={8} height={6} rx={1} className="pistol-detail" />
            <circle cx={PIVOT_X} cy={PIVOT_Y - BARREL_LEN + 12} r={6} className="pistol-bore" />
            {/* chambered potato — only visible while loaded */}
            {m.loaded && (
              <circle cx={PIVOT_X} cy={PIVOT_Y - BARREL_LEN + 12} r={4} className="pistol-chamber" />
            )}
          </g>

          {/* Reload indicator — fixed ring around the grip (does not rotate) */}
          {m.phase === 'playing' && !m.loaded && (() => {
            const R = 46
            const C = 2 * Math.PI * R
            const prog = Math.min(1, 1 - m.reloadLeft / RELOAD_TIME)
            return (
              <g transform={`translate(0 ${gunDy})`}>
                <circle cx={PIVOT_X} cy={PIVOT_Y} r={R} className="reload-track" />
                <circle
                  cx={PIVOT_X}
                  cy={PIVOT_Y}
                  r={R}
                  className="reload-progress"
                  transform={`rotate(-90 ${PIVOT_X} ${PIVOT_Y})`}
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - prog)}
                />
              </g>
            )
          })()}
        </svg>

        {/* English word to shoot — bottom-right per the design sketch */}
        {m.phase === 'playing' && (
          <div className="target-word">
            <span className="target-label">shoot</span>
            <span className="target-en">{m.english}</span>
            {m.pos && <span className="target-pos">{m.pos}</span>}
          </div>
        )}

        {/* Reloading label near the gun */}
        {m.phase === 'playing' && !m.loaded && (
          <div className="reload-label">Reloading…</div>
        )}

        {/* Ready overlay */}
        {m.phase === 'ready' && (
          <div className="overlay start-overlay" onClick={startPlaying}>
            <div className="panel">
              <h1>Canon Potato</h1>
              <p>Rotate the cannon and shoot the bubble that matches the English word.</p>
              <ul className="help">
                <li><b>Move the mouse</b> — aim</li>
                <li><b>Click</b> or <b>Space</b> — fire</li>
                <li>or <b>◀ ▶</b> / <b>A D</b> to aim</li>
                <li>Every shot empties the gun — wait to <b>reload</b></li>
                <li>Timer hits 0 → game over</li>
              </ul>
              <button className="btn btn-primary" onClick={startPlaying}>Start</button>
            </div>
          </div>
        )}

        {/* Game over overlay */}
        {m.phase === 'over' && (
          <div className="overlay over-overlay">
            <div className="panel">
              <h1>Game Over</h1>
              <p className="final-score">Score: <b>{m.score}</b></p>
              <div className="game-actions">
                <button className="btn btn-primary" onClick={restart}>Play Again</button>
                <button className="btn btn-secondary" onClick={onExit}>Back to Translator</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
