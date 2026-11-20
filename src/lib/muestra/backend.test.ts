import { beforeEach, describe, expect, it } from 'vitest'

import { fetchApi, fetchSupabase, reiniciarBase } from './backend'

const URL_FALSA = 'https://muestra.invalid'

const rpc = (fn: string, args: object) =>
  fetchSupabase(`${URL_FALSA}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

async function conversacion(id: string) {
  const r = await fetchSupabase(`${URL_FALSA}/rest/v1/conversations?select=*&id=eq.${id}`)
  return ((await r.json()) as Record<string, unknown>[])[0]
}

beforeEach(() => reiniciarBase())

describe('backend de la demostración', () => {
  it('la bandeja trae entre 8 y 10 chats, el más reciente primero', async () => {
    const r = await fetchSupabase(`${URL_FALSA}/rest/v1/conversations?select=*&order=last_message_at.desc`)
    const filas = (await r.json()) as { last_message_at: string }[]
    expect(filas.length).toBeGreaterThanOrEqual(8)
    expect(filas.length).toBeLessThanOrEqual(10)
    expect(filas[0].last_message_at >= filas[1].last_message_at).toBe(true)
  })

  it('el chat abierto tiene 12 mensajes y el precio de lista T9', async () => {
    const r = await fetchSupabase(`${URL_FALSA}/rest/v1/messages?select=*&conversation_id=eq.chat-altos-del-rio`)
    const filas = (await r.json()) as { content_text: string }[]
    expect(filas).toHaveLength(12)
    expect(filas.map((m) => m.content_text)).toContain('Precio de lista: $ 148.000 por unidad, antes de IVA.')
  })

  it('asignar cambia el dueño y mueve la marca; con la marca vieja, rechaza', async () => {
    const antes = await conversacion('chat-monteverde')
    const ok = await rpc('asignar_conversacion', {
      p_conversacion: 'chat-monteverde',
      p_agente: 'p-carolina',
      p_visto: antes.actualizado_en,
    })
    expect(ok.status).toBe(200)
    const despues = await conversacion('chat-monteverde')
    expect(despues.assigned_agent_id).toBe('u-carolina')
    expect(despues.actualizado_en).toBe(await ok.json())

    const vieja = await rpc('soltar_conversacion', { p_conversacion: 'chat-monteverde', p_visto: antes.actualizado_en })
    expect(vieja.status).toBe(409)
    expect((await conversacion('chat-monteverde')).assigned_agent_id).toBe('u-carolina')
  })

  it('tomar el control pausa el bot y deja el chat a quien lo toma', async () => {
    const c = await conversacion('chat-monteverde')
    const r = await fetchApi(new URL('http://x/api/ai/autoreply/chat-monteverde'), {
      method: 'POST',
      body: JSON.stringify({ accion: 'tomar', visto: c.actualizado_en }),
    })
    expect(await r.json()).toMatchObject({ paused: true, assigned_agent_id: 'u-laura' })
    expect((await conversacion('chat-monteverde')).ai_autoreply_disabled).toBe(true)
  })

  it('mandar una respuesta la guarda en el hilo y en la vista previa', async () => {
    const r = await fetchApi(new URL('http://x/api/whatsapp/send'), {
      method: 'POST',
      body: JSON.stringify({ conversation_id: 'chat-altos-del-rio', content_text: 'Listo, Mauricio.' }),
    })
    const { message_id } = (await r.json()) as { message_id: string }
    const m = await fetchSupabase(`${URL_FALSA}/rest/v1/messages?select=*&id=eq.${message_id}`)
    expect(((await m.json()) as { content_text: string }[])[0].content_text).toBe('Listo, Mauricio.')
    expect((await conversacion('chat-altos-del-rio')).last_message_text).toBe('Listo, Mauricio.')
  })

  it('el uso de IA cambia con la ventana de días y trae el tope mensual', async () => {
    const leer = async (d: number) =>
      (await (await fetchApi(new URL(`http://x/api/ai/usage?days=${d}`))).json()) as {
        daily: unknown[]
        gasto: { total_usd: number; tope_usd_mes: number; por_chat: unknown[] }
      }
    const [siete, treinta] = [await leer(7), await leer(30)]
    expect(siete.daily).toHaveLength(7)
    expect(treinta.daily).toHaveLength(30)
    expect(treinta.gasto.total_usd).toBeGreaterThan(siete.gasto.total_usd)
    expect(treinta.gasto.tope_usd_mes).toBe(25)
    expect(treinta.gasto.por_chat.length).toBeGreaterThan(0)
  })
})
