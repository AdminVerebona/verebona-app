/**
 * Étapes du contrôle exhaustif de l'onglet « Informations » branchées dans
 * le moteur commun (`reconcileAsset`, `reconcileEntity`) — lot 76J.
 *
 * Elles ne décident rien seules : elles préparent des preuves ordinaires
 * (prix ancré d'un candidat Opération), confrontent la date d'achat aux
 * sources transversales, dressent l'inventaire des champs et mémorisent
 * l'état du contrôle. Une étape en échec est tracée dans le rapport T3
 * (étape FAILED) et n'interrompt jamais la réconciliation — sauf une
 * interruption d'exécution (arrêt d'urgence, jeton révoqué), remontée.
 */
import { resolveAlias } from '@/services/canonical/registry';
import { fromMirrorColumn } from '@/services/canonical/asset-state/canonical-asset-view';
import { sameCanonicalValue } from '@/services/canonical/asset-state/write-canonical-asset-field';
import { listFields } from '@/services/canonical/registry';
import type { CollectedAsset, CollectedField } from '../evidence-collector';
import type { ReconciliationDecision } from '../types';
import type { T3ExecutionRecorder } from '../../execution-report/t3-report';
import {
  crossCheckAcquisitionDate, informationInventory, mirrorDivergences, type AcquisitionCrossResult,
} from './inventory';
import type { PriceMaterialization } from './store';

const annule = async (e: unknown): Promise<boolean> => {
  const { isExecutionCancelled } = await import('../../queue/execution-control');
  return isExecutionCancelled(e);
};

/** Clé canonique d'une clé de preuve (alias historiques ramenés au registre). */
export const canonicalKeyOf = (k: string): string => resolveAlias(k) ?? k;

/** Prix d'achat ancrés (candidats Opération T1) → preuves ordinaires, AVANT la collecte. */
export async function prepareInformationSources(
  p: { accountId: number; assetId: number }, rec?: T3ExecutionRecorder,
): Promise<PriceMaterialization | null> {
  try {
    const { materializeAcquisitionPrices } = await import('./store');
    const r = await materializeAcquisitionPrices(p);
    rec?.ok('INFORMATION_SOURCES', {
      recorded: r.recorded.length, withdrawn: r.withdrawn, skipped: r.skipped.length,
      skippedReasons: r.skipped.slice(0, 20), equipmentTargets: r.equipmentTargets,
    });
    return r;
  } catch (e) {
    if (await annule(e)) throw e;
    rec?.fail('INFORMATION_SOURCES', e);
    return null;
  }
}

interface CrossStepResult extends AcquisitionCrossResult {
  /** Décision du moteur remplacée par la décision croisée (pont « À traiter » : une décision par champ). */
  replaces: ReconciliationDecision | null;
}

/** Date d'achat ↔ agenda / Opérations, et colonnes miroirs (constats). */
export async function crossCheckAsset(p: {
  accountId: number; assetId: number; asset: CollectedAsset; kc: Record<string, unknown>;
  collected: readonly CollectedField[]; decisions: readonly ReconciliationDecision[];
}, rec?: T3ExecutionRecorder): Promise<CrossStepResult | null> {
  try {
    const store = await import('./store');
    const field = p.collected.find((f) => canonicalKeyOf(f.fieldKey) === 'acquisitionDate') ?? null;
    const engineDecision = p.decisions.find((d) => canonicalKeyOf(d.fieldKey) === 'acquisitionDate') ?? null;
    const [agenda, operations, etat] = await Promise.all([
      store.loadAgendaPurchases(p.accountId, p.assetId),
      store.loadAcquisitionOperations(p.accountId, p.assetId),
      store.readCheckState(p.accountId, p.assetId),
    ]);
    const res = crossCheckAcquisitionDate({
      current: p.asset.current('acquisitionDate'),
      evidenceSourceIds: field ? field.input.candidates.map((c) => c.sourceId) : [],
      observations: [...agenda, ...operations],
      engineDecision,
      arbitratedSignature: await store.arbitratedSignature(p.accountId, p.assetId, 'acquisitionDate', etat),
    });
    // Prix : constats seulement (le prix ancré est déjà une preuve du moteur).
    const prix = p.asset.current('acquisitionPrice');
    for (const o of operations) {
      if (o.amountEur == null) continue;
      const egal = prix?.value != null && sameCanonicalValue('acquisitionPrice', prix.value, o.amountEur);
      res.records.push({
        fieldKey: 'acquisitionPrice', value: o.amountEur, source: 'OPERATION', refId: o.id, confirmed: false,
        independent: !o.derivedFromField, sharedSourceFileIds: [],
        verdict: o.derivedFromField ? 'DERIVED_FROM_FIELD' : egal ? 'CONSISTENT' : 'OPERATION_NOT_RETAINED',
        contradiction: !o.derivedFromField && !egal && prix?.value != null,
      });
    }
    const famille = (await import('@/services/canonical/registry')).toAssetFamily(p.asset.category) ?? 'OBJECT';
    res.records.push(...mirrorDivergences({
      defs: listFields(famille), kc: p.kc, row: p.asset.row as Record<string, unknown>,
      fromColumn: (d, column) => {
        const col = (d.mirrorColumns ?? []).find((c) => c.column === column);
        return col ? fromMirrorColumn(col, (p.asset.row as Record<string, unknown>)[column]) : null;
      },
      same: sameCanonicalValue,
    }));
    const replaces = res.decision && engineDecision && (engineDecision.action === 'keep' || engineDecision.action === 'ignore')
      ? engineDecision : null;
    return { ...res, replaces };
  } catch (e) {
    if (await annule(e)) throw e;
    rec?.fail('INFORMATION_CROSS_CHECK', e);
    return null;
  }
}

/** Inventaire exhaustif (bien) — porté par le rapport T3. */
export function assetInventory(asset: CollectedAsset, decidedKeys: Iterable<string>) {
  const row = asset.row as Record<string, unknown>;
  return informationInventory({
    target: 'ASSET', category: asset.category, subtype: asset.subtype, current: asset.current,
    decided: new Set([...decidedKeys].map(canonicalKeyOf)),
    identity: { name: row.name ?? null, category: row.category ?? null, subtype: row.subtype ?? null, status: row.status ?? null },
  });
}

/** Synthèse chiffrée du contrôle (rapport, état 0597) — pure. */
export function checkSummary(rec: T3ExecutionRecorder): Record<string, number> {
  const inv = rec.inventory;
  const lignes = inv?.lines ?? [];
  const ecrits = rec.fields.filter((f) => f.outcome === 'written' && !f.error && !f.retraction);
  return {
    examined: lignes.filter((l) => l.status !== 'NOT_APPLICABLE').length + (inv?.identity.length ?? 0),
    notApplicable: lignes.filter((l) => l.status === 'NOT_APPLICABLE').length + (inv?.otherFamilyCount ?? 0),
    completed: ecrits.filter((f) => f.decision.action === 'apply').length,
    corrected: ecrits.filter((f) => f.decision.action === 'update').length,
    contradictions: rec.cross.filter((c) => c.contradiction).length
      + rec.fields.filter((f) => f.decision.action === 'create_conflict').length,
    arbitrations: rec.fields.filter((f) => f.decision.action === 'create_conflict').length,
    unverifiable: lignes.filter((l) => l.status === 'NO_EVIDENCE_EMPTY' || l.status === 'NO_EVIDENCE_FILLED').length,
    failures: rec.steps.filter((s) => s.status === 'FAILED').length + rec.fields.filter((f) => !!f.error).length,
  };
}

/**
 * Mémoire des arbitrages (lot 76J) : un conflit déjà PROPOSÉ puis TRANCHÉ
 * par l'utilisateur (carte du champ résolue depuis, aucune ouverte) n'est
 * jamais reproposé à l'identique — même valeur en place, même valeur
 * proposée, mêmes preuves. Un élément nouveau (preuve, valeur) change la
 * signature et rouvre un cycle. Avant : une valeur saisie conservée par
 * l'utilisateur revenait en carte à chaque passage.
 */
interface ConflictMemory {
  /** Décision rendue : conflit déjà tranché → conservation (ALREADY_DECIDED), sans carte. */
  filter(decision: ReconciliationDecision): Promise<ReconciliationDecision>;
  /** Signatures des conflits proposés pendant ce passage (état 0597). */
  readonly proposed: Record<string, string>;
}

const conflictSignature = (d: ReconciliationDecision): string =>
  crossSignatureOf(canonicalKeyOf(d.fieldKey), d.currentValue, d.proposedValue, d.evidenceIds);

const crossSignatureOf = (key: string, current: unknown, proposed: unknown, refs: number[]) =>
  `${key}|${current == null ? '' : JSON.stringify(current)}|${proposed == null ? '' : JSON.stringify(proposed)}|${[...refs].sort((a, b) => a - b).join(',')}`;

export async function loadConflictMemory(accountId: number, assetId: number, rec?: T3ExecutionRecorder): Promise<ConflictMemory> {
  const proposed: Record<string, string> = {};
  let etat: import('./store').CheckState | null = null;
  try {
    etat = await (await import('./store')).readCheckState(accountId, assetId);
  } catch (e) {
    if (await annule(e)) throw e;
    rec?.fail('INFORMATION_CHECK_STATE', e);
  }
  return {
    proposed,
    async filter(d) {
      if (d.action !== 'create_conflict') return d;
      const key = canonicalKeyOf(d.fieldKey);
      const sig = d.reasonCode === 'CONFIRMED_AGENDA_CONTRADICTION' ? null : conflictSignature(d);
      if (sig) proposed[key] = sig;
      if (!sig || !etat?.signatures[key] || etat.signatures[key].signature !== sig) return d;
      try {
        const tranche = await (await import('./store')).arbitratedSignature(accountId, assetId, key, etat);
        if (tranche !== sig) return d;
      } catch (e) {
        if (await annule(e)) throw e;
        return d;
      }
      delete proposed[key];
      return { ...d, action: 'keep', proposedValue: d.currentValue, reasonCode: 'ALREADY_DECIDED' };
    },
  };
}

/** Contrôle complet : état 0597 (version, synthèse, signatures d'arbitrage proposées). Ne lève jamais. */
export async function recordInformationCheck(p: {
  accountId: number; assetId: number; runId: number | null; rec: T3ExecutionRecorder; signatures: Record<string, string>;
}): Promise<void> {
  try {
    const { recordCheck } = await import('./store');
    await recordCheck({
      accountId: p.accountId, assetId: p.assetId, runId: p.runId, summary: checkSummary(p.rec), signatures: p.signatures,
    });
  } catch (e) {
    p.rec.fail('INFORMATION_CHECK_STATE', e);
  }
}
