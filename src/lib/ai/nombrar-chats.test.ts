import { describe, expect, it } from 'vitest'

import { nombrarChats } from './gasto'

const porChat = [
  { conversation_id: 'a', usd: 1, llamadas: 2 },
  { conversation_id: 'b', usd: 0.5, llamadas: 1 },
  { conversation_id: 'c', usd: 0.1, llamadas: 1 },
]

describe('nombrarChats', () => {
  it('pone el nombre, o el teléfono si no hay nombre', () => {
    const r = nombrarChats(porChat, [
      { id: 'a', contact: { name: 'Mauricio Salazar', phone: '+57 310' } },
      { id: 'b', contact: { name: '  ', phone: '+57 315 000 4821' } },
    ])
    expect(r.map((c) => c.cliente)).toEqual(['Mauricio Salazar', '+57 315 000 4821', null])
  })

  it('si la lectura falló (null), ninguno tiene nombre y no se pierde ningún chat', () => {
    const r = nombrarChats(porChat, null)
    expect(r).toHaveLength(3)
    expect(r.every((c) => c.cliente === null)).toBe(true)
    expect(r[0]).toMatchObject({ conversation_id: 'a', usd: 1, llamadas: 2 })
  })
})
