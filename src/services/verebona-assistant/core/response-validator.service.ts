/**
 * Validateur de sortie serveur — CDC §18.4 / §18.5 / §18.6.
 *
 * Vérifie systématiquement la sortie du modèle AVANT tout affichage. En cas d'échec,
 * une SEULE tentative de réparation est autorisée (§18.6) ; au second échec, l'orchestrateur
 * bascule en repli déterministe (§30.3).
 *
 * Les 10 points de contrôle (§18.4) :
 *   1. conformité au schéma (Zod, fait en amont) ;
 *   2. intention ∈ catalogue fermé ;
 *   3. types d'actions ∈ catalogue fermé ;
 *   4. tout id d'action référence une entité fournie au contexte ;
 *   5. tout sourceId de claim référence une source fournie ;
 *   6. réponse « supported » => ≥ 1 claim ;
 *   7. aucune URL/텍ste libre injecté comme action ;
 *   8. longueur de réponse bornée ;
 *   9. clarification bien formée si présente ;
 *  10. cohérence intention ↔ actions autorisées.
 */
import type { AssistantModelOutput } from '../types/contracts';
import type { RetrievedSource } from '../types/sources';
import { isVerebonaIntent } from '../types/intents';
import { isVerebonaActionType } from '../types/actions';
import { allowedActionsFor } from '../registries/action-registry';

export interface ValidationContext {
  /** Sources réellement fournies au modèle (ids autorisés à être cités). */
  providedSources: RetrievedSource[];
  /** Ids d'entités autorisés pour les actions (issus du retrieval / contexte). */
  allowedEntityIds: Set<string>;
  maxAnswerChars: number;
}

export interface ValidationResult {
  ok: boolean;
  violations: string[];
  /** Version « nettoyée » : claims/actions invalides retirés (réparation légère). */
  repaired?: AssistantModelOutput;
}

export function validateModelOutput(
  out: AssistantModelOutput,
  ctx: ValidationContext,
): ValidationResult {
  const violations: string[] = [];
  const sourceIds = new Set(ctx.providedSources.map((s) => s.id));

  // 2. intention fermée
  if (!isVerebonaIntent(out.intent)) violations.push(`intent hors catalogue: ${out.intent}`);

  // 3+4+10. actions
  const allowedTypes = new Set(allowedActionsFor(out.intent));
  const cleanActions = out.actionIntents.filter((a) => {
    if (!isVerebonaActionType(a.type)) {
      violations.push(`action hors catalogue: ${a.type}`);
      return false;
    }
    if (!allowedTypes.has(a.type)) {
      violations.push(`action ${a.type} non autorisée pour ${out.intent}`);
      return false;
    }
    if (a.targetId != null && !ctx.allowedEntityIds.has(String(a.targetId))) {
      violations.push(`action ${a.type} cible un id non fourni: ${a.targetId}`);
      return false;
    }
    return true;
  });

  // 5. sources des claims
  const cleanClaims = out.claims.filter((c) => {
    const bad = c.sourceIds.filter((id) => !sourceIds.has(id));
    if (bad.length) {
      violations.push(`claim "${c.claimKey}" cite des sources non fournies: ${bad.join(',')}`);
      return false;
    }
    return true;
  });

  // 6. supported => au moins un claim
  if (out.supportLevel === 'supported' && cleanClaims.length === 0) {
    violations.push('réponse "supported" sans claim valide (§18.4)');
  }

  // 8. longueur
  if (out.answer.length > ctx.maxAnswerChars) {
    violations.push(`réponse trop longue (${out.answer.length} > ${ctx.maxAnswerChars})`);
  }

  // 9. clarification bien formée
  if (out.clarification) {
    if (out.clarification.candidateIds.length < 2) {
      violations.push('clarification avec < 2 candidats (§20.2)');
    }
  }

  // 7. anti-URL : aucune action ne doit transporter d'URL (les href sont générés serveur)
  for (const a of cleanActions) {
    const values = Object.values(a.params ?? {});
    if (values.some((v) => typeof v === 'string' && /https?:\/\//i.test(v))) {
      violations.push(`action ${a.type} contient une URL libre (§18.7)`);
    }
  }

  const repaired: AssistantModelOutput = {
    ...out,
    claims: cleanClaims,
    actionIntents: cleanActions,
  };

  // La sortie est réparable si les violations ne portent que sur des éléments retirés
  // (claims/actions filtrés) et pas sur des invariants durs (supported sans claim, longueur).
  const hardFailure =
    (out.supportLevel === 'supported' && cleanClaims.length === 0) ||
    out.answer.length > ctx.maxAnswerChars ||
    !isVerebonaIntent(out.intent);

  return { ok: violations.length === 0, violations, repaired: hardFailure ? undefined : repaired };
}
