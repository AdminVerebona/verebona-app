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
 * Lot 16b-3 : commutateurs `CANONICAL_WRITE_MODE`, `T3_NEGATIVE_RECONCILIATION`
 * et drapeau `AI_RECONCILIATION_ENGINE` supprimés — écritures et retraits
 * toujours appliqués (comportement de l'ancien `enabled`), sans observation.
 *
 * Pas d'appel modèle (`request_ai_review` reste sans effet). Conflit :
 * carte « À traiter » (ENTITY-FIELD pour un équipement, ENTITY-FIELD-ROOM
 * pour une pièce), comme le conflit de champ d'un bien
 * (`entity-field-cards`) ; une décision tranchée rend la carte du champ sans
 * objet. Équipement archivé : ignoré.
 */
import { randomUUID } from 'crypto';
import { decide } from './decision/decision-matrix';
import { isCriticalField } from './decision/critical-fields';
import { normalize } from './decision/normalizers';
import { toEvidenceCandidates, isUnprovenAutomaticValue } from './evidence-collector';
import {
  planRetractions, retractionDecision, withoutStaleAuthority, NEGATIVE_REASON, isT4DateRevision, T4_REVISION_REASON,
} from './negative-reconciliation';
import {
  fieldTargetsEntity, resolveEntityDef, type CanonicalEntityState, type CanonicalEntityTarget,
} from '@/services/canonical/entity-state';
import type { CurrentValue, ReconciliationDecision } from './types';
import { assertJobActive } from '../queue/execution-control';

export interface ReconcileEntityInput {
  accountId: number;
  target: CanonicalEntityTarget;
  userId?: number | null;
  sourceFileId?: number | null;
  triggeredBy: 'document_analyzed' | 'document_linked' | 'manual';
}

export interface ReconcileEntityResult {
  target: CanonicalEntityTarget;
  /** Entité introuvable ou archivée : rien n'a été fait. */
  skipped: boolean;
  decisions: ReconciliationDecision[];
  /** Clés écrites, par issue. */
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
  /** Décisions → cartes « À traiter » (conflits ouverts, cartes devenues sans objet). */
  syncCards: (p: { accountId: number; target: CanonicalEntityTarget; entityName: string | null; decisions: ReconciliationDecision[] }) => Promise<unknown>;
}

async function defaultDeps(): Promise<EntityReconcileDeps> {
  const [es, ee] = await Promise.all([
    import('@/services/canonical/entity-state'),
    import('../evidence/entity-evidence'),
  ]);
  return {
    loadState: (a, t) => es.getCanonicalEntityState(t, a),
    evidenceKeys: (a, t) => ee.listEntityEvidenceKeys(a, t),
    activeEvidence: (a, k, t) => ee.getActiveEntityEvidence(a, t, k),
    retiredValues: (a, t) => ee.listRetiredEntityEvidenceValues(a, t),
    write: es.writeCanonicalEntityFields,
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

export async function reconcileEntity(input: ReconcileEntityInput, deps?: EntityReconcileDeps): Promise<ReconcileEntityResult> {
  const vide = (skipped = true): ReconcileEntityResult => ({
    target: input.target, skipped, decisions: [], written: [], retracted: [], protectedKeys: [],
  });
  const d = deps ?? await defaultDeps();

  const state = await d.loadState(input.accountId, input.target);
  if (!state || state.archived) return vide();
  const out = vide(false);
  const traceId = randomUUID();
  const source = input.sourceFileId ? { type: 'document', id: input.sourceFileId } : { type: 'reconciliation', id: traceId };

  const keys = await d.evidenceKeys(input.accountId, input.target);
  const prouves: string[] = [];
  for (const rawKey of keys) {
    const def = resolveEntityDef(rawKey);
    // Champ hors registre ou d'une autre cible : jamais appliqué à l'entité.
    // Champ de saisie seule (D-D, lot 20) : jamais réconcilié depuis une preuve.
    if (!def || !fieldTargetsEntity(def, input.target.type) || def.inputOnly) continue;
    const evidences = await d.activeEvidence(input.accountId, rawKey, input.target);
    const candidates = toEvidenceCandidates(def.key, evidences);
    if (candidates.length) prouves.push(def.key);
    const current = entityCurrentValue(state, def.key);
    const unproven = isUnprovenAutomaticValue(current, candidates);
    const entree = { fieldKey: def.key, current, candidates, isCritical: isCriticalField(def.key) };
    // D-M (lot 20) : date tranchée par T4 → la preuve révisée corrige la valeur automatique.
    const revision = isT4DateRevision(unproven, entree);
    let decision = unproven || revision ? decide(withoutStaleAuthority(entree)) : decide(entree);
    if (revision && decision.action === 'update') decision = { ...decision, reasonCode: T4_REVISION_REASON };
    else if (unproven && decision.action === 'update') decision = { ...decision, reasonCode: NEGATIVE_REASON.REPLACE };
    out.decisions.push(decision);
    if (decision.action !== 'apply' && decision.action !== 'update') continue;

    const best = candidates.find((c) => c.evidenceId === decision.evidenceIds[0]);
    // Lot 31C : garde avant écriture (sans effet hors file).
    await assertJobActive(`valeur ${def.key}`);
    const res = await d.write({
      target: input.target, accountId: input.accountId, origin: 'RECONCILIATION', source, traceId,
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
  {
    const retirees = await d.retiredValues(input.accountId, input.target);
    const kcVals: Record<string, unknown> = { ...state.kc };
    for (const r of planRetractions(kcVals, prouves, retirees)) {
      await assertJobActive(`retrait ${r.fieldKey}`);
      const res = await d.write({
        target: input.target, accountId: input.accountId, origin: 'RECONCILIATION',
        source: { type: 'reconciliation', id: traceId }, traceId,
        writes: [{ key: r.fieldKey, value: null, expectedCurrent: r.currentValue,
          trace: { decisionType: 'update', reasonCode: NEGATIVE_REASON.RETRACT, confidence: 'certain', authority: null, sourceDate: null } }],
      });
      if (res.fields[0]?.outcome === 'written') {
        out.retracted.push(r.fieldKey);
        out.decisions.push(retractionDecision(r));
      }
    }
  }

  // « À traiter » : conflits ouverts, cartes devenues sans objet.
  if (out.decisions.length) {
    await assertJobActive('cartes « À traiter »');
    await d.syncCards({ accountId: input.accountId, target: input.target, entityName: state.name, decisions: out.decisions })
      .catch((e: Error) => console.error(`[reconciliation] cartes de ${input.target.type} ${input.target.id} :`, e.message));
  }

  console.info(JSON.stringify({
    event: 't3.entity_reconciliation', accountId: input.accountId, target: input.target, assetId: state.assetId,
    triggeredBy: input.triggeredBy, traceId,
    // Jamais de valeur dans le journal : clés et motifs.
    decisions: out.decisions.map((x) => ({ fieldKey: x.fieldKey, action: x.action, reasonCode: x.reasonCode })),
    written: out.written, retracted: out.retracted, protected: out.protectedKeys,
    conflicts: out.decisions.filter((x) => x.action === 'create_conflict').map((x) => x.fieldKey),
  }));
  return out;
}
