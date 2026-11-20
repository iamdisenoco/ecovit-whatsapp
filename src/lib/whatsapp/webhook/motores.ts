// ============================================================
// Lo pesado de un entrante, dentro de `after()`: flujos, automatizaciones y la
// respuesta automática, en el mismo orden que wacrm (los flujos ganan; una
// automatización que esperaba respuesta la toma; si nadie la tomó, la IA).
//
// Cada motor tiene su propio try/catch y nunca lanza. Ojo, hasta el bloque 6:
// los motores todavía ENVÍAN por Meta (`lib/flows/meta-send.ts`,
// `lib/automations/meta-send.ts`, `lib/ai/auto-reply.ts`). Con Zernio fallan al
// buscar las credenciales de Meta y lo dicen en el registro; la IA está apagada
// por defecto (mínimo 7) y los flujos y automatizaciones solo los crea la
// dirección.
// ============================================================

import {
  resumeAwaitingReply,
  runAutomationsForTrigger,
} from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import type { NombreProveedor } from '../proveedor/tipos';
import type { TrabajoMotores } from './procesar';

export async function despacharMotores(
  trabajo: TrabajoMotores,
  proveedor: NombreProveedor
): Promise<void> {
  const { inquilino, contactoId, conversacionId, wamid, texto } = trabajo;
  const accountId = inquilino.accountId;

  const flujo = await dispatchInboundToFlows({
    accountId,
    userId: inquilino.usuarioId,
    contactId: contactoId,
    conversationId: conversacionId,
    // TODO(zernio): las respuestas a botones y listas llegan en `metadata.interactiveId`;
    // se normalizan cuando se verifiquen con Zernio (plan-wacrm: «los botones y las listas»).
    message: { kind: 'text', text: texto, meta_message_id: wamid },
    isFirstInboundMessage: trabajo.primerEntrante,
  });

  const tomadoPorAutomatizacion = flujo.consumed
    ? false
    : await resumeAwaitingReply({
        accountId,
        contactId: contactoId,
        context: { message_text: texto, conversation_id: conversacionId },
      });
  const consumido = flujo.consumed || tomadoPorAutomatizacion;

  const disparadores: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];
  if (trabajo.contactoCreado) disparadores.push('new_contact_created');
  if (trabajo.primerEntrante) disparadores.push('first_inbound_message');
  if (!consumido) disparadores.push('new_message_received', 'keyword_match');

  for (const triggerType of disparadores) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactoId,
      context: { message_text: texto, conversation_id: conversacionId },
    }).catch((err) => console.error('[automations] falló el disparo:', err));
  }

  if (!consumido && texto.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversacionId,
      contactId: contactoId,
      configOwnerUserId: inquilino.usuarioId,
      // El «escribiendo…» es de Meta; con otro proveedor no se pide.
      inboundMessageId: proveedor === 'meta' ? wamid : undefined,
    });
  }
}
