/**
 * Lot 108K (ticket « Correctifs de conformité du lot 91D », §C) — CONFORMITÉ
 * DE LA SORTIE T1 au contrat `t1-value-decisions-v1` (fonctions PURES).
 *
 * Le schéma serveur garde `valueDecisions` FACULTATIF (anciens prompts sans
 * marqueur, coupure `T1_VALUE_DECISIONS_ENABLED=0`). Mais quand le prompt
 * effectif PORTE le contrat et que c'est lui qui a répondu, le prompt exige
 * le tableau (vide compris) : on distingue alors, pour CHAQUE appel T1
 * (passe principale, lot de pages, réexamen) :
 *
 *   PRESENT    tableau présent avec au moins une décision ;
 *   EMPTY      tableau présent et vide (`[]`) — valide : rien à qualifier ;
 *   ABSENT     tableau absent de la réponse ;
 *   MALFORMED  champ présent mais pas un tableau, ou retiré par la validation ;
 *   TRUNCATED  tableau au-delà de la borne du contrat (décisions perdues).
 *
 * ABSENT / MALFORMED / TRUNCATED avec contrat porté = NON-CONFORMITÉ : un
 * constat tracé (fichier, run, version, extraction) est consigné dans
 * `document_extractions.metadata.valueDecisionsOutput`, lu par
 * COH-DOC-EXTRACT-CHAIN (constat `T1_VALUE_DECISIONS_OUTPUT_MISSING`,
 * réexamen ciblé des seules valeurs omises). Jamais de décision inventée,
 * jamais de blocage de la transcription ni des faits.
 */
import type { T1NormalisationReport } from '../master/tolerant-output';

export const VALUE_DECISIONS_OUTPUT_STATUSES = ['PRESENT', 'EMPTY', 'ABSENT', 'MALFORMED', 'TRUNCATED'] as const;
export type ValueDecisionsOutputStatus = (typeof VALUE_DECISIONS_OUTPUT_STATUSES)[number];
/** Statuts non conformes quand le contrat est porté. */
export const NONCONFORMING_OUTPUT: ReadonlySet<string> = new Set(['ABSENT', 'MALFORMED', 'TRUNCATED']);

/** Statut d'UNE réponse T1 (pure). */
export function valueDecisionsOutputStatus(
  output: { valueDecisions?: unknown[] }, report: Pick<T1NormalisationReport, 'invalidValueDecisions' | 'truncatedValueDecisions'> | null,
  pruned: ReadonlyArray<{ path?: string }> = [],
): { status: ValueDecisionsOutputStatus; decisions: number; invalid: number; truncated: number } {
  const invalid = (report?.invalidValueDecisions ?? []).filter((x) => x.path !== 'valueDecisions').length;
  const truncated = report?.truncatedValueDecisions ?? 0;
  const n = output.valueDecisions?.length ?? 0;
  if ((report?.invalidValueDecisions ?? []).some((x) => x.path === 'valueDecisions') || pruned.some((p) => /^(?:\$\.)?valueDecisions$/.test(p.path ?? ''))) {
    return { status: 'MALFORMED', decisions: n, invalid, truncated };
  }
  if (output.valueDecisions === undefined) return { status: invalid ? 'PRESENT' : 'ABSENT', decisions: 0, invalid, truncated };
  if (truncated > 0) return { status: 'TRUNCATED', decisions: n, invalid, truncated };
  return { status: n + invalid > 0 ? 'PRESENT' : 'EMPTY', decisions: n, invalid, truncated };
}

/** Une passe (appel T1) et son statut. */
export interface ValueDecisionsPass { origin: 'PASS_1' | 'CHUNK' | 'REVIEW'; status: ValueDecisionsOutputStatus; decisions: number; invalid: number; truncated: number }

/**
 * Constat consigné avec l'extraction (`metadata.valueDecisionsOutput`) :
 * statut global (le PIRE des passes), contrat, version du prompt qui a
 * répondu, version effective attendue, concordance, passes.
 */
export interface ValueDecisionsOutputRecord {
  schema: 'l108k/1';
  /** Contrat porté par le prompt effectif au moment de l'analyse (`CARRIED`, `MARKER_MISSING`, `DISABLED`, `UNREADABLE`). */
  contract: string;
  /** Version qui a répondu / version effective portant le contrat. */
  promptVersion: string | null;
  effectiveVersion: string | null;
  versionsMatch: boolean;
  /** Statut global (pire des passes) ; `NOT_EVALUATED` : contrat non porté ou versions discordantes (compatibilité). */
  status: ValueDecisionsOutputStatus | 'NOT_EVALUATED';
  conforming: boolean;
  passes: ValueDecisionsPass[];
  at: string;
}

const RANG: Record<ValueDecisionsOutputStatus, number> = { PRESENT: 0, EMPTY: 0, TRUNCATED: 1, MALFORMED: 2, ABSENT: 3 };

/** Statut global d'un ensemble de passes (pure) : le pire ; toutes vides → EMPTY. */
export function worstStatus(passes: readonly ValueDecisionsPass[]): ValueDecisionsOutputStatus {
  if (passes.length === 0) return 'ABSENT';
  const pire = passes.reduce((a, b) => (RANG[b.status] > RANG[a.status] ? b : a));
  if (RANG[pire.status] > 0) return pire.status;
  return passes.some((x) => x.status === 'PRESENT') ? 'PRESENT' : 'EMPTY';
}

/** Constat d'une analyse (pure). */
export function valueDecisionsOutputRecord(p: {
  contract: string; carried: boolean; effectiveVersion: string | null; promptVersion: string | null; passes: readonly ValueDecisionsPass[]; at?: Date;
}): ValueDecisionsOutputRecord {
  const versionsMatch = p.effectiveVersion === null || p.effectiveVersion === p.promptVersion;
  const evalue = p.carried && versionsMatch;
  const status = evalue ? worstStatus(p.passes) : 'NOT_EVALUATED';
  return {
    schema: 'l108k/1', contract: p.contract, promptVersion: p.promptVersion, effectiveVersion: p.effectiveVersion, versionsMatch,
    status, conforming: !evalue || !NONCONFORMING_OUTPUT.has(status), passes: [...p.passes], at: (p.at ?? new Date()).toISOString(),
  };
}
