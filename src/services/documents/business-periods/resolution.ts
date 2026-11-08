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
 *   · SUCCESSION       : périodes qui ne se chevauchent pas (au plus
 *     `COVERAGE_OVERLAP_TOLERANCE_DAYS`), ou chevauchement NON ÉTABLI (une
 *     borne inconnue) — succession normale, toutes conservées ;
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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { lowerBound, upperBound, type BusinessPeriodKind, type PartialDate } from '@/lib/documents/business-periods';
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
}

export type PairRelation =
  | 'DIFFERENT_NATURE' | 'SUCCESSION' | 'SAME_FACT' | 'AMENDMENT' | 'RECTIFICATION' | 'USER_DECISION' | 'CONTRADICTION' | 'UNQUALIFIED'
  // Lot 113AD : classement par le réexamen T3 (décision certaine validée).
  | 'AI_SUCCESSION' | 'AI_SAME_FACT' | 'AI_DIFFERENT_NATURE' | 'AI_AMENDMENT' | 'AI_RECTIFICATION';

export interface UserPeriodDecision {
  fingerprint: string;
  /** `KEEP` : la période du document `retainedFileId` est la bonne ; `BOTH` : les deux sont justes. */
  choice: 'KEEP' | 'BOTH';
  retainedFileId: number | null;
}

/**
 * Lot 113AD — état du réexamen T3 d'une divergence (mémoire `business_period_relation_reviews`) :
 *   · AWAITING : examen demandé, pas encore rendu (question différée, dans la limite du délai) ;
 *   · EXAMINED : examiné sans explication applicable (contradiction, abstention, sortie refusée,
 *     confiance insuffisante, délai dépassé) — comportement 113AA ;
 *   · DECIDED  : classement CERTAIN qui explique la divergence.
 */
export type AiPeriodRelation =
  | { fingerprint: string; state: 'AWAITING' | 'EXAMINED' }
  | { fingerprint: string; state: 'DECIDED'; relation: ExplainingRelation; replacingFileId: number | null };

export type ReviewState = 'NONE' | 'AWAITING' | 'EXAMINED';

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
}

export interface ResolutionResult {
  entries: Map<number, EntryResolution>;
  pairs: Array<{ a: number; b: number; relation: PairRelation }>;
  conflicts: PeriodConflict[];
}

const DAY = 86_400_000;
const days = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY;
/** Plus grande date possible d'une borne de fin partielle (jour réel du mois). */
function lastDay(v: PartialDate): string {
  if (v.length === 7) {
    const [y, m] = v.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  return upperBound(v);
}

/** Empreinte STABLE d'une divergence (indépendante des identifiants de faits, ordre des documents normalisé). */
export function conflictFingerprint(kind: BusinessPeriodKind, a: Pick<ResolutionEntry, 'fileId' | 'start' | 'end'>, b: Pick<ResolutionEntry, 'fileId' | 'start' | 'end'>): string {
  const [x, y] = a.fileId <= b.fileId ? [a, b] : [b, a];
  return `${kind}|${x.fileId}:${x.start ?? ''}/${x.end ?? ''}|${y.fileId}:${y.start ?? ''}/${y.end ?? ''}`;
}

/** Jours de chevauchement ÉTABLI (quatre bornes connues), sinon 0. Pur. */
export function overlapDays(a: Pick<ResolutionEntry, 'start' | 'end'>, b: Pick<ResolutionEntry, 'start' | 'end'>): number {
  if (!a.start || !a.end || !b.start || !b.end) return 0;
  const debut = Math.max(days(lowerBound(a.start)), days(lowerBound(b.start)));
  const fin = Math.min(days(lastDay(a.end)), days(lastDay(b.end)));
  return Math.max(0, fin - debut + 1);
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
  { relation: PairRelation; winner?: ResolutionEntry; loser?: ResolutionEntry; fingerprint?: string; review?: ReviewState } {
  if (a.kind !== b.kind) return { relation: 'DIFFERENT_NATURE' };
  if (a.start === b.start && a.end === b.end) return { relation: 'SAME_FACT' };
  // Chevauchement ÉTABLI seulement si les quatre bornes sont connues (une borne inconnue ne prouve rien).
  if (overlapDays(a, b) <= COVERAGE_OVERLAP_TOLERANCE_DAYS) return { relation: 'SUCCESSION' };
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
  const review: ReviewState = !ia ? 'NONE' : ia.state === 'AWAITING' ? 'AWAITING' : 'EXAMINED';
  // Relation DÉCLARÉE par un seul des deux documents (avenant, rectificatif) : elle explique la divergence
  // avec la période qu'il modifie (et seulement elle).
  if (declares(a) !== declares(b)) {
    const winner = declares(a) ? a : b;
    const loser = winner === a ? b : a;
    const cible = targets ? targets.get(winner.id) === loser.id : true;
    // Une période corrigée par l'utilisateur n'est jamais remplacée automatiquement : il décide.
    if (cible && !loser.userCorrected) return { relation: winner.relation as 'AMENDMENT' | 'RECTIFICATION', winner, loser, fingerprint };
  }
  return { relation: a.qualified && b.qualified ? 'CONTRADICTION' : 'UNQUALIFIED', fingerprint, review };
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
      } else if (c.relation === 'CONTRADICTION' || c.relation === 'UNQUALIFIED') {
        const review = c.review ?? 'NONE';
        conflicts.push({
          fingerprint: c.fingerprint!, kind: a.kind, periodIds: [a.id, b.id], fileIds: [a.fileId, b.fileId],
          // Lot 113AD : un réexamen T3 en attente diffère la question (jamais une question que T3 peut encore expliquer).
          needsUser: c.relation === 'CONTRADICTION' && review !== 'AWAITING', review,
        });
        poser(a.id, { status: 'CONFLICT', basis: c.relation, conflict: c.fingerprint });
        poser(b.id, { status: 'CONFLICT', basis: c.relation, conflict: c.fingerprint });
      }
    }
  }
  // Une divergence avec une période déjà remplacée ou identique à une autre n'est plus une question.
  const vivantes = conflicts.filter((c) => c.periodIds.every((id) => out.get(id)!.status === 'CONFLICT'));
  return { entries: out, pairs, conflicts: vivantes };
}
