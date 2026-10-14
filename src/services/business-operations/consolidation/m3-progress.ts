/**
 * Examen M3 PROGRESSIF des Opérations plausibles (lot 53, retour PO D7) —
 * règles PURES.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS JAMAIS « AU-DELÀ DE 5 CANDIDATS, PAS D'APPEL »
 *
 * Le modèle compare toujours un monde FERMÉ d'au plus
 * `OPERATION_MATCH_MAX_CANDIDATES` (5) Opérations : c'est un garde-fou de
 * qualité et de coût, conservé. Mais au-delà de 5 Opérations plausibles, le
 * candidat n'est plus laissé sans tentative (statut TOO_MANY_CANDIDATES du
 * lot 42, jamais repris) :
 *
 *   1. les Opérations plausibles sont CLASSÉES (`rankPlausible` : faisceau le
 *      plus fort, dates les plus proches) ;
 *   2. le lot courant = les 5 premières non encore écartées ;
 *   3. verdict « DISTINCT » certain sur ce lot ET d'autres Opérations restent
 *      → le lot est mémorisé comme EXAMINÉ (`distinct`), le lot suivant est
 *      soumis au cycle T3 suivant (aucune création tant que tout n'est pas
 *      examiné) ;
 *   4. « SAME » certain → rattachement ; doute → carte « À traiter » ;
 *   5. toutes examinées et distinctes → création (si la source le permet).
 *
 * La progression est mémorisée sur le candidat (`t3_detail.m3Progress`) avec
 * l'empreinte du SUJET (le candidat) : un candidat modifié repart de zéro.
 * Les plafonds d'appels (par passage, par jour, coût mensuel) ne font que
 * REPORTER le lot courant (`t3_detail.m3.status = DEFERRED`, motif, date de
 * reprise) : la reprise est automatique au cycle suivant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { CandidateIdentity } from './model';

/** Tours mémorisés (historique borné, diagnostic BO). */
export const M3_PROGRESS_HISTORY = 10;

export interface M3Progress {
  /** Empreinte du sujet (candidat) : progression remise à zéro si elle change. */
  subject: string;
  /** Opérations déjà examinées et jugées DISTINCTES avec certitude. */
  distinct: number[];
  /** Lots achevés. */
  rounds: number;
  /** Derniers lots examinés (diagnostic). */
  history: Array<{ at: string; operationIds: number[]; outcome: 'DISTINCT' }>;
}

export interface M3Selection {
  /** Lot soumis au modèle (≤ max). */
  batch: number[];
  /** Opérations plausibles déjà examinées (écartées). */
  examined: number[];
  /** Opérations plausibles pas encore examinées, hors lot courant. */
  remaining: number[];
  /** Total des Opérations plausibles classées. */
  total: number;
}

/** Empreinte stable du sujet M3 (ce que le candidat affirme). Pure. */
export function m3SubjectFingerprint(c: CandidateIdentity): string {
  const sujet = {
    k: c.candidateKey, f: c.fileId, t: c.type, s: c.status, r: c.role, m: c.summary, p: c.providerKey,
    a: [...c.assetIds].sort((x, y) => x - y), refs: c.refs.map((x) => `${x.kind}:${x.normalized}`).sort(),
    d: c.dates, h: c.hints.map((h) => `${h.role}/${h.amountScope ?? ''}/${h.amountMinor}/${h.currency}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(sujet)).digest('hex').slice(0, 24);
}

/** Progression mémorisée valable pour ce sujet, sinon progression vierge. Pure. */
export function m3ProgressFor(stored: unknown, subject: string): M3Progress {
  const s = stored as Partial<M3Progress> | null | undefined;
  if (!s || typeof s !== 'object' || s.subject !== subject || !Array.isArray(s.distinct)) {
    return { subject, distinct: [], rounds: 0, history: [] };
  }
  return {
    subject,
    distinct: s.distinct.map(Number).filter((n) => Number.isSafeInteger(n)),
    rounds: Number.isSafeInteger(s.rounds) ? Number(s.rounds) : 0,
    history: Array.isArray(s.history) ? s.history.slice(-M3_PROGRESS_HISTORY) : [],
  };
}

/** Lot courant : les `max` premières Opérations classées non encore écartées. Pure. */
export function selectM3Batch(ranked: readonly number[], progress: M3Progress, max: number): M3Selection {
  const vues = new Set(progress.distinct);
  const examined = ranked.filter((id) => vues.has(id));
  const restantes = ranked.filter((id) => !vues.has(id));
  const taille = Math.max(1, max);
  return { batch: restantes.slice(0, taille), examined, remaining: restantes.slice(taille), total: ranked.length };
}

/** Le lot `batch` a été jugé DISTINCT avec certitude : il rejoint les Opérations examinées. Pure. */
export function advanceM3Progress(progress: M3Progress, batch: readonly number[], at: string): M3Progress {
  return {
    subject: progress.subject,
    distinct: [...new Set([...progress.distinct, ...batch])].sort((a, b) => a - b),
    rounds: progress.rounds + 1,
    history: [...progress.history, { at, operationIds: [...batch], outcome: 'DISTINCT' as const }].slice(-M3_PROGRESS_HISTORY),
  };
}
