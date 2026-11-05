/**
 * T4 master — branche VERIFY_COMPLETION (CDC 15 §26, T4-12 à T4-14, V1 à V4).
 *
 * Appelée seulement quand la décision déterministe (`decideCompletion`)
 * reste `unknown` (forme de preuve à lire, preuve non datée) ET que T4 est
 * en architecture `master`. Le serveur garde le dernier mot :
 *   · la fenêtre d'occurrence calculée par le code prime — si la preuve est
 *     datée hors fenêtre, aucune réponse du modèle ne clôt l'échéance ;
 *   · `insufficient` ⇒ not_proven (jamais « non réalisé ») ;
 *   · `proves_not_completed` ⇒ not_completed, PROPOSÉ, jamais écrit ;
 *   · `conflictual` ⇒ unknown.
 *
 * Lot 111M (ticket « budgets IA », P2 T4, CA-13) : l'extrait n'est plus
 * COUPÉ à 1 000 caractères en silence. Il est lu par FENÊTRES successives
 * (`T4_EVIDENCE_CHARS_PER_CALL`, 1 000 — coût par appel inchangé) : une
 * réponse « insuffisant » ou « prouve la non-réalisation » sur une fenêtre
 * alors que la suite n'a pas été lue déclenche une RELECTURE CIBLÉE de la
 * fenêtre suivante, au plus `T4_EVIDENCE_MAX_REREADS` (2) fois. Relecture
 * épuisée avec du texte non lu : jamais de décision définitive (`unknown`,
 * `EVIDENCE_PARTIALLY_READ`). Une preuve de réalisation lue reste valable.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled } from '../../queue/execution-control';
import { resolveDocumentType } from '@/services/canonical/registry';
import type { ExistingAgendaItem } from '../types';
import {
  matchOccurrence, OCCURRENCE_EXACT_DAYS, NON_RECURRING_EARLY_DAYS,
  type CompletionDecision, type CompletionEvidence,
} from '../status-reconciler';
import { T4VerifyCompletionOutput, type T4VerifyCompletionOutput as Out } from './t4-contract';

export function verifyCompletionVariables(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision,
): Record<string, unknown> {
  const entry = resolveDocumentType(evidence.documentType);
  return {
    AGENDA_ITEM: {
      title: item.title,
      date: item.date,
      businessType: item.businessType ?? null,
      recurrence: item.recurrence ?? null,
      // Fenêtre serveur (T4-14), transmise en donnée (U4).
      occurrenceWindow: item.recurrence
        ? { rule: 'occurrence la plus proche : ± demi-période', exactDays: OCCURRENCE_EXACT_DAYS }
        : { rule: `de ${NON_RECURRING_EARLY_DAYS} jours avant l'échéance à toute date après`, exactDays: OCCURRENCE_EXACT_DAYS },
    },
    DOCUMENT_TYPE: entry
      ? { code: entry.code, label: entry.label, completionProofs: det.applicableProofs ?? entry.completionProofs }
      : { code: evidence.documentType ?? null, label: null, completionProofs: [] },
    EVIDENCE: {
      excerpt: evidence.excerpt.slice(0, T4_EVIDENCE_DEFAULT_CHARS),
      documentDate: evidence.documentDate ? evidence.documentDate.toISOString().slice(0, 10) : null,
      occurrenceDate: evidence.occurrenceDate ? evidence.occurrenceDate.toISOString().slice(0, 10) : null,
    },
    EVENT_CONTEXT: null, EVENT_CATALOG: null, TEMPORAL_CONTEXT: null, TEMPORAL_CANDIDATES: null,
  };
}

/** Traduction pure, avec contrôle serveur de l'occurrence. */
export function translateVerifyCompletion(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision, out: Out,
): CompletionDecision {
  const base = { applicableProofs: det.applicableProofs, needsModel: false };
  const serveur = matchOccurrence(item.date, evidence.occurrenceDate ?? evidence.documentDate, item.recurrence);
  const keep = (status: CompletionDecision['status'], reasonCode: CompletionDecision['reasonCode'], occurrenceMatch = out.occurrenceMatch): CompletionDecision => ({
    ...base, status, decision: 'keep', occurrenceMatch, reasonCode, reason: out.reason,
  });

  switch (out.evidenceStatus) {
    case 'insufficient':
      return keep('not_proven', 'MODEL_INSUFFICIENT');
    case 'conflictual':
      return keep('unknown', 'MODEL_CONFLICTUAL');
    case 'proves_not_completed':
      return { ...keep('not_completed', 'MODEL_NOT_COMPLETED'), decision: 'propose_not_done' };
    case 'proves_completed': {
      if (serveur === 'none' || out.occurrenceMatch === 'none') return keep('not_proven', 'MODEL_OCCURRENCE_MISMATCH', 'none');
      if (out.occurrenceMatch === 'ambiguous') return keep('unknown', 'MODEL_OCCURRENCE_AMBIGUOUS', 'ambiguous');
      const certain = out.confidence === 'certain' && evidence.confidence === 'certain' && serveur !== 'ambiguous';
      return {
        ...base, status: 'completed', decision: certain ? 'mark_done' : 'propose_done',
        occurrenceMatch: serveur === 'ambiguous' ? out.occurrenceMatch : serveur,
        reasonCode: 'COMPLETION_PROVEN', reason: out.reason,
      };
    }
  }
}

/** Lot 111M : caractères de preuve par appel (fenêtre) — valeur historique, coût par appel inchangé. */
const T4_EVIDENCE_DEFAULT_CHARS = 1000;
/** Recouvrement entre deux fenêtres : une date ou une clause à cheval reste lisible d'un tenant. */
const T4_EVIDENCE_OVERLAP_CHARS = 150;

/** Bornes de lecture de la preuve (variables d'environnement, défauts prudents). Pure. */
export function t4EvidenceBounds(env: Record<string, string | undefined> = process.env): { charsPerCall: number; maxRereads: number } {
  const n = (v: string | undefined, d: number, min: number, max: number) => {
    const x = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.trunc(x))) : d;
  };
  return { charsPerCall: n(env.T4_EVIDENCE_CHARS_PER_CALL, T4_EVIDENCE_DEFAULT_CHARS, 300, 8000), maxRereads: n(env.T4_EVIDENCE_MAX_REREADS, 2, 0, 5) };
}

/** Fenêtres successives d'un extrait (pure) : la première est l'extrait historique. */
export function evidenceWindows(excerpt: string, charsPerCall: number): string[] {
  if (excerpt.length <= charsPerCall) return [excerpt];
  const out: string[] = [];
  for (let debut = 0; debut < excerpt.length;) {
    const fin = Math.min(excerpt.length, debut + charsPerCall);
    out.push(excerpt.slice(debut, fin));
    if (fin >= excerpt.length) break;
    debut = fin - Math.min(T4_EVIDENCE_OVERLAP_CHARS, Math.floor(charsPerCall / 5));
  }
  return out;
}

/** Vérification par le master. Échec : décision déterministe conservée (unknown). */
export async function verifyCompletionMaster(
  item: ExistingAgendaItem, evidence: CompletionEvidence, det: CompletionDecision,
  ctx: { accountId: number; userId?: number; sourceFileId?: number | null },
): Promise<CompletionDecision> {
  try {
    const bornes = t4EvidenceBounds();
    const fenetres = evidenceWindows(evidence.excerpt, bornes.charsPerCall);
    const appels = Math.min(fenetres.length, 1 + bornes.maxRereads);
    let decision: CompletionDecision = det;
    for (let k = 0; k < appels; k += 1) {
      const vue: CompletionEvidence = { ...evidence, excerpt: fenetres[k] };
      const variables = verifyCompletionVariables(item, vue, det);
      (variables.EVIDENCE as { excerpt: string }).excerpt = fenetres[k];
      const res = await AiGateway.execute({
        useCaseCode: 'AGENDA_INTELLIGENCE',
        operationCode: 't4_verify_completion',
        accountId: ctx.accountId,
        userId: ctx.userId,
        sourceIds: ctx.sourceFileId ? [ctx.sourceFileId] : undefined,
        promptVariables: variables,
        outputSchema: T4VerifyCompletionOutput,
      });
      decision = translateVerifyCompletion(item, evidence, det, res.data);
      const reste = k < fenetres.length - 1;
      // Relecture ciblée seulement quand la fenêtre lue n'a pas suffi à prouver la réalisation.
      if (!reste || (res.data.evidenceStatus !== 'insufficient' && res.data.evidenceStatus !== 'proves_not_completed')) {
        return decision;
      }
    }
    // Texte de preuve resté non lu : aucune décision définitive sur une preuve incomplète.
    if (appels < fenetres.length) {
      return {
        ...decision, status: 'unknown', decision: 'keep', reasonCode: 'EVIDENCE_PARTIALLY_READ',
        reason: `preuve lue en partie (${appels}/${fenetres.length} fenêtre(s)) : ${decision.reason}`.slice(0, 500),
      };
    }
    return decision;
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.warn('[t4_verify_completion] vérification modèle indisponible :', (e as Error).message);
    return det;
  }
}
