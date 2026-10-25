/**
 * COH-T6-SUGGESTIONS — questions suggérées T6 encore fondées — lot 87C
 * (ticket P1 « T6 — fiabiliser la pertinence, le fondement et la
 * répondabilité des questions suggérées », §4.6, AC13).
 *
 * Objet contrôlé : le cache T6 du compte (`home_mascot_cache`), un objet par
 * compte qui conserve des questions. Invariant : toute question conservée
 * porte le contrat courant (`t6-suggestions-v3`) et des fondements ENCORE
 * ACTUELS — chaque source citée existe toujours dans le compte, n'est pas
 * écartée par une décision T6 actualisée ou une préférence de l'utilisateur,
 * et son contenu (version) n'a pas changé.
 *
 * MÊMES RÈGLES qu'à la génération et à la relecture du cache : les versions
 * courantes sont recalculées par le constructeur du contexte
 * (`currentSuggestionGroundVersions` → `buildT6SuggestionContext`) et
 * comparées par `storedGroundsViolation` — aucun second système.
 *
 * Réparation (mode correctif) : `invalidateT6SuggestionCache` — l'entrée est
 * retirée du cache (questions plus affichables, nouvelle génération possible
 * sur le contexte courant au prochain affichage ou à la pré-génération),
 * l'invalidation est ajoutée à la trace de la génération d'origine. Aucune
 * donnée métier modifiée, aucun appel IA déclenché par la cohérence.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, rows } from '../util';

/** Entrées de cache contrôlées par compte, au plus (les plus récentes). */
export const T6_SUGGESTION_ENTRIES_MAX = 50;

/** Diagnostic d'une entrée (pur, testé) : motifs par question invalide, ou null. */
export function t6SuggestionEntryDiagnosis(
  entry: { contract: string | null; suggestions: unknown },
  current: ReadonlyMap<string, string> | null,
  deps: {
    contract: string;
    groundsOf: (s: unknown) => Array<import('@/services/home/mascot/t6-suggestions').T6StoredGround[] | null>;
    violation: (g: import('@/services/home/mascot/t6-suggestions').T6StoredGround[] | null, c: ReadonlyMap<string, string>) => string | null;
  },
): { reasons: Record<string, number>; removed: number } | null {
  const n = Array.isArray(entry.suggestions) ? entry.suggestions.length : 0;
  if (n === 0) return null;
  if (entry.contract !== deps.contract) return { reasons: { contract_outdated: n }, removed: n };
  if (!current) return null;
  const reasons: Record<string, number> = {};
  let removed = 0;
  for (const g of deps.groundsOf(entry.suggestions)) {
    const v = g ? deps.violation(g, current) : 'contract_outdated';
    if (v) { reasons[v] = (reasons[v] ?? 0) + 1; removed += 1; }
  }
  return removed > 0 ? { reasons, removed } : null;
}

export const t6SuggestionsCheck: CoherenceCheck = {
  id: 'COH-T6-SUGGESTIONS',
  version: 1,
  status: 'ACTIVE',
  title: 'T6 : les questions suggérées conservées restent fondées sur des sources actuelles du compte',
  domain: 't6',
  level: 'N2',
  objectType: 'account',
  scope: 'cache T6 du compte (`home_mascot_cache`) portant des questions suggérées, un objet par compte',
  sources: ['home_mascot_cache', 'agenda_items', 'document_facts', 'asset_files', 't6_interpellation_assessments', 't6_reminder_preferences', 'assets'],
  applicability: 'compte éligible ; colonnes 0756 présentes',
  invariant: 'toute question conservée porte le contrat t6-suggestions-v3 et des fondements existants, non écartés et inchangés (mêmes règles qu’à la génération et à la relecture du cache)',
  anomalies: ['T6_SUGGESTION_GROUND_INVALID', 'T6_SUGGESTION_CONTRACT_OUTDATED'],
  autoRepairWhen: 'fondement disparu, écarté ou modifié, ou entrée d’un contrat antérieur : entrée retirée du cache par `invalidateT6SuggestionCache` (trace sur la génération d’origine)',
  forbiddenRepairs: [
    'modifier une donnée métier (échéance, document, fait, décision T6, préférence)',
    'relancer T6 (IA) d’office',
    'réintroduire, compléter ou reformuler une question (aucun catalogue de secours)',
    'convertir une question PREPARE en CONSULT',
  ],
  services: ['home/mascot/t6-suggestion-grounds#currentSuggestionGroundVersions', 'home/mascot/t6-suggestion-grounds#invalidateT6SuggestionCache'],
  chain: ['PERSISTENCE', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_UPDATED', 'AGENDA_ITEM_CREATED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'ASSET_UPDATED', 'ASSET_DELETED', 'SOURCE_ANALYZED', 'TO_PROCESS_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne et contrôles ciblés (modification d’une échéance, d’un document, d’un bien, fin d’analyse)',
  criticality: 'MEDIUM',
  tests: ['L87C-U-COH', 'L87C-E2E-AC13'],

  async listObjects(ctx, accountId, afterId) {
    if (afterId >= accountId) return [];
    const [r] = await rows(ctx.sql, `
      SELECT EXISTS (SELECT 1 FROM home_mascot_cache WHERE account_id = $1
                       AND jsonb_typeof(suggestions) = 'array' AND jsonb_array_length(suggestions) > 0) AS e`, [accountId]);
    return r?.e === true ? [accountId] : [];
  },

  async objectsForEvent(ctx, accountId) {
    return this.listObjects!(ctx, accountId, 0, 1);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [g, s] = await Promise.all([import('@/services/home/mascot/t6-suggestion-grounds'), import('@/services/home/mascot/t6-suggestions')]);
    for (const id of ids) {
      if (id !== accountId) { out.set(id, { verdict: 'GONE' }); continue; }
      const entrees = await rows(ctx.sql, `
        SELECT c.cache_key, c.suggestions, to_jsonb(c) ->> 'suggestion_contract' AS contract, to_jsonb(c) ->> 'trace_id' AS trace_id
          FROM home_mascot_cache c
         WHERE c.account_id = $1 AND jsonb_typeof(c.suggestions) = 'array' AND jsonb_array_length(c.suggestions) > 0
         ORDER BY c.created_at DESC LIMIT ${T6_SUGGESTION_ENTRIES_MAX}`, [accountId]);
      if (entrees.length === 0) { out.set(id, { verdict: 'GONE' }); continue; }
      // Versions courantes des fondements cités par les entrées du contrat courant (une lecture par compte).
      const cites = entrees.filter((e) => e.contract === s.T6_SUGGESTION_CONTRACT).flatMap((e) => g.storedGroundsOfEntry(e.suggestions).all);
      const courantes = cites.length ? await g.currentSuggestionGroundVersions(accountId, cites, ctx.today) : new Map<string, string>();
      const invalides: Array<{ cacheKey: string; traceId: string | null; reasons: Record<string, number>; removed: number }> = [];
      for (const e of entrees) {
        const d = t6SuggestionEntryDiagnosis({ contract: (e.contract as string | null) ?? null, suggestions: e.suggestions }, courantes, {
          contract: s.T6_SUGGESTION_CONTRACT,
          groundsOf: (x) => g.storedGroundsOfEntry(x).perSuggestion,
          violation: s.storedGroundsViolation,
        });
        if (d) invalides.push({ cacheKey: String(e.cache_key), traceId: (e.trace_id as string | null) ?? null, ...d });
      }
      const detail = {
        entries: entrees.length, invalidEntries: invalides.length,
        reasons: invalides.reduce<Record<string, number>>((acc, x) => { for (const [k, n] of Object.entries(x.reasons)) acc[k] = (acc[k] ?? 0) + n; return acc; }, {}),
        // Clés de cache et traces seulement (empreintes, jamais de texte).
        invalid: invalides.slice(0, T6_SUGGESTION_ENTRIES_MAX),
      };
      if (invalides.length === 0) { out.set(id, { verdict: 'CONSISTENT', detail: { entries: entrees.length } }); continue; }
      const seulementContrat = invalides.every((x) => Object.keys(x.reasons).every((k) => k === 'contract_outdated'));
      out.set(id, {
        verdict: 'REPAIRABLE',
        anomaly: seulementContrat ? 'T6_SUGGESTION_CONTRACT_OUTDATED' : 'T6_SUGGESTION_GROUND_INVALID',
        faultyLink: 'PERSISTENCE',
        expected: 'questions conservées fondées sur des sources actuelles du compte (contrat t6-suggestions-v3)',
        observed: { invalidEntries: invalides.length, reasons: detail.reasons }, detail,
        inputHash: hashOf({ id, invalid: invalides.map((x) => [x.cacheKey, x.reasons]) }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { invalidateT6SuggestionCache } = await import('@/services/home/mascot/t6-suggestion-grounds');
    for (const { id, inspection } of items) {
      const invalides = ((inspection.detail as { invalid?: Array<{ cacheKey: string; traceId: string | null; reasons: Record<string, number>; removed: number }> } | undefined)?.invalid ?? []);
      const supprimees = await invalidateT6SuggestionCache(accountId, invalides, 'COHERENCE', ctx.now);
      out.set(id, {
        called: true, service: 'invalidateT6SuggestionCache', aiCalls: 0,
        result: { entries: invalides.length, deleted: supprimees, removedSuggestions: invalides.reduce((n, x) => n + x.removed, 0) },
        // Le cache est un dérivé : la génération suivante le reconstruit sur le contexte courant.
        rollbackRef: null,
      });
    }
    return out;
  },
};
