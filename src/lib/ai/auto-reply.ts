// ============================================================
// La respuesta automática del webhook. En ECOVIT es el bot de clientes
// (bloque 6, `lib/bot-clientes/`): Sonnet 5.5 con las reglas de la base
// (0114). Esta capa solo arma sus dependencias reales —clave de servicio, la
// llave de Anthropic de `ai_configs`, el envío por el proveedor— y lo llama.
//
// Lo que se fue de wacrm: el modelo y el proveedor de `ai_configs` (el bot es
// siempre Claude Sonnet 5.5), el traspaso a `handoff_agent_id` (lo decide
// `pasar_a_vendedor_wa`, decisión C) y el `update` de la pausa y del asignado
// (0113: por función).
//
// Nunca lanza: el bot no puede tumbar el 200 del webhook.
// ============================================================

import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { aiRequestTimeoutMs } from './defaults'
import { buildConversationContext } from './context'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { atenderConBot, type ResultadoBot } from '@/lib/bot-clientes/bot'
import { llamarClaude } from '@/lib/bot-clientes/claude'

interface DispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  /** Autor de los envíos de motor (columnas de auditoría de wacrm). */
  configOwnerUserId: string
  /** wamid del mensaje que se contesta: si llega otro después, este se descarta. */
  inboundMessageId?: string
}

export async function dispatchInboundToAiReply(args: DispatchArgs): Promise<ResultadoBot | null> {
  const { accountId, conversationId, contactId, configOwnerUserId, inboundMessageId } = args
  try {
    const db = supabaseAdmin()

    // Las automatizaciones por mensaje contestan ellas: el bot no se cruza.
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return null

    // Freno de ráfagas por cuenta (un envío masivo que vuelve con 200 respuestas).
    const limite = checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
    if (!limite.success) {
      console.warn(`[bot-clientes] la cuenta ${accountId} pasó el freno de ráfagas; este entrante queda para una persona.`)
      return null
    }

    return await atenderConBot(
      {
        db,
        configuracion: async () => {
          const c = await loadAiConfig(db, accountId)
          // El bot de ECOVIT es Claude: otra llave no sirve.
          if (!c || c.provider !== 'anthropic') return null
          return { apiKey: c.apiKey, cupoPorChat: c.autoReplyMaxPerConversation }
        },
        llamar: (a) => llamarClaude({ ...a, timeoutMs: aiRequestTimeoutMs() }),
        contexto: () => buildConversationContext(db, conversationId),
        enviarTexto: async (texto) => {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: texto,
            aiGenerated: true,
          })
        },
        hayEntranteMasNuevo: inboundMessageId
          ? async () => {
              const { data, error } = await db
                .from('messages')
                .select('message_id')
                .eq('conversation_id', conversationId)
                .eq('sender_type', 'customer')
                .order('created_at', { ascending: false })
                .limit(1)
              if (error || !data || data.length === 0) return false
              return data[0].message_id !== inboundMessageId
            }
          : undefined,
      },
      conversationId,
    )
  } catch (err) {
    console.error('[bot-clientes] el despacho falló:', err)
    return null
  }
}
