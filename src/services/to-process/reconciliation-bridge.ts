/**
 * Pont réconciliation → « À traiter » V2. CDC V2.0 §11.1, §10.5, §14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN PONT, PAS UN SECOND MOTEUR
 *
 * Le §11.1 ne laisse aucune latitude : « Le chantier ne crée pas un traitement
 * IA supplémentaire. Les règles de ce CDC sont intégrées au traitement
 * existant de réconciliation / optimisation des données. »
 *
 * Le moteur `ai/reconciliation` produit déjà des décisions par champ, avec
 * preuves et autorité de source. Ce module ne refait pas ce travail : il
 * traduit ces décisions en mouvements de file V2. Réanalyser les mêmes champs
 * avec `decide()` produirait deux verdicts sur la même donnée, et le jour où
 * ils divergeraient, personne ne saurait lequel fait foi.
 *
 * ── LE FILTRE DU CATALOGUE EST LE CŒUR DU MODULE ──────────────────────────
 *
 * Le moteur de réconciliation travaille sur TOUS les champs d'un bien. Le
 * principe P-06 interdit qu'ils remplissent tous « À traiter » : « une règle
 * métier explicite doit justifier À compléter ».
 *
 * Un champ absent du catalogue §10 ne produit donc aucune action, quelle que
 * soit la décision du moteur. Sans ce filtre, la première exécution sur un
 * compte fourni déverserait des dizaines de cartes sur des champs descriptifs
 * que personne ne renseignera jamais — et la file deviendrait inutilisable
 * exactement au moment où elle devait servir.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { EvidenceConfidence } from '@/services/ai/evidence/evidence.types';
import type {
  ReconciliationAction,
  ReconciliationDecision,
} from '@/services/ai/reconciliation/types';
import type { ActionKind, ActionProposal } from './action-model';
import { findRule } from './rules-catalog';
import { resolveActionsForData, upsertAction } from './to-process-action.service';

/**
 * Conversion confiance qualitative → score.
 *
 * Les trois niveaux du moteur existant sont volontairement grossiers : un
 * modèle qui annonce « 0,87 » invente une précision qu'il n'a pas. Mais le
 * §11.2 raisonne sur un seuil de 90 %, et il faut bien situer les niveaux par
 * rapport à lui.
 *
 * `certain` = 1 passe le seuil, `probable` = 0,6 ne le passe pas. C'est le
 * comportement attendu : une valeur seulement probable n'est pas écrite, elle
 * est proposée. La table reprend celle déjà employée par le pipeline
 * d'analyse — deux conversions différentes pour la même échelle feraient
 * diverger les décisions selon le chemin emprunté.
 */
export function confidenceToScore(confidence: EvidenceConfidence): number {
  if (confidence === 'certain') return 1;
  if (confidence === 'probable') return 0.6;
  return 0.3;
}

export interface ActionIntent {
  kind: 'UPSERT' | 'RESOLVE';
  fieldKey: string;
  ruleCode: string;
  actionKind?: ActionKind;
  proposals?: ActionProposal[];
  reason: string;
}

/**
 * Traduit une décision de réconciliation en intention de file.
 *
 * Fonction pure : les six actions du moteur existant deviennent une table de
 * vérité testable, plutôt qu'un `switch` enfoui dans un service qui touche la
 * base.
 */
export function mapReconciliationDecision(
  decision: ReconciliationDecision,
): ActionIntent | null {
  const rule = findRule('ASSET', decision.fieldKey);
  if (!rule) return null; // P-06 : pas de règle, pas d'action.

  const action: ReconciliationAction = decision.action;

  switch (action) {
    case 'create_conflict': {
      const proposals: ActionProposal[] = [
        {
          value: normalize(decision.proposedValue),
          label: String(decision.proposedValue ?? ''),
          confidence: confidenceToScore(decision.confidence),
          evidenceIds: decision.evidenceIds.map(String),
        },
      ];
      // La valeur en place est jointe pour pouvoir être confirmée (§8.5).
      if (decision.currentValue !== null && decision.currentValue !== undefined) {
        proposals.push({
          value: normalize(decision.currentValue),
          label: String(decision.currentValue),
          confidence: 1,
          isCurrentValue: true,
        });
      }
      return {
        kind: 'UPSERT',
        fieldKey: decision.fieldKey,
        ruleCode: rule.code,
        actionKind: 'ARBITRATE',
        proposals,
        reason: decision.reasonCode,
      };
    }

    case 'ignore': {
      // Aucune preuve exploitable. Le §10.1 ne crée une complétion que si une
      // règle rend la donnée attendue — et seulement si elle est VIDE.
      if (decision.currentValue !== null && decision.currentValue !== undefined) return null;
      if (rule.completePriority === null) return null;
      return {
        kind: 'UPSERT',
        fieldKey: decision.fieldKey,
        ruleCode: rule.code,
        actionKind: 'COMPLETE',
        proposals: [],
        reason: decision.reasonCode,
      };
    }

    case 'apply':
    case 'update':
    case 'keep':
      // La donnée est désormais tranchée : l'action qui la réclamait n'a plus
      // d'objet (§7.3, « problème devenu sans objet »).
      return {
        kind: 'RESOLVE',
        fieldKey: decision.fieldKey,
        ruleCode: rule.code,
        reason: decision.reasonCode,
      };

    case 'request_ai_review':
      // Décision non aboutie : ni carte, ni fermeture. Une action créée ici
      // serait remplacée dès que l'arbitrage modèle aura tranché, et
      // l'utilisateur aurait vu passer une question qui ne le concernait pas.
      return null;
  }
}

export interface SyncReconciliationInput {
  accountId: number;
  assetId: number;
  decisions: readonly ReconciliationDecision[];
}

export interface SyncReconciliationResult {
  created: number;
  resolved: number;
  skipped: number;
}

/**
 * Applique les intentions à la file.
 *
 * Aucune exception ne remonte : la réconciliation a fait son travail et ses
 * décisions sont écrites. Une carte manquée se rattrape au passage suivant ;
 * une exécution de réconciliation perdue, non.
 */
export async function syncReconciliationToProcess(
  input: SyncReconciliationInput,
): Promise<SyncReconciliationResult> {
  const result: SyncReconciliationResult = { created: 0, resolved: 0, skipped: 0 };

  for (const decision of input.decisions) {
    const intent = mapReconciliationDecision(decision);
    if (!intent) {
      result.skipped += 1;
      continue;
    }

    try {
      if (intent.kind === 'RESOLVE') {
        const closed = await resolveActionsForData(
          input.accountId,
          'ASSET',
          input.assetId,
          intent.fieldKey,
          'OBSOLETE',
        );
        result.resolved += closed;
        continue;
      }

      const upserted = await upsertAction({
        accountId: input.accountId,
        targetType: 'ASSET',
        targetId: input.assetId,
        fieldKey: intent.fieldKey,
        actionKind: intent.actionKind!,
        ruleCode: intent.ruleCode,
        proposals: intent.proposals,
      });
      if (upserted.status === 'CREATED') result.created += 1;
      else if (upserted.status === 'SKIPPED') result.skipped += 1;
    } catch (e) {
      result.skipped += 1;
      console.error(
        `[to-process] synchronisation du champ ${intent.fieldKey} impossible :`,
        (e as Error).message,
      );
    }
  }

  return result;
}

function normalize(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}
