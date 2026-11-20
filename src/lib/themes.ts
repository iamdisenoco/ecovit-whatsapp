/**
 * Tema claro / oscuro de ECOVIT · Conversaciones.
 *
 * wacrm tenía dos ejes —acento (`data-theme`, cinco colores, violeta por
 * defecto) y modo (`data-mode`, oscuro por defecto)—. ECOVIT tiene uno solo:
 * su paleta DIS-04 en claro u oscuro, y el modo sigue al del sistema
 * (`prefers-color-scheme`) hasta que la persona elige uno.
 *
 * El atributo es el MISMO de ECOVIT, `data-tema="claro" | "oscuro"` en
 * <html>, y se guarda con la misma clave, `ecovit_tema`, con los mismos
 * valores. (Al ser otro dominio, el localStorage no se comparte: lo que se
 * comparte es la regla.) Los tokens viven en `src/app/globals.css`.
 *
 * Dentro del código el modo se sigue llamando `light` / `dark`, que es lo
 * que esperan sonner y los textos de wacrm.
 */
export const MODES = ['light', 'dark'] as const

export type Mode = (typeof MODES)[number]

/** Lo que pinta el servidor antes de saber la preferencia. */
export const DEFAULT_MODE: Mode = 'light'

/** Clave de ECOVIT (lib/tema.ts allá). Valores: "claro" | "oscuro". */
export const MODE_STORAGE_KEY = 'ecovit_tema'

export const TEMA_DE_MODO: Record<Mode, 'claro' | 'oscuro'> = {
  light: 'claro',
  dark: 'oscuro',
}

export function modoDeTema(valor: unknown): Mode | null {
  if (valor === 'claro') return 'light'
  if (valor === 'oscuro') return 'dark'
  return null
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as ReadonlyArray<string>).includes(value)
}
