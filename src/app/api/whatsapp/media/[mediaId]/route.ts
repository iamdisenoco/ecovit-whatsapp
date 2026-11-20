import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'
import { leerFilaWhatsAppConfig } from '@/lib/whatsapp/config-servidor'

const t = getT('Api')

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      )
    }

    const limit = checkRateLimit(`whatsapp-media:${user.id}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 },
      )
    }

    // ECOVIT · bloque 5: el token se lee con la clave de servicio (con la sesión
    // da 42501), así que la puerta ya no es la RLS de whatsapp_config. Se exige
    // que quien pide VEA un mensaje con este adjunto (RLS de messages): un
    // vendedor no baja adjuntos de chats que no son suyos adivinando el id.
    const { data: visible } = await supabase
      .from('messages')
      .select('id')
      .eq('media_url', `/api/whatsapp/media/${mediaId}`)
      // Solo un adjunto que mandó un CLIENTE: un mensaje del negocio con esa
      // URL lo puede fabricar un vendedor.
      .eq('sender_type', 'customer')
      .limit(1)
    if (!visible || visible.length === 0) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await leerFilaWhatsAppConfig(accountId)

    if (configError || !config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}
