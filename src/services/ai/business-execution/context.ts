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

export interface BusinessExecutionContext {
  /** Une ou plusieurs exécutions servies par les appels de ce contexte. */
  ids: readonly string[];
  /** Appelant à l'origine de l'exécution (SEM-06), repris dans le rapport T1. */
  origin?: string | null;
}

const storage = new AsyncLocalStorage<BusinessExecutionContext>();

/** Exécute `fn` pour la ou les exécutions métier données ; les appels déclenchés en héritent. */
export function runInBusinessExecution<T>(
  ids: string | readonly string[], fn: () => Promise<T>, opts: { origin?: string | null } = {},
): Promise<T> {
  const liste = (typeof ids === 'string' ? [ids] : [...ids]).filter((x) => typeof x === 'string' && x.length > 0);
  if (liste.length === 0) return fn();
  return storage.run({ ids: [...new Set(liste)], origin: opts.origin ?? null }, fn);
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
export function businessExecutionOfCall(call: { operationCode: string; traceId: string }): { id: string | null; ids: string[] } {
  const ids = currentBusinessExecutionIds();
  if (ids.length === 0 && call.operationCode === 't6_formulate') return { id: t6FormulateExecutionId(call.traceId), ids: [] };
  return ids.length === 1 ? { id: ids[0], ids: [] } : { id: null, ids };
}
