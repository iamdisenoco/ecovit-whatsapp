// ============================================================
// El almacén de verdad: escribe con la clave de servicio (RLS no aplica; las
// rejas de columnas y los disparadores de la base sí). Es, junto con la ruta de
// Meta (`app/api/whatsapp/meta/webhook`), lo único que crea contactos (por
// `contactos-supabase.ts`).
//
// Usa lo que trae la migración 0115: `registrar_evento_wa` y
// `marcar_evento_procesado_wa` (whatsapp_eventos), las columnas
// `conversations.proveedor_conversacion_id`/`proveedor_cuenta_id`,
// `messages.desde_celular`, el estado `incierto`, `callar_bot_por_celular_wa`,
// `despertar_bot_por_celular_wa` y `whatsapp_config.conectado_desde`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound';
import {
  applyMessageStatus,
  applyPendingMessageStatuses,
} from '../message-status-sync';
import { applyBroadcastRecipientStatus } from '../broadcast-recipient-webhook';
import type {
  Entorno,
  IdentidadRemitente,
  ReferenciaConversacion,
} from '../proveedor/tipos';
import {
  buscarOCrearContactoSupabase,
  completarNombresSupabase,
} from './contactos-supabase';
import {
  ErrorAlmacen,
  type AlmacenWhatsApp,
  type ChatRecalculado,
  type Conciliacion,
  type ConversacionFila,
  type EstadoEntrante,
  type EstadoEvento,
  type Inquilino,
  type MensajeGuardado,
  type MensajeNuevo,
  type OpcionesConversacionNueva,
  type ResumenHistoria,
} from './almacen';
import { resumen } from './procesar';
import { igualesAlChat } from './almacen';

export const BUCKET_ADJUNTOS = 'chat-media';

export const COLUMNA_REFERENCIA = 'proveedor_conversacion_id';
export const COLUMNA_CUENTA_REFERENCIA = 'proveedor_cuenta_id';

const COLUMNAS_CONVERSACION =
  'id, contact_id, status, assigned_agent_id, ai_autoreply_disabled, ai_handoff_summary, first_inbound_at, last_inbound_at';

/** Ventana para conciliar un envío dudoso con su `message.sent`. */
const VENTANA_CONCILIAR_MS = 15 * 60 * 1000;

/** El inquilino casi no cambia: uno por proceso, cinco minutos. */
const INQUILINO_TTL_MS = 5 * 60 * 1000;
let inquilinoCache: { en: number; valor: Inquilino } | null = null;

/** Para las pruebas. */
export function olvidarInquilino() {
  inquilinoCache = null;
}

export class AlmacenSupabase implements AlmacenWhatsApp {
  private accountId: string | null = null;

  /** Para lo que va en after() y puede tardar (Storage): sin el tope de 1,5 s. */
  private readonly dbLento: SupabaseClient;

  constructor(
    private readonly db: SupabaseClient,
    private readonly env: Entorno = process.env,
    dbLento?: SupabaseClient
  ) {
    this.dbLento = dbLento ?? db;
  }

  // ── Eventos ─────────────────────────────────────────────────────────

  /**
   * `registrar_evento_wa` (0115) devuelve el estado tal cual: `nuevo`,
   * `reintento` (quedó sin cerrar más de 2 min), `procesado` o `en_curso`.
   */
  async tomarEvento(eventoId: string, tipo: string): Promise<EstadoEvento> {
    const { data, error } = await this.db.rpc('registrar_evento_wa', {
      p_id: eventoId,
      p_tipo: tipo,
    });
    if (error)
      throw new ErrorAlmacen(
        `No se pudo registrar el evento: ${error.message}`
      );
    if (
      data === 'nuevo' ||
      data === 'reintento' ||
      data === 'procesado' ||
      data === 'en_curso'
    ) {
      return data;
    }
    throw new ErrorAlmacen(
      `registrar_evento_wa devolvió algo inesperado: ${JSON.stringify(data)}`
    );
  }

  async marcarEventoProcesado(eventoId: string, tipo: string): Promise<void> {
    const { error } = await this.db.rpc('marcar_evento_procesado_wa', {
      p_id: eventoId,
      p_tipo: tipo,
    });
    if (error)
      throw new ErrorAlmacen(`No se pudo cerrar el evento: ${error.message}`);
  }

  // ── La cuenta ───────────────────────────────────────────────────────

  async resolverInquilino(): Promise<Inquilino> {
    if (inquilinoCache && Date.now() - inquilinoCache.en < INQUILINO_TTL_MS) {
      this.accountId = inquilinoCache.valor.accountId;
      return inquilinoCache.valor;
    }
    // ECOVIT tiene una sola cuenta (restricción `accounts_solo_ecovit`).
    const { data: cuentas, error } = await this.db
      .from('accounts')
      .select('id')
      .limit(2);
    if (error)
      throw new ErrorAlmacen(`No se pudo leer la cuenta: ${error.message}`);
    if (!cuentas || cuentas.length !== 1) {
      throw new ErrorAlmacen(
        `Se esperaba una sola cuenta y hay ${cuentas?.length ?? 0}.`
      );
    }
    const accountId = cuentas[0].id as string;

    const { data: config, error: errConfig } = await this.db
      .from('whatsapp_config')
      .select('user_id, connected_at, conectado_desde')
      .eq('account_id', accountId)
      .maybeSingle();
    if (errConfig)
      throw new ErrorAlmacen(
        `No se pudo leer whatsapp_config: ${errConfig.message}`
      );

    let usuarioId = (config?.user_id as string | undefined) ?? null;
    if (!usuarioId) {
      // Con Zernio la configuración vive en el entorno y puede no haber fila: las
      // filas nuevas las firma el primer admin de la cuenta.
      const { data: admins, error: errAdmin } = await this.db
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .in('account_role', ['owner', 'admin'])
        .order('created_at', { ascending: true })
        .limit(1);
      if (errAdmin)
        throw new ErrorAlmacen(`No se pudo leer profiles: ${errAdmin.message}`);
      usuarioId = (admins?.[0]?.user_id as string | undefined) ?? null;
    }
    if (!usuarioId)
      throw new ErrorAlmacen(
        'No hay un admin en la cuenta para firmar las filas del webhook.'
      );

    this.accountId = accountId;
    const valor: Inquilino = {
      accountId,
      usuarioId,
      conectadoDesde:
        (config?.conectado_desde as string | null | undefined) ??
        (config?.connected_at as string | null | undefined) ??
        (this.env.WHATSAPP_CONECTADO_DESDE?.trim() || null),
    };
    inquilinoCache = { en: Date.now(), valor };
    return valor;
  }

  // ── Contactos y conversaciones ──────────────────────────────────────

  async buscarConversacionPorReferencia(
    inq: Inquilino,
    ref: ReferenciaConversacion
  ): Promise<ConversacionFila | null> {
    if (!ref.conversacionId) return null;
    let q = this.db
      .from('conversations')
      .select(COLUMNAS_CONVERSACION)
      .eq('account_id', inq.accountId)
      .eq(COLUMNA_REFERENCIA, ref.conversacionId);
    q = ref.cuentaId
      ? q.eq(COLUMNA_CUENTA_REFERENCIA, ref.cuentaId)
      : q.is(COLUMNA_CUENTA_REFERENCIA, null);
    const { data, error } = await q.limit(1);
    if (error)
      throw new ErrorAlmacen(
        `No se pudo buscar el chat del proveedor: ${error.message}`
      );
    return (data?.[0] as ConversacionFila | undefined) ?? null;
  }

  async buscarOCrearContacto(
    inq: Inquilino,
    identidad: IdentidadRemitente
  ): Promise<{ contactoId: string; creado: boolean }> {
    return buscarOCrearContactoSupabase(this.db, inq, identidad);
  }

  async completarNombres(
    inq: Inquilino,
    pares: Array<{ telefono: string; nombre: string }>
  ): Promise<number> {
    return completarNombresSupabase(this.db, inq, pares);
  }

  private async conversacionDe(
    accountId: string,
    contactoId: string
  ): Promise<ConversacionFila | null> {
    // La más vieja: la misma que conserva la deduplicación de wacrm (#363).
    const { data, error } = await this.db
      .from('conversations')
      .select(COLUMNAS_CONVERSACION)
      .eq('account_id', accountId)
      .eq('contact_id', contactoId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error)
      throw new ErrorAlmacen(
        `No se pudo buscar la conversación: ${error.message}`
      );
    return (data?.[0] as ConversacionFila | undefined) ?? null;
  }

  async buscarOCrearConversacion(
    inq: Inquilino,
    contactoId: string,
    nueva?: OpcionesConversacionNueva
  ): Promise<{ conversacion: ConversacionFila; creada: boolean }> {
    const existente = await this.conversacionDe(inq.accountId, contactoId);
    if (existente) return { conversacion: existente, creada: false };

    // Sin asignado: el webhook nunca escribe `assigned_agent_id` (reja de la 0113).
    const { data, error } = await this.db
      .from('conversations')
      .insert({
        account_id: inq.accountId,
        user_id: inq.usuarioId,
        contact_id: contactoId,
        // `stamp_conversation_closed_at` respeta el `closed_at` que viene.
        ...(nueva?.cerradaEn
          ? { status: 'closed', closed_at: nueva.cerradaEn }
          : {}),
        // Ningún disparador de `conversations` pisa `created_at` (0110–0115).
        ...(nueva?.creadaEn ? { created_at: nueva.creadaEn } : {}),
      })
      .select(COLUMNAS_CONVERSACION)
      .single();
    if (error) {
      if (isUniqueViolation(error)) {
        const ganadora = await this.conversacionDe(inq.accountId, contactoId);
        if (ganadora) return { conversacion: ganadora, creada: false };
      }
      throw new ErrorAlmacen(
        `No se pudo crear la conversación: ${error.message}`
      );
    }
    return { conversacion: data as ConversacionFila, creada: true };
  }

  async guardarReferencia(
    conversacionId: string,
    ref: ReferenciaConversacion
  ): Promise<void> {
    if (!ref.conversacionId) return;
    const { error } = await this.db
      .from('conversations')
      .update({
        [COLUMNA_REFERENCIA]: ref.conversacionId,
        [COLUMNA_CUENTA_REFERENCIA]: ref.cuentaId,
      })
      .eq('id', conversacionId);
    // Otra fila ya tiene esa conversación (carrera): se deja la que estaba.
    if (error && isUniqueViolation(error)) {
      console.warn(
        '[webhook] la conversación del proveedor ya está en otro chat:',
        ref.conversacionId
      );
      return;
    }
    if (error)
      throw new ErrorAlmacen(
        `No se pudo guardar la conversación del proveedor: ${error.message}`
      );
  }

  // ── Mensajes ────────────────────────────────────────────────────────

  async insertarMensajeSiNuevo(
    fila: MensajeNuevo
  ): Promise<{ id: string } | null> {
    // `ignoreDuplicates` = ON CONFLICT DO NOTHING; `.select()` devuelve la fila
    // solo si de verdad se insertó. Vacío = repetido (wacrm #367).
    const { data, error } = await this.db
      .from('messages')
      .upsert(fila, {
        onConflict: 'conversation_id,message_id',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error)
      throw new ErrorAlmacen(`No se pudo guardar el mensaje: ${error.message}`);
    if (!data || data.length === 0) return null;
    if (fila.sender_type !== 'customer' && this.accountId) {
      // Un «entregado» o «leído» que llegó antes que el `message.sent`.
      await applyPendingMessageStatuses(
        this.db,
        this.accountId,
        fila.message_id
      );
    }
    return { id: data[0].id as string };
  }

  async insertarMensajesSiNuevos(filas: MensajeNuevo[]): Promise<number> {
    if (filas.length === 0) return 0;
    // Un solo upsert con ON CONFLICT DO NOTHING: `.select()` devuelve solo
    // las filas que entraron. Sin `applyPendingMessageStatuses`: es historia
    // y trae su propio estado de entrega.
    const { data, error } = await this.db
      .from('messages')
      .upsert(filas, {
        onConflict: 'conversation_id,message_id',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error)
      throw new ErrorAlmacen(
        `No se pudieron guardar los mensajes: ${error.message}`
      );
    return data?.length ?? 0;
  }

  async mensajesPorWamid(
    conversacionId: string,
    wamids: string[]
  ): Promise<MensajeGuardado[]> {
    if (wamids.length === 0) return [];
    const salida: MensajeGuardado[] = [];
    // Tandas chicas: el `in()` viaja en la URL.
    for (let i = 0; i < wamids.length; i += 50) {
      const { data, error } = await this.db
        .from('messages')
        .select('id, message_id, media_url, content_text')
        .eq('conversation_id', conversacionId)
        .in('message_id', wamids.slice(i, i + 50));
      if (error)
        throw new ErrorAlmacen(
          `No se pudieron leer los mensajes guardados: ${error.message}`
        );
      salida.push(...((data ?? []) as MensajeGuardado[]));
    }
    return salida;
  }

  async borrarMensajesSinContenido(
    conversacionId: string,
    wamids: string[],
    texto: string
  ): Promise<number> {
    let n = 0;
    for (let i = 0; i < wamids.length; i += 50) {
      // El texto exacto va en el WHERE: si alguien lo cambió, no se borra.
      const { data, error } = await this.db
        .from('messages')
        .delete()
        .eq('conversation_id', conversacionId)
        .in('message_id', wamids.slice(i, i + 50))
        .eq('content_text', texto)
        .select('id');
      if (error) {
        // Una reacción u otra fila colgada (RESTRICT) lo impide: se deja.
        console.error(
          '[historial] no se pudo borrar un mensaje vacío de la sincronización:',
          error.message
        );
        continue;
      }
      n += data?.length ?? 0;
    }
    return n;
  }

  /** El primer o el último mensaje del chat que cumple `filtro`. */
  private async extremo(
    conversacionId: string,
    ascendente: boolean,
    filtro: 'todos' | 'entrante' | 'respuesta' = 'todos'
  ): Promise<{
    created_at: string;
    content_text: string | null;
    content_type: MensajeNuevo['content_type'];
  } | null> {
    let q = this.db
      .from('messages')
      .select('created_at, content_text, content_type')
      .eq('conversation_id', conversacionId);
    if (filtro === 'entrante') q = q.eq('sender_type', 'customer');
    // Lo mismo que cuenta `track_conversation_message_times`.
    if (filtro === 'respuesta')
      q = q
        .or('sender_type.eq.agent,ai_generated.is.true')
        .neq('status', 'failed');
    const { data, error } = await q
      .order('created_at', { ascending: ascendente })
      .limit(1)
      .maybeSingle();
    if (error)
      throw new ErrorAlmacen(
        `No se pudo leer el chat para recalcularlo: ${error.message}`
      );
    return (data as {
      created_at: string;
      content_text: string | null;
      content_type: MensajeNuevo['content_type'];
    } | null) ?? null;
  }

  /**
   * ¿Hay algo que apunte a este chat y que borrarlo dejaría suelto? Las tablas
   * con RESTRICT (mensajes, reacciones, el bot) ya las frena la base; estas
   * no: o ponen NULL, o guardan el id sin llave foránea. Si una consulta
   * falla, se toma como que sí: ante la duda no se borra.
   */
  private async tieneAlgoColgado(conversacionId: string): Promise<boolean> {
    const consultas = [
      ['ai_usage_log', 'conversation_id'],
      ['flow_runs', 'conversation_id'],
      ['notifications', 'conversation_id'],
      ['bitacora', 'entidad_id'],
      ['avisos', 'datos->>conversacion_id'],
    ] as const;
    for (const [tabla, columna] of consultas) {
      const { count, error } = await this.db
        .from(tabla)
        .select('*', { count: 'exact', head: true })
        .eq(columna, conversacionId);
      if (error || (count ?? 0) > 0) return true;
    }
    return false;
  }

  async recalcularChat(
    conversacionId: string,
    historiaAntesDe: string
  ): Promise<ChatRecalculado> {
    const { data, error } = await this.db
      .from('conversations')
      .select(
        'id, status, assigned_agent_id, asignado_por, ai_autoreply_disabled, ai_handoff_summary, ai_reply_count, created_at, closed_at, updated_at, last_message_text, last_message_at, first_inbound_at, last_inbound_at, last_reply_at'
      )
      .eq('id', conversacionId)
      .maybeSingle();
    if (error)
      throw new ErrorAlmacen(`No se pudo leer el chat: ${error.message}`);
    if (!data) return 'borrado';
    const conv = data as Record<string, unknown>;
    const fecha = (k: string) =>
      typeof conv[k] === 'string' ? (conv[k] as string) : null;
    const corte = Date.parse(historiaAntesDe);
    const creado = fecha('created_at');
    const deHistoria = !!creado && Date.parse(creado) < corte;
    // La guarda de todas las escrituras: si entre la lectura y la escritura
    // entró un mensaje (o alguien tocó el chat), `updated_at` cambió y no se
    // pisa nada. Lo nuevo gana.
    const visto = fecha('updated_at');
    const conGuarda = <T extends { eq: (c: string, v: unknown) => T; is: (c: string, v: null) => T }>(q: T) =>
      visto ? q.eq('updated_at', visto) : q.is('updated_at', null);

    const ultimo = await this.extremo(conversacionId, false);
    if (!ultimo) {
      if (
        deHistoria &&
        conv.status === 'closed' &&
        !conv.assigned_agent_id &&
        !conv.asignado_por &&
        !conv.ai_autoreply_disabled &&
        !conv.ai_handoff_summary &&
        !conv.ai_reply_count &&
        !(await this.tieneAlgoColgado(conversacionId))
      ) {
        const { data: borrado, error: errBorrar } = await conGuarda(
          this.db
            .from('conversations')
            .delete()
            .eq('id', conversacionId)
            .eq('status', 'closed')
            .is('assigned_agent_id', null)
        ).select('id');
        if (!errBorrar && (borrado?.length ?? 0) > 0) return 'borrado';
        if (errBorrar)
          console.error(
            '[historial] el chat vacío no se pudo borrar; queda vacío:',
            errBorrar.message
          );
      }
      const vacio = {
        last_message_text: null,
        last_message_at: creado,
        first_inbound_at: null,
        last_inbound_at: null,
        last_reply_at: null,
      };
      if (igualesAlChat(conv, vacio)) return 'sin_cambios';
      const { data: hecho, error: errVacio } = await conGuarda(
        this.db
          .from('conversations')
          .update({
            last_message_text: null,
            last_message_at: creado,
            first_inbound_at: null,
            last_inbound_at: null,
            last_reply_at: null,
          })
          .eq('id', conversacionId)
      ).select('id');
      if (errVacio)
        throw new ErrorAlmacen(
          `No se pudo dejar vacío el chat: ${errVacio.message}`
        );
      return (hecho?.length ?? 0) > 0 ? 'vacio' : 'otro_escribio';
    }

    const [primero, primerEntrante, ultimoEntrante, ultimaRespuesta] =
      await Promise.all([
        this.extremo(conversacionId, true),
        this.extremo(conversacionId, true, 'entrante'),
        this.extremo(conversacionId, false, 'entrante'),
        this.extremo(conversacionId, false, 'respuesta'),
      ]);
    // Lo creó la historia: sus fechas reales. El cierre, solo si sigue
    // cerrado desde la historia (nadie lo cerró después). Sin tocar `status`:
    // `stamp_conversation_closed_at` no corre.
    const cierre = fecha('closed_at');
    const nuevoCreado = deHistoria && primero ? primero.created_at : creado;
    const nuevoCierre =
      deHistoria &&
      conv.status === 'closed' &&
      cierre &&
      Date.parse(cierre) < corte
        ? ultimo.created_at
        : cierre;
    const nuevo = {
      last_message_text: resumen(ultimo.content_text, ultimo.content_type),
      last_message_at: ultimo.created_at,
      first_inbound_at: primerEntrante?.created_at ?? null,
      last_inbound_at: ultimoEntrante?.created_at ?? null,
      last_reply_at: ultimaRespuesta?.created_at ?? null,
      created_at: nuevoCreado,
      closed_at: nuevoCierre,
    };
    if (igualesAlChat(conv, nuevo)) return 'sin_cambios';
    // Directo a la tabla: los disparadores de `messages` (GREATEST) no corren
    // con un UPDATE de `conversations`, así que estas fechas sí pueden bajar.
    const { data: hecho, error: errCambio } = await conGuarda(
      this.db
        .from('conversations')
        .update({
          last_message_text: nuevo.last_message_text,
          last_message_at: nuevo.last_message_at,
          first_inbound_at: nuevo.first_inbound_at,
          last_inbound_at: nuevo.last_inbound_at,
          last_reply_at: nuevo.last_reply_at,
          created_at: nuevo.created_at,
          closed_at: nuevo.closed_at,
        })
        .eq('id', conversacionId)
    ).select('id');
    if (errCambio)
      throw new ErrorAlmacen(
        `No se pudo recalcular el chat: ${errCambio.message}`
      );
    return (hecho?.length ?? 0) > 0 ? 'recalculado' : 'otro_escribio';
  }

  async buscarMensajePorWamid(
    conversacionId: string,
    wamid: string
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversacionId)
      .eq('message_id', wamid)
      .maybeSingle();
    // Si falla, se lanza: un «no existe» falso llevaría a conciliar o a
    // insertar a ciegas.
    if (error)
      throw new ErrorAlmacen(
        `No se pudo buscar el mensaje por wamid: ${error.message}`
      );
    return (data?.id as string | undefined) ?? null;
  }

  async ultimoEcoCelular(conversacionId: string): Promise<string | null> {
    // `desde_celular` y `created_at` se leen con el `select` de tabla de
    // `messages` (0110/0115 solo pasan a columnas el `insert`).
    const { data, error } = await this.db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversacionId)
      .eq('desde_celular', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    // Si falla, se lanza: un «no hay eco» falso dejaría al bot callado sin
    // razón, y el reintento del proveedor lo arregla.
    if (error)
      throw new ErrorAlmacen(
        `No se pudo leer la última respuesta del celular: ${error.message}`
      );
    return (data?.created_at as string | undefined) ?? null;
  }

  async conciliarEnvioPendiente(
    conversacionId: string,
    texto: string | null,
    wamid: string
  ): Promise<Conciliacion> {
    // Antes que nada: si el wamid ya está, no se le pone a otra fila (chocaría
    // con el índice único y el webhook daría 500 en cada reintento).
    if (await this.buscarMensajePorWamid(conversacionId, wamid))
      return 'ninguno';

    let consulta = this.db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversacionId)
      .in('status', ['sending', 'incierto'])
      .is('message_id', null)
      .gte(
        'created_at',
        new Date(Date.now() - VENTANA_CONCILIAR_MS).toISOString()
      )
      .order('created_at', { ascending: true })
      .limit(2);
    consulta =
      texto === null
        ? consulta.is('content_text', null)
        : consulta.eq('content_text', texto);
    const { data, error } = await consulta;
    if (error)
      throw new ErrorAlmacen(
        `No se pudo buscar el envío pendiente: ${error.message}`
      );
    if (!data || data.length === 0) return 'ninguno';
    // Dos o más con el mismo texto: no se adivina.
    if (data.length > 1) return 'ambiguo';

    const { data: actualizado, error: errUpd } = await this.db
      .from('messages')
      .update({ message_id: wamid, status: 'sent' })
      .eq('id', data[0].id as string)
      .in('status', ['sending', 'incierto'])
      .is('message_id', null)
      .select('id');
    if (errUpd && isUniqueViolation(errUpd)) return 'ambiguo';
    if (errUpd)
      throw new ErrorAlmacen(
        `No se pudo conciliar el envío pendiente: ${errUpd.message}`
      );
    // Si la bandeja le puso el wamid en el medio, ya está: es la misma fila.
    if (!actualizado?.length) return 'conciliado';
    if (this.accountId)
      await applyPendingMessageStatuses(this.db, this.accountId, wamid);
    return 'conciliado';
  }

  async registrarEntrante(
    conv: ConversacionFila,
    resumen: string,
    recibidoEn: string
  ): Promise<{ primerEntrante: boolean }> {
    // El contador sube en la base, en un solo UPDATE (wacrm #369).
    const { error } = await this.db.rpc('bump_conversation_on_inbound', {
      p_conversation_id: conv.id,
      p_last_message_text: resumen,
    });
    if (error)
      console.error(
        '[webhook] no se pudo actualizar la conversación:',
        error.message
      );
    const primerEntrante = await claimFirstInboundMessage(
      this.db,
      conv,
      recibidoEn
    );
    await reopenClosedConversation(this.db, conv);
    return { primerEntrante };
  }

  async registrarSaliente(
    conversacionId: string,
    resumen: string
  ): Promise<void> {
    const ahora = new Date().toISOString();
    const { error } = await this.db
      .from('conversations')
      .update({
        last_message_text: resumen,
        last_message_at: ahora,
        updated_at: ahora,
      })
      .eq('id', conversacionId);
    if (error)
      console.error(
        '[webhook] no se pudo actualizar el resumen de la conversación:',
        error.message
      );
  }

  async registrarHistoria(
    conversacionId: string,
    h: ResumenHistoria
  ): Promise<void> {
    // Sin `unread_count`, sin reabrir y sin `updated_at` a mano: es historia.
    // `last_inbound_at` lo mueve el disparador de `messages` con la fecha
    // original (GREATEST), así que no revive la ventana de 24 h.
    const ultimoEn = new Date(h.ultimoEn).toISOString();
    const { error } = await this.db
      .from('conversations')
      .update({ last_message_text: h.resumen, last_message_at: ultimoEn })
      .eq('id', conversacionId)
      .or(`last_message_at.is.null,last_message_at.lt.${ultimoEn}`);
    if (error)
      throw new ErrorAlmacen(
        `No se pudo poner el resumen de la historia: ${error.message}`
      );
    if (!h.primerEntranteEn) return;
    // Así el primer mensaje que llegue después no cuenta como «primer
    // entrante» de un contacto que ya tenía historia.
    const { error: errPrimero } = await this.db
      .from('conversations')
      .update({ first_inbound_at: new Date(h.primerEntranteEn).toISOString() })
      .eq('id', conversacionId)
      .is('first_inbound_at', null);
    if (errPrimero)
      throw new ErrorAlmacen(
        `No se pudo poner el primer entrante de la historia: ${errPrimero.message}`
      );
  }

  async ajustarFechasHistoria(
    conversacionId: string,
    desde: string,
    hasta: string
  ): Promise<void> {
    const d = new Date(desde).toISOString();
    const h = new Date(hasta).toISOString();
    const { error } = await this.db
      .from('conversations')
      .update({ created_at: d })
      .eq('id', conversacionId)
      .gt('created_at', d);
    if (error)
      throw new ErrorAlmacen(
        `No se pudo ajustar la fecha del chat: ${error.message}`
      );
    // `stamp_conversation_closed_at` solo corre con UPDATE OF status: este no
    // lo toca. Si alguien lo reabrió, se deja.
    const { error: errCierre } = await this.db
      .from('conversations')
      .update({ closed_at: h })
      .eq('id', conversacionId)
      .eq('status', 'closed')
      .lt('closed_at', h);
    if (errCierre)
      throw new ErrorAlmacen(
        `No se pudo ajustar el cierre del chat: ${errCierre.message}`
      );
  }

  async aplicarEstado(
    accountId: string,
    estado: EstadoEntrante
  ): Promise<void> {
    // No retrocede (message-status.ts) y, si la fila no existe todavía, queda en
    // `pending_message_statuses` hasta que llegue.
    await applyMessageStatus(this.db, accountId, estado);
    await applyBroadcastRecipientStatus(this.db, {
      whatsappMessageId: estado.wamid,
      status: estado.status,
      occurredAt: estado.statusAt ?? new Date().toISOString(),
      failure: estado.failure,
    });
  }

  // ── El bot ──────────────────────────────────────────────────────────

  /** Con bitácora y sin pisar la nota si alguien ya lo había callado (0115). */
  async callarBot(
    conversacionId: string,
    mensajeId: string,
    motivo: string
  ): Promise<void> {
    const { error } = await this.db.rpc('callar_bot_por_celular_wa', {
      p_conversacion: conversacionId,
      p_mensaje_id: mensajeId,
      p_motivo: motivo,
    });
    if (error)
      throw new ErrorAlmacen(`No se pudo callar al bot: ${error.message}`);
  }

  async despertarBot(conversacionId: string, motivo: string): Promise<void> {
    const { error } = await this.db.rpc('despertar_bot_por_celular_wa', {
      p_conversacion: conversacionId,
      p_motivo: motivo,
    });
    if (error)
      throw new ErrorAlmacen(
        `No se pudo devolver el chat al bot: ${error.message}`
      );
  }

  async pausarFlujos(accountId: string, contactoId: string): Promise<void> {
    const { error } = await this.db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactoId)
      .eq('status', 'active');
    if (error)
      console.error(
        '[webhook] no se pudieron pausar los flujos:',
        error.message
      );
  }

  async anotarCuentaDesconectada(accountId: string): Promise<void> {
    const { error } = await this.db
      .from('whatsapp_config')
      .update({ status: 'disconnected' })
      .eq('account_id', accountId);
    if (error)
      throw new ErrorAlmacen(
        `No se pudo anotar la desconexión: ${error.message}`
      );
  }

  // ── Adjuntos ────────────────────────────────────────────────────────

  async guardarAdjunto(
    ruta: string,
    bytes: Uint8Array,
    mime: string
  ): Promise<boolean> {
    const { error } = await this.dbLento.storage
      .from(BUCKET_ADJUNTOS)
      .upload(ruta, bytes, {
        contentType: mime,
        cacheControl: '3600',
        upsert: true,
      });
    if (error) {
      console.error(
        '[webhook] no se pudo guardar el adjunto en Storage:',
        error.message
      );
      return false;
    }
    return true;
  }

  async actualizarAdjunto(
    mensajeId: string,
    mediaUrl: string | null,
    texto?: string | null
  ): Promise<boolean> {
    const cambios: Record<string, string | null> = { media_url: mediaUrl };
    if (texto !== undefined) cambios.content_text = texto;
    const { data, error } = await this.dbLento
      .from('messages')
      .update(cambios)
      .eq('id', mensajeId)
      .select('id');
    if (error)
      console.error(
        '[webhook] no se pudo anotar el adjunto en el mensaje:',
        error.message
      );
    return !error && (data?.length ?? 0) > 0;
  }
}
