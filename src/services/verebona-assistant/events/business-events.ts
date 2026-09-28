/**
 * Événements métier de l'assistant — CDC §25.7, §31.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUN ÉVÉNEMENT N'ÉTAIT ÉMIS
 *
 * Rien ne prévenait l'assistant qu'un document venait d'être supprimé ou
 * analysé : un cache pouvait servir une donnée supprimée (§31.4), et aucune
 * mesure ne suivait l'activité du compte.
 *
 * Ce module est le bus INTERNE du §25.7 : catalogue fermé des 14 événements,
 * émission qui ne lève jamais, abonnés isolés les uns des autres, compteurs
 * par type (métriques). Même principe que `source-analysis/events.ts` :
 * l'émetteur ne connaît pas ses abonnés.
 *
 * En V1 (§25.7), ces événements ne déclenchent AUCUN message conversationnel
 * proactif : ils n'alimentent que les caches, index, suggestions et métriques.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Catalogue fermé (§25.7). */
export const ASSISTANT_BUSINESS_EVENTS = [
  'ASSET_CREATED',
  'ASSET_UPDATED',
  'ASSET_DELETED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_ANALYSIS_COMPLETED',
  'DOCUMENT_UPDATED',
  'DOCUMENT_DELETED',
  'AGENDA_ITEM_CREATED',
  'AGENDA_ITEM_UPDATED',
  'AGENDA_ITEM_DELETED',
  'TO_PROCESS_ITEM_UPDATED',
  'PLAN_CHANGED',
  'HELP_ENTRY_PUBLISHED',
  'ACCOUNT_PERMISSION_CHANGED',
] as const;

export type AssistantCatalogEventType = (typeof ASSISTANT_BUSINESS_EVENTS)[number];

/**
 * Signaux d'invalidation HORS catalogue §25.7 — CDC §31.7.
 *
 * Le §31.7 exige d'invalider le cache sur des modifications que le catalogue
 * fermé du §25.7 ne nomme pas : fournisseur, effacement de la conversation,
 * changement de locale. Ils passent par le même bus (mêmes consommateurs de
 * cache, mêmes compteurs) sans élargir le catalogue du CDC.
 */
export const ASSISTANT_INVALIDATION_SIGNALS = [
  'SUPPLIER_CHANGED',
  'CONVERSATION_CLEARED',
  'LOCALE_CHANGED',
] as const;

export type AssistantInvalidationSignal = (typeof ASSISTANT_INVALIDATION_SIGNALS)[number];

export type AssistantBusinessEventType = AssistantCatalogEventType | AssistantInvalidationSignal;

const TOUS_LES_TYPES: readonly string[] = [...ASSISTANT_BUSINESS_EVENTS, ...ASSISTANT_INVALIDATION_SIGNALS];

/** Événements qui retirent une donnée : ce qui en a été copié doit disparaître (§31.4). */
export const DELETION_EVENTS: ReadonlySet<AssistantBusinessEventType> = new Set([
  'ASSET_DELETED', 'DOCUMENT_DELETED', 'AGENDA_ITEM_DELETED', 'ACCOUNT_PERMISSION_CHANGED',
]);

export interface AssistantBusinessEvent {
  type: AssistantBusinessEventType;
  /** Compte concerné ; `null` pour un événement global (article d'aide publié). */
  accountId: number | null;
  /** Objet concerné, s'il y en a un (jamais de contenu). */
  entityId?: number | string | null;
  occurredAt?: string;
}

type Handler = (e: Required<Pick<AssistantBusinessEvent, 'type' | 'accountId' | 'occurredAt'>> & AssistantBusinessEvent) => void | Promise<void>;

const abonnes = new Map<string, Handler>();
const compteurs = new Map<AssistantBusinessEventType, number>();

/** Type du catalogue §25.7 (les signaux d'invalidation n'en font pas partie). */
export function isAssistantBusinessEvent(v: unknown): v is AssistantCatalogEventType {
  return typeof v === 'string' && (ASSISTANT_BUSINESS_EVENTS as readonly string[]).includes(v);
}

/** Type accepté par le bus : catalogue §25.7 ou signal d'invalidation §31.7. */
export function isAssistantEventType(v: unknown): v is AssistantBusinessEventType {
  return typeof v === 'string' && TOUS_LES_TYPES.includes(v);
}

/** Abonne un consommateur, sous un nom stable (réabonnement idempotent). */
export function onBusinessEvent(name: string, handler: Handler): void {
  abonnes.set(name, handler);
}

/**
 * Publie un événement. Ne lève jamais : un abonné en échec est journalisé,
 * sans empêcher les autres ni l'opération métier qui a émis.
 */
export async function emitBusinessEvent(e: AssistantBusinessEvent): Promise<void> {
  if (!isAssistantEventType(e.type)) {
    console.warn('[verebona][evenements] type hors catalogue ignoré :', String(e.type).slice(0, 60));
    return;
  }
  compteurs.set(e.type, (compteurs.get(e.type) ?? 0) + 1);
  await diffuser({ ...e, accountId: e.accountId ?? null, occurredAt: e.occurredAt ?? new Date().toISOString() });
}

/** Transmet un événement à chaque abonné, isolément. */
async function diffuser(evt: Parameters<Handler>[0]): Promise<void> {
  for (const [nom, h] of abonnes) {
    try {
      await h(evt);
    } catch (err) {
      console.error(`[verebona][evenements] abonné « ${nom} » en échec (non bloquant) :`, (err as Error).message);
    }
  }
}

/**
 * Publie les événements d'UNE demande (opération en lot : suppression ou
 * déplacement de plusieurs documents, dépôt de plusieurs fichiers).
 *
 * Chaque événement est compté (métriques), mais les consommateurs ne sont
 * appelés qu'UNE fois par compte — une invalidation par demande et par
 * compte, et non une par document. L'événement transmis est une suppression
 * s'il y en a une dans le lot (c'est elle qui déclenche la purge des réponses
 * modèle), sinon le premier. `entityId` est alors `null` : il n'y a pas un
 * objet unique. Ne lève jamais.
 */
export async function emitBusinessEvents(events: AssistantBusinessEvent[]): Promise<void> {
  const valides = events.filter((e) => {
    if (isAssistantEventType(e.type)) return true;
    console.warn('[verebona][evenements] type hors catalogue ignoré :', String(e.type).slice(0, 60));
    return false;
  });
  if (valides.length === 1) return emitBusinessEvent(valides[0]);
  const parCompte = new Map<number | null, AssistantBusinessEvent>();
  for (const e of valides) {
    compteurs.set(e.type, (compteurs.get(e.type) ?? 0) + 1);
    const cle = e.accountId ?? null;
    const retenu = parCompte.get(cle);
    if (!retenu || (!DELETION_EVENTS.has(retenu.type) && DELETION_EVENTS.has(e.type))) parCompte.set(cle, e);
  }
  const occurredAt = new Date().toISOString();
  for (const [accountId, e] of parCompte) {
    await diffuser({ ...e, accountId, entityId: null, occurredAt: e.occurredAt ?? occurredAt });
  }
}

/** Nombre d'événements publiés par type depuis le démarrage (métriques). */
export function businessEventCounters(): Record<AssistantBusinessEventType, number> {
  return Object.fromEntries(TOUS_LES_TYPES.map((t) => [t, compteurs.get(t as AssistantBusinessEventType) ?? 0])) as Record<AssistantBusinessEventType, number>;
}

/** Réservé aux tests. */
export function resetBusinessEventsForTests(): void {
  abonnes.clear();
  compteurs.clear();
}
