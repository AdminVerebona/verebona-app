/**
 * États de qualification d'un couple — lot 86A (CDC Pilotage IA V2 P5 :
 * §16.1 « jamais testée → en test → admissible / refusée / non concluante /
 * obsolète », ACT-02, MIG-02). PUR.
 *
 * L'état n'est jamais écrit : il est CALCULÉ à la lecture à partir de la
 * dernière preuve du couple et de sa signature courante (`signature.ts`).
 * Ainsi un changement de prompt, de contrat, de corpus, d'évaluateur, de
 * capacités ou de profil rend la preuve obsolète sans aucune écriture, et
 * une preuve obsolète n'est jamais réutilisée pour une décision automatique.
 */
import { changedParts, PART_LABELS, type CoupleSignatureParts } from './signature';
import type { Verdict } from './verdict';

export type QualificationState = 'NEVER_TESTED' | 'TESTING' | 'ADMISSIBLE' | 'REFUSED' | 'INCONCLUSIVE' | 'OBSOLETE';

export const STATE_LABELS: Readonly<Record<QualificationState, string>> = {
  NEVER_TESTED: 'Jamais testé',
  TESTING: 'En test',
  ADMISSIBLE: 'Admissible',
  REFUSED: 'Refusée',
  INCONCLUSIVE: 'Non concluante',
  OBSOLETE: 'Obsolète',
};

export interface EvidenceRef {
  id: number;
  verdict: Verdict;
  signature: string;
  parts: Partial<CoupleSignatureParts>;
  createdAt: string;
}

export interface CoupleState {
  state: QualificationState;
  label: string;
  /** Preuve qui fonde l'état (dernière preuve de même signature, sinon la dernière). */
  evidenceId: number | null;
  verdictAt: string | null;
  /** Obsolète : parties de la signature qui ont changé depuis la preuve. */
  changed: string[];
}

/**
 * État d'un couple : `testing` (campagne en cours sur ce couple) l'emporte ;
 * sinon la dernière preuve de signature IDENTIQUE donne le verdict ; à défaut,
 * une preuve d'une autre signature rend le couple « obsolète » ; aucune
 * preuve : « jamais testé » (configurations existantes — MIG-02).
 */
export function stateOfCouple(p: {
  evidences: readonly EvidenceRef[]; current: { signature: string; parts: CoupleSignatureParts }; testing?: boolean;
}): CoupleState {
  const tri = [...p.evidences].sort((a, b) => (b.createdAt.localeCompare(a.createdAt)) || b.id - a.id);
  const meme = tri.find((e) => e.signature === p.current.signature) ?? null;
  if (p.testing) return { state: 'TESTING', label: STATE_LABELS.TESTING, evidenceId: meme?.id ?? null, verdictAt: meme?.createdAt ?? null, changed: [] };
  if (meme) {
    const state: QualificationState = meme.verdict === 'ADMISSIBLE' ? 'ADMISSIBLE' : meme.verdict === 'REFUSED' ? 'REFUSED' : 'INCONCLUSIVE';
    return { state, label: STATE_LABELS[state], evidenceId: meme.id, verdictAt: meme.createdAt, changed: [] };
  }
  const derniere = tri[0];
  if (!derniere) return { state: 'NEVER_TESTED', label: STATE_LABELS.NEVER_TESTED, evidenceId: null, verdictAt: null, changed: [] };
  return {
    state: 'OBSOLETE', label: STATE_LABELS.OBSOLETE, evidenceId: derniere.id, verdictAt: derniere.createdAt,
    changed: changedParts(derniere.parts, p.current.parts).map((k) => PART_LABELS[k]),
  };
}

/** Une preuve peut-elle fonder une décision AUTOMATIQUE ? (admissible et signature courante.) */
export function supportsAutomaticDecision(s: CoupleState): boolean {
  return s.state === 'ADMISSIBLE';
}

/**
 * Libellé d'un couple choisi MANUELLEMENT (ACT-02, R05) : jamais présenté
 * comme qualifié sans preuve admissible de signature courante.
 */
export function manualChoiceLabel(s: CoupleState): string {
  if (s.state === 'ADMISSIBLE') return 'Choix manuel · qualifié';
  if (s.state === 'TESTING') return 'Choix manuel · en test';
  return `Choix manuel · non testé${s.state === 'NEVER_TESTED' ? '' : ` (${STATE_LABELS[s.state].toLowerCase()})`}`;
}
