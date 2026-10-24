/**
 * Rattrapage des FAUX ARBITRAGES « À traiter » — lot 81A (ticket « [P1] T3 /
 * À traiter — Corriger les faux arbitrages entre valeurs identiques », §3.3,
 * §4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉEXAMINER, JAMAIS SUPPRIMER À L'AVEUGLE
 *
 * Une carte « 06/05/2021 ou 06/05/2021 ? » peut masquer une VRAIE troisième
 * valeur (acte A = fiche = 06/05, acte B = 17/05 : l'ancien moteur proposait
 * la meilleure preuve, égale à la fiche). Chaque carte ARBITRATE active dont
 * les propositions sont équivalentes (à la valeur actuelle, ou entre elles)
 * après normalisation métier est donc RÉÉVALUÉE par le moteur corrigé, en
 * LECTURE SEULE (preuves actives, valeur en place, mémoire des arbitrages
 * tranchés — `evaluateAssetField` / `evaluateEntityField`) :
 *   · contradiction réelle (conflit, ou preuve qui l'emporterait à la
 *     prochaine réconciliation) → la carte est CORRIGÉE avec les bonnes
 *     valeurs (même carte, `upsertAction` : jamais de doublon) ;
 *   · plus aucune contradiction → la carte est résolue `OBSOLETE`.
 * Les valeurs de la fiche ne sont JAMAIS modifiées ; aucune carte n'est
 * supprimée ; l'historique (propositions avant / après, preuves, motif
 * initial, décision corrective) est tracé dans `to_process_action_events`,
 * exporté par « Données du compte » (BO) — aucun système parallèle.
 *
 * Périmètre : cartes de champ de BIEN (pont de réconciliation) et
 * d'ÉQUIPEMENT / PIÈCE (ENTITY-FIELD). Les autres familles suspectes
 * (documents…) sont comptées `OUT_OF_SCOPE`, jamais touchées : leur
 * producteur passe déjà par le contrôle d'équivalence de `upsertAction`.
 *
 * Deux pilotes, même code (`reexamineCard`) :
 *   · le contrôle de cohérence COH-TODO-T3-FIELD-CARDS (lot 85B, campagne
 *     exhaustive quotidienne `coherence-control` : preuve par objet, mode à
 *     blanc / correctif, anti-boucle, journal des réparations, Supervision) —
 *     il REMPLACE la campagne automatique `l81-faux-arbitrages-1` (C-Q9 : une
 *     seule chaîne ; la table 0626 garde l'historique de cette campagne) ;
 *   · BO › Exploitation › Rattrapages : simulation (aucune écriture) ou
 *     application, éventuellement limitée à un compte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { and, eq, isNull } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ReconciliationDecision } from '@/services/ai/reconciliation/types';
import { areBusinessEquivalent, businessKey } from '@/services/ai/reconciliation/decision/equivalence';
import { sanitizeArbitrationProposals, type ActionProposal } from './action-model';
import { findRule, canonicalAssetKey } from './rules-catalog';

/** Campagne du lot 81A (historique 0626 ; libellé du rattrapage BO). */
export const ARBITRATION_REPRISE_CAMPAIGN = 'l81-faux-arbitrages-1';
/** Cartes lues par page. */
const PAGE = 200;

export type RepriseOutcome =
  /** Contradiction réelle : carte mise à jour avec les bonnes valeurs. */
  | 'CORRECTED'
  /** Plus aucune contradiction : carte résolue OBSOLETE. */
  | 'OBSOLETE'
  /** Famille hors moteur T3 (document…) : comptée, jamais touchée. */
  | 'OUT_OF_SCOPE'
  /** Bien / entité introuvable : laissé tel quel (signalé). */
  | 'TARGET_MISSING'
  | 'ERROR';

export type SuspectReason = 'EQUIVALENT_TO_CURRENT' | 'DUPLICATE_PROPOSALS';

/**
 * Carte suspecte (pure) : au moins une proposition équivalente à la valeur
 * actuelle, ou deux propositions équivalentes entre elles (comparaison
 * métier sur la clé de la donnée). `null` : carte saine.
 */
export function suspectArbitration(fieldKey: string, proposals: readonly ActionProposal[]): SuspectReason | null {
  const courantes = proposals.filter((p) => p.isCurrentValue && p.value !== null && p.value !== undefined);
  const autres = proposals.filter((p) => !p.isCurrentValue);
  if (autres.some((a) => a.value !== null && a.value !== undefined && courantes.some((c) => areBusinessEquivalent(fieldKey, c.value, a.value)))) {
    return 'EQUIVALENT_TO_CURRENT';
  }
  return sanitizeArbitrationProposals([...proposals], fieldKey).length < proposals.length ? 'DUPLICATE_PROPOSALS' : null;
}

interface Card {
  id: number; accountId: number; targetType: string; targetId: number; fieldKey: string; ruleCode: string; proposals: ActionProposal[];
}

/** Diagnostic d'une carte réexaminée (BO, événement). Jamais montré à l'utilisateur final. */
export interface RepriseItem {
  actionId: number;
  accountId: number;
  targetType: string;
  targetId: number;
  fieldKey: string;
  ruleCode: string;
  suspect: SuspectReason;
  outcome: RepriseOutcome;
  /** Propositions avant / après (après : CORRECTED seulement). */
  before: ActionProposal[];
  after?: ActionProposal[];
  currentValue?: unknown;
  currentOrigin?: string | null;
  candidates?: Array<{ evidenceId: number; value: unknown; normalized: string | null; businessKey: string | null; documentType: string | null; documentDate: string | null; authority: number; sourceId: number }>;
  /** Motif initial : conflit du registre (`inconsistency_registry`) et dernière décision T3 du champ. */
  initial?: { registryReason: string | null; registryProposed: string | null; lastDecision: { action: string; reasonCode: string } | null };
  /** Décision corrective du moteur (lecture seule). */
  corrective?: Array<{ action: string; reasonCode: string; proposedValue: unknown; alternatives?: unknown[] }>;
  error?: string;
}

export interface RepriseCounters {
  scanned: number;
  suspects: number;
  CORRECTED: number;
  OBSOLETE: number;
  OUT_OF_SCOPE: number;
  TARGET_MISSING: number;
  ERROR: number;
}

const zero = (): RepriseCounters => ({ scanned: 0, suspects: 0, CORRECTED: 0, OBSOLETE: 0, OUT_OF_SCOPE: 0, TARGET_MISSING: 0, ERROR: 0 });

type Raw = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Raw[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Raw[];

const asProposals = (v: unknown): ActionProposal[] => {
  if (Array.isArray(v)) return v as ActionProposal[];
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

/** Famille de la carte : bien (pont T3), équipement / pièce (ENTITY-FIELD), sinon hors périmètre. */
function familleDe(c: Card): 'ASSET' | 'ENTITY' | null {
  if (c.targetType === 'ASSET') return findRule('ASSET', c.fieldKey)?.producer === 'RECONCILIATION_BRIDGE' ? 'ASSET' : null;
  if ((c.targetType === 'EQUIPMENT' || c.targetType === 'ROOM') && (c.ruleCode === 'ENTITY-FIELD' || c.ruleCode === 'ENTITY-FIELD-ROOM')) return 'ENTITY';
  return null;
}

const decisionsResume = (ds: ReconciliationDecision[]) => ds.map((d) => ({
  action: d.action, reasonCode: d.reasonCode, proposedValue: d.proposedValue ?? null,
  ...(d.alternatives?.length ? { alternatives: d.alternatives.map((a) => ({ value: a.value, evidenceIds: a.evidenceIds })) } : {}),
}));

/** Décision portant une contradiction RÉELLE avec la valeur en place, s'il y en a une. */
const REELLES = new Set(['create_conflict', 'apply', 'update', 'request_ai_review']);

/** Motif initial (lecture) : conflit du registre et dernière décision T3 du champ. */
async function motifInitial(c: Card): Promise<RepriseItem['initial']> {
  if (c.targetType !== 'ASSET') return { registryReason: null, registryProposed: null, lastDecision: null };
  const { assetKeyVariants } = await import('./to-process-action.service');
  const cles = assetKeyVariants(c.fieldKey);
  const [reg] = await q(
    `SELECT reason_code, proposed_value FROM inconsistency_registry WHERE account_id = $1 AND asset_id = $2 AND field_key = ANY($3::text[])
      ORDER BY (status = 'open') DESC, updated_at DESC NULLS LAST, id DESC LIMIT 1`, [c.accountId, c.targetId, cles],
  ).catch(() => [] as Raw[]);
  const [dec] = await q(
    `SELECT action, reason_code FROM reconciliation_decisions WHERE account_id = $1 AND asset_id = $2 AND field_key = ANY($3::text[])
      ORDER BY id DESC LIMIT 1`, [c.accountId, c.targetId, cles],
  ).catch(() => [] as Raw[]);
  return {
    registryReason: (reg?.reason_code as string | null) ?? null,
    registryProposed: (reg?.proposed_value as string | null) ?? null,
    lastDecision: dec ? { action: String(dec.action), reasonCode: String(dec.reason_code) } : null,
  };
}

/**
 * Réexamine UNE carte suspecte (lecture seule si `apply` est faux). Ne lève
 * pas : une erreur est rendue dans l'issue.
 */
export async function reexamineCard(c: Card, suspect: SuspectReason, opts: { apply: boolean; campaign: string; origin: 'SCHEDULED' | 'BO' }): Promise<RepriseItem> {
  const item: RepriseItem = {
    actionId: c.id, accountId: c.accountId, targetType: c.targetType, targetId: c.targetId, fieldKey: c.fieldKey,
    ruleCode: c.ruleCode, suspect, outcome: 'OUT_OF_SCOPE', before: c.proposals,
  };
  const famille = familleDe(c);
  if (!famille) return item;
  try {
    item.initial = await motifInitial(c);
    let decisions: ReconciliationDecision[];
    let proposalsOf: (d: ReconciliationDecision) => ActionProposal[] | null;
    if (famille === 'ASSET') {
      const { evaluateAssetField } = await import('@/services/ai/reconciliation/reconciliation-engine');
      const ev = await evaluateAssetField(c.accountId, c.targetId, canonicalAssetKey(c.fieldKey));
      if (ev.missing) { item.outcome = 'TARGET_MISSING'; return item; }
      decisions = ev.decisions;
      item.currentValue = ev.current?.value ?? null;
      item.currentOrigin = ev.current?.origin ?? null;
      item.candidates = ev.fields.flatMap((f) => f.input.candidates).map((x) => ({
        evidenceId: x.evidenceId, value: x.value, normalized: x.normalized, businessKey: businessKey(c.fieldKey, x.value),
        documentType: x.documentType, documentDate: x.documentDate ? new Date(x.documentDate).toISOString().slice(0, 10) : null,
        authority: x.authorityScore, sourceId: x.sourceId,
      }));
      const { arbitrationProposals } = await import('./reconciliation-bridge');
      proposalsOf = arbitrationProposals;
    } else {
      const { evaluateEntityField } = await import('@/services/ai/reconciliation/entity-reconciliation');
      const ev = await evaluateEntityField(c.accountId, { type: c.targetType as 'EQUIPMENT' | 'ROOM', id: c.targetId }, c.fieldKey);
      if (ev.missing) { item.outcome = 'TARGET_MISSING'; return item; }
      decisions = ev.decisions;
      item.currentValue = ev.current?.value ?? null;
      item.currentOrigin = ev.current?.origin ?? null;
      item.candidates = ev.candidates.map((x) => ({
        evidenceId: x.evidenceId, value: x.value, normalized: x.normalized, businessKey: businessKey(c.fieldKey, x.value),
        documentType: x.documentType, documentDate: x.documentDate ? new Date(x.documentDate).toISOString().slice(0, 10) : null,
        authority: x.authorityScore, sourceId: x.sourceId,
      }));
      const { entityConflictProposals } = await import('./entity-field-cards');
      proposalsOf = (d) => { const p = entityConflictProposals(d); return p.length ? p : null; };
    }
    item.corrective = decisionsResume(decisions);

    // Contradiction réelle : la première décision qui garde une véritable alternative.
    let correction: { decision: ReconciliationDecision; proposals: ActionProposal[] } | null = null;
    for (const d of decisions) {
      if (!REELLES.has(d.action)) continue;
      const p = proposalsOf(d);
      if (p && sanitizeArbitrationProposals(p, c.fieldKey).some((x) => !x.isCurrentValue)) { correction = { decision: d, proposals: p }; break; }
    }
    item.outcome = correction ? 'CORRECTED' : 'OBSOLETE';
    if (correction) item.after = sanitizeArbitrationProposals(correction.proposals, c.fieldKey);
    if (!opts.apply) return item;

    const details = {
      reason: 'L81A_FALSE_ARBITRATION_REPRISE', campaign: opts.campaign, origin: opts.origin, suspect,
      currentValue: item.currentValue ?? null, currentOrigin: item.currentOrigin ?? null, candidates: item.candidates ?? [],
      initial: item.initial ?? null, corrective: item.corrective,
    };
    const now = new Date();
    if (correction) {
      const { upsertAction } = await import('./to-process-action.service');
      const r = await upsertAction({
        accountId: c.accountId, targetType: c.targetType as 'ASSET' | 'EQUIPMENT' | 'ROOM', targetId: c.targetId, fieldKey: c.fieldKey,
        actionKind: 'ARBITRATE', ruleCode: c.ruleCode, proposals: correction.proposals,
      });
      if (r.status === 'SKIPPED') throw new Error(`mise à jour refusée : ${r.reason}`);
      await db.insert(toProcessActionEvents).values({
        actionId: r.actionId ?? c.id, accountId: c.accountId, event: 'PROPOSALS_CORRECTED', targetType: c.targetType, targetId: c.targetId,
        fieldKey: c.fieldKey, previousValue: c.proposals as never, newValue: item.after as never,
        details: { ...details, upsert: r.status, decision: correction.decision.reasonCode }, createdAt: now,
      });
      // Registre des contradictions aligné (aucune valeur métier touchée).
      if (c.targetType === 'ASSET' && correction.decision.action === 'create_conflict') {
        const { writeConflict } = await import('@/services/ai/reconciliation/conflict-writer');
        await writeConflict(correction.decision, {
          accountId: c.accountId, assetId: c.targetId, currentEvidenceIds: [], currentOrigin: item.currentOrigin ?? 'USER',
        });
      }
      return item;
    }
    const fermee = await db.transaction(async (tx) => {
      const r = await tx.update(toProcessActions)
        .set({ resolvedAt: now, resolutionReason: 'OBSOLETE', updatedAt: now })
        .where(and(eq(toProcessActions.id, c.id), eq(toProcessActions.accountId, c.accountId), isNull(toProcessActions.resolvedAt)))
        .returning({ id: toProcessActions.id });
      if (r.length) {
        await tx.insert(toProcessActionEvents).values({
          actionId: c.id, accountId: c.accountId, event: 'OBSOLETE', targetType: c.targetType, targetId: c.targetId, fieldKey: c.fieldKey,
          previousValue: c.proposals as never, details: { ...details, reason: 'EQUIVALENT_VALUES_NO_CONTRADICTION', reprise: 'L81A_FALSE_ARBITRATION_REPRISE' }, createdAt: now,
        });
      }
      return r.length > 0;
    });
    if (fermee && c.targetType === 'ASSET') {
      const { resolveObsoleteConflict } = await import('@/services/ai/reconciliation/conflict-writer');
      const { assetKeyVariants } = await import('./to-process-action.service');
      for (const k of assetKeyVariants(c.fieldKey)) {
        await resolveObsoleteConflict(c.accountId, c.targetId, k, 'sans objet : valeurs équivalentes (rattrapage lot 81A)');
      }
    }
    return item;
  } catch (e) {
    item.outcome = 'ERROR';
    item.error = String((e as Error)?.message ?? e).slice(0, 300);
    if (opts.apply) {
      await db.insert(toProcessActionEvents).values({
        actionId: c.id, accountId: c.accountId, event: 'REPRISE_ERROR', targetType: c.targetType, targetId: c.targetId, fieldKey: c.fieldKey,
        details: { reason: 'L81A_FALSE_ARBITRATION_REPRISE', campaign: opts.campaign, origin: opts.origin, error: item.error }, createdAt: new Date(),
      }).catch(() => {});
    }
    return item;
  }
}

/** Page de cartes ARBITRATE actives sur une DONNÉE (id > curseur), éventuellement d'un compte. */
async function pageCartes(cursor: number, accountId: number | null, ids?: number[]): Promise<Card[]> {
  const rows = await q(
    `SELECT id, account_id, target_type, target_id, field_key, rule_code, proposals_json FROM to_process_actions
      WHERE resolved_at IS NULL AND action_kind = 'ARBITRATE' AND field_key IS NOT NULL AND id > $1
        AND ($2::int IS NULL OR account_id = $2::int) AND ($3::int[] IS NULL OR id = ANY($3::int[]))
        -- Lot 82A (C-Q10, §3.3) : rattrapage des seuls comptes éligibles.
        AND ${processingEligibleSql('to_process_actions.account_id')}
      ORDER BY id LIMIT $4`,
    [cursor, accountId, ids ?? null, PAGE],
  );
  return rows.map((r) => ({
    id: Number(r.id), accountId: Number(r.account_id), targetType: String(r.target_type), targetId: Number(r.target_id),
    fieldKey: String(r.field_key), ruleCode: String(r.rule_code), proposals: asProposals(r.proposals_json),
  }));
}

export interface RepriseRunResult {
  mode: 'SIMULATE' | 'APPLY';
  campaign: string;
  counters: RepriseCounters;
  items: RepriseItem[];
  /** Reste à parcourir. */
  more: boolean;
  done: boolean;
  disabled?: boolean;
  cursor?: number;
}

/**
 * BO › Exploitation › Rattrapages : parcours COMPLET des cartes actives
 * (simulation : aucune écriture ; application : corrections et
 * fermetures tracées). Même code que le contrôle COH-TODO-T3-FIELD-CARDS.
 */
export async function runArbitrationReprise(p: {
  apply: boolean; accountId?: number | null; origin?: 'SCHEDULED' | 'BO'; log?: (m: string) => void; maxCards?: number;
}): Promise<RepriseRunResult> {
  const counters = zero();
  const items: RepriseItem[] = [];
  let cursor = 0;
  const max = p.maxCards ?? 100_000;
  for (;;) {
    const page = await pageCartes(cursor, p.accountId ?? null);
    if (page.length === 0) break;
    for (const c of page) {
      cursor = c.id;
      counters.scanned += 1;
      const s = suspectArbitration(c.fieldKey, c.proposals);
      if (!s) continue;
      counters.suspects += 1;
      const it = await reexamineCard(c, s, { apply: p.apply, campaign: `bo:${ARBITRATION_REPRISE_CAMPAIGN}`, origin: p.origin ?? 'BO' });
      counters[it.outcome] += 1;
      items.push(it);
    }
    p.log?.(`${counters.scanned} carte(s) parcourue(s), ${counters.suspects} suspecte(s)`);
    if (counters.scanned >= max) break;
  }
  return { mode: p.apply ? 'APPLY' : 'SIMULATE', campaign: ARBITRATION_REPRISE_CAMPAIGN, counters, items, more: false, done: true, cursor };
}
