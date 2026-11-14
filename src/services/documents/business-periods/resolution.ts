/**
 * Lot 113AA (Trello #725, §2 B — décision D11 de #724, R13 / R14) —
 * RÉSOLUTION CONTEXTUELLE des périodes d'un événement de référence (couche
 * de consolidation T3 des périodes métier). PURE : aucune IA, aucune base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Entrées : les périodes ACTIVES des documents membres d'un événement de
 * référence (`document_business_periods`, déjà qualifiées depuis T1), leurs
 * marques T1 v2 (pertinence rendue → `qualified` ; relation DÉCLARÉE par le
 * document → `relation`), les corrections de l'utilisateur et ses décisions
 * d'arbitrage déjà prises (`business_period_decisions`).
 *
 * Pour chaque paire de documents DIFFÉRENTS, la relation est classée :
 *   · DIFFERENT_NATURE : natures différentes (effet contractuel ≠
 *     couverture ≠ facturation…) — jamais une contradiction ;
 *   · SUCCESSION       : périodes dont le non-chevauchement est PROUVÉ (au
 *     plus `COVERAGE_OVERLAP_TOLERANCE_DAYS` jours communs) — succession
 *     normale, toutes conservées (carte #766, E06 : une borne inconnue qui
 *     empêche de conclure ne donne plus une succession, voir plus bas) ;
 *   · SAME_FACT        : mêmes bornes (duplicata, même attestation reçue
 *     deux fois) — un seul fait, sources réunies ;
 *   · AMENDMENT / RECTIFICATION : l'un des deux documents DÉCLARE (T1) être
 *     l'avenant ou le rectificatif — sa période actualise CELLE QU'IL MODIFIE
 *     (la période de même nature qu'il recouvre le plus ; égalité → aucune
 *     cible, la divergence reste une question), qui reste dans l'historique
 *     (« remplacée »), sources conservées ; un autre chevauchement de
 *     l'avenant n'est pas « expliqué » par lui ;
 *   · USER_DECISION    : l'utilisateur a déjà tranché CETTE divergence
 *     (empreinte identique) — jamais redemandé ;
 *   · AI_*             : lot 113AD — T3 a classé CETTE divergence (réexamen
 *     IA d'une divergence non déclarée, contrat `t3-period-relation-v1`,
 *     décision CERTAINE validée, `relation-contract.ts`), même place que la
 *     décision de l'utilisateur et toujours SOUS elle : succession, même
 *     fait, natures différentes → aucune question ; avenant / rectificatif →
 *     remplacement de la SEULE période concernée (jamais une période
 *     corrigée par l'utilisateur), historique conservé ; un examen EN
 *     ATTENTE diffère la question (`review: 'AWAITING'`) ;
 *   · CONTRADICTION    : divergence que les preuves n'expliquent pas, les
 *     deux documents qualifiés sous le contrat v2 → question ciblée à
 *     l'utilisateur (carte « À traiter », justificatifs et choix) ;
 *   · UNQUALIFIED      : divergence non expliquée, l'un des documents n'a
 *     PAS été qualifié sous le contrat v2 (bloc 28 absent ou document
 *     antérieur) → aucune fausse résolution, aucune question prématurée :
 *     périodes signalées comme divergentes (fiche, contrôle de cohérence).
 *
 * Jamais : « le dernier document gagne » (aucun ordre de dates d'émission ni
 * d'identifiants ne tranche), juxtaposition présentée comme une résolution,
 * remplacement automatique d'une période CORRIGÉE par l'utilisateur (une
 * telle paire devient une question).
 *
 * CARTE #766 (pré-MEP) — règles remplacées ou ajoutées :
 *   · E06 — SUCCESSION n'est affirmée que si les bornes PROUVENT le non-chevauchement (`boundsProof` :
 *     quatre bornes connues, ou fin connue de l'une avant le début connu de l'autre). Une borne manquante
 *     qui empêche de conclure donne `UNDETERMINED` : les deux périodes restent établies avec leurs
 *     preuves, AUCUNE succession n'est affirmée, AUCUNE question n'est posée ; un réexamen T3 hors
 *     lecture est demandé (`uncertain`) quand la branche est disponible. Seul un classement T3 CERTAIN
 *     « contradiction » en fait une divergence ;
 *   · E10 — SAME_FACT exige la même modalité de fin : fin inconnue ≠ durée indéterminée établie ;
 *   · E07 — un réexamen T3 en ÉCHEC TECHNIQUE (`FAILED` : panne, quota, délai, refus d'accès) ou encore
 *     EN ATTENTE (quel que soit son âge) ne produit jamais de question : la question n'est posée que
 *     lorsque T3 a réellement travaillé sans expliquer la divergence (`EXAMINED`), ou qu'aucun
 *     réexamen n'est possible par configuration (bloc 29 absent : comportement 113AA) ;
 *   · E08 — continuité d'un fait corrigé : une période dont les bornes sont celles qu'avait une période
 *     CORRIGÉE par l'utilisateur avant sa correction est le même fait, non corrigé sur cet autre
 *     justificatif (`CORRECTED_SAME_FACT`) : elle est remplacée par la correction, sans question.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { boundsProof, endToken, samePeriodBounds, type BusinessPeriodKind, type PartialDate, type PeriodBounds } from '@/lib/documents/business-periods';
import type { DocumentRelation } from './t1-v2';
import type { ExplainingRelation } from './relation-contract';

/**
 * Chevauchement toléré entre deux périodes successives (jours) : deux
 * attestations annuelles partagent souvent leur jour de bascule (« au
 * 01/04 » puis « du 01/04 »). Paramètre centralisé (aucune règle par
 * fournisseur), à valider par le PO.
 */
export const COVERAGE_OVERLAP_TOLERANCE_DAYS = 1;

export interface ResolutionEntry {
  id: number;
  fileId: number;
  kind: BusinessPeriodKind;
  start: PartialDate | null;
  end: PartialDate | null;
  userCorrected: boolean;
  /** Document qualifié sous le contrat T1 v2 (pertinence rendue par T1). */
  qualified: boolean;
  relation: DocumentRelation | null;
  /** Carte #766 (E10) : durée indéterminée ÉTABLIE (≠ fin inconnue). */
  openEnded?: boolean;
  /** Carte #766 (E08) : bornes de la période avant sa correction par l'utilisateur (`before_correction`). */
  correctedFrom?: PeriodBounds | null;
}

export type PairRelation =
  | 'DIFFERENT_NATURE' | 'SUCCESSION' | 'SAME_FACT' | 'AMENDMENT' | 'RECTIFICATION' | 'USER_DECISION' | 'CONTRADICTION' | 'UNQUALIFIED'
  // Lot 113AD : classement par le réexamen T3 (décision certaine validée).
  | 'AI_SUCCESSION' | 'AI_SAME_FACT' | 'AI_DIFFERENT_NATURE' | 'AI_AMENDMENT' | 'AI_RECTIFICATION'
  // Carte #766 : ordre non prouvé (E06) ; même fait qu'une période corrigée, avant sa correction (E08).
  | 'UNDETERMINED' | 'CORRECTED_SAME_FACT';

export interface UserPeriodDecision {
  fingerprint: string;
  /** `KEEP` : la période du document `retainedFileId` est la bonne ; `BOTH` : les deux sont justes. */
  choice: 'KEEP' | 'BOTH';
  retainedFileId: number | null;
}

/**
 * Lot 113AD — état du réexamen T3 d'une divergence (mémoire `business_period_relation_reviews`) :
 *   · AWAITING : examen demandé, pas encore rendu, ou nouvel essai planifié après un échec technique —
 *     question différée. Carte #766 (E07), règle remplacée : SANS limite de délai (un dépassement est
 *     signalé au BO par `late`, il ne devient plus une question) ;
 *   · FAILED   : carte #766 (E07) — échec TECHNIQUE dont les essais sont épuisés (panne, quota, délai,
 *     refus d'accès). Jamais une question ; `rearmable` : un nouveau cycle d'essais est encore permis ;
 *   · EXAMINED : T3 a travaillé sans explication applicable (contradiction, abstention, sortie refusée,
 *     confiance insuffisante) — comportement 113AA ; `contradiction` : classement CERTAIN
 *     « contradiction » (seul cas qui fait une divergence d'un ordre non prouvé, E06) ;
 *   · DECIDED  : classement CERTAIN qui explique la divergence.
 */
export type AiPeriodRelation =
  | { fingerprint: string; state: 'AWAITING'; late?: boolean }
  | { fingerprint: string; state: 'FAILED'; rearmable?: boolean }
  | { fingerprint: string; state: 'EXAMINED'; contradiction?: boolean }
  | { fingerprint: string; state: 'DECIDED'; relation: ExplainingRelation; replacingFileId: number | null };

export type ReviewState = 'NONE' | 'AWAITING' | 'EXAMINED' | 'FAILED';

export type EntryStatus = 'ESTABLISHED' | 'SAME_AS' | 'REPLACED' | 'CONFLICT';

export interface EntryResolution {
  status: EntryStatus;
  /** Document qui remplace (REPLACED) ou porte déjà le même fait (SAME_AS). */
  byFileId?: number;
  basis?: PairRelation;
  /** Empreinte de la divergence (CONFLICT ; REPLACED par un classement T3, lot 113AD). */
  conflict?: string;
}

export interface PeriodConflict {
  fingerprint: string;
  kind: BusinessPeriodKind;
  periodIds: [number, number];
  fileIds: [number, number];
  /** Les deux documents sont qualifiés (et aucun réexamen T3 n'est en attente) : question à l'utilisateur ; sinon signalement seul. */
  needsUser: boolean;
  /** Lot 113AD : état du réexamen T3 de CETTE divergence (NONE : jamais demandé). */
  review: ReviewState;
  /** Carte #766 (E07) : réexamen en attente depuis plus longtemps que le délai de supervision. */
  late?: boolean;
  /** Carte #766 (E07) : échec technique dont un nouveau cycle d'essais est encore permis. */
  rearmable?: boolean;
}

export interface ResolutionResult {
  entries: Map<number, EntryResolution>;
  pairs: Array<{ a: number; b: number; relation: PairRelation }>;
  conflicts: PeriodConflict[];
  /**
   * Carte #766 (E06) : paires dont l'ordre n'est PAS prouvé (borne manquante) — ni succession affirmée, ni
   * divergence, ni question (`needsUser` toujours faux) : candidates au réexamen T3 hors lecture.
   */
  uncertain: PeriodConflict[];
}

/** Empreinte STABLE d'une divergence (indépendante des identifiants de faits, ordre des documents normalisé). */
// Carte #766 (E10) : la durée indéterminée entre dans l'empreinte (`INDEFINITE`) ; une fin inconnue reste
// vide — les empreintes déjà enregistrées (quatre bornes connues) sont inchangées.
export function conflictFingerprint(kind: BusinessPeriodKind, a: Pick<ResolutionEntry, 'fileId' | 'start' | 'end' | 'openEnded'>, b: Pick<ResolutionEntry, 'fileId' | 'start' | 'end' | 'openEnded'>): string {
  const [x, y] = a.fileId <= b.fileId ? [a, b] : [b, a];
  return `${kind}|${x.fileId}:${x.start ?? ''}/${endToken(x)}|${y.fileId}:${y.start ?? ''}/${endToken(y)}`;
}

/** Jours de chevauchement ÉTABLI (quatre bornes connues), sinon 0. Pur. */
export function overlapDays(a: Pick<ResolutionEntry, 'start' | 'end'>, b: Pick<ResolutionEntry, 'start' | 'end'>): number {
  return boundsProof(a, b).days ?? 0;
}

const declares = (e: ResolutionEntry) => e.relation === 'AMENDMENT' || e.relation === 'RECTIFICATION';

/**
 * Période que modifie chaque document qui se déclare avenant / rectificatif (pure) : la période de même
 * nature, d'un autre document qui ne se déclare pas lui-même, qu'il recouvre le PLUS (au-delà de la
 * tolérance). Égalité ou aucune : pas de cible (rien n'est expliqué par la déclaration).
 */
export function amendmentTargets(entries: readonly ResolutionEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of entries.filter(declares)) {
    const scores = entries.filter((e) => e.fileId !== d.fileId && e.kind === d.kind && !declares(e))
      .map((e) => ({ id: e.id, n: overlapDays(d, e) })).filter((x) => x.n > COVERAGE_OVERLAP_TOLERANCE_DAYS)
      .sort((x, y) => y.n - x.n);
    if (scores.length && (scores.length === 1 || scores[0].n > scores[1].n)) out.set(d.id, scores[0].id);
  }
  return out;
}

/** Classement d'une paire (pur, symétrique hors relation déclarée). `targets` : cibles des avenants (défaut : toute paire). */
export function classifyPair(a: ResolutionEntry, b: ResolutionEntry, decisions: ReadonlyMap<string, UserPeriodDecision>, targets?: ReadonlyMap<number, number>,
  ai?: ReadonlyMap<string, AiPeriodRelation>):
  { relation: PairRelation; winner?: ResolutionEntry; loser?: ResolutionEntry; fingerprint?: string; review?: ReviewState; late?: boolean; rearmable?: boolean } {
  if (a.kind !== b.kind) return { relation: 'DIFFERENT_NATURE' };
  // Carte #766 (E10) : même fait = mêmes bornes ET même modalité de fin.
  if (samePeriodBounds(a, b)) return { relation: 'SAME_FACT' };
  // Carte #766 (E08) : l'autre justificatif porte encore la valeur que la période corrigée avait AVANT sa
  // correction (même fait, datée) — la correction de l'utilisateur vaut pour lui aussi, sans question.
  if (a.userCorrected !== b.userCorrected) {
    const corrigee = a.userCorrected ? a : b;
    const autre = corrigee === a ? b : a;
    const avant = corrigee.correctedFrom;
    if (avant && (avant.start !== null || avant.end !== null || avant.openEnded === true) && samePeriodBounds(avant, autre)) {
      return { relation: 'CORRECTED_SAME_FACT', winner: corrigee, loser: autre };
    }
  }
  // Carte #766 (E06) — règle remplacée : l'absence de preuve de chevauchement n'est plus une succession.
  const preuve = boundsProof(a, b, COVERAGE_OVERLAP_TOLERANCE_DAYS).proof;
  if (preuve === 'DISJOINT') return { relation: 'SUCCESSION' };
  const fingerprint = conflictFingerprint(a.kind, a, b);
  const d = decisions.get(fingerprint);
  if (d) {
    if (d.choice === 'BOTH') return { relation: 'USER_DECISION', fingerprint };
    const winner = d.retainedFileId === a.fileId ? a : d.retainedFileId === b.fileId ? b : null;
    if (winner) return { relation: 'USER_DECISION', winner, loser: winner === a ? b : a, fingerprint };
  }
  // Lot 113AD : classement CERTAIN du réexamen T3 (même place que la décision de l'utilisateur, sous elle).
  const ia = ai?.get(fingerprint);
  if (ia?.state === 'DECIDED') {
    if (ia.relation === 'AMENDMENT' || ia.relation === 'RECTIFICATION') {
      const winner = ia.replacingFileId === a.fileId ? a : ia.replacingFileId === b.fileId ? b : null;
      const loser = winner === a ? b : a;
      // Une période corrigée par l'utilisateur n'est jamais remplacée automatiquement : il décide.
      if (winner && !loser.userCorrected) return { relation: ia.relation === 'AMENDMENT' ? 'AI_AMENDMENT' : 'AI_RECTIFICATION', winner, loser, fingerprint };
    } else {
      return { relation: ia.relation === 'SUCCESSION' ? 'AI_SUCCESSION' : ia.relation === 'SAME_FACT' ? 'AI_SAME_FACT' : 'AI_DIFFERENT_NATURE', fingerprint };
    }
  }
  const review: ReviewState = !ia ? 'NONE' : ia.state === 'DECIDED' ? 'EXAMINED' : ia.state;
  const suivi = {
    review,
    ...(ia?.state === 'AWAITING' && ia.late ? { late: true } : {}),
    ...(ia?.state === 'FAILED' && ia.rearmable ? { rearmable: true } : {}),
  };
  // Carte #766 (E06) : ordre non prouvé — ni succession, ni divergence, ni question. Seul un classement
  // T3 certain « contradiction » en fait une divergence (traitée ci-dessous comme les autres).
  if (preuve === 'UNKNOWN' && !(ia?.state === 'EXAMINED' && ia.contradiction === true)) {
    return { relation: 'UNDETERMINED', fingerprint, ...suivi };
  }
  // Relation DÉCLARÉE par un seul des deux documents (avenant, rectificatif) : elle explique la divergence
  // avec la période qu'il modifie (et seulement elle).
  if (declares(a) !== declares(b)) {
    const winner = declares(a) ? a : b;
    const loser = winner === a ? b : a;
    const cible = targets ? targets.get(winner.id) === loser.id : true;
    // Une période corrigée par l'utilisateur n'est jamais remplacée automatiquement : il décide.
    if (cible && !loser.userCorrected) return { relation: winner.relation as 'AMENDMENT' | 'RECTIFICATION', winner, loser, fingerprint };
  }
  return { relation: a.qualified && b.qualified ? 'CONTRADICTION' : 'UNQUALIFIED', fingerprint, ...suivi };
}

/** Résolution des périodes d'un événement de référence (pure, déterministe, ordre stable). */
export function resolvePeriods(entries: readonly ResolutionEntry[], decisions: readonly UserPeriodDecision[] = [], aiRelations: readonly AiPeriodRelation[] = []): ResolutionResult {
  const parEmpreinte = new Map(decisions.map((d) => [d.fingerprint, d]));
  const parExamen = new Map(aiRelations.map((r) => [r.fingerprint, r]));
  const tri = [...entries].sort((x, y) => x.fileId - y.fileId || x.id - y.id);
  const cibles = amendmentTargets(tri);
  const out = new Map<number, EntryResolution>(tri.map((e) => [e.id, { status: 'ESTABLISHED' as EntryStatus }]));
  const pairs: ResolutionResult['pairs'] = [];
  const conflicts: PeriodConflict[] = [];
  const incertaines: PeriodConflict[] = [];
  const rang: Record<EntryStatus, number> = { ESTABLISHED: 0, CONFLICT: 1, SAME_AS: 2, REPLACED: 3 };
  const poser = (id: number, r: EntryResolution) => { if (rang[r.status] > rang[out.get(id)!.status]) out.set(id, r); };
  for (let i = 0; i < tri.length; i++) {
    for (let j = i + 1; j < tri.length; j++) {
      const a = tri[i]; const b = tri[j];
      if (a.fileId === b.fileId) continue;
      const c = classifyPair(a, b, parEmpreinte, cibles, parExamen);
      pairs.push({ a: a.id, b: b.id, relation: c.relation });
      if (c.relation === 'SAME_FACT') poser(b.id, { status: 'SAME_AS', byFileId: a.fileId, basis: 'SAME_FACT' });
      else if (c.winner && c.loser) {
        poser(c.loser.id, { status: 'REPLACED', byFileId: c.winner.fileId, basis: c.relation, ...(c.relation.startsWith('AI_') ? { conflict: c.fingerprint } : {}) });
      } else if (c.relation === 'UNDETERMINED') {
        // Carte #766 (E06) : les deux périodes restent établies ; réexamen T3 hors lecture, jamais de question.
        incertaines.push({
          fingerprint: c.fingerprint!, kind: a.kind, periodIds: [a.id, b.id], fileIds: [a.fileId, b.fileId], needsUser: false, review: c.review ?? 'NONE',
          ...(c.late ? { late: true } : {}), ...(c.rearmable ? { rearmable: true } : {}),
        });
      } else if (c.relation === 'CONTRADICTION' || c.relation === 'UNQUALIFIED') {
        const review = c.review ?? 'NONE';
        conflicts.push({
          fingerprint: c.fingerprint!, kind: a.kind, periodIds: [a.id, b.id], fileIds: [a.fileId, b.fileId],
          // Lot 113AD : un réexamen T3 en attente diffère la question (jamais une question que T3 peut encore expliquer).
          // Carte #766 (E07) : un échec TECHNIQUE du réexamen ne fait jamais une question.
          needsUser: c.relation === 'CONTRADICTION' && review !== 'AWAITING' && review !== 'FAILED', review,
          ...(c.late ? { late: true } : {}), ...(c.rearmable ? { rearmable: true } : {}),
        });
        poser(a.id, { status: 'CONFLICT', basis: c.relation, conflict: c.fingerprint });
        poser(b.id, { status: 'CONFLICT', basis: c.relation, conflict: c.fingerprint });
      }
    }
  }
  // Une divergence avec une période déjà remplacée ou identique à une autre n'est plus une question.
  const vivantes = conflicts.filter((c) => c.periodIds.every((id) => out.get(id)!.status === 'CONFLICT'));
  // Un ordre non prouvé avec une période remplacée, identique à une autre ou déjà divergente n'est plus à examiner.
  const aExaminer = incertaines.filter((c) => c.periodIds.every((id) => out.get(id)!.status === 'ESTABLISHED'));
  return { entries: out, pairs, conflicts: vivantes, uncertain: aExaminer };
}
