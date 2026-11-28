// ============================================================
// Cuerpos de ejemplo de los webhooks de Zernio, armados SOLO con los campos que
// documentan sus páginas (webhooks, inbox/message-received, message-sent,
// message-delivered, message-read, message-failed, contact-updated). El de `webhook.test` es el
// de la documentación, tal cual. Los usan las pruebas y
// `scripts/simular-zernio.mts`, así que este archivo no importa nada.
// ============================================================

export const CUENTA_EJEMPLO = '66b2e19d8c3f5a7e9d0b1c2d';
export const CONVERSACION_EJEMPLO = '66c3d2ae7b4f6c8d0e1f2a3b';

/** Literal de docs.zernio.com/webhooks («First event», paso 3). */
export const EJEMPLO_WEBHOOK_TEST = {
  id: '3f0c1c2e-6c4a-4d3e-9b1f-2a7d8e9f0a1b',
  event: 'webhook.test',
  message: 'This is a test webhook from Zernio',
  timestamp: '2027-01-01T17:00:00Z',
};

function cuenta(accountId = CUENTA_EJEMPLO) {
  // `account.id` repite `account.accountId` «for compatibility».
  return { accountId, id: accountId, platform: 'whatsapp' };
}

export interface OpcionesRecibido {
  id: string;
  wamid: string;
  /** E.164 con «+», o null (usuarios con nombre de usuario desde abril de 2026). */
  telefono: string | null;
  bsuid?: string | null;
  nombre?: string;
  texto?: string | null;
  sentAt?: string;
  conversationId?: string;
  standby?: boolean;
  adjuntos?: Array<{ type: string; url: string; mimeType?: string }>;
}

export function mensajeRecibido(o: OpcionesRecibido) {
  const sender: Record<string, unknown> = {
    id: o.telefono ? o.telefono.replace(/^\+/, '') : (o.bsuid ?? ''),
    name: o.nombre ?? 'Cliente de prueba',
    phoneNumber: o.telefono,
  };
  if (o.bsuid) sender.businessScopedUserId = o.bsuid;
  const sentAt = o.sentAt ?? '2026-11-20T15:00:00Z';
  return {
    id: o.id,
    event: 'message.received',
    message: {
      id: `int-${o.wamid}`,
      conversationId: o.conversationId ?? CONVERSACION_EJEMPLO,
      platform: 'whatsapp',
      platformMessageId: o.wamid,
      direction: 'incoming',
      text:
        o.texto === undefined
          ? 'Hola, ¿tienen el vidrio templado de 6 mm?'
          : o.texto,
      attachments: o.adjuntos ?? [],
      sender,
      sentAt,
      isRead: false,
      sentVia: null,
      automationId: null,
      workflowId: null,
      executionId: null,
      broadcastId: null,
      sequenceId: null,
    },
    conversation: {
      id: o.conversationId ?? CONVERSACION_EJEMPLO,
      participantId: o.telefono
        ? o.telefono.replace(/^\+/, '')
        : (o.bsuid ?? ''),
      participantName: o.nombre ?? 'Cliente de prueba',
    },
    account: cuenta(),
    metadata: o.standby ? { standby: true } : null,
    timestamp: sentAt,
  };
}

export interface OpcionesEnviado {
  id: string;
  wamid: string;
  /** El cliente (dígitos con indicativo, sin «+»). */
  participante: string;
  texto?: string | null;
  source?: 'whatsapp_business_app' | 'cloud_api' | 'meta_business_agent';
  sentAt?: string;
  conversationId?: string;
}

export function mensajeEnviado(o: OpcionesEnviado) {
  const sentAt = o.sentAt ?? '2026-11-20T15:05:00Z';
  return {
    id: o.id,
    event: 'message.sent',
    message: {
      id: `int-${o.wamid}`,
      conversationId: o.conversationId ?? CONVERSACION_EJEMPLO,
      platform: 'whatsapp',
      platformMessageId: o.wamid,
      direction: 'outgoing',
      text: o.texto === undefined ? 'Sí señor, ya le cotizo.' : o.texto,
      attachments: [],
      // En `message.sent` el remitente es el propio negocio.
      sender: { id: CUENTA_EJEMPLO, name: 'ECOVIT' },
      sentAt,
      isRead: false,
      source: o.source ?? 'whatsapp_business_app',
      // `null` para lo que se mandó desde la app del teléfono.
      sentVia: o.source === 'cloud_api' ? 'api' : null,
      automationId: null,
      workflowId: null,
      executionId: null,
      broadcastId: null,
      sequenceId: null,
    },
    conversation: {
      id: o.conversationId ?? CONVERSACION_EJEMPLO,
      participantId: o.participante,
      participantName: 'Cliente de prueba',
    },
    account: cuenta(),
    timestamp: sentAt,
  };
}

export function estadoMensaje(
  evento: 'message.delivered' | 'message.read' | 'message.failed',
  o: {
    id: string;
    wamid: string;
    statusAt?: string;
    error?: { code: string | number; title: string; message: string };
  }
) {
  const statusAt = o.statusAt ?? '2026-11-20T15:06:00Z';
  return {
    id: o.id,
    event: evento,
    message: {
      id: `int-${o.wamid}`,
      conversationId: CONVERSACION_EJEMPLO,
      platform: 'whatsapp',
      platformMessageId: o.wamid,
      direction: 'outgoing',
    },
    statusAt,
    error: evento === 'message.failed' ? (o.error ?? null) : null,
    conversation: { id: CONVERSACION_EJEMPLO },
    account: cuenta(),
    timestamp: statusAt,
  };
}

export function cuentaDesconectada(id: string) {
  return {
    id,
    event: 'account.disconnected',
    account: cuenta(),
    timestamp: '2026-11-20T16:00:00Z',
  };
}

/**
 * `contact.updated` (docs.zernio.com/webhooks/inbox/contact-updated): solo trae
 * el id del contacto y `changeType`; el nombre se lee con `GET /v1/contacts/{id}`.
 */
export function contactoActualizado(
  id: string,
  contactoId: string,
  o: { changeType?: 'updated' | 'deleted'; platform?: string } = {}
) {
  return {
    id,
    event: 'contact.updated',
    account: {
      ...cuenta(),
      profileId: '66a1f0c2a4b9d3e8f1a2b3c4',
      platform: o.platform ?? 'whatsapp',
      username: '+573001234567',
      displayName: 'ECOVIT',
    },
    contact: { id: contactoId, changeType: o.changeType ?? 'updated' },
    timestamp: '2026-11-20T16:30:00Z',
  };
}

/** La respuesta de `GET /v1/contacts/{id}` (forma medida el 28-nov). */
export function respuestaContacto(
  contactoId: string,
  nombre: string,
  telefonoE164: string,
  accountId = CUENTA_EJEMPLO
) {
  return {
    success: true,
    contact: {
      id: contactoId,
      name: nombre,
      email: null,
      company: null,
      tags: [],
      isSubscribed: true,
      isBlocked: false,
      customFields: {},
      notes: null,
      createdAt: '2026-11-20T16:00:00Z',
      updatedAt: '2026-11-20T16:30:00Z',
    },
    channels: [
      {
        id: `canal-${contactoId}`,
        accountId,
        platform: 'whatsapp',
        platformIdentifier: telefonoE164,
        displayIdentifier: `${telefonoE164} (${telefonoE164})`,
        isSubscribed: true,
        conversationId: null,
      },
    ],
  };
}
