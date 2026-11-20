import { describe, expect, it } from 'vitest'
import { firmarCuerpo, leerSecretos, verificarFirmaHmac } from './firma'
import { ProveedorZernio } from './zernio'

const CUERPO = '{"id":"evt-1","event":"message.received"}'

describe('verificarFirmaHmac (X-Zernio-Signature)', () => {
  it('acepta la firma buena', () => {
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 's3cr3t'), ['s3cr3t'])).toBe(true)
  })

  it('acepta la firma en mayúsculas (hex igual)', () => {
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 's3cr3t').toUpperCase(), ['s3cr3t'])).toBe(true)
  })

  it('rechaza la firma de otro secreto', () => {
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 'otro'), ['s3cr3t'])).toBe(false)
  })

  it('rechaza si el cuerpo cambió un byte', () => {
    const firma = firmarCuerpo(CUERPO, 's3cr3t')
    expect(verificarFirmaHmac(CUERPO.replace('evt-1', 'evt-2'), firma, ['s3cr3t'])).toBe(false)
  })

  it('rechaza la firma vacía o ausente', () => {
    expect(verificarFirmaHmac(CUERPO, '', ['s3cr3t'])).toBe(false)
    expect(verificarFirmaHmac(CUERPO, null, ['s3cr3t'])).toBe(false)
    expect(verificarFirmaHmac(CUERPO, undefined, ['s3cr3t'])).toBe(false)
  })

  it('rechaza TODO sin secreto configurado, aunque la firma sea la del secreto vacío', () => {
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, ''), [])).toBe(false)
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 's3cr3t'), [])).toBe(false)
  })

  it('con varios secretos (rotación), acepta cualquiera de ellos y nada más', () => {
    const secretos = leerSecretos(' viejo , nuevo ,, ')
    expect(secretos).toEqual(['viejo', 'nuevo'])
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 'viejo'), secretos)).toBe(true)
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 'nuevo'), secretos)).toBe(true)
    expect(verificarFirmaHmac(CUERPO, firmarCuerpo(CUERPO, 'tercero'), secretos)).toBe(false)
  })

  it('no lanza con basura en la firma (largo, no-hex, no-ASCII)', () => {
    for (const basura of ['abc', 'z'.repeat(64), 'ñ'.repeat(64), `${'a'.repeat(64)}x`]) {
      expect(() => verificarFirmaHmac(CUERPO, basura, ['s3cr3t'])).not.toThrow()
      expect(verificarFirmaHmac(CUERPO, basura, ['s3cr3t'])).toBe(false)
    }
  })

  it('con prefijo (Meta: sha256=<hex>) exige el prefijo', () => {
    const hex = firmarCuerpo(CUERPO, 'm')
    expect(verificarFirmaHmac(CUERPO, `sha256=${hex}`, ['m'], 'sha256=')).toBe(true)
    expect(verificarFirmaHmac(CUERPO, hex, ['m'], 'sha256=')).toBe(false)
  })
})

describe('ProveedorZernio.verificarFirma lee el encabezado', () => {
  const p = new ProveedorZernio({ apiKey: 'sk_x', secretos: ['s3cr3t'], cuentaId: 'c' })

  it('en Headers, sin importar mayúsculas', () => {
    const h = new Headers({ 'X-Zernio-Signature': firmarCuerpo(CUERPO, 's3cr3t') })
    expect(p.verificarFirma(CUERPO, h)).toBe(true)
  })

  it('en un objeto plano', () => {
    expect(p.verificarFirma(CUERPO, { 'x-zernio-signature': firmarCuerpo(CUERPO, 's3cr3t') })).toBe(true)
  })

  it('sin el encabezado, rechaza', () => {
    expect(p.verificarFirma(CUERPO, new Headers())).toBe(false)
  })

  it('un proveedor sin secretos rechaza todo', () => {
    const sin = new ProveedorZernio({ apiKey: 'sk_x', secretos: [], cuentaId: 'c' })
    expect(sin.verificarFirma(CUERPO, { 'x-zernio-signature': firmarCuerpo(CUERPO, '') })).toBe(false)
  })
})
