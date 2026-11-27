import type { SupabaseClient } from "@supabase/supabase-js";
import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*)))";

/**
 * ECOVIT · coexistencia: la misma lectura trae, embebido, el último mensaje
 * contestado desde el celular de cada chat (solo `created_at`). Con eso la
 * bandeja dice a qué hora vuelve el bot, sin una consulta por fila.
 */
export const ECO_CELULAR = "eco_celular";
export const CONVERSATION_SELECT_CON_ECO = `${CONVERSATION_SELECT}, ${ECO_CELULAR}:messages(created_at)`;

/**
 * La lectura de la bandeja (lista o un chat). Primero con el último eco del
 * celular embebido; si esa parte falla, se lee sin ella: la hora es un
 * adorno y no puede dejar la bandeja vacía.
 */
export async function leerConversaciones(
  supabase: SupabaseClient,
  id?: string,
): Promise<{
  data: RawConversation[] | null;
  error: { message: string; details: string; hint: string; code: string } | null;
}> {
  const base = (select: string) => {
    const q = supabase.from("conversations").select(select);
    return id ? q.eq("id", id) : q.order("last_message_at", { ascending: false });
  };
  const conEco = await base(CONVERSATION_SELECT_CON_ECO)
    .eq(`${ECO_CELULAR}.desde_celular`, true)
    .order("created_at", { referencedTable: ECO_CELULAR, ascending: false })
    .limit(1, { referencedTable: ECO_CELULAR });
  if (!conEco.error) {
    return { data: conEco.data as unknown as RawConversation[], error: null };
  }
  console.warn("[bandeja] sin la hora del celular:", conEco.error.message);
  const sinEco = await base(CONVERSATION_SELECT);
  return {
    data: (sinEco.data as unknown as RawConversation[] | null) ?? null,
    error: sinEco.error,
  };
}

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
export type RawConversation = Omit<Conversation, "contact"> & {
  contact?: RawContact | null;
  eco_celular?: { created_at: string }[] | null;
};

/** El `created_at` del último eco del celular embebido, o `null`. */
function ultimoEco(raw: RawConversation): string | null {
  return raw.eco_celular?.[0]?.created_at ?? null;
}

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(input: RawConversation): Conversation {
  // Sin la parte embebida (lectura sin eco, o un evento de realtime) el campo
  // no se toca: así no se borra lo que ya se sabía.
  const { eco_celular, ...sinEco } = input;
  const raw: Omit<RawConversation, "eco_celular"> & {
    ultimo_eco_celular_at?: string | null;
  } =
    eco_celular === undefined
      ? sinEco
      : { ...sinEco, ultimo_eco_celular_at: ultimoEco(input) };
  const rawContact = raw.contact;
  if (!rawContact) return raw as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...raw,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
