/**
 * Fondements des questions suggérées T6 — lot 87C (ticket P1 « T6 —
 * fiabiliser la pertinence, le fondement et la répondabilité des questions
 * suggérées »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE DÉFINITION DES FONDEMENTS, TROIS USAGES
 *
 *   · génération : `suggestionGroundsOf(prep)` transforme ce que la décision
 *     T6 du passage a DÉJÀ lu (preuves `loadT6Evidence`, décision conservée)
 *     en fondements des échéances — aucune relecture, aucune collecte
 *     parallèle ;
 *   · relecture du cache : les fondements conservés avec chaque question
 *     sont comparés à ceux du contexte courant (`storedGroundsViolation`) ;
 *   · contrôle de cohérence (COH-T6-SUGGESTIONS) : les mêmes sources
 *     canoniques sont relues pour les SEULS objets cités
 *     (`currentSuggestionGroundVersions`) et passées par le MÊME constructeur
 *     (`buildT6SuggestionContext`) — mêmes clés, mêmes versions, même règle.
 *
 * Invalidation (`invalidateT6SuggestionCache`) : l'entrée de cache concernée
 * est SUPPRIMÉE (la question n'est plus affichable, une nouvelle génération
 * sur le contexte courant devient possible — les textes de la bulle restent
 * figés par R8) et l'invalidation est ajoutée à la trace de la génération
 * d'origine (`home_mascot_generations.suggestion_report`). Aucune donnée
 * métier n'est jamais modifiée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { T6DecisionTrace, T6ItemEvidence, T6Preparation } from './t6-interpellation.service';
import { evaluationEvidenceOf } from './t6-interpellation.service';
import type { T6StoredAssessment } from './t6-interpellation';
import { daysBetween, exceptionEvidenceGrounded, T6_ASSESSMENT_CONTRACT, T6_ASSESSMENT_MAX_AGE_DAYS } from './t6-interpellation';
import {
  buildT6SuggestionContext, futureSuggestionAgenda, storedGroundsOf, T6_SUGGESTION_CONTRACT,
  type T6DeadlineGroundsInput, type T6StoredGround, type T6SuggestionReport,
} from './t6-suggestions';

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/**
 * Décision T6 conservée → fondement « décision / démarche » (pure, PARTAGÉE).
 * Seule une décision du contrat courant ET fraîche est transmise ; la
 * démarche n'existe que pour un SHOW_NOW d'action (jamais un rappel
 * informatif) ; elle est « établie » si une preuve concrète citée par la
 * décision est encore disponible (`exceptionEvidenceGrounded`, lot 75E).
 */
export function decisionInputOf(
  a: T6StoredAssessment | null | undefined, fresh: boolean, evidence: T6ItemEvidence | null | undefined,
): T6DeadlineGroundsInput['decision'] {
  if (!a || !fresh || a.contractVersion !== T6_ASSESSMENT_CONTRACT || !a.decision) return null;
  const actionAttendue = a.decision === 'SHOW_NOW' && a.category !== 'INFORMATION' && a.actionNeeded;
  const action = actionAttendue ? a.action : null;
  return {
    decision: a.decision, category: a.category ?? null, reasonCode: a.reasonCode ?? null, uncertainties: a.uncertainties ?? [],
    action,
    actionEstablished: !!action && !!evidence && exceptionEvidenceGrounded(a, { description: evidence.description, facts: evidence.facts }),
  };
}

/**
 * Preuves canoniques d'une échéance → description, faits, documents (pure,
 * PARTAGÉE) — sélection et ordre de pertinence d'EVALUATE, par la même
 * fonction (`evaluationEvidenceOf` : clé d'origine, confiance, document
 * d'origine ; statut PROVEN / DEDUCED / UNCERTAIN).
 */
export function evidenceInputOf(e: T6ItemEvidence | null | undefined): Pick<T6DeadlineGroundsInput, 'description' | 'facts' | 'documents'> {
  if (!e) return { description: null, facts: [], documents: [] };
  const p = evaluationEvidenceOf('S', e);
  const docs = p.refs.filter((r) => r.kind === 'DOCUMENT');
  return {
    description: e.description,
    facts: p.facts.flatMap((f) => {
      const v = p.versions.get(f.ref);
      return v?.fileId != null && v.factKey ? [{ fileId: v.fileId, factKey: v.factKey, label: f.label, value: f.value, status: f.status }] : [];
    }),
    documents: docs.flatMap((r, i) => {
      const v = p.versions.get(r.ref);
      return v?.fileId != null ? [{ fileId: v.fileId, title: p.documents[i] }] : [];
    }),
  };
}

/**
 * Lot 87C — fondements des échéances à partir de la décision T6 du passage
 * (pure) : preuves déjà lues et décision conservée de chaque échéance
 * candidate. Une échéance sans décision ni preuve n'a que son titre et sa
 * date comme fondement.
 */
export function suggestionGroundsOf(prep: Pick<T6Preparation, 'decisions' | 'evidence'>): Map<number, T6DeadlineGroundsInput> {
  const out = new Map<number, T6DeadlineGroundsInput>();
  for (const d of prep.decisions as readonly T6DecisionTrace[]) {
    const e = prep.evidence?.get(d.agendaItemId) ?? null;
    out.set(d.agendaItemId, { ...evidenceInputOf(e), decision: decisionInputOf(d.assessment, d.assessmentFresh, e) });
  }
  return out;
}

// ── État courant des fondements (contrôle de cohérence) ─────────────────────

/** Sources propriétaires citées par des fondements conservés. */
function ownersOf(grounds: readonly T6StoredGround[]): { agenda: number[]; assets: number[]; account: boolean } {
  const agenda = new Set<number>();
  const assets = new Set<number>();
  let account = false;
  for (const g of grounds) {
    const m = /^(agenda|asset):(\d+)$/.exec(g.owner ?? '');
    if (m?.[1] === 'agenda') agenda.add(Number(m[2]));
    else if (m?.[1] === 'asset') assets.add(Number(m[2]));
    else if (g.key.startsWith('account:')) account = true;
  }
  return { agenda: [...agenda], assets: [...assets], account };
}

/**
 * Versions COURANTES des fondements cités (clé → version), relues aux
 * sources canoniques du compte pour les SEULS objets cités, puis passées par
 * le constructeur du contexte (mêmes clés, mêmes versions) :
 *   · échéances du compte, à venir, non closes, non écartées (décision T6
 *     fraîche autre que SHOW_NOW, ou préférence active d'un utilisateur du
 *     compte) — sinon indisponibles ;
 *   · preuves (`loadT6Evidence`) et décision conservée, fraîche si son
 *     empreinte est celle du contexte courant, son âge sous le maximum
 *     d'`assessmentFreshness` et sa date de réexamen non atteinte ;
 *   · biens nommables du compte, indicateurs du compte.
 * Lève en cas d'échec (le contrôle ne conclut alors rien).
 */
export async function currentSuggestionGroundVersions(accountId: number, grounds: readonly T6StoredGround[], today: string): Promise<Map<string, string>> {
  const { agenda, assets, account } = ownersOf(grounds);
  const [collector, service, signals, labels, state] = await Promise.all([
    import('./collector'), import('./t6-interpellation.service'), import('./signals'), import('./deadline-label'),
    import('@/services/verebona-assistant/core/account-state'),
  ]);
  const [lignes, ouvertes, preuves, evaluations, preferences, biens, etat, operations] = await Promise.all([
    collector.readAgendaRowsByIds(accountId, agenda),
    agenda.length ? rows(`SELECT id FROM agenda_items WHERE account_id = $1 AND id = ANY($2::int[]) AND (manual_status IS NULL OR trim(manual_status) = '')`, [accountId, agenda]) : Promise.resolve([]),
    service.loadT6Evidence(accountId, agenda),
    service.loadAssessments(accountId, agenda),
    agenda.length ? rows(
      `SELECT DISTINCT agenda_item_id FROM t6_reminder_preferences
        WHERE account_id = $1 AND agenda_item_id = ANY($2::int[]) AND (decision = 'DISMISSED' OR (decision = 'SNOOZED' AND remind_at > $3::date))`,
      [accountId, agenda, today]) : Promise.resolve([]),
    assets.length ? state.listNameableSuggestionAssets(accountId, 500) : Promise.resolve([]),
    account ? state.loadAccountSuggestionState(accountId) : Promise.resolve(null),
    account ? (await import('./t6-suggestions')).countSuggestionOperations(accountId) : Promise.resolve(0),
  ]);
  const ouvertesIds = new Set(ouvertes.map((x) => Number(x.id)));
  const silencieuses = new Set(preferences.map((x) => Number(x.agenda_item_id)));
  const inputs = new Map<number, T6DeadlineGroundsInput>();
  const eligibles = futureSuggestionAgenda(lignes.filter((r) => {
    if (!ouvertesIds.has(r.id) || silencieuses.has(r.id)) return false;
    const a = evaluations.get(r.id);
    const e = preuves.get(r.id);
    // Fraîcheur au sens d'`assessmentFreshness` (contexte identique, âge maximal, date de réexamen non atteinte).
    const fraiche = !!a && a.fingerprint === service.t6ContextFingerprint(r, e)
      && daysBetween(a.assessedOn, today) <= T6_ASSESSMENT_MAX_AGE_DAYS && (!a.reevaluateOn || a.reevaluateOn > today);
    // Décision T6 actualisée qui écarte l'échéance : jamais un fondement.
    if (fraiche && a!.contractVersion === T6_ASSESSMENT_CONTRACT && a!.decision && a!.decision !== 'SHOW_NOW') return false;
    inputs.set(r.id, { ...evidenceInputOf(e), decision: decisionInputOf(a, fraiche, e) });
    return true;
  }), today);
  const bundle = buildT6SuggestionContext({
    speech: '', attentionToday: false, state: etat, operations,
    assets: biens.filter((b) => assets.includes(b.id)), agenda: [],
    labelOf: (r) => labels.deadlineButtonLabel({ ...r, dateRole: signals.roleOf(r) }), formatDate: (x) => x,
  });
  const out = new Map([...bundle.grounds!.values()].map((g) => [g.key, g.version]));
  // Une échéance à la fois : le plafond de 3 échéances du contexte ne masque aucun fondement.
  for (const r of eligibles) {
    const b = buildT6SuggestionContext({
      speech: '', attentionToday: false, state: null, operations: 0, assets: [], agenda: [r],
      labelOf: (x) => labels.deadlineButtonLabel({ ...x, dateRole: signals.roleOf(x) }), formatDate: (x) => x, grounds: inputs,
    });
    for (const g of b.grounds!.values()) if (g.owner === `agenda:${r.id}`) out.set(g.key, g.version);
  }
  return out;
}

/** Fondements conservés de toutes les questions d'une entrée de cache. */
export function storedGroundsOfEntry(suggestions: unknown): { perSuggestion: Array<T6StoredGround[] | null>; all: T6StoredGround[] } {
  const perSuggestion = (Array.isArray(suggestions) ? suggestions : []).map((s) => storedGroundsOf((s as { grounds?: unknown } | null)?.grounds));
  return { perSuggestion, all: perSuggestion.flatMap((g) => g ?? []) };
}

// ── Invalidation et trace ────────────────────────────────────────────────────

export interface T6SuggestionInvalidation {
  cacheKey: string;
  traceId: string | null;
  /** Motifs structurés (`ground_changed`, `ground_unavailable`, `contract_outdated`…) → nombre de questions. */
  reasons: Record<string, number>;
  /** Questions retirées. */
  removed: number;
}

/**
 * Invalide des entrées du cache T6 du compte : suppression (questions plus
 * affichables, nouvelle génération possible sur le contexte courant) et
 * invalidation ajoutée à la trace de la génération d'origine. Aucune donnée
 * métier touchée. Rend le nombre d'entrées supprimées.
 */
export async function invalidateT6SuggestionCache(
  accountId: number, entries: readonly T6SuggestionInvalidation[], source: 'CACHE_READ' | 'COHERENCE', now: Date = new Date(),
): Promise<number> {
  if (entries.length === 0) return 0;
  const r = await rows(
    `DELETE FROM home_mascot_cache WHERE account_id = $1 AND cache_key = ANY($2::text[]) RETURNING cache_key`,
    [accountId, entries.map((e) => e.cacheKey)],
  );
  for (const e of entries) {
    if (!e.traceId) continue;
    const trace: NonNullable<T6SuggestionReport['invalidations']>[number] = { at: now.toISOString(), source, reasons: e.reasons, removed: e.removed };
    await rows(
      `UPDATE home_mascot_generations
          SET suggestion_report = jsonb_set(COALESCE(suggestion_report, '{}'::jsonb), '{invalidations}',
                COALESCE(suggestion_report -> 'invalidations', '[]'::jsonb) || $3::jsonb)
        WHERE account_id = $1 AND trace_id = $2 AND status = 'generated'`,
      [accountId, e.traceId, JSON.stringify([trace])],
    ).catch((err: Error) => console.error('[mascotte] invalidation des questions non tracée :', err.message));
  }
  return r.length;
}

/** Contrat des questions conservées dans le cache (lecture, contrôle). */
export const T6_SUGGESTION_CACHE_CONTRACT = T6_SUGGESTION_CONTRACT;
