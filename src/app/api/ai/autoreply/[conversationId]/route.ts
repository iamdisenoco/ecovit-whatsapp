import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow). Assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 *
 * ECOVIT (mínimo 4): la columna del asignado no se escribe con `update`.
 * «Tomar el control» toma el chat con `tomar_conversacion` y la marca de la
 * misma lectura; si ya tiene dueño, no se toca. «Retomar IA» ya no suelta el
 * chat: no hay función para soltar (TODO bloque 4/6), así que el bot sigue
 * callado mientras una persona lo tenga.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: t('ai.pausedRequired') },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, assigned_agent_id, actualizado_en')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: t('common.failedToLoadConversation') },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: t('common.conversationNotFound') }, { status: 404 })
    }

    let assignedAgentId: string | null = conv.assigned_agent_id ?? null
    let actualizadoEn: string | undefined = conv.actualizado_en ?? undefined

    // Tomar primero: si la función lo rechaza (otro lo tomó en el medio),
    // no se pausa nada y se devuelve su mensaje.
    if (paused && assignToMe && !assignedAgentId) {
      const { data: marca, error: tomarErr } = await supabase.rpc('tomar_conversacion', {
        p_conversacion: conversationId,
        p_visto: conv.actualizado_en,
      })
      if (tomarErr) {
        return NextResponse.json({ error: tomarErr.message }, { status: 409 })
      }
      assignedAgentId = userId
      actualizadoEn = (marca as string | null) ?? actualizadoEn
    }

    const update: Record<string, unknown> = { ai_autoreply_disabled: paused }
    if (!paused) {
      // Give the bot a fresh reply budget on this thread. This is a
      // deliberate, manual, rate-limited action (not automatable), so it
      // can't be used to bypass the per-conversation cap at scale.
      update.ai_reply_count = 0
      update.ai_handoff_summary = null
    }

    const { error: upErr } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', conversationId)
      .eq('account_id', accountId)
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr)
      return NextResponse.json(
        { error: t('ai.updateConversationFailed') },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      paused,
      assigned_agent_id: assignedAgentId,
      actualizado_en: actualizadoEn,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
