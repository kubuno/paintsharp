// Stage 1 (GPU abstraction) — live-resource bookkeeping.
//
// The audit (F10) found that the current engine leaks: `fbPair` is overwritten
// without deleting the previous pair, per-call framebuffers are created and
// destroyed around every readback, and nothing ever released the context. The
// fix is not "remember to call delete": it is to make every GPU object pass
// through a registry, so that `dispose()` can be COMPLETE by construction and
// so a test can assert `inventory().total === 0` afterwards.

export type ResourceKind =
  | 'texture'
  | 'framebuffer'
  | 'renderbuffer'
  | 'program'
  | 'shader'
  | 'buffer'
  | 'vertexArray'
  | 'sampler'
  | 'sync'

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'texture', 'framebuffer', 'renderbuffer', 'program', 'shader',
  'buffer', 'vertexArray', 'sampler', 'sync',
]

/** Counts per kind, plus the VRAM total that the tile budget is spent against. */
export type ResourceInventory = Record<ResourceKind, number> & {
  /** Sum of all per-kind counts. */
  total: number
  /** Bytes of GPU memory attributable to live resources (textures dominate). */
  bytes: number
}

export function emptyInventory(): ResourceInventory {
  const inv = {
    total: 0, bytes: 0,
  } as ResourceInventory
  for (const k of RESOURCE_KINDS) inv[k] = 0
  return inv
}

/** Anything the tracker can own. Disposal must be idempotent. */
export interface GLResource {
  readonly resourceId: number
  readonly kind: ResourceKind
  readonly label: string
  /** GPU bytes attributable to this object; 0 for objects with no storage. */
  readonly gpuBytes: number
  readonly disposed: boolean
  dispose(): void
}

let nextResourceId = 1

/**
 * Registry of live GPU objects for one device.
 *
 * Insertion order is preserved by `Set`, and `disposeAll()` walks a snapshot in
 * REVERSE order so that dependents (framebuffers, VAOs) are released before the
 * objects they reference.
 */
export class ResourceTracker {
  private readonly live = new Set<GLResource>()

  static nextId(): number {
    return nextResourceId++
  }

  register<T extends GLResource>(r: T): T {
    this.live.add(r)
    return r
  }

  unregister(r: GLResource): void {
    this.live.delete(r)
  }

  get count(): number {
    return this.live.size
  }

  inventory(): ResourceInventory {
    const inv = emptyInventory()
    for (const r of this.live) {
      inv[r.kind]++
      inv.total++
      inv.bytes += r.gpuBytes
    }
    return inv
  }

  /** Snapshot for leak diagnostics: what is still alive, and under what label. */
  list(): { kind: ResourceKind; label: string; gpuBytes: number }[] {
    return [...this.live].map(r => ({ kind: r.kind, label: r.label, gpuBytes: r.gpuBytes }))
  }

  /** Dispose every live resource. Safe to call twice. */
  disposeAll(): void {
    const snapshot = [...this.live].reverse()
    for (const r of snapshot) {
      try {
        r.dispose()
      } catch {
        // A disposal must never prevent the rest of the teardown; the object is
        // dropped from the registry regardless so the inventory reaches zero.
        this.live.delete(r)
      }
    }
    this.live.clear()
  }
}
