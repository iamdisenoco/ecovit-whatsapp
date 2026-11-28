import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rol: 'admin' as string, importar: vi.fn() }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error {
    readonly status = 403 as const;
  }
  return {
    requireRole: async (min: string) => {
      if (min === 'admin' && h.rol !== 'admin' && h.rol !== 'owner')
        throw new ForbiddenError('Necesita el rol de dirección.');
      return { accountId: 'acc-1', userId: 'u-1', role: h.rol };
    },
    toErrorResponse: (err: unknown) =>
      err instanceof ForbiddenError
        ? { body: { error: err.message }, status: 403 }
        : { body: { error: 'error' }, status: 500 },
  };
});

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));

vi.mock('@/lib/whatsapp/proveedor/historial', async (importar) => ({
  ...(await importar<typeof import('@/lib/whatsapp/proveedor/historial')>()),
  importarHistorial: h.importar,
}));

import { POST } from './route';

function pedido(cuerpo: unknown = {}) {
  return new Request('http://x/api/whatsapp/historial', {
    method: 'POST',
    body: JSON.stringify(cuerpo),
  });
}

describe('POST /api/whatsapp/historial', () => {
  beforeEach(() => {
    h.rol = 'admin';
    h.importar.mockReset();
    vi.stubEnv('WHATSAPP_PROVEEDOR', 'zernio');
    vi.stubEnv('ZERNIO_API_KEY', 'llave');
    vi.stubEnv('ZERNIO_ACCOUNT_ID', 'cuenta');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('403 al vendedor, sin tocar nada', async () => {
    h.rol = 'agent';
    const r = (await POST(pedido())) as unknown as { status: number };
    expect(r.status).toBe(403);
    expect(h.importar).not.toHaveBeenCalled();
  });

  it.each([['ZERNIO_API_KEY'], ['ZERNIO_ACCOUNT_ID'], ['WHATSAPP_PROVEEDOR']])(
    '503 sin %s, con un mensaje que no nombra al proveedor',
    async (variable) => {
      vi.stubEnv(variable, '');
      const r = (await POST(pedido())) as unknown as {
        status: number;
        body: { error: string };
      };
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('La conexión de WhatsApp no está configurada.');
      expect(r.body.error).not.toMatch(/zernio/i);
      expect(h.importar).not.toHaveBeenCalled();
    }
  );

  it('pasa el cursor y devuelve el tramo', async () => {
    h.importar.mockResolvedValue({
      procesadas: 3,
      mensajes: 9,
      listas: 3,
      saltados: 0,
      cursor: 'c2',
      terminado: false,
      esperarMs: null,
    });
    const r = (await POST(pedido({ cursor: 'c1' }))) as unknown as {
      status: number;
      body: { cursor: string };
    };
    expect(r.status).toBe(200);
    expect(r.body.cursor).toBe('c2');
    expect(h.importar.mock.calls[0][0]).toMatchObject({
      cursor: 'c1',
      cuentaId: 'cuenta',
    });
  });
});
