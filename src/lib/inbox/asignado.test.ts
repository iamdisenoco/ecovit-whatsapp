import { describe, expect, it } from 'vitest'

import { chipAsignado } from './asignado'

const nombres = new Map([['u-1', 'Carolina Mejía']])

describe('chipAsignado', () => {
  it('sin dueño dice «Sin asignar»', () => {
    expect(chipAsignado(null, nombres)).toEqual({ texto: 'Sin asignar', asignado: false })
    expect(chipAsignado(undefined, nombres)).toEqual({ texto: 'Sin asignar', asignado: false })
  })

  it('con dueño dice su nombre', () => {
    expect(chipAsignado('u-1', nombres)).toEqual({ texto: 'Carolina Mejía', asignado: true })
  })

  it('con dueño sin nombre leído dice «Asignado», no «Sin asignar»', () => {
    expect(chipAsignado('u-9', nombres)).toEqual({ texto: 'Asignado', asignado: true })
  })
})
