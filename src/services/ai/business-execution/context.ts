/**
 * Exécution métier COURANTE, portée par l'exécution (AsyncLocalStorage) —
 * lot 83C (SEM-01, R22, R56).
 *
 * Même principe que le contexte de job (`queue/job-context.ts`) : la
 * passerelle et la trace lisent l'identifiant sans qu'aucun appelant ait à le
 * transmettre de paramètre en paramètre. Ordre de lecture :
 *   1. contexte métier explicite (`runInBusinessExecution`) — analyse T1 hors
 *      file, groupe T1, demande T2, évaluation T6 ;
 *   2. contexte du travail de file (`AiJobContext.businessExecutionId`) ;
 *   3. sinon aucun (appel technique : sonde, qualification, test fournisseur),
 *      sauf T6 FORMULATE dont l'exécution EST l'exécution de la passerelle
 *      (`T6F:<trace>`, voir `businessExecutionOfCall`).
 * Un appel qui sert plusieurs exécutions (T6 EVALUATE d'un lot d'échéances)
 * porte la liste ; la colonne n'est alors pas renseignée (pas d'attribution
 * arbitraire).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentJobContext } from '../queue/job-context';
import { t6FormulateExecutionId } from './identity';

interface BusinessExecutionContext {
  /** Une ou plusieurs exécutions servies par les appels de ce contexte. */
  ids: readonly string[];
  /** Appelant à l'origine de l'exécution (SEM-06), repris dans le rapport T1. */
  origin?: string | null;
  /**
   * Lot 113AO (#748, B) : exécution métier qui a PROVOQUÉ ce traitement (lien
   * de causalité : fin d'une analyse T1 → pré-génération T6). Jamais
   * l'exécution des appels : elle n'est portée qu'en métadonnée
   * (`causedByExecutionId`), sans attribution de compteurs ni de coûts.
   */
  causedBy?: string | null;
}

const storage = new AsyncLocalStorage<BusinessExecutionContext>();

/** Exécute `fn` pour la ou les exécutions métier données ; les appels déclenchés en héritent. */
export function runInBusinessExecution<T>(
  ids: string | readonly string[], fn: () => Promise<T>, opts: { origin?: string | null } = {},
): Promise<T> {
  const liste = (typeof ids === 'string' ? [ids] : [...ids]).filter((x) => typeof x === 'string' && x.length > 0);
  if (liste.length === 0) return fn();
  // Lot 113AO : le lien de causalité du contexte englobant (T6 détaché) est conservé.
  const parent = storage.getStore();
  return storage.run({ ids: [...new Set(liste)], origin: opts.origin ?? null, causedBy: parent?.causedBy ?? null }, fn);
}

/**
 * Lot 113AO (#748, B) — exécute un traitement T6 (pré-génération, FORMULATE,
 * EVALUATE) comme SA PROPRE exécution : contexte métier explicite VIDE (aucune
 * exécution héritée — ni d'un travail de file T1, ni d'une analyse T1 hors
 * file dont la fin a demandé la pré-génération), le déclencheur éventuel
 * conservé à part comme lien de causalité. Les appels FORMULATE sont alors
 * rattachés à `T6F:<trace>` et les appels EVALUATE à leurs `T6E:…`
 * (`runInBusinessExecution`), jamais à l'exécution T1.
 */
export function runAsT6Execution<T>(fn: () => Promise<T>, opts: { causedBy?: string | null } = {}): Promise<T> {
  return storage.run({ ids: [], origin: null, causedBy: opts.causedBy ?? inheritedCausalExecutionId() }, fn);
}

/**
 * Lot 113AO — exécution métier NON T6 du contexte courant (explicite, sinon
 * travail de file), candidate au lien de causalité d'un traitement T6 qu'elle
 * déclenche ; null s'il n'y en a pas (ou plusieurs). Pur hors lecture du contexte.
 */
export function inheritedCausalExecutionId(): string | null {
  const parent = storage.getStore();
  if (parent?.causedBy) return parent.causedBy;
  const ids = currentBusinessExecutionIds().filter((x) => !isT6ExecutionId(x));
  return ids.length === 1 ? ids[0] : null;
}

/** Exécution métier à l'origine du traitement courant (lien de causalité, lot 113AO), ou null. */
export function currentCausalExecutionId(): string | null {
  return storage.getStore()?.causedBy ?? null;
}

/** Identifiant d'exécution T6 (FORMULATE `T6F:` ou EVALUATE `T6E:`) ? Pur. */
export function isT6ExecutionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && (id.startsWith('T6F:') || id.startsWith('T6E:'));
}

/** Origine déclarée de l'exécution métier courante (contexte explicite seulement). */
export function currentBusinessExecutionOrigin(): string | null {
  return storage.getStore()?.origin ?? null;
}

/** Exécutions métier courantes (contexte explicite, sinon travail de file), liste vide sinon. */
export function currentBusinessExecutionIds(): string[] {
  const explicite = storage.getStore();
  if (explicite) return [...explicite.ids];
  const job = currentJobContext()?.businessExecutionId;
  return job ? [job] : [];
}

/** Exécution métier UNIQUE courante (null : aucune, ou plusieurs). */
export function currentBusinessExecutionId(): string | null {
  const ids = currentBusinessExecutionIds();
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Rattachement d'un appel tracé (pur hors lecture du contexte) :
 * `id` — colonne `business_execution_id` (une seule exécution) ;
 * `ids` — liste portée en métadonnée quand l'appel en sert plusieurs.
 */
export function businessExecutionOfCall(call: { operationCode: string; traceId: string }): { id: string | null; ids: string[]; causedBy?: string | null } {
  const tous = currentBusinessExecutionIds();
  // Lot 113AO (#748, B) : un appel T6 appartient TOUJOURS à une exécution T6 —
  // jamais à l'exécution T1 (ou autre) dont il hériterait le contexte. FORMULATE :
  // l'exécution est celle de la passerelle (`T6F:<trace>`) ; EVALUATE : ses `T6E:…`
  // seulement. Un identifiant écarté est conservé comme lien de causalité.
  if (call.operationCode === 't6_formulate' || call.operationCode === 't6_evaluate') {
    const ecartes = tous.filter((x) => !isT6ExecutionId(x));
    const causedBy = currentCausalExecutionId() ?? (ecartes.length === 1 ? ecartes[0] : null);
    const extra = causedBy ? { causedBy } : {};
    if (call.operationCode === 't6_formulate') return { id: t6FormulateExecutionId(call.traceId), ids: [], ...extra };
    const ids = tous.filter((x) => x.startsWith('T6E:'));
    return ids.length === 1 ? { id: ids[0], ids: [], ...extra } : { id: null, ids, ...extra };
  }
  const ids = tous;
  return ids.length === 1 ? { id: ids[0], ids: [] } : { id: null, ids };
}
