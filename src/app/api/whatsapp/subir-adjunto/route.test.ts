import { beforeEach, describe, expect, it, vi } from 'vitest';

const CUENTA = '11111111-1111-1111-1111-111111111111';
const OTRA = '22222222-2222-2222-2222-222222222222';
const ARCHIVO = '33333333-3333-3333-3333-333333333333.png';

const h = vi.hoisted(() => ({
  usado: false,
  borrados: [] as string[][],
  subidos: [] as string[],
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: '11111111-1111-1111-1111-111111111111' }),
  toErrorResponse: () => ({ body: { error: 'error' }, status: 500 }),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) b[m] = () => b;
      b.limit = async () => ({ data: h.usado ? [{ id: 'm1' }] : [], error: null });
      return b;
    },
    storage: {
      from: () => ({
        remove: async (rutas: string[]) => {
          h.borrados.push(rutas);
          return { error: null };
        },
        upload: async (ruta: string) => {
          h.subidos.push(ruta);
          return { error: null };
        },
        createSignedUrl: async () => ({ data: { signedUrl: 'https://f' } }),
      }),
    },
  }),
}));

import { DELETE, POST } from './route';

type Resp = { status: number; body: Record<string, unknown> };
const borrar = (path: unknown) =>
  DELETE(
    new Request('http://t', { method: 'DELETE', body: JSON.stringify({ path }) })
  ) as unknown as Promise<Resp>;

beforeEach(() => {
  h.usado = false;
  h.borrados = [];
  h.subidos = [];
});

describe('DELETE /api/whatsapp/subir-adjunto', () => {
  it('borra un borrador de esta cuenta que nadie usa', async () => {
    const r = await borrar(`account-${CUENTA}/outbound/${ARCHIVO}`);
    expect(r.status).toBe(200);
    expect(h.borrados).toEqual([[`account-${CUENTA}/outbound/${ARCHIVO}`]]);
  });

  it('no borra lo de otra cuenta, lo entrante ni rutas raras', async () => {
    for (const p of [
      `account-${OTRA}/outbound/${ARCHIVO}`,
      `account-${CUENTA}/inbound/${ARCHIVO}`,
      `account-${CUENTA}/outbound/../inbound/${ARCHIVO}`,
      `account-${CUENTA}/outbound/x.png`,
      null,
    ]) {
      expect((await borrar(p)).status, String(p)).toBe(400);
    }
    expect(h.borrados).toEqual([]);
  });

  it('no borra un archivo que ya está en un mensaje (enviado o fallido)', async () => {
    h.usado = true;
    const r = await borrar(`account-${CUENTA}/outbound/${ARCHIVO}`);
    expect(r.status).toBe(409);
    expect(h.borrados).toEqual([]);
  });
});

describe('POST /api/whatsapp/subir-adjunto', () => {
  const subir = (bytes: number) => {
    const datos = new FormData();
    datos.append('archivo', new File([new Uint8Array(bytes)], 'f.png', { type: 'image/png' }));
    return POST(new Request('http://t', { method: 'POST', body: datos })) as unknown as Promise<Resp>;
  };

  it('pasando de 4 MB: 413 con el mensaje claro, sin subir nada', async () => {
    const r = await subir(4 * 1024 * 1024 + 1);
    expect(r.status).toBe(413);
    expect(String(r.body.error)).toMatch(/4 MB/);
    expect(h.subidos).toEqual([]);
  });

  it('hasta 4 MB sube', async () => {
    const r = await subir(1024);
    expect(r.status).toBe(200);
    expect(h.subidos).toHaveLength(1);
  });
});
