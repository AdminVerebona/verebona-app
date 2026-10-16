/**
 * Contrôle SERVEUR d'une évaluation d'intervention « À traiter » rendue par
 * T4 (`t4_output_v3`) — lot 61. Module PUR (aucun accès base) : utilisé par
 * le moteur « À traiter » (`document-field-evidence.ts`) et par le corpus des
 * prompts maîtres (évaluateur T4).
 */
import type { T4InterventionAssessment } from '@/services/ai/agenda/master/t4-contract';
import { FORBIDDEN_UX_TERMS } from '@/lib/referential/v2/microcopy';

/** Intervention identifiée par T4 (`t4_output_v3`), contrôlée par le code. */
export interface InterventionDecision {
  needed: 'yes' | 'no' | 'uncertain';
  kind: string | null;
  action: string | null;
  justification: string;
  consequence: string | null;
  evidence: string | null;
  timing: 'NOW' | 'LATER' | 'NONE';
  actBy: string | null;
  dataNeeded: boolean | null;
  /** Avertissements du contrôle serveur (preuve introuvable, vocabulaire…). */
  warnings: string[];
}

/** Vocabulaire interdit à l'utilisateur (§17.1) : le libellé T4 est alors remplacé. */
const contientInterdit = (t: string) => FORBIDDEN_UX_TERMS.some((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'iu').test(t));
const normTexte = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Contrôle SERVEUR d'une évaluation d'intervention rendue par T4 (pure) —
 * le code ne se fie pas au texte libre :
 *   · demandée ? (sinon ignorée) ;
 *   · une intervention réelle (autre que fournir la donnée ou vérifier) doit
 *     citer un passage de la preuve FOURNIE, retrouvé tel quel dans le
 *     contexte transmis ; sinon : incertaine (U1, U5) ;
 *   · `actBy` doit être une date valide ;
 *   · libellé destiné à l'utilisateur : ≤ 160, une ligne, sans vocabulaire
 *     technique interdit (sinon remplacé par un libellé générique).
 */
export function checkInterventionCoherence(
  raw: T4InterventionAssessment | null | undefined,
  context: { requested: boolean; providedText: string },
): InterventionDecision | null {
  if (!raw || !context.requested) return null;
  const warnings: string[] = [];
  let needed = raw.needed;
  const exigePreuve = needed === 'yes' && raw.kind !== 'PROVIDE_INFORMATION' && raw.kind !== 'VERIFY';
  if (raw.evidence && !normTexte(context.providedText).includes(normTexte(raw.evidence).slice(0, 120))) {
    warnings.push('EVIDENCE_NOT_IN_CONTEXT');
    if (exigePreuve) needed = 'uncertain';
  } else if (exigePreuve && !raw.evidence) {
    warnings.push('EVIDENCE_MISSING');
    needed = 'uncertain';
  }
  const actBy = raw.actBy && /^\d{4}-\d{2}-\d{2}$/.test(raw.actBy) && !Number.isNaN(Date.parse(`${raw.actBy}T00:00:00Z`))
    && new Date(`${raw.actBy}T00:00:00Z`).toISOString().slice(0, 10) === raw.actBy ? raw.actBy : null;
  if (raw.actBy && !actBy) warnings.push('ACT_BY_INVALID');
  let action = raw.action ? raw.action.replace(/\s+/g, ' ').trim().slice(0, 160) : null;
  if (action && contientInterdit(action)) { warnings.push('ACTION_LABEL_REPLACED'); action = null; }
  return {
    needed, kind: needed === 'no' ? null : raw.kind, action: needed === 'no' ? null : action,
    justification: raw.justification.slice(0, 300), consequence: raw.consequence ? raw.consequence.slice(0, 300) : null,
    evidence: raw.evidence ? raw.evidence.slice(0, 300) : null, timing: needed === 'no' ? 'NONE' : raw.timing,
    actBy, dataNeeded: raw.dataNeeded, warnings,
  };
}

