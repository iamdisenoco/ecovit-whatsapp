// ECOVIT · Bloque 3 (migración 0112): flujos y automatizaciones los crea,
// edita, activa, duplica, borra y dispara a mano solo la dirección (`admin`).
// Estas rutas escriben con la clave de servicio, que se salta RLS: si el rol
// no se exige acá, la 0112 no protege nada.
//
// La prueba corre cada ruta de escritura como vendedor (`agent`) y espera 403,
// y el testigo —la misma ruta como `admin`— NO puede dar 403: si diera, la
// prueba del vendedor no estaría midiendo el rol.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rol: 'agent' as string, minimos: [] as string[] }))

vi.mock('@/lib/auth/account', async () => {
  const { hasMinRole } = await import('@/lib/auth/roles')
  class ForbiddenError extends Error {
    readonly status = 403 as const
  }
  const ctx = () => ({
    accountId: 'acc-1',
    userId: 'u-1',
    role: h.rol,
    supabase: {},
    account: { id: 'acc-1', name: 'ECOVIT' },
  })
  return {
    ForbiddenError,
    getCurrentAccount: async () => ctx(),
    requireRole: async (min: 'admin' | 'agent' | 'viewer' | 'owner') => {
      h.minimos.push(min)
      if (!hasMinRole(h.rol as 'agent', min)) throw new ForbiddenError('Rol insuficiente')
      return ctx()
    },
    toErrorResponse: (err: unknown) =>
      err instanceof ForbiddenError
        ? Response.json({ error: err.message }, { status: 403 })
        : Response.json({ error: 'interno' }, { status: 500 }),
  }
})

// Si el rol deja pasar, la ruta sigue y toca la base: aquí la base es un
// objeto que revienta, así que el testigo da 500 (o lo que sea) pero nunca 403.
const { reventar } = vi.hoisted(() => ({
  reventar: (): never => {
    throw new Error('la base no debería tocarse en esta prueba')
  },
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: reventar }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: reventar }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => reventar() }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: async () => reventar() }))

import { POST as crearFlujo } from './flows/route'
import { PUT as editarFlujo, DELETE as borrarFlujo } from './flows/[id]/route'
import { POST as activarFlujo } from './flows/[id]/activate/route'
import { POST as crearAutomatizacion } from './automations/route'
import { PATCH as editarAutomatizacion, DELETE as borrarAutomatizacion } from './automations/[id]/route'
import { POST as duplicarAutomatizacion } from './automations/[id]/duplicate/route'
import { POST as dispararMotor } from './automations/engine/route'

const cuerpo = () =>
  new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', trigger_type: 'new_message' }),
  })
const params = { params: Promise.resolve({ id: 'f-1' }) }

const rutas: [string, () => Promise<Response>][] = [
  ['POST /api/flows', () => crearFlujo(cuerpo())],
  ['PUT /api/flows/[id]', () => editarFlujo(cuerpo(), params)],
  ['DELETE /api/flows/[id]', () => borrarFlujo(cuerpo(), params)],
  ['POST /api/flows/[id]/activate', () => activarFlujo(cuerpo(), params)],
  ['POST /api/automations', () => crearAutomatizacion(cuerpo())],
  ['PATCH /api/automations/[id]', () => editarAutomatizacion(cuerpo(), params)],
  ['DELETE /api/automations/[id]', () => borrarAutomatizacion(cuerpo(), params)],
  ['POST /api/automations/[id]/duplicate', () => duplicarAutomatizacion(cuerpo(), params)],
  ['POST /api/automations/engine', () => dispararMotor(cuerpo())],
]

beforeEach(() => {
  h.minimos = []
})

describe('flujos y automatizaciones: escribir es solo de la dirección (0112)', () => {
  it.each(rutas)('%s da 403 al vendedor', async (_nombre, llamar) => {
    h.rol = 'agent'
    const res = await llamar()
    expect(res.status).toBe(403)
    expect(h.minimos).toEqual(['admin'])
  })

  it.each(rutas)('testigo: %s no da 403 a la dirección', async (_nombre, llamar) => {
    h.rol = 'admin'
    const res = await llamar().catch(() => new Response(null, { status: 500 }))
    expect(res.status).not.toBe(403)
    expect(h.minimos).toEqual(['admin'])
  })
})
