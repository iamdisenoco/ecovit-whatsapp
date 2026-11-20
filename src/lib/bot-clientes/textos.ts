// ============================================================
// Los textos fijos que ve el cliente del bot de WhatsApp (RF-M03.9), en UN solo
// lugar. La IA no los escribe ni los reescribe: los pone el código.
//
// Fuente: specs/MOD-03-whatsapp/cruce-hu28.md («Los textos fijos: una sola
// lista») y, para la letra de T3 a T6 y T9, la §5 de la spec de HU-28 (rama
// `claude/hu-28-asistente-spec`, 208f977), «tal como están» por la decisión 3
// de la spec de MOD-03. T10 y T11 son nuevos de MOD-03 y NO tienen letra
// aprobada: van como borrador con `aprobado: false`, y el bot no los manda
// hasta que Jon los apruebe (T11 además necesita el horario real de ECOVIT).
// ============================================================

export interface TextoFijo {
  id: 'T3' | 'T4' | 'T5' | 'T6' | 'T9' | 'T10' | 'T11';
  nombre: string;
  plantilla: string;
  /** Solo los aprobados salen al cliente. */
  aprobado: boolean;
}

export const TEXTOS: Record<TextoFijo['id'], TextoFijo> = {
  T3: {
    id: 'T3',
    nombre: 'Paso con el asesor',
    plantilla:
      'Listo, {asesor} ya tiene tu solicitud y te escribe para continuar.',
    aprobado: true,
  },
  T4: {
    id: 'T4',
    nombre: 'Falta dato',
    plantilla:
      'Ese dato no lo tengo confirmado. Ya le pasé tu pregunta a {asesor}.',
    aprobado: true,
  },
  T5: {
    id: 'T5',
    nombre: 'No negocia',
    plantilla:
      'Eso lo revisa tu asesor.',
    aprobado: true,
  },
  T6: {
    id: 'T6',
    nombre: 'La IA no responde',
    plantilla: 'Ya le avisé a tu asesor para que te escriba.',
    aprobado: true,
  },
  T9: {
    id: 'T9',
    nombre: 'Precio de lista',
    plantilla:
      'Precio de lista: {precio} por {unidad}, antes de IVA.',
    aprobado: true,
  },
  T10: {
    id: 'T10',
    nombre: 'Saludo',
    // BORRADOR: el cruce solo da el comienzo («Hola, le escribe el asistente de
    // ECOVIT…»). Va en «tú», como los demás, y sin explicar reglas (Jon, 20-nov).
    plantilla:
      'Hola, te escribe el asistente de ECOVIT. ¿En qué te ayudo?',
    aprobado: false,
  },
  T11: {
    id: 'T11',
    nombre: 'Fuera de horario',
    // BORRADOR: falta el horario real de ECOVIT (lo dice Manuela).
    plantilla:
      'Ya le pasé tu solicitud a {asesor}. Estamos fuera de horario ({horario}); te escribe apenas empiece la jornada.',
    aprobado: false,
  },
};

/** El horario de atención de ECOVIT. Sin definir: nunca se está «fuera de horario». */
export const HORARIO_ECOVIT: { texto: string; abre: number; cierra: number; dias: number[] } | null =
  null;

/** El nombre que va en T3/T4 cuando nadie tiene el chat (queda en «Esperan»). */
export const ASESOR_SIN_NOMBRE = 'un asesor de ECOVIT';


function rellenar(plantilla: string, valores: Record<string, string>): string {
  return plantilla.replace(/\{(\w+)\}/g, (_, k: string) => valores[k] ?? `{${k}}`);
}

export function textoAprobado(id: TextoFijo['id']): boolean {
  return TEXTOS[id].aprobado;
}

/** T3. Sin explicar condiciones al cliente (Jon, 20-nov). */
export function t3PasoConAsesor(asesor: string): string {
  return rellenar(TEXTOS.T3.plantilla, { asesor });
}

export function t4FaltaDato(asesor: string): string {
  return rellenar(TEXTOS.T4.plantilla, { asesor });
}

export const t5NoNegocia = (): string => TEXTOS.T5.plantilla;
export const t6IaNoResponde = (): string => TEXTOS.T6.plantilla;

/** Pesos colombianos: «$ 148.000», o con centavos si los hay. */
export function formatoPrecio(valor: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(valor);
}

export function t9PrecioLista(precio: number, unidad: string | null): string {
  return rellenar(TEXTOS.T9.plantilla, {
    precio: formatoPrecio(precio),
    unidad: unidad?.trim() || 'unidad',
  });
}
