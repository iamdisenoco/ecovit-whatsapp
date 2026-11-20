// ============================================================
// ECOVIT · RF-M03.11: lo que se gastó en Claude, en USD, sobre las filas de
// `ai_usage_log` de la ventana pedida. Numerador y denominador salen de las
// MISMAS filas (AGENTS.md): el total es la suma de los días y de los chats.
// Las filas viejas de wacrm no traen `costo_usd`: cuentan como llamadas sin
// costo conocido, y se dice cuántas son en vez de sumarlas como cero callado.
// ============================================================

export interface FilaGasto {
  created_at: string;
  conversation_id: string | null;
  costo_usd: number | string | null;
}

export interface GastoChat {
  conversation_id: string;
  usd: number;
  llamadas: number;
}

export interface ResumenGasto {
  total_usd: number;
  sin_costo: number;
  por_dia: Record<string, number>;
  por_chat: GastoChat[];
}

const redondear = (v: number) => Math.round(v * 1_000_000) / 1_000_000;

export function resumirGasto(
  filas: FilaGasto[],
  diaDe: (iso: string) => string,
  topChats = 10
): ResumenGasto {
  let total = 0;
  let sinCosto = 0;
  const porDia: Record<string, number> = {};
  const chats = new Map<string, GastoChat>();
  for (const f of filas) {
    const usd = f.costo_usd === null ? null : Number(f.costo_usd);
    if (usd === null || !Number.isFinite(usd)) {
      sinCosto++;
      continue;
    }
    total += usd;
    const dia = diaDe(f.created_at);
    porDia[dia] = (porDia[dia] ?? 0) + usd;
    if (f.conversation_id) {
      const c = chats.get(f.conversation_id) ?? { conversation_id: f.conversation_id, usd: 0, llamadas: 0 };
      c.usd += usd;
      c.llamadas += 1;
      chats.set(f.conversation_id, c);
    }
  }
  for (const k of Object.keys(porDia)) porDia[k] = redondear(porDia[k]);
  const porChat = [...chats.values()]
    .map((c) => ({ ...c, usd: redondear(c.usd) }))
    .sort((a, b) => b.usd - a.usd || a.conversation_id.localeCompare(b.conversation_id))
    .slice(0, topChats);
  return { total_usd: redondear(total), sin_costo: sinCosto, por_dia: porDia, por_chat: porChat };
}
