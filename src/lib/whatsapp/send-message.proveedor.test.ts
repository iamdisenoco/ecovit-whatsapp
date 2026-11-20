// ECOVIT · revisión del bloque 5 (🔴2 y 🟡9). Con Zernio, la fila del mensaje se
// guarda en `sending` ANTES de llamar al proveedor (su id es la clave de
// idempotencia), con la sesión y SIN `media_url` (0115: insert por columna; esa
// llave haría fallar la sentencia entera). Después, con la clave de servicio,
// el adjunto y el wamid. El adjunto saliente va a Zernio como enlace firmado de
// chat-media, no como URL pública.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => ({
  orden: [] as string[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  pedidos: [] as Record<string, unknown>[],
  resultado: {
    estado: 'enviado',
    mensajeId: 'wamid.Z',
    referencia: null,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['eq', 'is', 'in', 'select']) b[m] = vi.fn(chain);
      b.insert = vi.fn((row: Record<string, unknown>) => {
        if (table === 'messages') h.orden.push(`insert-servicio:${row.status}`);
        return b;
      });
      b.update = vi.fn((row: Record<string, unknown>) => {
        if (table === 'messages') {
          h.orden.push(`update:${row.status ?? Object.keys(row).join('+')}`);
          h.updates.push(row);
        }
        return b;
      });
      b.single = vi.fn(async () => ({ data: null, error: null }));
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [{ id: 'x' }], error: null });
      return b;
    },
    storage: {
      from: () => ({
        createSignedUrl: async (ruta: string, segundos: number) => ({
          data: {
            signedUrl: `https://almacen.example/firmado/${ruta}?vence=${segundos}`,
          },
          error: null,
        }),
      }),
    },
  }),
}));

vi.mock('@/lib/whatsapp/enviar-por-proveedor', async (importOriginal) => ({
  // `urlParaProveedor` de verdad (firma con el almacén de arriba); solo el envío es falso.
  ...(await importOriginal<typeof import('./enviar-por-proveedor')>()),
  enviarPorProveedor: vi.fn(async (args: Record<string, unknown>) => {
    h.orden.push('enviar');
    h.pedidos.push(args);
    return h.resultado;
  }),
}));

vi.mock('@/lib/whatsapp/message-status-sync', () => ({
  applyPendingMessageStatuses: vi.fn(async () => []),
}));

import { sendMessageToConversation } from './send-message';

function sesion(): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'eq', 'update', 'is']) b[m] = vi.fn(chain);
      b.insert = vi.fn((row: Record<string, unknown>) => {
        if (table === 'messages') {
          h.orden.push(`insert-sesion:${row.status}`);
          h.inserts.push(row);
        }
        return b;
      });
      b.single = vi.fn(async () =>
        table === 'conversations'
          ? {
              data: {
                id: 'cv-1',
                contact: { id: 'ct-1', phone: '+573001112233' },
              },
              error: null,
            }
          : { data: { id: h.inserts.at(-1)?.id ?? 'x' }, error: null }
      );
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: [], error: null });
      return b;
    },
  } as unknown as SupabaseClient;
}

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
  h.resultado = { estado: 'enviado', mensajeId: 'wamid.Z', referencia: null };
});

describe('envío por el proveedor', () => {
  it('guarda la fila en sending ANTES de enviar, con id = clave de idempotencia, y luego le pone el wamid', async () => {
    const r = await sendMessageToConversation(sesion(), 'acc-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });
    expect(h.orden).toEqual(['insert-sesion:sending', 'enviar', 'update:sent']);
    expect(h.inserts[0].id).toBe(h.pedidos[0].idMensaje);
    expect(h.updates[0]).toMatchObject({
      message_id: 'wamid.Z',
      status: 'sent',
    });
    expect(r.messageId).toBe(h.inserts[0].id);
  });

  it('un 4xx deja la fila en fallido con el mensaje real', async () => {
    h.resultado = {
      estado: 'fallido',
      motivo: 'Zernio respondió 409: Account is disconnected',
      codigo: 'x',
      status: 502,
    };
    await expect(
      sendMessageToConversation(sesion(), 'acc-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
      })
    ).rejects.toThrow(/Account is disconnected/);
    expect(h.updates[0]).toMatchObject({
      status: 'failed',
      error_title: expect.stringContaining('Account is disconnected'),
    });
  });

  it('un adjunto de chat-media va a Zernio como enlace firmado de vencimiento corto', async () => {
    await sendMessageToConversation(sesion(), 'acc-1', {
      conversationId: 'cv-1',
      messageType: 'image',
      mediaUrl: '/api/whatsapp/adjunto/account-acc-1/outbound/abc.png',
    });
    const pedido = h.pedidos[0].pedido as { url: string };
    expect(pedido.url).toMatch(
      /^https:\/\/almacen\.example\/firmado\/account-acc-1\/outbound\/abc\.png\?vence=\d+$/
    );
    // La URL interna la escribe el servicio, antes de enviar.
    expect(h.orden).toEqual([
      'insert-sesion:sending',
      'update:media_url',
      'enviar',
      'update:sent',
    ]);
    expect(h.updates[0]).toEqual({
      media_url: '/api/whatsapp/adjunto/account-acc-1/outbound/abc.png',
    });
  });

  it('el insert con la sesión NUNCA lleva la llave media_url (ni en null): 42501 con la 0115', async () => {
    await sendMessageToConversation(sesion(), 'acc-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Hola',
    });
    await sendMessageToConversation(sesion(), 'acc-1', {
      conversationId: 'cv-1',
      messageType: 'image',
      mediaUrl: '/api/whatsapp/adjunto/account-acc-1/outbound/abc.png',
    });
    expect(h.inserts).toHaveLength(2);
    for (const fila of h.inserts)
      expect(Object.keys(fila)).not.toContain('media_url');
  });

  it('no firma un adjunto que no se subió para mandar desde esta cuenta', async () => {
    await expect(
      sendMessageToConversation(sesion(), 'acc-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl:
          '/api/whatsapp/adjunto/account-acc-1/inbound/wamid.de-otro-0.png',
      })
    ).rejects.toThrow(/no se puede enviar/);
    expect(h.orden).toEqual([]);
  });

  it('no deja pasar una URL externa: no se guarda nada ni se envía', async () => {
    await expect(
      sendMessageToConversation(sesion(), 'acc-1', {
        conversationId: 'cv-1',
        messageType: 'image',
        mediaUrl: 'https://otro-sitio.example/foto.png',
      })
    ).rejects.toThrow(/enlaces externos/);
    expect(h.orden).toEqual([]);
  });

  it('botones y listas fuera de Meta fallan ANTES de guardar la fila (no queda huérfana en sending)', async () => {
    await expect(
      sendMessageToConversation(sesion(), 'acc-1', {
        conversationId: 'cv-1',
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Elija',
          buttons: [{ id: 'a', title: 'A' }],
        },
      })
    ).rejects.toThrow(/botones y las listas/);
    expect(h.orden).toEqual([]);
  });

  it('un texto con media_url se rechaza: el servicio no escribe media_url fuera de un adjunto', async () => {
    await expect(
      sendMessageToConversation(sesion(), 'acc-1', {
        conversationId: 'cv-1',
        messageType: 'text',
        contentText: 'Hola',
        mediaUrl: '/api/whatsapp/adjunto/account-acc-1/outbound/abc.png',
      })
    ).rejects.toThrow(/Solo los adjuntos/);
    expect(h.orden).toEqual([]);
  });

  it('una plantilla no deja media_url escrita por el servicio', async () => {
    await sendMessageToConversation(sesion(), 'acc-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'promo',
      templateMessageParams: { header: { type: 'image', link: 'https://otro.example/x.png' } } as never,
    }).catch(() => {});
    expect(h.updates.some((u) => 'media_url' in u)).toBe(false);
  });
});
