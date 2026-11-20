import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSACION_EJEMPLO,
  CUENTA_EJEMPLO,
  EJEMPLO_WEBHOOK_TEST,
  cuentaDesconectada,
  estadoMensaje,
  mensajeEnviado,
  mensajeRecibido,
} from './ejemplos-zernio';
import { ErrorProveedor } from './tipos';
import { ProveedorZernio, leerWebhookZernio } from './zernio';

describe('leerWebhookZernio: los payloads de la documentación', () => {
  it('webhook.test (literal de la documentación) es un evento de prueba', () => {
    const [e] = leerWebhookZernio(EJEMPLO_WEBHOOK_TEST);
    expect(e).toMatchObject({
      tipo: 'prueba',
      prueba: true,
      eventoId: EJEMPLO_WEBHOOK_TEST.id,
    });
  });

  it('message.received con teléfono', () => {
    const [e] = leerWebhookZernio(
      mensajeRecibido({
        id: 'evt-1',
        wamid: 'wamid.A',
        telefono: '+573001112233',
      })
    );
    expect(e).toMatchObject({
      tipo: 'mensaje_entrante',
      eventoId: 'evt-1',
      mensajeId: 'wamid.A',
      referencia: {
        conversacionId: CONVERSACION_EJEMPLO,
        cuentaId: CUENTA_EJEMPLO,
      },
      remitente: {
        telefono: '573001112233',
        waUserId: null,
        nombre: 'Cliente de prueba',
      },
      enEspera: false,
      esHistoria: false,
    });
  });

  it('phoneNumber nulo con businessScopedUserId: identifica por BSUID, sin teléfono', () => {
    const [e] = leerWebhookZernio(
      mensajeRecibido({
        id: 'evt-2',
        wamid: 'wamid.B',
        telefono: null,
        bsuid: 'CO.13491208655302741918',
      })
    );
    if (e.tipo !== 'mensaje_entrante') throw new Error('tipo');
    expect(e.remitente.telefono).toBe('');
    expect(e.remitente.waUserId).toBe('CO.13491208655302741918');
  });

  it('sender.id con BSUID no se toma como teléfono', () => {
    const cuerpo = mensajeRecibido({
      id: 'evt-3',
      wamid: 'wamid.C',
      telefono: null,
      bsuid: 'US.ENT.118157992',
    });
    const [e] = leerWebhookZernio(cuerpo);
    if (e.tipo !== 'mensaje_entrante') throw new Error('tipo');
    expect(e.remitente.telefono).toBe('');
  });

  it('standby (otra app tiene el chat) queda marcado', () => {
    const [e] = leerWebhookZernio(
      mensajeRecibido({
        id: 'e',
        wamid: 'w',
        telefono: '+57300',
        standby: true,
      })
    );
    expect(e).toMatchObject({ tipo: 'mensaje_entrante', enEspera: true });
  });

  it('adjuntos: file → document, con url y mime', () => {
    const [e] = leerWebhookZernio(
      mensajeRecibido({
        id: 'e',
        wamid: 'w',
        telefono: '+573001112233',
        texto: null,
        adjuntos: [
          {
            type: 'file',
            url: 'https://zernio.com/api/v1/whatsapp/media/123',
            mimeType: 'application/pdf',
          },
        ],
      })
    );
    if (e.tipo !== 'mensaje_entrante') throw new Error('tipo');
    expect(e.texto).toBeNull();
    expect(e.adjuntos).toEqual([
      {
        tipo: 'document',
        url: 'https://zernio.com/api/v1/whatsapp/media/123',
        mime: 'application/pdf',
        indice: 0,
      },
    ]);
  });

  it('message.sent desde el celular: origen celular, y la otra parte es el participante', () => {
    const [e] = leerWebhookZernio(
      mensajeEnviado({ id: 'e', wamid: 'w', participante: '573001112233' })
    );
    expect(e).toMatchObject({
      tipo: 'mensaje_enviado',
      origen: 'celular',
      origenCrudo: 'whatsapp_business_app',
      destinatario: { telefono: '573001112233' },
    });
  });

  it('message.sent por la API y por el agente de Meta', () => {
    const [api] = leerWebhookZernio(
      mensajeEnviado({
        id: 'a',
        wamid: 'w',
        participante: '57300111',
        source: 'cloud_api',
      })
    );
    const [agente] = leerWebhookZernio(
      mensajeEnviado({
        id: 'b',
        wamid: 'w2',
        participante: '57300111',
        source: 'meta_business_agent',
      })
    );
    expect(api).toMatchObject({ origen: 'api' });
    expect(agente).toMatchObject({ origen: 'agente_meta' });
  });

  it('estados: entregado, leído y fallido con su error (código en texto → número)', () => {
    const [d] = leerWebhookZernio(
      estadoMensaje('message.delivered', { id: 'd', wamid: 'w' })
    );
    const [r] = leerWebhookZernio(
      estadoMensaje('message.read', { id: 'r', wamid: 'w' })
    );
    const [f] = leerWebhookZernio(
      estadoMensaje('message.failed', {
        id: 'f',
        wamid: 'w',
        error: {
          code: '131026',
          title: 'Message undeliverable',
          message: 'Unable to deliver',
        },
      })
    );
    expect(d).toMatchObject({
      tipo: 'estado',
      estado: 'delivered',
      error: null,
    });
    expect(r).toMatchObject({ tipo: 'estado', estado: 'read' });
    expect(f).toMatchObject({
      tipo: 'estado',
      estado: 'failed',
      error: {
        codigo: 131026,
        titulo: 'Message undeliverable',
        detalle: 'Unable to deliver',
      },
    });
  });

  it('account.disconnected trae la cuenta', () => {
    const [e] = leerWebhookZernio(cuentaDesconectada('x'));
    expect(e).toMatchObject({
      tipo: 'cuenta_desconectada',
      cuentaId: CUENTA_EJEMPLO,
    });
  });

  it('otras plataformas y eventos desconocidos se ignoran (no lanzan)', () => {
    const ig = mensajeRecibido({ id: 'i', wamid: 'w', telefono: '+57' });
    ig.message.platform = 'instagram';
    expect(leerWebhookZernio(ig)[0].tipo).toBe('ignorado');
    expect(
      leerWebhookZernio({ id: 'z', event: 'post.published' })[0].tipo
    ).toBe('ignorado');
    expect(leerWebhookZernio(null)[0].tipo).toBe('ignorado');
  });
});

function respuesta(
  status: number,
  cuerpo: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(
    typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
    { status, headers }
  );
}

function zernio(fetchMock: typeof fetch) {
  return new ProveedorZernio({
    apiKey: 'sk_prueba',
    secretos: ['s'],
    cuentaId: CUENTA_EJEMPLO,
    fetch: fetchMock,
  });
}

const DESTINO = {
  referencia: { conversacionId: 'conv-1', cuentaId: null },
  telefono: '573001112233',
};

describe('ProveedorZernio: enviar', () => {
  it('texto: POST a la conversación con accountId, message, Bearer e Idempotency-Key', async () => {
    const f = vi.fn(async () =>
      respuesta(200, {
        success: true,
        data: { messageId: 'wamid.X', conversationId: 'conv-1' },
      })
    );
    const r = await zernio(f as unknown as typeof fetch).enviarTexto(
      DESTINO,
      'Hola',
      { idempotencia: 'msg-uuid-1' }
    );
    expect(r.mensajeId).toBe('wamid.X');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://zernio.com/api/v1/inbox/conversations/conv-1/messages'
    );
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk_prueba');
    expect(h['Idempotency-Key']).toBe('msg-uuid-1');
    expect(JSON.parse(init.body as string)).toEqual({
      accountId: CUENTA_EJEMPLO,
      message: 'Hola',
    });
  });

  it('media: attachmentUrl y attachmentType (document → file, con nombre)', async () => {
    const f = vi.fn(async () => respuesta(200, { data: { messageId: 'w' } }));
    await zernio(f as unknown as typeof fetch).enviarMedia(
      DESTINO,
      {
        tipo: 'document',
        url: 'https://x/cot.pdf',
        texto: 'Cotización',
        nombreArchivo: 'cot.pdf',
      },
      { idempotencia: 'k' }
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      accountId: CUENTA_EJEMPLO,
      attachmentUrl: 'https://x/cot.pdf',
      attachmentType: 'file',
      message: 'Cotización',
      attachmentName: 'cot.pdf',
    });
  });

  it('plantilla sin conversación: POST /inbox/conversations con participantId en dígitos', async () => {
    const f = vi.fn(async () =>
      respuesta(201, {
        data: { messageId: 'wamid.T', conversationId: 'conv-nueva' },
      })
    );
    const r = await zernio(f as unknown as typeof fetch).enviarPlantilla(
      {
        referencia: { conversacionId: null, cuentaId: null },
        telefono: '+57 300 111 2233',
      },
      { nombre: 'recordatorio', idioma: 'es', parametros: ['Ana'] },
      { idempotencia: 'k' }
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://zernio.com/api/v1/inbox/conversations');
    expect(JSON.parse(init.body as string)).toEqual({
      accountId: CUENTA_EJEMPLO,
      participantId: '573001112233',
      templateName: 'recordatorio',
      templateLanguage: 'es',
      templateParams: ['Ana'],
    });
    expect(r.referencia?.conversacionId).toBe('conv-nueva');
  });

  it('plantilla dentro de la conversación: template.elements con el cuerpo', async () => {
    const f = vi.fn(async () => respuesta(200, { data: { messageId: 'w' } }));
    await zernio(f as unknown as typeof fetch).enviarPlantilla(
      DESTINO,
      { nombre: 'seguimiento', idioma: 'es', parametros: ['Ana', 'COT-1'] },
      { idempotencia: 'k' }
    );
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).template).toEqual({
      elements: [
        {
          name: 'seguimiento',
          language: 'es',
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Ana' },
                { type: 'text', text: 'COT-1' },
              ],
            },
          ],
        },
      ],
    });
  });

  it('5xx: error DUDOSO, y no se reintenta (una sola llamada)', async () => {
    const f = vi.fn(async () => respuesta(503, { error: 'busy' }));
    const err = await zernio(f as unknown as typeof fetch)
      .enviarTexto(DESTINO, 'Hola', { idempotencia: 'k' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ErrorProveedor);
    expect(err.dudoso).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tiempo agotado o red caída: DUDOSO', async () => {
    const f = vi.fn(async () => {
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError'
      );
    });
    const err = await zernio(f as unknown as typeof fetch)
      .enviarTexto(DESTINO, 'Hola', { idempotencia: 'k' })
      .catch((e) => e);
    expect(err).toMatchObject({ dudoso: true });
  });

  it('409 (cuenta desconectada u otro conflicto) es definitivo, no dudoso', async () => {
    const f = vi.fn(async () =>
      respuesta(409, {
        error: 'Account is disconnected',
        code: 'account_disconnected',
      })
    );
    const err = await zernio(f as unknown as typeof fetch)
      .enviarTexto(DESTINO, 'Hola', { idempotencia: 'k' })
      .catch((e) => e);
    expect(err).toMatchObject({ dudoso: false, estadoHttp: 409 });
    expect(err.message).toContain('Account is disconnected');
  });

  it('4xx: error definitivo con el código de Zernio', async () => {
    const f = vi.fn(async () =>
      respuesta(400, { error: 'Window closed', code: '131047' })
    );
    const err = await zernio(f as unknown as typeof fetch)
      .enviarTexto(DESTINO, 'Hola', { idempotencia: 'k' })
      .catch((e) => e);
    expect(err).toMatchObject({
      dudoso: false,
      estadoHttp: 400,
      codigo: '131047',
    });
  });

  it('sin conversación de Zernio, el texto no se manda y lo dice', async () => {
    const f = vi.fn();
    const err = await zernio(f as unknown as typeof fetch)
      .enviarTexto(
        {
          referencia: { conversacionId: null, cuentaId: null },
          telefono: '57300',
        },
        'Hola',
        {
          idempotencia: 'k',
        }
      )
      .catch((e) => e);
    expect(err).toMatchObject({
      dudoso: false,
      codigo: 'sin_conversacion_proveedor',
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('ProveedorZernio: conexión y adjuntos', () => {
  it('verificarConexion: 200 de number-info = conectado, con número y calidad', async () => {
    const f = vi.fn(async () =>
      respuesta(200, {
        phone: {
          display_phone_number: '+57 300 111 2233',
          verified_name: 'ECOVIT',
          quality_rating: 'GREEN',
        },
      })
    );
    const e = await zernio(f as unknown as typeof fetch).verificarConexion();
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(
      `https://zernio.com/api/v1/whatsapp/number-info?accountId=${CUENTA_EJEMPLO}`
    );
    expect(e).toMatchObject({
      conectado: true,
      numero: '+57 300 111 2233',
      nombre: 'ECOVIT',
      calidad: 'GREEN',
    });
  });

  it('verificarConexion: 400 (error 100/33) = sin conexión', async () => {
    const f = vi.fn(async () =>
      respuesta(400, {
        error: 'Meta will not let Zernio read this WhatsApp object',
      })
    );
    const e = await zernio(f as unknown as typeof fetch).verificarConexion();
    expect(e.conectado).toBe(false);
    expect(e.detalle).toContain('400');
  });

  it('descargarAdjunto: con Bearer solo a zernio.com', async () => {
    const f = vi.fn(async () =>
      respuesta(200, 'bytes', { 'content-type': 'image/jpeg' })
    );
    const p = zernio(f as unknown as typeof fetch);
    const bajado = await p.descargarAdjunto({
      tipo: 'image',
      url: 'https://zernio.com/api/v1/whatsapp/media/9',
      mime: null,
      indice: 0,
    });
    expect(bajado?.mime).toBe('image/jpeg');
    expect(
      (
        (f.mock.calls[0] as unknown as [string, RequestInit])[1]
          .headers as Record<string, string>
      ).Authorization
    ).toBe('Bearer sk_prueba');

    f.mockClear();
    const ajeno = await p.descargarAdjunto({
      tipo: 'image',
      url: 'https://otro.example/x.jpg',
      mime: null,
      indice: 0,
    });
    expect(ajeno).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
