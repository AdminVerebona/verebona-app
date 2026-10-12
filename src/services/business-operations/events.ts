/**
 * Bus interne des événements Opération — CDC Opérations V1 C21.1
 * (décision PO Q10 : bus DÉDIÉ, distinct du catalogue fermé de l'assistant
 * `verebona-assistant/events/business-events.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * APRÈS COMMIT SEULEMENT
 *
 * Les écritures accumulent leurs événements dans un tampon
 * (`BusinessOperationEventBuffer`) ; ils ne sont publiés qu'une fois la
 * transaction validée (`withBusinessOperationWrite`, ou l'appelant qui
 * possède la transaction). Transaction annulée = aucun événement.
 *
 * Abonnés en mémoire, isolés : l'échec d'un abonné n'empêche ni les autres
 * ni l'écriture (déjà validée). Pas de persistance : la convergence repose
 * sur le balayage T3 et le recalcul à la lecture (C21.1, NFR-OP-006/007).
 * L'assistant pourra s'abonner pour invalider ses caches.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const BUSINESS_OPERATION_EVENT_TYPES = [
  'BUSINESS_OPERATION_CREATED',
  'BUSINESS_OPERATION_UPDATED',
  'BUSINESS_OPERATION_FINANCIAL_CHANGED',
  'BUSINESS_OPERATION_TARGET_CHANGED',
  'BUSINESS_OPERATION_INVALIDATED',
  'BUSINESS_OPERATION_REACTIVATED',
  'BUSINESS_OPERATION_MERGED',
] as const;

export type BusinessOperationEventType = (typeof BUSINESS_OPERATION_EVENT_TYPES)[number];

export interface BusinessOperationEvent {
  type: BusinessOperationEventType;
  /** Compte propriétaire APRÈS l'écriture. */
  accountId: number;
  operationId: number;
  /** Chaîne T1 → T3 → T4 (C16.2, C21.1). */
  correlationId: string;
  occurredAt: string;
  /** Transfert de bien entre comptes (Q14) : compte quitté. */
  previousAccountId?: number;
  /** Fusion : Opération canonique. */
  canonicalOperationId?: number;
  /** Motif stable de l'écriture (diagnostic). */
  reasonCode?: string;
}

type Handler = (event: BusinessOperationEvent) => void | Promise<void>;

const abonnes = new Map<string, Handler>();
const compteurs = new Map<BusinessOperationEventType, number>();

/**
 * Types qui RENDENT superflus les signaux plus fins de la même Opération dans
 * la même transaction : une Opération créée est nouvelle pour tous les
 * consommateurs (inutile de signaler aussi ses cibles ou composantes).
 */
const ENGLOBANTS: Partial<Record<BusinessOperationEventType, readonly BusinessOperationEventType[]>> = {
  BUSINESS_OPERATION_CREATED: ['BUSINESS_OPERATION_UPDATED', 'BUSINESS_OPERATION_FINANCIAL_CHANGED', 'BUSINESS_OPERATION_TARGET_CHANGED'],
};

/** Tampon d'une transaction : dédoublonné par (type, Opération, compte). */
export class BusinessOperationEventBuffer {
  private readonly events = new Map<string, BusinessOperationEvent>();

  constructor(readonly correlationId: string) {}

  push(e: Omit<BusinessOperationEvent, 'correlationId' | 'occurredAt'> & { correlationId?: string }): void {
    const key = `${e.type}:${e.operationId}:${e.accountId}`;
    if (this.events.has(key)) return;
    this.events.set(key, { ...e, correlationId: e.correlationId ?? this.correlationId, occurredAt: new Date().toISOString() });
  }

  get size(): number {
    return this.events.size;
  }

  /** Événements à publier, signaux englobés retirés. Vide le tampon. */
  drain(): BusinessOperationEvent[] {
    const all = [...this.events.values()];
    this.events.clear();
    return all.filter((e) => !all.some((o) => o.operationId === e.operationId && o.accountId === e.accountId
      && (ENGLOBANTS[o.type] ?? []).includes(e.type)));
  }
}

/** Abonne un consommateur (nom unique : un réabonnement remplace). Rend le désabonnement. */
export function subscribeBusinessOperationEvents(name: string, handler: Handler): () => void {
  abonnes.set(name, handler);
  return () => {
    if (abonnes.get(name) === handler) abonnes.delete(name);
  };
}

/**
 * Publie des événements DÉJÀ VALIDÉS (après commit). Ne lève jamais : un
 * abonné en échec est journalisé, les autres sont servis.
 */
export async function publishBusinessOperationEvents(events: readonly BusinessOperationEvent[]): Promise<void> {
  for (const e of events) {
    compteurs.set(e.type, (compteurs.get(e.type) ?? 0) + 1);
    for (const [nom, handler] of abonnes) {
      try {
        await handler(e);
      } catch (err) {
        console.error(`[business-operations] abonné « ${nom} » en échec sur ${e.type} #${e.operationId} :`, err);
      }
    }
  }
}

/** Compteurs par type depuis le démarrage (observabilité). */
export function businessOperationEventCounters(): Record<BusinessOperationEventType, number> {
  return Object.fromEntries(BUSINESS_OPERATION_EVENT_TYPES.map((t) => [t, compteurs.get(t) ?? 0])) as Record<BusinessOperationEventType, number>;
}

/** Tests seulement. */
export function resetBusinessOperationEventBusForTests(): void {
  abonnes.clear();
  compteurs.clear();
}
