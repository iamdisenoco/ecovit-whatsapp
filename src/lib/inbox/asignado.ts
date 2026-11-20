/**
 * El chip de la bandeja que dice quién tiene cada chat: el nombre de la
 * persona o «Sin asignar». Si el chat tiene dueño pero su nombre no se pudo
 * leer, dice «Asignado» (no se inventa un nombre ni se calla que lo tiene).
 */
export function chipAsignado(
  asignadoId: string | null | undefined,
  nombres: ReadonlyMap<string, string>,
): { texto: string; asignado: boolean } {
  if (!asignadoId) return { texto: 'Sin asignar', asignado: false }
  return { texto: nombres.get(asignadoId)?.trim() || 'Asignado', asignado: true }
}
