import { afterEach, describe, expect, it, vi } from 'vitest'

import MuestraPage from './page'

afterEach(() => vi.unstubAllEnvs())

/** Lo que Next lanza adentro de notFound() / redirect(). */
function lanzado(): string {
  try {
    MuestraPage()
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e)
  }
  return 'nada'
}

describe('/muestra', () => {
  it('sin NEXT_PUBLIC_MODO_MUESTRA da 404', () => {
    vi.stubEnv('NEXT_PUBLIC_MODO_MUESTRA', '')
    expect(lanzado()).toMatch(/404/)
  })

  it('con NEXT_PUBLIC_MODO_MUESTRA=0 también da 404', () => {
    vi.stubEnv('NEXT_PUBLIC_MODO_MUESTRA', '0')
    expect(lanzado()).toMatch(/404/)
  })

  it('con NEXT_PUBLIC_MODO_MUESTRA=1 lleva a la bandeja', () => {
    vi.stubEnv('NEXT_PUBLIC_MODO_MUESTRA', '1')
    const d = lanzado()
    expect(d).toMatch(/^NEXT_REDIRECT/)
    expect(d).toContain('/inbox')
  })
})
