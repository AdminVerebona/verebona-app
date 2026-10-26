/**
 * Lot 85F — constats SÉMANTIQUES T3 (connaissance T1 persistée, validés par
 * le serveur) → entrées du moteur « À traiter » EXISTANT. Partie PURE.
 *
 * Une compréhension IA ne devient JAMAIS une écriture canonique directe
 * (ticket §8) :
 *   · valeur de la donnée → PROPOSITION du moteur de décision (`decide()`),
 *     confiance au plus `SEMANTIC_PROPOSAL_CONFIDENCE` — sous le seuil
 *     d'écriture automatique : la valeur est soumise, jamais écrite seule ;
 *   · contradiction → toutes les valeurs, confiance basse : arbitrage ;
 *   · constituants → faits du calcul EXISTANT, source distincte de `FACTS` :
 *     au plus un calcul PROBABLE (candidat de pertinence, jamais écrit), et
 *     le signal d'un échéancier (pertinence de la date de fin, lot 76 I).
 */
import type { ActionProposal } from './action-model';
import type { EvidenceFact } from './document-field-evidence';
import type { ExtraDerivationFacts } from './document-derivations';
import type { ScheduleFacts } from './document-derivations';
import type { SemanticResolution } from '@/services/ai/reconciliation/knowledge-query/service';

/** Source des faits issus du traitement sémantique (diagnostic, pertinence). */
const SEMANTIC_SOURCE = 'T3_SEMANTIC';
/** Confiance d'une valeur comprise (modèle certain, preuve T1 fiable) : proposition, jamais écriture automatique. */
export const SEMANTIC_PROPOSAL_CONFIDENCE = 0.6;
/** Confiance d'une valeur comprise incertaine, ambiguë ou contradictoire. */
export const SEMANTIC_WEAK_CONFIDENCE = 0.3;

const SCHEDULE_ROLES = ['firstInstalment', 'lastInstalment', 'count', 'periodicity', 'disbursement', 'repayment'] as const;

/** Propositions de la DONNÉE (cible FIELD) issues des constats retenus. Pure. */
export function semanticFieldProposals(r: SemanticResolution | null, normalize: (v: unknown) => string | number | boolean | null): ActionProposal[] {
  if (!r || r.status !== 'ANSWERED') return [];
  const contradiction = r.contradictions.includes('FIELD');
  const out = new Map<string, ActionProposal>();
  for (const f of r.findings) {
    if (f.target !== 'FIELD' || f.normalized === null) continue;
    const v = normalize(f.normalized);
    if (v === null) continue;
    const sur = !contradiction && f.modelConfidence === 'certain' && f.evidenceConfidence === 'certain' && f.dateStatus !== 'ORDER_AMBIGUOUS';
    const conf = sur ? SEMANTIC_PROPOSAL_CONFIDENCE : SEMANTIC_WEAK_CONFIDENCE;
    const k = String(v);
    const prev = out.get(k);
    if (prev && prev.confidence >= conf) continue;
    out.set(k, {
      value: v, label: k, confidence: conf, evidenceIds: f.evidenceRefs.map((ref) => `t1:${ref}`),
      sourceContext: { label: f.excerpt.replace(/\s+/g, ' ').slice(0, 120) },
    });
  }
  return [...out.values()];
}

/** Faits de pertinence (date lue sémantiquement, extrait) — la pertinence situe la donnée dans le temps. Pure. */
export function semanticEvidenceFacts(r: SemanticResolution | null, normalize: (v: unknown) => string | number | boolean | null): EvidenceFact[] {
  return semanticFieldProposals(r, normalize).map((p) => ({
    value: p.value, confidence: 'probable', excerpt: p.sourceContext?.label ?? null, source: SEMANTIC_SOURCE, key: 'FIELD', label: null,
  }));
}

/** Constituants retenus → faits du calcul existant (jamais fiables). Pure. Null : aucun constituant. */
export function semanticConstituents(r: SemanticResolution | null): ExtraDerivationFacts | null {
  if (!r || r.status !== 'ANSWERED') return null;
  const fait = (f: SemanticResolution['findings'][number], valeur: string): EvidenceFact => ({
    value: valeur, confidence: 'probable', excerpt: f.excerpt, source: `${SEMANTIC_SOURCE}:${f.evidenceRefs[0]}`, key: `t3:${f.target}`, label: null,
  });
  const out: ExtraDerivationFacts = { start: [], duration: [], schedule: {} };
  let n = 0;
  for (const f of r.findings) {
    // Constituant en contradiction : présenté tel quel — le calcul existant refuse plusieurs valeurs (AMBIGUOUS).
    if (f.target === 'start' && f.normalized) { out.start!.push(fait(f, f.normalized)); n += 1; continue; }
    if (f.target === 'duration') { out.duration!.push(fait(f, f.rawValue)); n += 1; continue; }
    const role = SCHEDULE_ROLES.find((x) => x === f.target);
    if (!role) continue;
    const date = role === 'firstInstalment' || role === 'lastInstalment' || role === 'disbursement';
    if (date && !f.normalized) continue;
    ((out.schedule as Partial<ScheduleFacts>)[role] ??= []).push(fait(f, date ? f.normalized! : f.rawValue));
    n += 1;
  }
  return n ? out : null;
}
