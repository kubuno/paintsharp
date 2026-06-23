// Per-user, backend-persisted module preferences.
//
// Stored under `core.users.preferences[<moduleKey>]` (JSONB) via `PATCH /me`.
// PostgreSQL merges at the root level (`preferences || $1`), so writing a single
// module key never clobbers another module's keys. These settings follow the
// user across browsers/devices (unlike localStorage). The same tiny helper is
// copied verbatim into every module (modules can't share new SDK code without a
// republish).
import { useCallback } from 'react'
import { api, useAuthStore } from '@kubuno/sdk'

export function useModulePrefs<T extends Record<string, unknown>>(
  moduleKey: string,
  defaults: T,
): { prefs: T; update: (patch: Partial<T>) => Promise<void> } {
  const user = useAuthStore(s => s.user)
  const stored = (user?.preferences?.[moduleKey] as Partial<T> | undefined) ?? {}
  const prefs = { ...defaults, ...stored }

  const update = useCallback(async (patch: Partial<T>) => {
    const u = useAuthStore.getState().user
    const current = { ...defaults, ...((u?.preferences?.[moduleKey] as Partial<T> | undefined) ?? {}) }
    const next = { ...current, ...patch }
    const { data } = await api.patch<{ user: { preferences: Record<string, unknown> } }>(
      '/me',
      { preferences: { [moduleKey]: next } },
    )
    if (data?.user) useAuthStore.getState().updateUser({ preferences: data.user.preferences })
  }, [moduleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { prefs, update }
}
