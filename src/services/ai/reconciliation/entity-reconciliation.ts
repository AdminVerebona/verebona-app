/**
 * Réconciliation T3 CIBLÉE — valeurs lues pour un ÉQUIPEMENT ou une PIÈCE
 * appliquées à leur fiche (CDC 15 T1-04, T3-01, T3-04 ; lot 18, volet R3).
 *
 * Même moteur que pour un bien, sur la fiche de l'entité :
 *   · preuves de la CIBLE seulement (`target_type` / `target_entity_id`,
 *     cycle de vie ACTIVE, `status = 'active'`) — jamais celles du bien ;
 *     lues par cible et COMPTE, sans filtre sur `asset_id` : un équipement
 *     déplacé vers un autre bien garde ses preuves (l'entité, elle, est
 *     contrôlée par son bien parent ACTUEL) ;
 *   · matrice de décision identique (`decide`, autorité, date, champs
 *     critiques), candidats construits comme pour un bien ;
 *   · application par `writeCanonicalEntityFields` (origine RECONCILIATION,
 *     contrôle optimiste, préséance USER/ADMIN sous verrou, miroirs, journal) ;
 *   · phase négative du lot 13 (T3-04) : valeur automatique dont la dernière
 *     preuve a disparu → retirée ; preuve remplacée → la meilleure preuve
 *     restante l'emporte (`withoutStaleAuthority`).
 *
 * Commutateurs :
 *   CANONICAL_WRITE_MODE        legacy : aucune écriture (aucune requête si
 *                               le négatif est aussi legacy) ; shadow : journal
 *                               `dry_run` ; enabled : écriture ;
 *   T3_NEGATIVE_RECONCILIATION  même règle pour les RETRAITS ;
 *   AI_RECONCILIATION_ENGINE    moteur en observation → au plus `shadow`.
 *
 * Pas d'appel modèle (`request_ai_review` reste sans effet). Conflit :
 * carte « À traiter » (ENTITY-FIELD pour un équipement, ENTITY-FIELD-ROOM
 * pour une pièce), comme le conflit de champ d'un bien
 * (`entity-field-cards`), seulement quand l'écriture est effective (mode
 * `enabled`, moteur hors observation) ; une décision tranchée rend la carte
 * du champ sans objet. Équipement archivé : ignoré.
 */
import { randomUUID } from 'crypto';
import { decide } from './decision/decision-matrix';
import { isCriticalField } from './decision/critical-fields';
import { normalize } from './decision/normalizers';
import { toEvidenceCandidates, isUnprovenAutomaticValue } from './evidence-collector';
import { planRetractions, retractionDecision, withoutStaleAuthority, NEGATIVE_REASON } from './negative-reconciliation';
import { canonicalWriteMode, t3NegativeMode, type RolloutMode } from '@/services/canonical/rollout';
import {
  fieldTargetsEntity, resolveEntityDef, type CanonicalEntityState, type CanonicalEntityTarget,
} from '@/services/canonical/entity-state';
import type { CurrentValue, ReconciliationDecision } from './types';

export interface ReconcileEntityInput {
  accountId: number;
  target: CanonicalEntityTarget;
  userId?: number | null;
  sourceFileId?: number | null;
  triggeredBy: 'document_analyzed' | 'document_linked' | 'manual';
  /** Force l'observation (moteur en shadow). */
  forceShadow?: boolean;
}

export interface ReconcileEntityResult {
  target: CanonicalEntityTarget;
  skipped: boolean;
  applyMode: RolloutMode;
  retractMode: RolloutMode;
  decisions: ReconciliationDecision[];
  /** Clés écrites (enabled) ou qui le seraient (shadow), par issue. */
  written: string[];
  retracted: string[];
  protectedKeys: string[];
}

/** Dépendances (tests) — défaut : base, registre, primitive. */
export interface EntityReconcileDeps {
  loadState: (accountId: number, target: CanonicalEntityTarget) => Promise<CanonicalEntityState | null>;
  evidenceKeys: (accountId: number, target: CanonicalEntityTarget) => Promise<string[]>;
  /** Preuves actives de la CIBLE (par cible et compte, sans filtre sur le bien porteur). */
  activeEvidence: (accountId: number, key: string, target: CanonicalEntityTarget)
    => Promise<import('../evidence/evidence.types').FieldEvidence[]>;
  retiredValues: (accountId: number, target: CanonicalEntityTarget) => Promise<Array<{ fieldKey: string; value: unknown }>>;
  write: typeof import('@/services/canonical/entity-state').writeCanonicalEntityFields;
  engineShadow: () => boolean;
  /** Décisions → cartes « À traiter » (conflits ouverts, cartes devenues sans objet). */
  syncCards: (p: { accountId: number; target: CanonicalEntityTarget; entityName: string | null; decisions: ReconciliationDecision[] }) => Promise<unknown>;
}

async function defaultDeps(): Promise<EntityReconcileDeps> {
  const [es, ee, flags] = await Promise.all([
    import('@/services/canonical/entity-state'),
    import('../evidence/entity-evidence'),
    import('../flags/ai-feature-flags'),
  ]);
  return {
    loadState: (a, t) => es.getCanonicalEntityState(t, a),
    evidenceKeys: (a, t) => ee.listEntityEvidenceKeys(a, t),
    activeEvidence: (a, k, t) => ee.getActiveEntityEvidence(a, t, k),
    retiredValues: (a, t) => ee.listRetiredEntityEvidenceValues(a, t),
    write: es.writeCanonicalEntityFields,
    engineShadow: () => !flags.shouldWrite('AI_RECONCILIATION_ENGINE'),
    syncCards: async (p) => (await import('@/services/to-process/entity-field-cards')).syncEntityFieldCards(p),
  };
}

const parseDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Valeur en place d'une entité, au format du moteur (pure). */
export function entityCurrentValue(state: CanonicalEntityState, key: string): CurrentValue | null {
  const f = state.fields[key];
  if (!f) return null;
  const kc = state.kc;
  return {
    value: f.value,
    normalized: normalize(key, f.value),
    origin: f.origin,
    updatedAt: parseDate(kc[`${key}__updatedAt`]),
    authorityScore: typeof kc[`${key}__authority`] === 'number' ? kc[`${key}__authority`] as number : undefined,
    sourceDate: parseDate(kc[`${key}__sourceDate`]),
  };
}

/** Modes effectifs (pure) : moteur en observation → au plus `shadow`. */
export function entityModes(write: RolloutMode, negative: RolloutMode, engineShadow: boolean): { apply: RolloutMode; retract: RolloutMode } {
  const borne = (m: RolloutMode): RolloutMode => (m === 'legacy' ? 'legacy' : engineShadow ? 'shadow' : m);
  return { apply: borne(write), retract: borne(negative) };
}

export async function reconcileEntity(input: ReconcileEntityInput, deps?: EntityReconcileDeps): Promise<ReconcileEntityResult> {
  const vide = (apply: RolloutMode, retract: RolloutMode, skipped = true): ReconcileEntityResult => ({
    target: input.target, skipped, applyMode: apply, retractMode: retract, decisions: [], written: [], retracted: [], protectedKeys: [],
  });
  const writeMode = canonicalWriteMode();
  const negMode = t3NegativeMode();
  // Legacy des deux côtés : rien, AUCUNE requête.
  if (writeMode === 'legacy' && negMode === 'legacy') return vide('legacy', 'legacy');
  const d = deps ?? await defaultDeps();
  const modes = entityModes(writeMode, negMode, input.forceShadow === true || d.engineShadow());

  const state = await d.loadState(input.accountId, input.target);
  if (!state || state.archived) return vide(modes.apply, modes.retract);
  const out = vide(modes.apply, modes.retract, false);
  const traceId = randomUUID();
  const source = input.sourceFileId ? { type: 'document', id: input.sourceFileId } : { type: 'reconciliation', id: traceId };
  const negEnabled = modes.retract === 'enabled';

  const keys = await d.evidenceKeys(input.accountId, input.target);
  const prouves: string[] = [];
  for (const rawKey of keys) {
    const def = resolveEntityDef(rawKey);
    // Champ hors registre ou d'une autre cible : jamais appliqué à l'entité.
    if (!def || !fieldTargetsEntity(def, input.target.type)) continue;
    const evidences = await d.activeEvidence(input.accountId, rawKey, input.target);
    const candidates = toEvidenceCandidates(def.key, evidences);
    if (candidates.length) prouves.push(def.key);
    const current = entityCurrentValue(state, def.key);
    const unproven = isUnprovenAutomaticValue(current, candidates);
    const entree = { fieldKey: def.key, current, candidates, isCritical: isCriticalField(def.key) };
    let decision = unproven && negEnabled ? decide(withoutStaleAuthority(entree)) : decide(entree);
    if (unproven && negEnabled && decision.action === 'update') decision = { ...decision, reasonCode: NEGATIVE_REASON.REPLACE };
    out.decisions.push(decision);
    if ((decision.action !== 'apply' && decision.action !== 'update') || modes.apply === 'legacy') continue;

    const best = candidates.find((c) => c.evidenceId === decision.evidenceIds[0]);
    const res = await d.write({
      target: input.target, accountId: input.accountId, origin: 'RECONCILIATION', mode: modes.apply, source, traceId,
      writes: [{
        key: def.key, value: decision.proposedValue, expectedCurrent: decision.currentValue ?? null,
        trace: {
          evidenceId: decision.evidenceIds[0] ?? null, decisionType: decision.action, reasonCode: decision.reasonCode,
          confidence: decision.confidence, authority: decision.sourcePriority ?? 0,
          sourceDate: best?.documentDate ? new Date(best.documentDate).toISOString() : null,
        },
      }],
    });
    const f = res.fields[0];
    if (f?.outcome === 'written') out.written.push(def.key);
    else if (f?.outcome === 'protected') out.protectedKeys.push(def.key);
  }

  // Phase négative (T3-04) : valeur automatique dont la dernière preuve a disparu.
  if (modes.retract !== 'legacy') {
    const retirees = await d.retiredValues(input.accountId, input.target);
    const kcVals: Record<string, unknown> = { ...state.kc };
    for (const r of planRetractions(kcVals, prouves, retirees)) {
      const res = await d.write({
        target: input.target, accountId: input.accountId, origin: 'RECONCILIATION', mode: modes.retract,
        source: { type: 'reconciliation', id: traceId }, traceId,
        writes: [{ key: r.fieldKey, value: null, expectedCurrent: r.currentValue,
          trace: { decisionType: 'update', reasonCode: NEGATIVE_REASON.RETRACT, confidence: 'certain', authority: null, sourceDate: null } }],
      });
      if (res.fields[0]?.outcome === 'written') {
        out.retracted.push(r.fieldKey);
        out.decisions.push(retractionDecision(r, modes.retract !== 'enabled'));
      }
    }
  }

  // « À traiter » : seulement si les décisions sont réellement écrites.
  if (modes.apply === 'enabled' && out.decisions.length) {
    await d.syncCards({ accountId: input.accountId, target: input.target, entityName: state.name, decisions: out.decisions })
      .catch((e: Error) => console.error(`[reconciliation] cartes de ${input.target.type} ${input.target.id} :`, e.message));
  }

  console.info(JSON.stringify({
    event: 't3.entity_reconciliation', accountId: input.accountId, target: input.target, assetId: state.assetId,
    applyMode: modes.apply, retractMode: modes.retract, triggeredBy: input.triggeredBy, traceId,
    // Jamais de valeur dans le journal : clés et motifs.
    decisions: out.decisions.map((x) => ({ fieldKey: x.fieldKey, action: x.action, reasonCode: x.reasonCode })),
    written: out.written, retracted: out.retracted, protected: out.protectedKeys,
    conflicts: out.decisions.filter((x) => x.action === 'create_conflict').map((x) => x.fieldKey),
  }));
  return out;
}
