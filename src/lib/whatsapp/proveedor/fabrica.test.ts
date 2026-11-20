import { describe, expect, it, vi } from 'vitest'

vi.mock('../config-servidor', () => ({ leerCredencialesMeta: vi.fn(async () => null) }))

import { crearProveedor, nombreProveedor } from './index'
import { leerWebhookMeta } from './meta'
import { ErrorConfiguracion } from './tipos'

describe('la fábrica lee WHATSAPP_PROVEEDOR', () => {
  it('zernio, simulado y meta', () => {
    expect(crearProveedor({ env: { WHATSAPP_PROVEEDOR: 'zernio' } }).nombre).toBe('zernio')
    expect(crearProveedor({ env: { WHATSAPP_PROVEEDOR: ' Simulado ' } }).nombre).toBe('simulado')
    expect(crearProveedor({ env: { WHATSAPP_PROVEEDOR: 'meta' } }).nombre).toBe('meta')
  })

  it('sin la variable o con otro valor, lanza (el webhook responde 500 y el proveedor reintenta)', () => {
    expect(() => nombreProveedor({})).toThrow(ErrorConfiguracion)
    expect(() => nombreProveedor({ WHATSAPP_PROVEEDOR: 'twilio' })).toThrow(/no es válido/)
  })

  it('Zernio sin ZERNIO_WEBHOOK_SECRET rechaza toda firma', () => {
    const p = crearProveedor({ env: { WHATSAPP_PROVEEDOR: 'zernio', ZERNIO_API_KEY: 'sk' } })
    expect(p.verificarFirma('{}', { 'x-zernio-signature': 'a'.repeat(64) })).toBe(false)
  })
})

describe('el adaptador de Meta conserva la lectura de su webhook', () => {
  it('normaliza un mensaje de texto y un estado fallido', () => {
    const eventos = leerWebhookMeta({
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1', display_phone_number: '57300' },
                contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
                messages: [{ id: 'wamid.M', from: '573001112233', timestamp: '1763650800', type: 'text', text: { body: 'hola' } }],
                statuses: [
                  { id: 'wamid.S', status: 'failed', timestamp: '1763650900', errors: [{ code: 131026, title: 'Undeliverable' }] },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(eventos[0]).toMatchObject({
      tipo: 'mensaje_entrante',
      mensajeId: 'wamid.M',
      texto: 'hola',
      remitente: { telefono: '573001112233', nombre: 'Ana' },
      referencia: { conversacionId: null, cuentaId: 'pn-1' },
    })
    expect(eventos[1]).toMatchObject({ tipo: 'estado', estado: 'failed', error: { codigo: 131026 } })
  })
})
