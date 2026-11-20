import { describe, expect, it } from 'vitest';
import {
  estadoMensaje,
  mensajeEnviado,
  mensajeRecibido,
} from '../proveedor/ejemplos-zernio';
import { leerWebhookZernio } from '../proveedor/zernio';
import { AlmacenMemoria } from './almacen-memoria';
import { MOTIVO_CELULAR } from './coexistencia';
import { ADJUNTO_SIN_DESCARGAR, Procesador } from './procesar';

const TEL = '+573001112233';

async function procesar(almacen: AlmacenMemoria, ...cuerpos: unknown[]) {
  const p = new Procesador(almacen);
  return p.procesar(cuerpos.flatMap((c) => leerWebhookZernio(c)));
}

describe('deduplicación', () => {
  it('el mismo evento dos veces (mismo id) se guarda una sola vez', async () => {
    const a = new AlmacenMemoria();
    const evento = mensajeRecibido({
      id: 'evt-1',
      wamid: 'wamid.1',
      telefono: TEL,
    });
    const r1 = await procesar(a, evento);
    const r2 = await procesar(a, evento);
    expect(a.mensajes).toHaveLength(1);
    expect(r1.repetidos).toBe(0);
    expect(r2.repetidos).toBe(1);
    expect(r2.trabajos).toHaveLength(0); // ni bot ni motores la segunda vez
  });

  it('otro id de evento con el mismo wamid (sin tabla de eventos) tampoco duplica', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({ id: 'evt-1', wamid: 'wamid.1', telefono: TEL })
    );
    const r = await procesar(
      a,
      mensajeRecibido({ id: 'evt-OTRO', wamid: 'wamid.1', telefono: TEL })
    );
    expect(a.mensajes).toHaveLength(1);
    expect(r.repetidos).toBe(1);
    expect(r.trabajos).toHaveLength(0);
  });

  it('testigo: dos wamid distintos son dos mensajes, en el mismo chat', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({ id: 'e1', wamid: 'wamid.1', telefono: TEL }),
      mensajeRecibido({ id: 'e2', wamid: 'wamid.2', telefono: TEL })
    );
    expect(a.mensajes).toHaveLength(2);
    expect(a.conversaciones).toHaveLength(1);
    expect(a.conversaciones[0].unread_count).toBe(2);
  });

  it('remitente solo con BSUID (phoneNumber nulo): un contacto, sin teléfono', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({
        id: 'e',
        wamid: 'w',
        telefono: null,
        bsuid: 'CO.1349120865530',
      })
    );
    expect(a.contactos).toEqual([
      expect.objectContaining({ telefono: '', waUserId: 'CO.1349120865530' }),
    ]);
  });

  it('guarda la conversación de Zernio para poder contestar', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({
        id: 'e',
        wamid: 'w',
        telefono: TEL,
        conversationId: 'conv-z',
      })
    );
    expect([...a.referencias.values()][0].conversacionId).toBe('conv-z');
  });
});

describe('los estados no retroceden', () => {
  async function conEnvio() {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeEnviado({
        id: 'env',
        wamid: 'wamid.S',
        participante: '573001112233',
        source: 'cloud_api',
      })
    );
    return a;
  }

  it('leído y después entregado: queda leído', async () => {
    const a = await conEnvio();
    await procesar(
      a,
      estadoMensaje('message.read', { id: 'r', wamid: 'wamid.S' }),
      estadoMensaje('message.delivered', { id: 'd', wamid: 'wamid.S' })
    );
    expect(a.mensajes[0].status).toBe('read');
  });

  it('entregado y después fallido: no pasa a fallido', async () => {
    const a = await conEnvio();
    await procesar(
      a,
      estadoMensaje('message.delivered', { id: 'd', wamid: 'wamid.S' }),
      estadoMensaje('message.failed', {
        id: 'f',
        wamid: 'wamid.S',
        error: { code: 1, title: 't', message: 'm' },
      })
    );
    expect(a.mensajes[0].status).toBe('delivered');
  });

  it('testigo: enviado y después fallido sí falla, con el código', async () => {
    const a = await conEnvio();
    await procesar(
      a,
      estadoMensaje('message.failed', {
        id: 'f',
        wamid: 'wamid.S',
        error: { code: '131026', title: 'No llegó', message: 'm' },
      })
    );
    expect(a.mensajes[0]).toMatchObject({
      status: 'failed',
      error_code: 131026,
      error_title: 'No llegó',
    });
  });

  it('un estado que llega antes que su mensaje queda pendiente y se aplica al llegar', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      estadoMensaje('message.delivered', { id: 'd', wamid: 'wamid.T' })
    );
    expect(a.pendientes).toHaveLength(1);
    await procesar(
      a,
      mensajeEnviado({
        id: 'env',
        wamid: 'wamid.T',
        participante: '573001112233',
        source: 'cloud_api',
      })
    );
    expect(a.mensajes[0].status).toBe('delivered');
    expect(a.pendientes).toHaveLength(0);
  });
});

describe('coexistencia con el celular (RF-M03.10)', () => {
  it('un mensaje desde el celular se guarda como agente y calla al bot en ese chat', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({ id: 'in', wamid: 'wamid.in', telefono: TEL })
    );
    await procesar(
      a,
      mensajeEnviado({
        id: 'cel',
        wamid: 'wamid.cel',
        participante: '573001112233',
      })
    );
    const conv = a.conversaciones[0];
    expect(a.mensajes[1]).toMatchObject({
      sender_type: 'agent',
      sender_id: null,
      status: 'sent',
    });
    expect(conv.ai_autoreply_disabled).toBe(true);
    expect(conv.ai_handoff_summary).toBe(MOTIVO_CELULAR);
    expect(a.flujosPausados).toHaveLength(1);
  });

  it('testigo: un envío por la API no calla al bot', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeEnviado({
        id: 'api',
        wamid: 'wamid.api',
        participante: '573001112233',
        source: 'cloud_api',
      })
    );
    expect(a.conversaciones[0].ai_autoreply_disabled).toBe(false);
  });

  it('un eco del celular anterior a la conexión (historia) no calla al bot', async () => {
    const a = new AlmacenMemoria({
      accountId: 'c',
      usuarioId: 'u',
      conectadoDesde: '2026-11-20T12:00:00Z',
    });
    await procesar(
      a,
      mensajeEnviado({
        id: 'h',
        wamid: 'wamid.h',
        participante: '573001112233',
        sentAt: '2026-07-01T10:00:00Z',
      })
    );
    expect(a.mensajes).toHaveLength(1);
    expect(a.conversaciones[0].ai_autoreply_disabled).toBe(false);
  });

  it('un entrante anterior a la conexión se guarda pero no despierta a los motores', async () => {
    const a = new AlmacenMemoria({
      accountId: 'c',
      usuarioId: 'u',
      conectadoDesde: '2026-11-20T12:00:00Z',
    });
    const r = await procesar(
      a,
      mensajeRecibido({
        id: 'h',
        wamid: 'wamid.h',
        telefono: TEL,
        sentAt: '2026-07-01T10:00:00Z',
      })
    );
    expect(a.mensajes).toHaveLength(1);
    expect(r.trabajos.filter((t) => t.clase === 'motores')).toHaveLength(0);
  });

  it('testigo: un entrante nuevo sí despierta a los motores', async () => {
    const a = new AlmacenMemoria({
      accountId: 'c',
      usuarioId: 'u',
      conectadoDesde: '2026-11-20T12:00:00Z',
    });
    const r = await procesar(
      a,
      mensajeRecibido({
        id: 'n',
        wamid: 'wamid.n',
        telefono: TEL,
        sentAt: '2026-11-20T13:00:00Z',
      })
    );
    expect(r.trabajos.filter((t) => t.clase === 'motores')).toHaveLength(1);
  });

  it('callado por el celular, el cliente vuelve tras 24 h: el bot vuelve', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({
        id: 'in1',
        wamid: 'w1',
        telefono: TEL,
        sentAt: '2026-11-20T10:00:00Z',
      })
    );
    await procesar(
      a,
      mensajeEnviado({
        id: 'cel',
        wamid: 'wc',
        participante: '573001112233',
        sentAt: '2026-11-20T10:05:00Z',
      })
    );
    expect(a.conversaciones[0].ai_autoreply_disabled).toBe(true);

    await procesar(
      a,
      mensajeRecibido({
        id: 'in2',
        wamid: 'w2',
        telefono: TEL,
        sentAt: '2026-11-20T12:00:00Z',
      })
    );
    expect(a.conversaciones[0].ai_autoreply_disabled).toBe(true); // 2 h: sigue callado

    await procesar(
      a,
      mensajeRecibido({
        id: 'in3',
        wamid: 'w3',
        telefono: TEL,
        sentAt: '2026-11-21T12:00:00Z',
      })
    );
    expect(a.conversaciones[0].ai_autoreply_disabled).toBe(false);
  });

  it('un entrante en espera (standby) no despierta a los motores', async () => {
    const a = new AlmacenMemoria();
    const r = await procesar(
      a,
      mensajeRecibido({ id: 's', wamid: 'ws', telefono: TEL, standby: true })
    );
    expect(r.trabajos).toHaveLength(0);
  });
});

describe('envíos dudosos y adjuntos', () => {
  it('un envío nuestro que quedó en sending se concilia con su message.sent', async () => {
    const a = new AlmacenMemoria();
    await procesar(
      a,
      mensajeRecibido({ id: 'in', wamid: 'w-in', telefono: TEL })
    );
    a.mensajes.push({
      id: 'nuestro-1',
      conversation_id: a.conversaciones[0].id,
      sender_type: 'agent',
      sender_id: 'u',
      content_type: 'text',
      content_text: 'Ya le cotizo',
      media_url: null,
      media_type: null,
      message_id: null as unknown as string,
      status: 'sending',
      created_at: new Date().toISOString(),
      reply_to_message_id: null,
      error_code: null,
      error_title: null,
    });
    await procesar(
      a,
      mensajeEnviado({
        id: 'sent',
        wamid: 'wamid.ok',
        participante: '573001112233',
        texto: 'Ya le cotizo',
        source: 'cloud_api',
      })
    );
    expect(a.mensajes.filter((m) => m.sender_type === 'agent')).toHaveLength(1);
    expect(a.mensajes.find((m) => m.id === 'nuestro-1')).toMatchObject({
      status: 'sent',
      message_id: 'wamid.ok',
    });
  });

  it('un adjunto entrante deja el aviso «sin descargar» y un trabajo para después', async () => {
    const a = new AlmacenMemoria();
    const r = await procesar(
      a,
      mensajeRecibido({
        id: 'img',
        wamid: 'w-img',
        telefono: TEL,
        texto: null,
        adjuntos: [
          {
            type: 'image',
            url: 'https://zernio.com/api/v1/whatsapp/media/1',
            mimeType: 'image/jpeg',
          },
        ],
      })
    );
    expect(a.mensajes[0]).toMatchObject({
      content_type: 'image',
      content_text: ADJUNTO_SIN_DESCARGAR,
      media_url: null,
    });
    expect(r.trabajos.map((t) => t.clase)).toEqual(['adjunto', 'motores']);
  });
});
