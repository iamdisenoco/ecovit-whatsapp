// ============================================================
// Adaptador de Meta (WhatsApp Cloud API directo). Envuelve lo que ya traía
// wacrm —`meta-api.ts`, la firma `X-Hub-Signature-256` y la lectura de su
// webhook— para que pasar a Meta el día de mañana sea cambiar
// `WHATSAPP_PROVEEDOR=meta` (guía de Zernio, «Pasar después a Meta directo»).
//
// El procesamiento COMPLETO del webhook de Meta que tenía wacrm (reacciones,
// plantillas, mensajes sin contenido, la verificación GET con `hub.challenge`)
// sigue vivo en `/api/whatsapp/meta/webhook`, que solo responde con este
// proveedor activo. Aquí `leerWebhook` normaliza lo esencial (mensajes y
// estados) para quien use la interfaz.
// ============================================================

import { verifyMetaWebhookSignature } from '../webhook-signature';
import {
  MetaApiError,
  downloadMedia,
  getMediaUrl,
  getPhoneNumberHealth,
  sendMediaMessage,
  sendTemplateMessage,
  sendTextMessage,
} from '../meta-api';
import {
  ErrorConfiguracion,
  ErrorProveedor,
  leerEncabezado,
  type AdjuntoEntrante,
  type ArchivoBajado,
  type DestinoEnvio,
  type Encabezados,
  type EnvioMedia,
  type EnvioPlantilla,
  type EstadoConexion,
  type EstadoMensaje,
  type EventoWhatsApp,
  type OpcionesEnvio,
  type ProveedorWhatsApp,
  type ResultadoEnvio,
  type TipoAdjunto,
} from './tipos';

export interface CredencialesMetaMinimas {
  phoneNumberId: string;
  accessToken: string;
}

/** Carga perezosa de las credenciales (con la clave de servicio, en el servidor). */
export type CargarCredencialesMeta =
  () => Promise<CredencialesMetaMinimas | null>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

const ADJUNTOS_META: Record<string, TipoAdjunto> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

const ESTADOS_META: Record<string, EstadoMensaje> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

function epochAIso(valor: unknown): string | null {
  const segundos = Number.parseInt(String(valor ?? ''), 10);
  return Number.isFinite(segundos)
    ? new Date(segundos * 1000).toISOString()
    : null;
}

/**
 * Normaliza el cuerpo de un webhook de Meta (`entry[].changes[].value`). Meta no
 * manda un id de evento: se arma con el wamid (y el estado), que es lo que
 * deduplica de verdad.
 */
export function leerWebhookMeta(json: unknown): EventoWhatsApp[] {
  const eventos: EventoWhatsApp[] = [];
  const entradas = Array.isArray(obj(json).entry)
    ? (obj(json).entry as unknown[])
    : [];
  for (const entrada of entradas) {
    const cambios = Array.isArray(obj(entrada).changes)
      ? (obj(entrada).changes as unknown[])
      : [];
    for (const cambio of cambios) {
      const valor = obj(obj(cambio).value);
      const numero = str(obj(valor.metadata).phone_number_id);
      const contactos = Array.isArray(valor.contacts)
        ? (valor.contacts as unknown[])
        : [];

      const mensajes = Array.isArray(valor.messages)
        ? (valor.messages as unknown[])
        : [];
      mensajes.forEach((crudo, i) => {
        const m = obj(crudo);
        const wamid = str(m.id);
        if (!wamid) return;
        const contacto = obj(contactos[i] ?? contactos[0]);
        const tipo = str(m.type) ?? 'text';
        const cuerpoMedia = obj(m[tipo]);
        const adjuntos: AdjuntoEntrante[] =
          tipo in ADJUNTOS_META && str(cuerpoMedia.id)
            ? [
                {
                  tipo: ADJUNTOS_META[tipo],
                  url: `meta-media:${cuerpoMedia.id}`,
                  mime: str(cuerpoMedia.mime_type),
                  indice: 0,
                },
              ]
            : [];
        const enviadoEn = epochAIso(m.timestamp) ?? new Date().toISOString();
        eventos.push({
          eventoId: `meta:${wamid}`,
          generadoEn: enviadoEn,
          prueba: false,
          tipo: 'mensaje_entrante',
          mensajeId: wamid,
          referencia: { conversacionId: null, cuentaId: numero },
          remitente: {
            telefono: (str(m.from) ?? str(contacto.wa_id) ?? '').replace(
              /\D/g,
              ''
            ),
            waUserId: str(m.from_user_id) ?? str(contacto.user_id),
            waParentUserId:
              str(m.from_parent_user_id) ?? str(contacto.parent_user_id),
            waUsername: str(obj(contacto.profile).username),
            nombre: (str(obj(contacto.profile).name) ?? '').trim(),
          },
          texto: str(obj(m.text).body) ?? str(cuerpoMedia.caption),
          adjuntos,
          enviadoEn,
          enEspera: false,
          esHistoria: false,
          citaA: str(obj(m.context).id),
        });
      });

      const estados = Array.isArray(valor.statuses)
        ? (valor.statuses as unknown[])
        : [];
      for (const crudo of estados) {
        const s = obj(crudo);
        const wamid = str(s.id);
        const estado = ESTADOS_META[str(s.status) ?? ''];
        if (!wamid || !estado) continue;
        const error = obj(Array.isArray(s.errors) ? s.errors[0] : null);
        eventos.push({
          eventoId: `meta:${wamid}:${estado}`,
          generadoEn: epochAIso(s.timestamp),
          prueba: false,
          tipo: 'estado',
          mensajeId: wamid,
          estado,
          ocurridoEn: epochAIso(s.timestamp),
          error:
            estado === 'failed'
              ? {
                  codigo: typeof error.code === 'number' ? error.code : null,
                  titulo: str(error.title) ?? 'Falló el envío',
                  detalle:
                    str(obj(error.error_data).details) ?? str(error.message),
                }
              : null,
        });
      }
    }
  }
  return eventos;
}

function aErrorProveedor(err: unknown): ErrorProveedor {
  if (err instanceof ErrorProveedor) return err;
  if (err instanceof MetaApiError) {
    return new ErrorProveedor(err.message, {
      dudoso: err.httpStatus >= 500,
      estadoHttp: err.httpStatus,
      codigo: err.code === null ? null : String(err.code),
    });
  }
  // `fetch` lanza TypeError cuando la red se cae: no se sabe si salió.
  const mensaje = err instanceof Error ? err.message : String(err);
  return new ErrorProveedor(mensaje, { dudoso: err instanceof TypeError });
}

export class ProveedorMeta implements ProveedorWhatsApp {
  readonly nombre = 'meta' as const;

  constructor(private readonly cargarCredenciales: CargarCredencialesMeta) {}

  verificarFirma(cuerpoCrudo: string, encabezados: Encabezados): boolean {
    return verifyMetaWebhookSignature(
      cuerpoCrudo,
      leerEncabezado(encabezados, 'x-hub-signature-256')
    );
  }

  leerWebhook(json: unknown): EventoWhatsApp[] {
    return leerWebhookMeta(json);
  }

  private async credenciales(): Promise<CredencialesMetaMinimas> {
    const c = await this.cargarCredenciales();
    if (!c)
      throw new ErrorConfiguracion(
        'WhatsApp (Meta) no está configurado para esta cuenta.'
      );
    return c;
  }

  private destinatario(destino: DestinoEnvio): string {
    const to = (destino.telefono ?? '').trim();
    if (!to)
      throw new ErrorProveedor('El contacto no tiene teléfono ni BSUID.', {
        dudoso: false,
      });
    return to;
  }

  async enviarTexto(
    destino: DestinoEnvio,
    texto: string,
    opciones: OpcionesEnvio
  ): Promise<ResultadoEnvio> {
    const c = await this.credenciales();
    try {
      const r = await sendTextMessage({
        ...c,
        to: this.destinatario(destino),
        text: texto,
        contextMessageId: opciones.responderA ?? undefined,
      });
      return { mensajeId: r.messageId, referencia: null };
    } catch (err) {
      throw aErrorProveedor(err);
    }
  }

  async enviarMedia(
    destino: DestinoEnvio,
    media: EnvioMedia,
    opciones: OpcionesEnvio
  ): Promise<ResultadoEnvio> {
    const c = await this.credenciales();
    try {
      const r = await sendMediaMessage({
        ...c,
        to: this.destinatario(destino),
        kind: media.tipo,
        link: media.url,
        caption: media.texto ?? undefined,
        filename: media.nombreArchivo ?? undefined,
        contextMessageId: opciones.responderA ?? undefined,
      });
      return { mensajeId: r.messageId, referencia: null };
    } catch (err) {
      throw aErrorProveedor(err);
    }
  }

  async enviarPlantilla(
    destino: DestinoEnvio,
    plantilla: EnvioPlantilla,
    opciones: OpcionesEnvio
  ): Promise<ResultadoEnvio> {
    const c = await this.credenciales();
    try {
      const r = await sendTemplateMessage({
        ...c,
        to: this.destinatario(destino),
        templateName: plantilla.nombre,
        language: plantilla.idioma,
        params: plantilla.parametros,
        contextMessageId: opciones.responderA ?? undefined,
      });
      return { mensajeId: r.messageId, referencia: null };
    } catch (err) {
      throw aErrorProveedor(err);
    }
  }

  async verificarConexion(): Promise<EstadoConexion> {
    const vacio = { numero: null, nombre: null, calidad: null };
    let c: CredencialesMetaMinimas | null;
    try {
      c = await this.cargarCredenciales();
    } catch (err) {
      return {
        conectado: false,
        detalle: err instanceof Error ? err.message : String(err),
        ...vacio,
      };
    }
    if (!c)
      return {
        conectado: false,
        detalle: 'No hay número de Meta configurado.',
        ...vacio,
      };
    try {
      const salud = await getPhoneNumberHealth(c);
      return {
        conectado: true,
        detalle: 'Meta responde por el número.',
        numero: salud.display_phone_number ?? null,
        nombre: null,
        calidad: salud.quality_rating ?? null,
      };
    } catch (err) {
      return {
        conectado: false,
        detalle: err instanceof Error ? err.message : String(err),
        ...vacio,
      };
    }
  }

  async descargarAdjunto(
    adjunto: AdjuntoEntrante
  ): Promise<ArchivoBajado | null> {
    if (!adjunto.url.startsWith('meta-media:')) return null;
    const c = await this.cargarCredenciales();
    if (!c) return null;
    try {
      const { url, mimeType } = await getMediaUrl({
        mediaId: adjunto.url.slice('meta-media:'.length),
        accessToken: c.accessToken,
      });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: url,
        accessToken: c.accessToken,
      });
      return {
        bytes: new Uint8Array(buffer),
        mime: (contentType || mimeType).split(';')[0].trim(),
      };
    } catch {
      return null;
    }
  }
}
