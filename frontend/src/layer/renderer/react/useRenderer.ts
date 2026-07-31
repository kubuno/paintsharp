// The ONLY React-aware file in the rendering engine.
//
// It owns nothing but the engine's lifetime and the wiring of its events. It
// must not re-create the `Renderer` on a re-render, must not push React state
// into the hot path, and must not read engine state during render.
//
//
// THREE REACT TRAPS, NAMED, WITH THEIR COUNTERMEASURE
// ---------------------------------------------------
// 1. React #310 — a hook short-circuited by `&&`. This project has already hit
//    it (`useIsMobile() && useIsLandscape()` blowing up on resize). The
//    structural countermeasure is that THE ENGINE HAS NO HOOKS AT ALL, and this
//    adapter has exactly two — `useRef` and `useEffect` — both unconditional,
//    both at the top level, neither with a derived dependency. There is no `&&`
//    and no early `return` before a hook anywhere in this file, and there must
//    never be an `eslint-disable` in this folder.
//
// 2. An effect that re-schedules itself on every parent render. That is the
//    current `LayerThumb` bug: `paint` is a prop rebuilt on each render, so the
//    effect restarts and its `setTimeout(150)` never converges under frequent
//    re-renders. Countermeasure: the engine PUSHES thumbnails through its event
//    bus and caches them; nothing pulls them from an effect.
//
// 3. A thread freeze from synchronous work inside an effect. Countermeasure: no
//    synchronous `readPixels`, no CPU filter, ever, in an effect. Everything
//    goes through the async readback or a worker.
//
//
// WHAT THIS HOOK DELIBERATELY DOES NOT DO
// ---------------------------------------
// It does not subscribe to `'frame'`. It does not call `setState` on anything
// the engine emits during a gesture. Components that want to react to engine
// output subscribe themselves, to `'tiles-settled'` or `'thumbnails'` — both of
// which the engine rate-caps — and they do it deliberately, in their own file,
// where the cost is visible.

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { Renderer } from '../Renderer.ts'
import type { RendererDeps, RendererOptions } from '../Renderer.ts'

export interface UseRendererResult {
  /**
   * The engine, or null before the first effect runs / when WebGL2 is missing.
   * Read it in event handlers and effects — NEVER during render, or the
   * component becomes coupled to the engine's frame timing.
   */
  readonly current: Renderer | null
}

/**
 * Owns the engine's lifetime, and nothing else.
 *
 * `deps` and `opts` are captured ONCE, on mount. That is intentional and is the
 * dependency array being empty on purpose: an engine that were re-created
 * whenever a parent re-rendered would drop every GPU allocation it owns, which
 * is exactly the failure mode this hook exists to prevent. Pass a stable object
 * (a module constant, or a `useRef`'d one) — changing its contents later is a
 * no-op by design.
 */
export function useRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  deps: RendererDeps,
  opts?: RendererOptions,
): UseRendererResult {
  const ref = useRef<Renderer | null>(null)
  // Latest-value refs so the mount effect never needs them as dependencies.
  const depsRef = useRef(deps)
  const optsRef = useRef(opts)
  depsRef.current = deps
  optsRef.current = opts

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const r = Renderer.create(canvas, depsRef.current, optsRef.current)
    ref.current = r
    // The cleanup the current implementation lacks entirely (defect F10):
    // without it, every remount leaks the whole GPU allocation set.
    return () => {
      r?.dispose()
      ref.current = null
    }
    // Empty ON PURPOSE — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ref
}

/**
 * Subscribe to one engine event for the lifetime of a component.
 *
 * Separate from `useRenderer` so that the decision to let engine output reach
 * React is always an explicit, greppable call site. The callback is kept in a
 * ref, so passing an inline arrow does not re-subscribe on every render — the
 * mistake that makes an "innocent" subscription cost a listener churn per
 * frame.
 */
export function useRendererEvent<T extends Parameters<Renderer['on']>[0]>(
  rendererRef: UseRendererResult,
  type: T,
  handler: (e: Extract<import('../Renderer.ts').RendererEvent, { type: T }>) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const r = rendererRef.current
    if (!r) return
    return r.on(type, (e) => handlerRef.current(e))
    // `rendererRef` is a stable ref object; `type` is a literal in practice.
  }, [rendererRef, type])
}
