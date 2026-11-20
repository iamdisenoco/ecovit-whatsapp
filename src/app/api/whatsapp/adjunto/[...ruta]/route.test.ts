import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  remitente: 'customer' as string,
  firmado: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({
    accountId: 'acc-1',
    userId: 'u-1',
    role: 'agent',
    supabase: {
      from: () => {
        const filtros: Record<string, unknown> = {};
        const chain = {
          select: () => chain,
          eq: (c: string, v: unknown) => {
            filtros[c] = v;
            return chain;
          },
          in: (c: string, v: unknown[]) => {
            filtros[c] = v;
            return chain;
          },
          // Hay UN mensaje visible con esa URL; su remitente es h.remitente.
          limit: async () => {
            const f = filtros.sender_type;
            const pasa =
              f === undefined ||
              f === h.remitente ||
              (Array.isArray(f) && f.includes(h.remitente));
            return { data: pasa ? [{ id: 'm-1' }] : [], error: null };
          },
        };
        return chain;
      },
    },
  }),
  toErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (ruta: string) => {
          h.firmado.push(ruta);
          return {
            data: { signedUrl: `https://almacen.example/firmado/${ruta}` },
            error: null,
          };
        },
      }),
    },
  }),
}));

import { GET } from './route';

function pedir(ruta: string) {
  return GET(new Request(`http://local/api/whatsapp/adjunto/${ruta}`), {
    params: Promise.resolve({ ruta: ruta.split('/') }),
  });
}

beforeEach(() => {
  h.remitente = 'customer';
  h.firmado = [];
});

describe('GET /api/whatsapp/adjunto/...', () => {
  it('adjunto entrante de un cliente: redirige a un enlace firmado', async () => {
    const res = await pedir('account-acc-1/inbound/wamid.1-0.png');
    expect(res.status).toBe(302);
    expect(h.firmado).toEqual(['account-acc-1/inbound/wamid.1-0.png']);
  });

  it('entrante cuyo único mensaje visible es de un vendedor (fabricado): 404', async () => {
    h.remitente = 'agent';
    const res = await pedir('account-acc-1/inbound/wamid.1-0.png');
    expect(res.status).toBe(404);
    expect(h.firmado).toEqual([]);
  });

  it('saliente (lo subió el servicio): lo ve quien ve el mensaje del agente', async () => {
    h.remitente = 'agent';
    const res = await pedir(
      'account-acc-1/outbound/8f0c2b0e-1111-4222-8333-944455556666.pdf'
    );
    expect(res.status).toBe(302);
  });

  it('otra cuenta: 404', async () => {
    expect((await pedir('account-otra/inbound/w-0.png')).status).toBe(404);
  });
});
