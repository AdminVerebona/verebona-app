/**
 * Lot 75C (ticket T1 résiduels, point D) — alimentation DIRECTE des
 * attributs métier par T1, pour les seuls faits FIABLES.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Avant : T1 écrivait faits et preuves, la fiche n'était matérialisée que
 * par T3 (file différée). Une preuve dans `field_evidence` ne démontrait pas
 * que l'attribut avait été actualisé.
 *
 * Ici, après l'écriture des preuves et SANS appel IA, chaque fait :
 *   · canonique, de confiance « certain », lu (pas une observation visuelle),
 *   · dont la preuve vient d'être écrite par CE passage sur une cible
 *     VÉRIFIÉE (ASSET, EQUIPMENT ou ROOM — jamais une autre),
 *   · sans contradiction dans le document (une seule valeur pour la clé et
 *     la cible),
 * passe par le MÊME moteur de décision que T3 (`decide`, autorité, date,
 * champs critiques), sur les preuves actives de SA cible seulement. Il n'est
 * écrit que si la décision est déterministe (`apply` / `update`) et retient
 * la valeur de CE document — par la MÊME primitive d'écriture que T3
 * (origine RECONCILIATION, préséance USER/ADMIN sous verrou, miroirs,
 * journal), puis RELU (attribut ↔ fait ↔ preuve cohérents).
 *
 * Tout le reste est laissé à T3, qui reste programmé comme avant : conflit,
 * autre source plus autoritaire, valeur automatique devenue non prouvée,
 * revue IA, rapprochements incertains. Une valeur USER/ADMIN n'est jamais
 * remplacée. Les preuves d'un équipement ou d'une pièce ne sont jamais lues
 * pour le bien parent (collecte au niveau du bien : `ASSET_LEVEL`, lot 71A).
 *
 * Ne lève pas (sauf interruption de l'exécution) : une erreur est RENDUE par
 * attribut (`FAILED`) — étape secondaire du pipeline, T3 rattrape.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import type { ProjectedFact } from '../master/t1-contract';
import { projectedEvidenceKey } from './persist-evidence.step';
import { isExecutionCancelled } from '../../queue/execution-control';

export type AttributeOutcome = 'WRITTEN' | 'NOT_CONFIRMED' | 'ALREADY_SET' | 'PROTECTED' | 'DEFERRED_T3' | 'NOT_ELIGIBLE' | 'FAILED';

export interface AttributeProjection {
  fieldKey: string;
  targetType: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  entityId: number;
  value: unknown;
  evidenceIds: number[];
  outcome: AttributeOutcome;
  reasonCode: string;
  reason: string;
}

export interface ApplyReliableFactsInput {
  accountId: number;
  leadSourceId: number;
  facts: readonly ProjectedFact[];
  /** Preuves écrites par CE passage (`canonicalKey@TYPE:id` → id). */
  evidenceIds: ReadonlyMap<string, number>;
}

const REASON: Record<string, string> = {
  NOT_CERTAIN: 'Fait non certain : décision laissée à T3',
  VISUAL_ONLY: 'Observation visuelle : jamais appliquée seule',
  INTRA_DOCUMENT_CONFLICT: 'Valeurs contradictoires dans le document : arbitrage T3',
  NOT_APPLICABLE: 'Champ sans objet pour cette cible (registre, famille, saisie seule)',
  TARGET_NOT_FOUND: 'Cible introuvable ou archivée',
  UNPROVEN_CURRENT: 'Valeur automatique en place devenue non prouvée : réconciliation négative T3',
  OTHER_SOURCE_WINS: 'Une autre source fait autorité sur ce champ : T3',
  SAME_VALUE: 'Valeur déjà en place',
  USER_VALUE_PROTECTED: 'Valeur saisie par l’utilisateur : jamais remplacée',
};

const groupKey = (f: ProjectedFact) => `${f.canonicalKey}@${f.target.targetType}:${f.target.targetEntityId}`;

/** Faits de CE passage dont la preuve est écrite, regroupés par clé et cible (pure). */
export function reliableCandidates(p: Pick<ApplyReliableFactsInput, 'facts' | 'evidenceIds'>): Array<{
  key: string; type: 'ASSET' | 'EQUIPMENT' | 'ROOM'; entityId: number; facts: ProjectedFact[]; evidenceIds: number[];
  eligible: boolean; reasonCode: string | null;
}> {
  const groupes = new Map<string, ProjectedFact[]>();
  for (const f of p.facts) {
    if (!f.canonicalKey || f.target.targetEntityId == null) continue;
    const t = f.target.targetType;
    if (t !== 'ASSET' && t !== 'EQUIPMENT' && t !== 'ROOM') continue;
    if (!p.evidenceIds.has(projectedEvidenceKey(f.canonicalKey, t, f.target.targetEntityId))) continue;
    const k = groupKey(f);
    groupes.set(k, [...(groupes.get(k) ?? []), f]);
  }
  return [...groupes.values()].map((facts) => {
    const f = facts[0];
    const type = f.target.targetType as 'ASSET' | 'EQUIPMENT' | 'ROOM';
    const entityId = f.target.targetEntityId as number;
    const evidenceId = p.evidenceIds.get(projectedEvidenceKey(f.canonicalKey!, type, entityId))!;
    const valeurs = new Set(facts.map((x) => JSON.stringify(x.value)));
    const reasonCode = facts.some((x) => x.provenance === 'VISUAL_ANALYSIS') ? 'VISUAL_ONLY'
      : facts.some((x) => x.confidence !== 'certain') ? 'NOT_CERTAIN'
        : valeurs.size > 1 ? 'INTRA_DOCUMENT_CONFLICT' : null;
    return { key: f.canonicalKey!, type, entityId, facts, evidenceIds: [evidenceId], eligible: reasonCode === null, reasonCode };
  });
}

/** Alimente les attributs métier des faits fiables (voir l'en-tête). */
export async function applyReliableFacts(p: ApplyReliableFactsInput): Promise<AttributeProjection[]> {
  const out: AttributeProjection[] = [];
  const candidats = reliableCandidates(p);
  if (candidats.length === 0) return out;

  const [{ decide }, { normalize }, collector, { applyDecision }, entityState, { getActiveEntityEvidence }, { entityCurrentValue }, { getCanonicalAssetState }, { isCriticalField }, { assertJobActive }] = await Promise.all([
    import('../../reconciliation/decision/decision-matrix'),
    import('../../reconciliation/decision/normalizers'),
    import('../../reconciliation/evidence-collector'),
    import('../../reconciliation/apply-decision'),
    import('@/services/canonical/entity-state'),
    import('../../evidence/entity-evidence'),
    import('../../reconciliation/entity-reconciliation'),
    import('@/services/canonical/asset-state'),
    import('../../reconciliation/decision/critical-fields'),
    import('../../queue/execution-control'),
  ]);
  const traceId = randomUUID();
  const etatsBiens = new Map<number, Awaited<ReturnType<typeof collector.collectAssetEvidenceState>>>();

  for (const c of candidats) {
    const value = c.facts[0].value;
    const ligne = (outcome: AttributeOutcome, reasonCode: string, reason?: string): AttributeProjection => ({
      fieldKey: c.key, targetType: c.type, entityId: c.entityId, value, evidenceIds: c.evidenceIds, outcome, reasonCode,
      reason: reason ?? REASON[reasonCode] ?? reasonCode,
    });
    if (!c.eligible) { out.push(ligne('NOT_ELIGIBLE', c.reasonCode!)); continue; }
    try {
      // ── Décision : même moteur que T3, preuves actives de LA cible seulement ──
      let input: import('../../reconciliation/types').DecisionInput;
      let unproven = false;
      if (c.type === 'ASSET') {
        let etat = etatsBiens.get(c.entityId);
        if (!etat) { etat = await collector.collectAssetEvidenceState(p.accountId, c.entityId); etatsBiens.set(c.entityId, etat); }
        if (!etat.kc) { out.push(ligne('NOT_ELIGIBLE', 'TARGET_NOT_FOUND')); continue; }
        const champ = etat.fields.find((x) => x.fieldKey === c.key);
        if (!champ) { out.push(ligne('NOT_ELIGIBLE', 'NOT_APPLICABLE')); continue; }
        input = champ.input;
        unproven = champ.unproven;
      } else {
        const target = { type: c.type, id: c.entityId } as const;
        const state = await entityState.getCanonicalEntityState(target, p.accountId);
        if (!state || state.archived) { out.push(ligne('NOT_ELIGIBLE', 'TARGET_NOT_FOUND')); continue; }
        const def = entityState.resolveEntityDef(c.key);
        if (!def || !entityState.fieldTargetsEntity(def, c.type) || def.inputOnly) { out.push(ligne('NOT_ELIGIBLE', 'NOT_APPLICABLE')); continue; }
        const candidates = collector.toEvidenceCandidates(def.key, await getActiveEntityEvidence(p.accountId, target, def.key));
        const current = entityCurrentValue(state, def.key);
        unproven = collector.isUnprovenAutomaticValue(current, candidates);
        input = { fieldKey: def.key, current, candidates, isCritical: isCriticalField(def.key) };
      }
      const current = input.current;
      const notreValeur = normalize(c.key, value);
      if (current && (current.origin === 'USER' || current.origin === 'ADMIN')) {
        out.push(ligne(current.normalized === notreValeur ? 'ALREADY_SET' : 'PROTECTED', current.normalized === notreValeur ? 'SAME_VALUE' : 'USER_VALUE_PROTECTED'));
        continue;
      }
      if (unproven) { out.push(ligne('DEFERRED_T3', 'UNPROVEN_CURRENT')); continue; }
      const decision = decide(input);
      if (decision.action !== 'apply' && decision.action !== 'update') {
        out.push(decision.action === 'keep' && current?.normalized === notreValeur
          ? ligne('ALREADY_SET', 'SAME_VALUE')
          : ligne('DEFERRED_T3', decision.reasonCode, `Décision « ${decision.action} » (${decision.reasonCode}) : laissée à T3`));
        continue;
      }
      if (!decision.deterministic || normalize(c.key, decision.proposedValue) !== notreValeur) {
        out.push(ligne('DEFERRED_T3', 'OTHER_SOURCE_WINS'));
        continue;
      }

      // ── Écriture : même primitive que T3 (préséance USER/ADMIN sous verrou) ──
      await assertJobActive(`attribut ${c.key}`);
      let issue: string;
      if (c.type === 'ASSET') {
        issue = await applyDecision(decision, {
          accountId: p.accountId, assetId: c.entityId, sourceFileId: p.leadSourceId, traceId,
          bestCandidate: input.candidates.find((x) => x.evidenceId === decision.evidenceIds[0]),
        });
      } else {
        const best = input.candidates.find((x) => x.evidenceId === decision.evidenceIds[0]);
        const res = await entityState.writeCanonicalEntityFields({
          target: { type: c.type, id: c.entityId }, accountId: p.accountId, origin: 'RECONCILIATION',
          source: { type: 'document', id: p.leadSourceId }, traceId,
          writes: [{
            key: c.key, value: decision.proposedValue, expectedCurrent: decision.currentValue ?? null,
            trace: {
              evidenceId: decision.evidenceIds[0] ?? null, decisionType: decision.action, reasonCode: decision.reasonCode,
              confidence: decision.confidence, authority: decision.sourcePriority ?? 0,
              sourceDate: best?.documentDate ? new Date(best.documentDate).toISOString() : null,
            },
          }],
        });
        issue = res.fields[0]?.outcome ?? 'skipped';
      }
      if (issue === 'protected') { out.push(ligne('PROTECTED', 'USER_VALUE_PROTECTED')); continue; }
      if (issue === 'unchanged') { out.push(ligne('ALREADY_SET', 'SAME_VALUE')); continue; }
      if (issue !== 'written') {
        out.push(ligne('DEFERRED_T3', `WRITE_${String(issue).toUpperCase()}`, `Écriture non appliquée (${issue}) : laissée à T3`));
        continue;
      }
      // ── Point de contrôle : l'attribut RELU porte la valeur du fait ──
      const relu = c.type === 'ASSET'
        ? (await getCanonicalAssetState(c.entityId, p.accountId))?.fields[c.key]?.value
        : (await entityState.getCanonicalEntityState({ type: c.type, id: c.entityId }, p.accountId))?.fields[c.key]?.value;
      out.push(normalize(c.key, relu) === notreValeur
        ? ligne('WRITTEN', decision.reasonCode, `Attribut écrit par T1 (${decision.reasonCode}) et relu`)
        : ligne('NOT_CONFIRMED', 'READBACK_MISMATCH', 'Écriture déclarée, valeur relue différente'));
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      out.push(ligne('FAILED', 'WRITE_ERROR', `Écriture de l’attribut en échec : ${((e as Error)?.message ?? String(e)).slice(0, 300)}`));
    }
  }
  return out;
}
