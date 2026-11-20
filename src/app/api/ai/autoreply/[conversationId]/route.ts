import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ejecutarPausaIa, leerAccionPausaIa } from '@/lib/conversations/pausa-ia'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * El banner de la IA en la bandeja.
 *
 * Body: { accion: 'tomar' | 'retomar', visto: string, asignado_visto?: string | null }
 *   - tomar:   «Tomar el control». Toma el chat (si no tenía dueño) y pausa la IA.
 *   - retomar: «Retomar IA». Suelta el chat y se lo devuelve al bot.
 *   - visto:   `actualizado_en` de la conversación que la pantalla mostró, de la
 *              misma lectura que el asignado (condición de versión, mínimo 4).
 *
 * ECOVIT · bloque 4 (0113): nada se escribe con `update`. Todo va por
 * `tomar_conversacion`, `pausar_ia_conversacion` y `reanudar_ia_conversacion`,
 * con la sesión de quien hace clic: las funciones deciden si puede.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const pedido = leerAccionPausaIa(await request.json().catch(() => null))
    if (!pedido) {
      return NextResponse.json(
        {
          error:
            'Falta la acción (tomar o retomar) o la marca de la conversación. Recarga la página.',
        },
        { status: 400 },
      )
    }

    const r = await ejecutarPausaIa(supabase, conversationId, userId, pedido)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })

    return NextResponse.json({
      success: true,
      paused: r.pausada,
      assigned_agent_id: r.asignado,
      actualizado_en: r.actualizadoEn,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
