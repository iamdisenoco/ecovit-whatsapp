// ============================================================
// Lo pesado de un entrante, dentro de `after()`: flujos, automatizaciones y la
// respuesta automática, en el mismo orden que wacrm (los flujos ganan; una
// automatización que esperaba respuesta la toma; si nadie la tomó, la IA).
//
// Cada motor tiene su propio try/catch y nunca lanza. Fuera de Meta, los motores
// envían por la interfaz del proveedor (`lib/whatsapp/enviar-motor.ts`). La IA
// (el bot de clientes, `lib/bot-clientes/`) está apagada por defecto (mínimo 7)
// y los flujos y automatizaciones solo los crea la dirección.
// ============================================================

import {
  resumeAwaitingReply,
  runAutomationsForTrigger,
} from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import type { TrabajoMotores } from './procesar';

export async function despacharMotores(
  // El manejador también pasa el proveedor; desde el bloque 6 ningún motor
  // depende de él (los envíos eligen solos, `enviar-motor.ts`).
  trabajo: TrabajoMotores
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
      // Si el cliente escribe otra vez mientras el bot piensa, se descarta esta.
      inboundMessageId: wamid,
    });
  }
}
