// ECOVIT · bloque 5/6: los motores mandan por la interfaz del proveedor cuando
// no es Meta, con el mismo orden que la bandeja (fila en `sending` ANTES de
// enviar, id = clave de idempotencia) y sin dejar filas huérfanas.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orden: [] as string[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  pedidos: [] as Record<string, unknown>[],
  plantillas: [] as Record<string, unknown>[],
  resultado: { estado: 'enviado', mensajeId: 'wamid.M', referencia: null } as Record<string, unknown>,
  errorPlantilla: null as Error | null,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['eq', 'is', 'select']) b[m] = vi.fn(chain);
      b.insert = vi.fn((row: Record<string, unknown>) => {
        if (table === 'messages') {
          h.orden.push(`insert:${row.status}`);
          h.inserts.push(row);
        }
        return Promise.resolve({ error: null });
      });
      b.update = vi.fn((row: Record<string, unknown>) => {
        if (table === 'messages') {
          h.orden.push(`update:${row.status}`);
          h.updates.push(row);
        }
        return b;
      });
      b.maybeSingle = vi.fn(async () =>
        table === 'contacts'
          ? { data: { id: 'ct-1', phone: '+573001112233', wa_user_id: null }, error: null }
          : { data: { id: 'cv-1', account_id: 'acc-1' }, error: null },
      );
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

vi.mock('./conversation-scope', () => ({ assertConversationInAccount: vi.fn(async () => {}) }));
vi.mock('./message-status-sync', () => ({ applyPendingMessageStatuses: vi.fn(async () => []) }));
vi.mock('./enviar-por-proveedor', () => ({
  enviarPorProveedor: vi.fn(async (args: Record<string, unknown>) => {
    h.orden.push('enviar');
    h.pedidos.push(args);
    return h.resultado;
  }),
}));
vi.mock('./proveedor', () => ({
  crearProveedor: () => ({
    enviarPlantilla: async (destino: unknown, plantilla: unknown, opciones: unknown) => {
      h.plantillas.push({ destino, plantilla, opciones });
      if (h.errorPlantilla) throw h.errorPlantilla;
      return { mensajeId: 'wamid.P', referencia: null };
    },
  }),
}));

import { enviarDesdeMotor, enviarPlantillaATelefono } from './enviar-motor';
import { engineSendInteractiveButtons, engineSendText } from '@/lib/flows/meta-send';
import { ErrorProveedor } from './proveedor/tipos';

let anterior: string | undefined;
beforeAll(() => {
  anterior = process.env.WHATSAPP_PROVEEDOR;
  process.env.WHATSAPP_PROVEEDOR = 'simulado';
});
afterAll(() => {
  process.env.WHATSAPP_PROVEEDOR = anterior;
});
beforeEach(() => {
  h.orden = [];
  h.inserts = [];
  h.updates = [];
  h.pedidos = [];
  h.plantillas = [];
  h.errorPlantilla = null;
  h.resultado = { estado: 'enviado', mensajeId: 'wamid.M', referencia: null };
});

const base = {
  accountId: 'acc-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  pedido: { clase: 'texto' as const, texto: 'Hola' },
  fila: { content_type: 'text', content_text: 'Hola', ai_generated: true },
  previa: 'Hola',
};

describe('enviarDesdeMotor', () => {
  it('guarda en sending ANTES de enviar, con id = clave de idempotencia, y luego le pone el wamid', async () => {
    const r = await enviarDesdeMotor(base);
    expect(h.orden).toEqual(['insert:sending', 'enviar', 'update:sent']);
    expect(h.inserts[0].id).toBe(h.pedidos[0].idMensaje);
    expect(h.inserts[0]).toMatchObject({ sender_type: 'bot', ai_generated: true });
    expect(r).toEqual({ id: h.inserts[0].id, whatsapp_message_id: 'wamid.M', pendiente: false });
  });

  it('un rechazo definitivo deja la fila en failed con el motivo, y lanza', async () => {
    h.resultado = { estado: 'fallido', motivo: 'Zernio 409: desconectado', codigo: 'x', status: 502 };
    await expect(enviarDesdeMotor(base)).rejects.toThrow(/desconectado/);
    expect(h.updates[0]).toMatchObject({ status: 'failed', error_title: 'Zernio 409: desconectado' });
  });

  it('un envío dudoso queda en sending, sin reintentar', async () => {
    h.resultado = { estado: 'pendiente', motivo: '503' };
    const r = await enviarDesdeMotor(base);
    expect(h.orden).toEqual(['insert:sending', 'enviar']);
    expect(r.pendiente).toBe(true);
  });

  it('los flujos mandan texto por el proveedor cuando no es Meta', async () => {
    await engineSendText({ accountId: 'acc-1', userId: 'u', conversationId: 'cv-1', contactId: 'ct-1', text: 'Hola' });
    expect(h.orden).toEqual(['insert:sending', 'enviar', 'update:sent']);
  });

  it('botones fuera de Meta: falla ANTES de guardar nada', async () => {
    await expect(
      engineSendInteractiveButtons({
        accountId: 'acc-1',
        userId: 'u',
        conversationId: 'cv-1',
        contactId: 'ct-1',
        bodyText: 'Elija',
        buttons: [{ id: 'a', title: 'A' }],
      }),
    ).rejects.toThrow(/botones y las listas/);
    expect(h.orden).toEqual([]);
  });
});

describe('enviarPlantillaATelefono (envíos masivos)', () => {
  it('manda por la interfaz con la clave de idempotencia dada', async () => {
    const r = await enviarPlantillaATelefono({
      telefono: '+573001112233',
      nombre: 'promo',
      idioma: 'es',
      parametros: ['Ana'],
      idempotencia: 'fila-1',
    });
    expect(r).toEqual({ ok: true, wamid: 'wamid.P' });
    expect(h.plantillas[0].opciones).toEqual({ idempotencia: 'fila-1' });
  });

  it('un dudoso se dice como dudoso (no se reenvía a ciegas)', async () => {
    h.errorPlantilla = new ErrorProveedor('503', { dudoso: true });
    const r = await enviarPlantillaATelefono({
      telefono: '+573001112233',
      nombre: 'promo',
      idioma: 'es',
      parametros: [],
      idempotencia: 'fila-1',
    });
    expect(r).toMatchObject({ ok: false, dudoso: true });
  });
});
