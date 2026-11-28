// ============================================================
// Lectura de los webhooks de Zernio: de su JSON a los eventos normalizados de
// `tipos.ts`. Solo campos documentados (webhooks, inbox/message-*); lo que no
// está ahí va marcado «sin verificar en la documentación».
// ============================================================

import type {
  AdjuntoEntrante,
  EstadoMensaje,
  EventoWhatsApp,
  IdentidadRemitente,
  OrigenEnvio,
  ReferenciaConversacion,
  TipoAdjunto,
} from './tipos';

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

const SOLO_DIGITOS = /^\d{6,15}$/;

/**
 * La identidad de quien escribe. `phoneNumber` viene en E.164 con «+» y puede
 * faltar o ser nulo desde la llegada de los nombres de usuario (abril de 2026):
 * entonces se usa `businessScopedUserId`. `sender.id` es el teléfono sin «+»
 * «when available», si no el BSUID; por eso solo se toma como teléfono si son
 * solo dígitos.
 */
export function identidadDeRemitente(sender: Obj): IdentidadRemitente {
  const deTelefono = (str(sender.phoneNumber) ?? '').replace(/\D/g, '');
  const id = str(sender.id) ?? '';
  const telefono = deTelefono || (SOLO_DIGITOS.test(id) ? id : '');
  return {
    telefono,
    waUserId: str(sender.businessScopedUserId),
    waParentUserId: str(sender.parentBusinessScopedUserId),
    waUsername: str(sender.whatsappUsername),
    nombre: (str(sender.name) ?? '').trim(),
  };
}

/**
 * La otra parte en un `message.sent`: ahí `sender` es el propio negocio, y la
 * documentación pide leer `conversation.participantId` / `participantName` /
 * `participantUsername`. Si `participantId` es un BSUID y no dígitos, queda como
 * BSUID (sin verificar en la documentación cuál de los dos trae para usuarios
 * sin teléfono).
 */
function identidadDeParticipante(conversation: Obj): IdentidadRemitente {
  const participante = str(conversation.participantId) ?? '';
  const digitos = participante.replace(/^\+/, '');
  const esTelefono = SOLO_DIGITOS.test(digitos);
  return {
    telefono: esTelefono ? digitos : '',
    waUserId: esTelefono ? null : participante || null,
    waParentUserId: null,
    waUsername: str(conversation.participantUsername),
    nombre: (str(conversation.participantName) ?? '').trim(),
  };
}

function tipoAdjunto(tipo: string | null): TipoAdjunto {
  switch (tipo) {
    case 'image':
    case 'video':
    case 'audio':
    case 'sticker':
      return tipo;
    case 'file':
      return 'document';
    default:
      return 'otro';
  }
}

function adjuntos(lista: unknown): AdjuntoEntrante[] {
  if (!Array.isArray(lista)) return [];
  const salida: AdjuntoEntrante[] = [];
  lista.forEach((crudo, indice) => {
    const a = obj(crudo);
    const url = str(a.url);
    if (!url) return;
    salida.push({
      tipo: tipoAdjunto(str(a.type)),
      url,
      mime: str(a.mimeType),
      indice,
    });
  });
  return salida;
}

function referencia(mensaje: Obj, cuenta: Obj): ReferenciaConversacion {
  return {
    conversacionId: str(mensaje.conversationId),
    // `account.id` repite `account.accountId` «for compatibility».
    cuentaId: str(cuenta.accountId) ?? str(cuenta.id),
  };
}

function origenDe(source: string | null): OrigenEnvio {
  if (source === 'whatsapp_business_app') return 'celular';
  if (source === 'cloud_api') return 'api';
  if (source === 'meta_business_agent') return 'agente_meta';
  return 'desconocido';
}

const ESTADOS: Record<string, EstadoMensaje> = {
  'message.delivered': 'delivered',
  'message.read': 'read',
  // Un audio reproducido ya fue leído; el orden de estados impide que retroceda.
  'message.played': 'read',
  'message.failed': 'failed',
};

function numeroOnull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim()))
    return Number.parseInt(v.trim(), 10);
  return null;
}

/**
 * Normaliza un evento de Zernio. Lo que no es WhatsApp o no se usa sale como
 * `ignorado` (se contesta 200 igual: un 4xx haría que Zernio lo mande a la cola
 * de muertos, y un 5xx lo reintentaría siete veces sin razón).
 */
export function leerWebhookZernio(json: unknown): EventoWhatsApp[] {
  const sobre = obj(json);
  const eventoId = str(sobre.id) ?? '';
  const nombre = str(sobre.event) ?? '';
  const base = {
    eventoId,
    generadoEn: str(sobre.timestamp),
    prueba: sobre.test === true,
  };
  const mensaje = obj(sobre.message);
  const cuenta = obj(sobre.account);
  const metadata = obj(sobre.metadata);

  if (nombre === 'webhook.test') {
    return [
      { ...base, prueba: true, tipo: 'prueba', mensaje: str(sobre.message) },
    ];
  }

  if (nombre === 'account.disconnected') {
    return [
      {
        ...base,
        tipo: 'cuenta_desconectada',
        cuentaId: str(cuenta.accountId) ?? str(cuenta.id),
        // TODO(zernio): el motivo («Meta's own reason») no tiene campo nombrado en
        // las páginas leídas — sin verificar en la documentación. Se guarda nulo.
        motivo: null,
      },
    ];
  }

  // La agenda del celular (coexistencia) agregó o renombró un contacto. El
  // mismo evento sale de Google/Outlook: solo se toma el de WhatsApp. Un
  // `deleted` no borra nada en la app.
  if (nombre === 'contact.updated') {
    const contacto = obj(sobre.contact);
    const contactoId = str(contacto.id);
    const plataforma = str(cuenta.platform);
    if (
      !contactoId ||
      str(contacto.changeType) === 'deleted' ||
      (plataforma !== null && plataforma !== 'whatsapp')
    )
      return [{ ...base, tipo: 'ignorado', nombre }];
    return [
      {
        ...base,
        tipo: 'contacto_actualizado',
        contactoId,
        cuentaId: str(cuenta.accountId) ?? str(cuenta.id),
      },
    ];
  }

  const esWhatsApp = str(mensaje.platform) === 'whatsapp';

  if (nombre === 'message.received' && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId);
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }];
    return [
      {
        ...base,
        tipo: 'mensaje_entrante',
        mensajeId,
        referencia: referencia(mensaje, cuenta),
        remitente: identidadDeRemitente(obj(mensaje.sender)),
        texto: str(mensaje.text),
        adjuntos: adjuntos(mensaje.attachments),
        enviadoEn:
          str(mensaje.sentAt) ?? base.generadoEn ?? new Date().toISOString(),
        enEspera: metadata.standby === true,
        // Solo un REFUERZO: lo que decide si es historia es la fecha de conexión
        // (`coexistencia.ts`, que falla cerrado). `coexistence_history` está
        // documentado como `metadata.source` en la lectura REST; que llegue en el
        // webhook está sin verificar en la documentación (TODO zernio).
        esHistoria: str(metadata.source) === 'coexistence_history',
        // TODO(zernio): el nombre del campo de la cita en `message.received` está sin
        // verificar en la documentación; `quotedMessageId` es el de `message.sent`.
        citaA: str(metadata.quotedMessageId),
      },
    ];
  }

  if (nombre === 'message.sent' && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId);
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }];
    const source = str(mensaje.source);
    return [
      {
        ...base,
        tipo: 'mensaje_enviado',
        mensajeId,
        referencia: referencia(mensaje, cuenta),
        destinatario: identidadDeParticipante(obj(sobre.conversation)),
        texto: str(mensaje.text),
        adjuntos: adjuntos(mensaje.attachments),
        enviadoEn:
          str(mensaje.sentAt) ?? base.generadoEn ?? new Date().toISOString(),
        origen: origenDe(source),
        origenCrudo: source,
      },
    ];
  }

  if (nombre in ESTADOS && esWhatsApp) {
    const mensajeId = str(mensaje.platformMessageId);
    if (!mensajeId) return [{ ...base, tipo: 'ignorado', nombre }];
    const estado = ESTADOS[nombre];
    const error = obj(sobre.error);
    return [
      {
        ...base,
        tipo: 'estado',
        mensajeId,
        estado,
        ocurridoEn: str(sobre.statusAt),
        error:
          estado === 'failed'
            ? {
                codigo: numeroOnull(error.code),
                titulo:
                  str(error.title) ?? str(error.message) ?? 'Falló el envío',
                detalle: str(error.message),
              }
            : null,
      },
    ];
  }

  return [{ ...base, tipo: 'ignorado', nombre: nombre || '(sin nombre)' }];
}
