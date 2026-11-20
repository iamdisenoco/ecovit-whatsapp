// ECOVIT · revisión del bloque 5: GET /api/ai/config solo para la dirección
// (system_prompt y la configuración no son para un vendedor).
import { describe, expect, it, vi } from 'vitest';

class Prohibido extends Error {}

const h = vi.hoisted(() => ({ rol: 'agent' as string }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/auth/account', () => {
  const ctx = () => ({
    accountId: 'acc-1',
    userId: 'u-1',
    role: h.rol,
    supabase: {},
  });
  return {
    getCurrentAccount: async () => ctx(),
    requireRole: async (min: string) => {
      if (min === 'admin' && h.rol !== 'admin' && h.rol !== 'owner')
        throw new Prohibido('solo admin');
      return ctx();
    },
    toErrorResponse: (err: unknown) => ({
      body: { error: String(err) },
      status: err instanceof Prohibido ? 403 : 500,
    }),
  };
});

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              provider: 'anthropic',
              model: 'm',
              system_prompt: 'secreto de negocio',
              api_key: 'x',
            },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { GET } from './route';

describe('GET /api/ai/config', () => {
  it('un vendedor no ve el system_prompt (403)', async () => {
    h.rol = 'agent';
    const res = (await GET()) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('secreto de negocio');
  });

  it('testigo: la dirección sí lo ve', async () => {
    h.rol = 'admin';
    const res = (await GET()) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };
    expect(res.status).toBe(200);
    expect(res.body.system_prompt).toBe('secreto de negocio');
  });
});
