import { describe, expect, it } from 'vitest'

import { getPageTitleKey } from './header'

describe('título de la cabecera', () => {
  it('Agentes de IA y Flujos tienen su título (antes decían «Panel»)', () => {
    expect(getPageTitleKey('/agents')).toBe('agents')
    expect(getPageTitleKey('/flows/abc/runs')).toBe('flows')
  })

  it('compara por segmento: /inboxes no es la bandeja', () => {
    expect(getPageTitleKey('/inbox')).toBe('inbox')
    expect(getPageTitleKey('/inbox/x')).toBe('inbox')
    expect(getPageTitleKey('/inboxes')).toBe('dashboard')
  })
})
