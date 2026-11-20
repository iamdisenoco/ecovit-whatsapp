import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  llamadas: [] as { fn: string; args: unknown }[],
  fallan: new Set<string>(),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: unknown) => {
      h.llamadas.push({ fn, args });
      return h.fallan.has(fn)
        ? { data: null, error: { message: 'boom' } }
        : { data: 3, error: null };
    },
  }),
}));

import { GET } from './route';

type Resp = { status: number; body: Record<string, unknown> };
const pedir = (auth?: string) =>
  GET(
    new Request('http://t/api/whatsapp/cron', auth ? { headers: { authorization: auth } } : {})
  ) as unknown as Promise<Resp>;

let anterior: string | undefined;
beforeEach(() => {
  anterior = process.env.CRON_SECRET;
  h.llamadas = [];
  h.fallan = new Set();
});
afterEach(() => {
  process.env.CRON_SECRET = anterior;
});

describe('GET /api/whatsapp/cron', () => {
  it('sin CRON_SECRET: 503 y no corre nada', async () => {
    delete process.env.CRON_SECRET;
    const r = await pedir('Bearer algo');
    expect(r.status).toBe(503);
    expect(h.llamadas).toEqual([]);
  });

  it('con un secreto malo (o sin encabezado): 401 y no corre nada', async () => {
    process.env.CRON_SECRET = 's3creto';
    expect((await pedir('Bearer otro')).status).toBe(401);
    expect((await pedir()).status).toBe(401);
    expect((await pedir('s3creto')).status).toBe(401);
    expect(h.llamadas).toEqual([]);
  });

  it('con el secreto: corre las tres funciones de la 0115', async () => {
    process.env.CRON_SECRET = 's3creto';
    const r = await pedir('Bearer s3creto');
    expect(r.status).toBe(200);
    expect(h.llamadas).toEqual([
      { fn: 'marcar_envios_inciertos_wa', args: { p_minutos: 2 } },
      { fn: 'limpiar_eventos_wa', args: { p_dias: 7 } },
      { fn: 'limpiar_estados_pendientes_wa', args: { p_dias: 7 } },
    ]);
    expect(r.body).toMatchObject({ inciertos: 3, eventos: 3, estados_pendientes: 3, errores: [] });
  });

  it('una que falla no tumba a las otras', async () => {
    process.env.CRON_SECRET = 's3creto';
    h.fallan.add('limpiar_eventos_wa');
    const r = await pedir('Bearer s3creto');
    expect(h.llamadas).toHaveLength(3);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inciertos: 3, eventos: null });
  });
});
