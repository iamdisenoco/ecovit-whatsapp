import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  since: null as string | null,
  ranges: [] as [number, number][],
  mes: null as { desde: string; hasta: string } | null,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'acc-1',
    userId: 'user-1',
    role: 'admin',
    supabase: {
      from: () => {
        // Dos consultas: la de la ventana (gte) y la del mes de Bogotá (gte + lt).
        let desde: string | null = null
        let hasta: string | null = null
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: (_col: string, value: string) => {
            desde = value
            return chain
          },
          lt: (_col: string, value: string) => {
            hasta = value
            return chain
          },
          order: () => chain,
          // Los nombres de los chats que más gastaron (conversations + contacts).
          in: async (_col: string, ids: string[]) => ({
            data: ids
              .filter((id) => id !== 'c-sin-fila')
              .map((id) => ({ id, contact: id === 'c1' ? { name: 'Ana Ruiz', phone: '+57 300' } : { name: null, phone: '+57 311' } })),
            error: null,
          }),
          range: async (from: number, to: number) => {
            if (hasta) {
              h.mes = { desde: desde!, hasta }
              const delMes = h.rows.filter(
                (r) => String(r.created_at) >= desde! && String(r.created_at) < hasta!,
              )
              return { data: delMes.slice(from, Math.min(to + 1, from + 1000)), error: null }
            }
            h.since = desde
            h.ranges.push([from, to])
            const end = Math.min(to + 1, from + 1000)
            return { data: h.rows.slice(from, end), error: null }
          },
        }
        return chain
      },
    },
  }),
  toErrorResponse: () => ({ body: { error: 'error' }, status: 500 }),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.maybeSingle = async () => ({ data: { valor: '25', definido: true }, error: null })
      return b
    },
  }),
}))

import { GET } from './route'

type UsageBody = {
  truncated: boolean
  time_zone: string
  totals: { calls: number; total_tokens: number }
  daily: { date: string; tokens: number; calls: number }[]
}

function get(query: string) {
  return GET(new Request(`http://t/api/ai/usage?${query}`)) as unknown as Promise<{
    status: number
    body: UsageBody
  }>
}

function row(createdAt: string, tokens = 10, extra: Record<string, unknown> = {}) {
  return {
    conversation_id: null,
    costo_usd: null,
    created_at: createdAt,
    mode: 'draft',
    provider: 'openai',
    model: 'gpt-test',
    prompt_tokens: tokens,
    completion_tokens: 0,
    total_tokens: tokens,
    ...extra,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-18T12:00:00Z'))
  h.rows = []
  h.since = null
  h.ranges = []
  h.mes = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/ai/usage', () => {
  it('buckets days in the caller time zone', async () => {
    h.rows = [row('2026-05-18T03:00:00Z')]
    const la = await get('days=2&tz=America/Los_Angeles')
    expect(la.body.time_zone).toBe('America/Los_Angeles')
    expect(h.since).toBe('2026-05-17T07:00:00.000Z')
    expect(la.body.daily).toEqual([
      { date: '2026-05-17', tokens: 10, calls: 1, usd: 0 },
      { date: '2026-05-18', tokens: 0, calls: 0, usd: 0 },
    ])

    const utc = await get('days=2')
    expect(utc.body.time_zone).toBe('UTC')
    expect(utc.body.daily[1]).toEqual({ date: '2026-05-18', tokens: 10, calls: 1, usd: 0 })
  })

  it('ECOVIT RF-M03.11: gasto en USD por día y por chat, de las mismas filas, y el tope', async () => {
    h.rows = [
      row('2026-05-18T10:00:00Z', 1, { conversation_id: 'c1', costo_usd: '0.002' }),
      row('2026-05-18T09:00:00Z', 1, { conversation_id: 'c2', costo_usd: 0.005 }),
      row('2026-05-17T09:00:00Z', 1, { conversation_id: 'c1', costo_usd: 0.001 }),
      row('2026-05-17T08:00:00Z', 1),
    ]
    const res = await get('days=2')
    const body = res.body as unknown as {
      daily: { date: string; usd: number }[]
      gasto: { total_usd: number; sin_costo: number; por_chat: { conversation_id: string; usd: number; llamadas: number }[]; tope_usd_mes: number }
    }
    expect(body.gasto.total_usd).toBe(0.008)
    expect(body.gasto.sin_costo).toBe(1)
    expect(body.daily.map((d) => d.usd)).toEqual([0.001, 0.007])
    expect(body.daily.reduce((n, d) => n + d.usd, 0)).toBeCloseTo(body.gasto.total_usd, 9)
    expect(body.gasto.por_chat).toEqual([
      { conversation_id: 'c2', usd: 0.005, llamadas: 1, cliente: '+57 311' },
      { conversation_id: 'c1', usd: 0.003, llamadas: 2, cliente: 'Ana Ruiz' },
    ])
    expect(body.gasto.tope_usd_mes).toBe(25)
  })

  it('ECOVIT: el tope se compara con el gasto del MES de Bogotá, no con el de la ventana', async () => {
    // Hoy (fijo) es 2026-05-18. La ventana de 90 días toma abril; el mes no.
    h.rows = [
      row('2026-05-18T10:00:00Z', 1, { conversation_id: 'c1', costo_usd: 0.004 }),
      // 1-may 03:00 UTC = 30-abr 22:00 en Bogotá: es de ABRIL (borde de abajo).
      row('2026-05-01T03:00:00Z', 1, { conversation_id: 'c1', costo_usd: 0.5 }),
      // 1-may 05:00 UTC = 1-may 00:00 en Bogotá: es de MAYO.
      row('2026-05-01T05:00:00Z', 1, { conversation_id: 'c1', costo_usd: 0.002 }),
      row('2026-04-10T10:00:00Z', 1, { conversation_id: 'c2', costo_usd: 1 }),
      // Borde de arriba: 31-may 23:59 en Bogotá entra; 1-jun 00:00 en Bogotá no.
      row('2026-06-01T04:59:00Z', 1, { conversation_id: 'c3', costo_usd: 0.01 }),
      row('2026-06-01T05:00:00Z', 1, { conversation_id: 'c3', costo_usd: 0.1 }),
    ]
    const res = await get('days=90')
    const g = (res.body as unknown as { gasto: { total_usd: number; gasto_mes_usd: number; mes: string } }).gasto
    expect(h.mes).toEqual({ desde: '2026-05-01T05:00:00.000Z', hasta: '2026-06-01T05:00:00.000Z' })
    expect(g.mes).toBe('2026-05')
    expect(g.gasto_mes_usd).toBe(0.016)
    expect(g.total_usd).toBe(1.616)
  })

  it('falls back to UTC for an invalid zone', async () => {
    const res = await get('days=2&tz=Mars/Olympus')
    expect(res.body.time_zone).toBe('UTC')
  })

  it('pages past the 1000-row response cap', async () => {
    h.rows = Array.from({ length: 2500 }, () => row('2026-05-18T10:00:00Z', 1))
    const res = await get('days=1')
    expect(res.body.totals.calls).toBe(2500)
    expect(res.body.truncated).toBe(false)
    expect(h.ranges.length).toBeGreaterThan(2)
  })

  it('ECOVIT: el gasto suma TODA la ventana aunque los tokens se corten en 10.000 filas', async () => {
    h.rows = Array.from({ length: 10_050 }, () =>
      row('2026-05-18T10:00:00Z', 1, { conversation_id: 'c1', costo_usd: 0.001 }),
    )
    const res = await get('days=1')
    expect(res.body.truncated).toBe(true)
    const g = (res.body as unknown as { gasto: { total_usd: number; gasto_mes_usd: number } }).gasto
    expect(g.total_usd).toBe(10.05)
    expect(g.gasto_mes_usd).toBe(10.05)
  })

  it('flags truncation once the row cap is exceeded', async () => {
    h.rows = Array.from({ length: 10_050 }, () => row('2026-05-18T10:00:00Z', 1))
    const res = await get('days=1')
    expect(res.body.truncated).toBe(true)
    expect(res.body.totals.calls).toBe(10_000)
  })
})
