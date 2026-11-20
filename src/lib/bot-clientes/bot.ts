// ============================================================
// El bot de clientes de ECOVIT por WhatsApp (bloque 6, RF-M03.2, .9 y .11).
//
// Lo que NO decide el modelo lo decide la base (0114), y el bot solo pregunta:
//  · ¿contesta este chat?           → `bot_puede_contestar_wa` (IA prendida,
//    sin pausa, sin dueño, lista blanca A, tope mensual, cupo del chat);
//  · ¿qué puede saber el cliente?   → `catalogo_cliente_wa` (decisión B: precio
//    de lista y nada de costos; el precio lo pone el código con T9);
//  · ¿a quién se pasa?              → `pasar_a_vendedor_wa` (decisión C);
//  · ¿cuánto se gastó?              → `registrar_uso_ia_wa`, por CADA llamada,
//    aunque la respuesta falle o se descarte.
// Justo antes de enviar, `claim_ai_reply_slot` mira otra vez que nadie haya
// tomado el chat ni pausado la IA (RF-M03.3), y reclama el cupo.
//
// Nunca lanza: un fallo del bot no puede tumbar el webhook.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { mergeConsecutive } from '@/lib/ai/providers/shared';
import type { ChatMessage } from '@/lib/ai/types';
import { ErrorClaude, type BloqueContenido, type MensajeClaude, type RespuestaClaude } from './claude';
import { costoUsd, leerUso, MODELO_BOT } from './costo';
import { HERRAMIENTAS_BOT, MOTIVOS_MODELO, SISTEMA_BOT } from './prompt';
import { revisarRespuesta, type ReferenciaCatalogo } from './revisor';
import {
  ASESOR_SIN_NOMBRE,
  HORARIO_ECOVIT,
  t3PasoConAsesor,
  t4FaltaDato,
  t5NoNegocia,
  t6IaNoResponde,
  TEXTOS,
  textoAprobado,
} from './textos';

/** Vueltas de herramientas por mensaje: buscar, quizá buscar otra vez, contestar. */
const MAX_VUELTAS = 3;
const MAX_RESUMEN = 2000;

export interface DependenciasBot {
  /** Con la clave de servicio: el bot no tiene sesión. */
  db: SupabaseClient;
  /** La llave de Anthropic y el cupo por chat; null si la IA no está configurada para Claude. */
  configuracion: () => Promise<{ apiKey: string; cupoPorChat: number } | null>;
  llamar: (args: { apiKey: string; sistema: string; herramientas: typeof HERRAMIENTAS_BOT; mensajes: MensajeClaude[] }) => Promise<RespuestaClaude>;
  /** Manda un texto del bot al chat (queda `ai_generated`). */
  enviarTexto: (texto: string) => Promise<void>;
  /** Los últimos mensajes de texto, del más viejo al más nuevo. */
  contexto: () => Promise<ChatMessage[]>;
  /** ¿Llegó otro mensaje del cliente después del que se está contestando? */
  hayEntranteMasNuevo?: () => Promise<boolean>;
  /** «Escribiendo…» para el cliente (solo Meta). Cosmético: no puede fallar el bot. */
  escribiendo?: () => Promise<void>;
  ahora?: () => Date;
}

export type ResultadoBot =
  | { accion: 'silencio'; motivo: string }
  | { accion: 'respondio'; texto: string }
  | { accion: 'paso'; motivo: string; texto: string | null }
  | { accion: 'descartado'; motivo: string };

type Puede = { puede: boolean; motivo: string | null };

async function puedeContestar(db: SupabaseClient, conversationId: string): Promise<Puede | null> {
  const { data, error } = await db.rpc('bot_puede_contestar_wa', { p_conversacion: conversationId });
  if (error) {
    console.error('[bot-clientes] bot_puede_contestar_wa falló:', error.message);
    return null;
  }
  return data as Puede;
}

/**
 * Una fila por llamada. Sin `usage` (corte de red, tiempo agotado) va en cero;
 * el motivo queda en el registro del servidor, porque `registrar_uso_ia_wa`
 * no tiene dónde guardarlo (pendiente en SQL).
 */
async function registrarUso(
  db: SupabaseClient,
  conversationId: string,
  usage: unknown,
  motivoSinUso?: string
): Promise<void> {
  if (!usage && motivoSinUso) {
    console.warn(`[bot-clientes] llamada sin usage (${conversationId}): ${motivoSinUso}`);
  }
  const uso = leerUso(usage);
  const { error } = await db.rpc('registrar_uso_ia_wa', {
    p_conversacion: conversationId,
    p_modelo: MODELO_BOT,
    p_tokens_entrada: uso.entrada,
    p_tokens_salida: uso.salida,
    p_cache_lectura: uso.cacheLectura,
    p_cache_escritura: uso.cacheEscritura,
    p_costo_usd: costoUsd(uso),
  });
  // No se calla: un gasto sin anotar deja el tope ciego.
  if (error) console.error('[bot-clientes] no se pudo anotar el gasto:', error.message);
}

/** Lo que Claude acepta: turnos alternados que empiezan por el cliente. */
/**
 * El T9 que mandó el sistema NO lo escribió el modelo: si le llega como suyo,
 * después cree que dio un precio sin consultar. Se le muestra como lo que es,
 * un texto automático, y sin la cifra.
 */
const T9_ENVIADO = new RegExp(
  TEXTOS.T9.plantilla
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace('{precio}', '[^\\n]+?')
    .replace('{unidad}', '[^\\n]+?'),
  'g'
);
export const MARCA_T9_HISTORIAL =
  '[Precio de lista entregado al cliente correctamente por el sistema, con su aclaración. Ya está hecho: no se repite ni es un error.]';

export function mensajesParaClaude(contexto: ChatMessage[]): MensajeClaude[] {
  const unidos = mergeConsecutive(
    contexto.map((m) =>
      m.role === 'assistant' ? { ...m, content: m.content.replace(T9_ENVIADO, MARCA_T9_HISTORIAL) } : m
    )
  );
  while (unidos.length > 0 && unidos[0].role === 'assistant') unidos.shift();
  return unidos.map((m) => ({ role: m.role, content: m.content }));
}

export function fueraDeHorario(ahora: Date): boolean {
  if (!HORARIO_ECOVIT) return false;
  const bogota = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const hora = bogota.getHours();
  return (
    !HORARIO_ECOVIT.dias.includes(bogota.getDay()) ||
    hora < HORARIO_ECOVIT.abre ||
    hora >= HORARIO_ECOVIT.cierra
  );
}

function resumenDe(contexto: ChatMessage[], prefijo: string): string {
  const ultimo = [...contexto].reverse().find((m) => m.role === 'user')?.content ?? '';
  return `${prefijo}${ultimo ? ` Último mensaje del cliente: «${ultimo.replace(/\s+/g, ' ').slice(0, 300)}»` : ''}`.slice(
    0,
    MAX_RESUMEN
  );
}

/** El texto que recibe el cliente al pasar el chat, según el motivo. */
export function textoAlPasar(motivo: string, asesor: string, fuera: boolean): string {
  if (motivo === 'tope' || motivo === 'ia_caida') return t6IaNoResponde();
  if (motivo === 'sin_dato') return t4FaltaDato(asesor);
  const t3 =
    fuera && textoAprobado('T11') && HORARIO_ECOVIT
      ? TEXTOS.T11.plantilla.replace('{asesor}', asesor).replace('{horario}', HORARIO_ECOVIT.texto)
      : t3PasoConAsesor(asesor);
  if (motivo === 'descuento' || motivo === 'volumen' || motivo === 'credito') {
    return `${t5NoNegocia()}\n\n${t3}`;
  }
  return t3;
}

async function pasarAVendedor(
  deps: DependenciasBot,
  conversationId: string,
  motivo: string,
  resumen: string,
  revisarAntes: boolean
): Promise<ResultadoBot> {
  const db = deps.db;
  // Si una persona tomó el chat mientras el bot pensaba, no se le pasa nada ni
  // se le escribe al cliente: ya lo atiende alguien (RF-M03.3).
  if (revisarAntes) {
    const p = await puedeContestar(db, conversationId);
    if (p && (p.motivo === 'chat_con_dueno' || p.motivo === 'ia_pausada')) {
      return { accion: 'silencio', motivo: p.motivo };
    }
  }
  // `ia_caida` es del código; en la base va como `otro`.
  const motivoBase = motivo === 'ia_caida' ? 'otro' : motivo;
  const { data, error } = await db.rpc('pasar_a_vendedor_wa', {
    p_conversacion: conversationId,
    p_motivo: motivoBase,
    p_resumen: resumen.slice(0, MAX_RESUMEN) || 'El bot pasó el chat.',
  });
  if (error) {
    // Sin el paso hecho, decirle al cliente «ya lo tiene tu asesor» sería mentir.
    console.error('[bot-clientes] pasar_a_vendedor_wa falló:', error.message);
    return { accion: 'silencio', motivo: 'paso_fallido' };
  }
  const paso = data as { en_espera: boolean; destino_id: string | null };
  let asesor = ASESOR_SIN_NOMBRE;
  if (!paso.en_espera && paso.destino_id) {
    const { data: perfil } = await db
      .from('perfiles')
      .select('nombre')
      .eq('id', paso.destino_id)
      .maybeSingle();
    const nombre = (perfil as { nombre?: string } | null)?.nombre?.trim();
    if (nombre) asesor = nombre.split(/\s+/)[0];
  }
  const texto = textoAlPasar(motivo, asesor, fueraDeHorario(deps.ahora?.() ?? new Date()));
  try {
    await deps.enviarTexto(texto);
  } catch (err) {
    console.error('[bot-clientes] no se pudo mandar el texto del paso:', err instanceof Error ? err.message : err);
    return { accion: 'paso', motivo, texto: null };
  }
  return { accion: 'paso', motivo, texto };
}

/** Lo que el modelo puede saber de una referencia: sin el número del precio. */
export function paraElModelo(refs: ReferenciaCatalogo[]): string {
  return JSON.stringify(
    refs.map((r) => ({
      codigo: r.codigo,
      descripcion: r.descripcion,
      unidad: r.unidad,
      disponibilidad: r.disponibilidad ?? 'a confirmar',
      tiene_precio_de_lista: r.precio_base !== null && r.precio_base > 0,
    }))
  );
}

/** Códigos con letras y cifras: «SR-3300», «FX1020». Los solo numéricos no (podrían ser cifras). */
const CODIGO_EN_TEXTO = /(?<![\p{L}\d])[A-Za-z]{1,8}[-_.]?\d[A-Za-z0-9.-]*(?<![.-])/gu;
const MAX_CODIGOS_PREVIOS = 10;

/**
 * Los códigos que el catálogo devolvió en turnos anteriores. No se guardan
 * (`messages` no tiene dónde, y pedirlo sería SQL nuevo): el modelo solo puede
 * conocerlos por el historial, así que se toman los códigos que aparecen ahí y
 * se confirman uno por uno con `catalogo_cliente_wa` (código exacto, sin gastar
 * en la IA). Solo códigos: ni cantidades ni existencias.
 */
export async function codigosDeTurnosAnteriores(
  db: SupabaseClient,
  contexto: ChatMessage[],
  yaConsultadas: Map<string, ReferenciaCatalogo>
): Promise<string[]> {
  const candidatos = new Set<string>();
  for (const m of contexto) {
    for (const c of m.content.match(CODIGO_EN_TEXTO) ?? []) {
      if (!yaConsultadas.has(c)) candidatos.add(c);
      if (candidatos.size >= MAX_CODIGOS_PREVIOS) break;
    }
  }
  const confirmados: string[] = [];
  for (const c of candidatos) {
    const { data, error } = await db.rpc('catalogo_cliente_wa', { p_texto: c });
    if (error) continue;
    const refs = ((data as { referencias?: ReferenciaCatalogo[] } | null)?.referencias ?? []) as ReferenciaCatalogo[];
    const exacta = refs.find((r) => r.codigo.toLowerCase() === c.toLowerCase());
    if (exacta) confirmados.push(exacta.codigo);
  }
  return confirmados;
}

export async function atenderConBot(deps: DependenciasBot, conversationId: string): Promise<ResultadoBot> {
  const db = deps.db;
  try {
    const puede = await puedeContestar(db, conversationId);
    if (!puede) return { accion: 'silencio', motivo: 'error_al_preguntar' };

    if (!puede.puede) {
      // El tope y el cupo SÍ le avisan al cliente y pasan el chat (RF-M03.11);
      // los demás motivos son silencio: la IA apagada, la pausa, el dueño, la
      // lista blanca (decisión A: los demás llegan a «Esperan» sin bot).
      if (puede.motivo === 'tope_alcanzado' || puede.motivo === 'cupo_chat_alcanzado') {
        const motivo = puede.motivo === 'tope_alcanzado' ? 'tope' : 'cupo';
        const prefijo =
          motivo === 'tope' ? 'Se llegó al tope de gasto del mes del bot.' : 'Se acabó el cupo de respuestas del bot en este chat.';
        return pasarAVendedor(deps, conversationId, motivo, resumenDe(await deps.contexto(), prefijo), false);
      }
      return { accion: 'silencio', motivo: puede.motivo ?? 'no_puede' };
    }

    const contexto = await deps.contexto();
    const mensajes = mensajesParaClaude(contexto);
    if (mensajes.length === 0) return { accion: 'silencio', motivo: 'sin_mensajes' };

    const config = await deps.configuracion();
    if (!config) {
      console.error('[bot-clientes] la IA está prendida pero sin llave de Anthropic.');
      return pasarAVendedor(deps, conversationId, 'ia_caida', resumenDe(contexto, 'La IA no está configurada.'), true);
    }

    // Pasó todo: el bot va a pensar. Se le muestra al cliente que escribe.
    if (deps.escribiendo) {
      await deps.escribiendo().catch((err) =>
        console.warn('[bot-clientes] «escribiendo…» falló (sigue):', err instanceof Error ? err.message : err)
      );
    }

    const { data: conv } = await db
      .from('conversations')
      .select('ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle();
    const respuestasAntes = (conv as { ai_reply_count?: number } | null)?.ai_reply_count ?? 0;

    const consultadas = new Map<string, ReferenciaCatalogo>();
    // Lo que el modelo vio de las herramientas en ESTE turno: la lista blanca
    // de números del revisor. Sin precios (`paraElModelo` no los manda).
    let permitidos = '';
    let texto: string | null = null;
    for (let vuelta = 0; vuelta < MAX_VUELTAS && texto === null; vuelta++) {
      // Mensajes en pedazos: si el cliente ya mandó otro, esta vuelta se va a
      // descartar; se corta ANTES de gastar.
      if (deps.hayEntranteMasNuevo && (await deps.hayEntranteMasNuevo())) {
        return { accion: 'descartado', motivo: 'entrante_mas_nuevo' };
      }
      let resp: RespuestaClaude;
      try {
        resp = await deps.llamar({
          apiKey: config.apiKey,
          sistema: SISTEMA_BOT,
          herramientas: HERRAMIENTAS_BOT,
          mensajes,
        });
      } catch (err) {
        // Siempre deja rastro: con el `usage` que haya, o una fila en cero.
        const detalle = err instanceof Error ? err.message : String(err);
        await registrarUso(db, conversationId, err instanceof ErrorClaude ? err.usage : null, detalle);
        return pasarAVendedor(deps, conversationId, 'ia_caida', resumenDe(contexto, `La IA no respondió (${detalle}).`), true);
      }
      await registrarUso(db, conversationId, resp.usage);

      // Cortada por el tope de tokens: el texto está a medias y no se manda.
      if (resp.stop_reason === 'max_tokens') {
        return pasarAVendedor(deps, conversationId, 'ia_caida', resumenDe(contexto, 'La respuesta de la IA quedó cortada.'), true);
      }

      if (resp.stop_reason === 'refusal') {
        return pasarAVendedor(deps, conversationId, 'ia_caida', resumenDe(contexto, 'La IA se negó a responder.'), true);
      }

      const usos = resp.content.filter((b) => b.type === 'tool_use') as (BloqueContenido & {
        id: string;
        name: string;
        input: Record<string, unknown>;
      })[];
      if (usos.length === 0) {
        texto = resp.content
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('')
          .trim();
        break;
      }

      const paso = usos.find((u) => u.name === 'pasar_a_vendedor');
      if (paso) {
        const motivo = (MOTIVOS_MODELO as readonly string[]).includes(String(paso.input.motivo))
          ? String(paso.input.motivo)
          : 'otro';
        const resumen = String(paso.input.resumen ?? '').trim() || resumenDe(contexto, 'El bot pasó el chat.');
        return pasarAVendedor(deps, conversationId, motivo, resumen, true);
      }

      // Las búsquedas: todas en el mismo mensaje de vuelta (uso en paralelo).
      const resultados: BloqueContenido[] = [];
      for (const u of usos) {
        if (u.name !== 'buscar_referencias') {
          resultados.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Herramienta desconocida.' });
          continue;
        }
        const { data, error } = await db.rpc('catalogo_cliente_wa', { p_texto: String(u.input.texto ?? '') });
        if (error) {
          resultados.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: error.message });
          continue;
        }
        const refs = ((data as { referencias?: ReferenciaCatalogo[] } | null)?.referencias ?? []) as ReferenciaCatalogo[];
        for (const r of refs) consultadas.set(r.codigo, r);
        const visto = paraElModelo(refs);
        permitidos += `\n${visto}`;
        resultados.push({ type: 'tool_result', tool_use_id: u.id, content: visto });
      }
      mensajes.push({ role: 'assistant', content: resp.content });
      mensajes.push({ role: 'user', content: resultados });
    }

    if (!texto) {
      return pasarAVendedor(deps, conversationId, 'enredo', resumenDe(contexto, 'El bot no llegó a una respuesta.'), true);
    }

    const delCliente = contexto.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const previos = await codigosDeTurnosAnteriores(db, contexto, consultadas);
    const revision = revisarRespuesta(texto, consultadas, permitidos, delCliente, previos);
    if (!revision.ok) {
      console.warn('[bot-clientes] respuesta bloqueada por el revisor:', revision.motivo);
      return pasarAVendedor(deps, conversationId, 'sin_dato', resumenDe(contexto, `Respuesta del bot bloqueada: ${revision.motivo}.`), true);
    }

    // Si el cliente escribió otra vez mientras tanto, se contesta ese (el gasto
    // de esta ya quedó anotado).
    if (deps.hayEntranteMasNuevo && (await deps.hayEntranteMasNuevo())) {
      return { accion: 'descartado', motivo: 'entrante_mas_nuevo' };
    }

    // Justo antes de enviar: reclama el cupo solo si sigue sin dueño y sin pausa.
    const { data: reclamado, error: reclamoErr } = await db.rpc('claim_ai_reply_slot', {
      conversation_id: conversationId,
      max_replies: config.cupoPorChat,
    });
    if (reclamoErr) {
      console.error('[bot-clientes] claim_ai_reply_slot falló:', reclamoErr.message);
      return { accion: 'descartado', motivo: 'reclamo_fallido' };
    }
    if (reclamado !== true) return { accion: 'descartado', motivo: 'chat_tomado_o_cupo' };

    const final =
      respuestasAntes === 0 && textoAprobado('T10') ? `${TEXTOS.T10.plantilla}\n\n${revision.texto}` : revision.texto;
    await deps.enviarTexto(final);
    return { accion: 'respondio', texto: final };
  } catch (err) {
    console.error('[bot-clientes] falló:', err instanceof Error ? err.message : err);
    return { accion: 'silencio', motivo: 'error' };
  }
}
