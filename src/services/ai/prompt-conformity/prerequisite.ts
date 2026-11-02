/**
 * Lot 103G — prérequis d'exploitation de la mise en conformité des prompts
 * (compte technique de qualification) et SANTÉ FONCTIONNELLE d'un passage.
 * Module PUR (testé), sans accès base.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * BLOCAGE DE PRÉREQUIS ≠ REFUS DE NON-RÉGRESSION
 *
 * Une incompatibilité est « bloquée par un prérequis » quand sa qualification
 * n'a pas pu s'exécuter faute de compte technique utilisable :
 *   · refus amont de la campagne (précontrôle CORPUS_ACCOUNT_*) ;
 *   · cas du corpus refusés par la passerelle pour le compte technique
 *     (`ACCOUNT_INELIGIBLE`) — y compris l'HISTORIQUE antérieur au lot 103G
 *     (motif « cause non établie (ACCOUNT_INELIGIBLE…) » sur un cas `corpus:`),
 *     à condition qu'aucune régression ni aucun défaut n'ait été constaté et
 *     que la décision ne soit pas un refus (REFUSED).
 * Un vrai refus (régression, défaut, critère éliminatoire), un cas
 * obligatoire non concluant pour une autre raison, une couverture
 * insuffisante ou le verrou A1 fermé ne sont JAMAIS requalifiés en prérequis.
 *
 * REPRISE AUTOMATIQUE (bornée, idempotente, sans boucle) : quand le compte
 * redevient utilisable, une incompatibilité bloquée par ce prérequis est
 * réessayée au passage suivant — une fois par ÉTAT réparé du compte
 * (empreinte), au plus `CORPUS_ACCOUNT_PARAMS.maxAutoResumes` fois. Le bail
 * partagé du passage exclut toute campagne concurrente.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** État persistant (`ai_prompt_conformity_issues.prerequisite`, migration 0960). */
export interface IssuePrerequisite {
  /** Code du blocage en cours (null : aucun blocage en cours). */
  code?: string | null;
  label?: string | null;
  since?: string | null;
  /** Empreinte de l'état du compte constaté au blocage. */
  stateFingerprint?: string | null;
  /** Reprises automatiques déjà faites, et empreinte de l'état du compte de la dernière reprise. */
  resumes?: number;
  lastResumeStateFingerprint?: string | null;
  lastResumedAt?: string | null;
  /** Origine : précontrôle, cas bloqués en exécution, ou reconnaissance de l'historique. */
  stage?: 'PRECHECK' | 'EXECUTION' | 'LEGACY' | null;
  clearedAt?: string | null;
}

interface IssueLike {
  status: string;
  prerequisite?: IssuePrerequisite | Record<string, unknown> | null;
  qualification?: Record<string, unknown> | null;
}

/** Motif de cas non concluant dû au compte technique (formats lot 103G et antérieurs). */
export function isTechnicalAccountReason(reason: string): boolean {
  return /ACCOUNT_INELIGIBLE|CORPUS_ACCOUNT_|compte technique de (mesure|qualification)/i.test(reason);
}

/**
 * Historique antérieur au lot 103G : qualification non concluante dont des cas
 * du CORPUS ont été refusés pour le compte technique, sans régression ni défaut,
 * décision ≠ REFUSED. Pure.
 */
export function legacyPrerequisiteBlock(issue: IssueLike): boolean {
  if (issue.status !== 'BLOCKED') return false;
  const q = (issue.qualification ?? {}) as {
    decision?: string | null; refusal?: string | null;
    operations?: Array<{ regressions?: string[]; defects?: string[]; inconclusive?: string[] }>;
  };
  if (q.decision === 'REFUSED' || q.decision === 'QUALIFIED') return false;
  const ops = Array.isArray(q.operations) ? q.operations : [];
  if (ops.some((o) => (o.regressions?.length ?? 0) > 0 || (o.defects?.length ?? 0) > 0)) return false;
  const corpusBloque = ops.some((o) => (o.inconclusive ?? []).some((x) => /^corpus:/.test(x) && isTechnicalAccountReason(x)));
  return corpusBloque || (typeof q.refusal === 'string' && /CORPUS_ACCOUNT_/.test(q.refusal));
}

/** Blocage de prérequis en cours (stocké, sinon reconnu dans l'historique). Pure. */
export function currentPrerequisite(issue: IssueLike): IssuePrerequisite | null {
  const p = (issue.prerequisite ?? {}) as IssuePrerequisite;
  if (p.code) return p;
  if (legacyPrerequisiteBlock(issue)) return { ...p, code: 'CORPUS_ACCOUNT_LEGACY', label: 'compte technique non éligible lors de la dernière qualification (historique)', stage: 'LEGACY' };
  return null;
}

export type ResumeDecision =
  | { kind: 'NONE' }
  | { kind: 'WAIT'; message: string }
  | { kind: 'RESUME'; message: string }
  | { kind: 'EXHAUSTED'; message: string };

/**
 * Décision de reprise (pure) d'une incompatibilité bloquée par le prérequis.
 *   · compte non utilisable → WAIT (aucune candidate, aucune campagne) ;
 *   · utilisable, état réparé jamais repris, reprises < max → RESUME ;
 *   · déjà repris sur ce même état du compte → NONE (pas de boucle) ;
 *   · reprises épuisées → EXHAUSTED (seul « Nouvel essai » du BO relance).
 */
export function resumeDecision(issue: IssueLike, corpus: { ok: boolean; code: string; stateFingerprint: string } | null, maxResumes: number): ResumeDecision {
  const p = currentPrerequisite(issue);
  if (!p) return { kind: 'NONE' };
  if (!corpus || !corpus.ok) return { kind: 'WAIT', message: `En attente du prérequis : compte technique de qualification (${corpus?.code ?? p.code}).` };
  if ((p.resumes ?? 0) >= maxResumes) return { kind: 'EXHAUSTED', message: `Reprises automatiques épuisées (${p.resumes}/${maxResumes}) : « Nouvel essai » depuis le BO.` };
  if (p.lastResumeStateFingerprint && p.lastResumeStateFingerprint === corpus.stateFingerprint) return { kind: 'NONE' };
  return { kind: 'RESUME', message: `Reprise automatique : le compte technique de qualification est de nouveau utilisable (blocage ${p.code}).` };
}

// ══════════════════════════════════════════════════════════════════════════
// Synthèse et santé fonctionnelle d'un passage
// ══════════════════════════════════════════════════════════════════════════

export interface PassSummary {
  /** Incompatibilités suivies ouvertes (≠ résolues) après la détection. */
  detected: number;
  /** Éligibles à une correction à ce passage (prérequis de contrat satisfaits, prompt non occupé). */
  eligible: number;
  /** Déjà bloquées / en échec sur un contexte inchangé (aucun nouvel essai possible sans changement). */
  alreadyBlocked: number;
  /** En attente du prérequis d'exploitation (compte technique). */
  waitingPrerequisite: number;
  /** Lot 105B : qualifiées métier mais en attente du verrou A1 (manques structurels : import #601, approbations). */
  waitingA1: number;
  /** En attente d'un autre contrat (ordre du guide). */
  waitingContract: number;
  /** Surveillées seulement (aucun bloc officiel : jamais corrigées automatiquement). */
  monitoredOnly: number;
  /** Non essayées faute de place dans ce passage (AI_PROMPT_CONFORMITY_MAX_PER_PASS). */
  deferredByBudget: number;
  /** Essais réellement lancés à ce passage. */
  attempted: number;
  qualified: number;
  refused: number;
  activated: number;
  resolved: number;
  /** Reprises automatiques après réparation du prérequis. */
  resumed: number;
}

export const EMPTY_PASS_SUMMARY: PassSummary = Object.freeze({
  detected: 0, eligible: 0, alreadyBlocked: 0, waitingPrerequisite: 0, waitingA1: 0, waitingContract: 0, monitoredOnly: 0, deferredByBudget: 0,
  attempted: 0, qualified: 0, refused: 0, activated: 0, resolved: 0, resumed: 0,
}) as PassSummary;

export type PassHealthCode = 'HEALTHY' | 'PROGRESS' | 'BLOCKED_PREREQUISITE' | 'NO_CAPACITY' | 'NO_PROGRESS' | 'DETECTION_ONLY' | 'DISABLED';

export interface PassHealth {
  code: PassHealthCode;
  /** Sain fonctionnellement ? (distinct du succès TECHNIQUE de la tâche). */
  healthy: boolean;
  label: string;
  /** Motif systémique principal et prochain geste. */
  cause: string | null;
  nextAction: string | null;
}

/** Santé fonctionnelle (pure). « 12 incompatibilités, 0 tentative » n'est jamais « sain ». */
export function passHealth(p: {
  summary: PassSummary; mode: string; disabled?: string | null; maxPerPass: number;
  corpus?: { ok: boolean; code: string; label: string; nextAction: string | null } | null;
}): PassHealth {
  const s = p.summary;
  if (p.disabled || p.mode === 'off') return { code: 'DISABLED', healthy: false, label: 'mise en conformité inactive', cause: p.disabled ?? 'AI_PROMPT_CONFORMITY=off', nextAction: null };
  if (p.mode === 'detect' || p.mode === 'candidate') {
    return { code: 'DETECTION_ONLY', healthy: s.detected === 0, label: p.mode === 'detect' ? 'diagnostic seul (aucune correction)' : 'candidates seulement (aucune qualification ni activation)', cause: `AI_PROMPT_CONFORMITY=${p.mode}`, nextAction: null };
  }
  if (s.waitingPrerequisite > 0 && p.corpus && !p.corpus.ok) {
    return {
      code: 'BLOCKED_PREREQUISITE', healthy: false, label: `bloquée par un prérequis (${p.corpus.code})`,
      cause: `${p.corpus.label} : ${s.waitingPrerequisite} incompatibilité(s) en attente, aucune qualification possible`, nextAction: p.corpus.nextAction,
    };
  }
  if (p.maxPerPass <= 0 && s.detected > 0) {
    return { code: 'NO_CAPACITY', healthy: false, label: 'aucune correction possible (AI_PROMPT_CONFORMITY_MAX_PER_PASS=0)', cause: 'AI_PROMPT_CONFORMITY_MAX_PER_PASS=0 : le paramétrage empêche tout essai', nextAction: 'Remettre AI_PROMPT_CONFORMITY_MAX_PER_PASS à 1 (défaut) côté hébergeur, puis redémarrer.' };
  }
  if (s.attempted > 0) return { code: 'PROGRESS', healthy: true, label: `${s.attempted} essai(s) lancé(s)`, cause: null, nextAction: null };
  if (s.detected === 0) return { code: 'HEALTHY', healthy: true, label: 'aucune incompatibilité ouverte', cause: null, nextAction: null };
  const cause = s.waitingA1 > 0
    ? `${s.waitingA1} incompatibilité(s) qualifiée(s) métier, en attente du verrou A1 (corpus #601 incomplet ou références non approuvées) — aucun appel tant que ces manques subsistent`
    : s.alreadyBlocked > 0
    ? `${s.alreadyBlocked} incompatibilité(s) bloquée(s) sur un contexte inchangé (pas de nouvel essai sans changement ou décision)`
    : s.waitingContract > 0 ? `${s.waitingContract} incompatibilité(s) en attente d’un autre contrat du guide` : 'aucun essai lancé';
  return { code: 'NO_PROGRESS', healthy: false, label: `${s.detected} incompatibilité(s), aucun essai à ce passage`, cause, nextAction: 'BO › Configuration IA › Conformité des prompts : lire les motifs de chaque incompatibilité.' };
}

const HEALTH_WORD: Record<PassHealthCode, string> = {
  HEALTHY: 'SAINE', PROGRESS: 'EN PROGRÈS', BLOCKED_PREREQUISITE: 'BLOQUÉE (PRÉREQUIS)', NO_CAPACITY: 'BLOQUÉE (PARAMÉTRAGE)',
  NO_PROGRESS: 'SANS PROGRÈS', DETECTION_ONLY: 'DIAGNOSTIC SEUL', DISABLED: 'INACTIVE',
};

/** Note de la tâche planifiée (≤ 500 caractères conservés) : santé d'abord, puis compteurs distincts. */
export function passNote(h: PassHealth, s: PassSummary, extra: string[] = []): string {
  const comp = `${s.detected} détectée(s) · ${s.eligible} éligible(s) · ${s.alreadyBlocked} déjà bloquée(s) · ${s.waitingPrerequisite} en attente de prérequis`
    + `${s.waitingA1 ? ` · ${s.waitingA1} en attente du verrou A1` : ''}`
    + `${s.waitingContract ? ` · ${s.waitingContract} en attente d’un contrat` : ''} · ${s.attempted} essayée(s)${s.resumed ? ` (dont ${s.resumed} reprise(s) auto)` : ''}`
    + ` · ${s.qualified} qualifiée(s) · ${s.refused} refusée(s) · ${s.activated} activée(s) · ${s.resolved} résolue(s)`;
  return [`Santé : ${HEALTH_WORD[h.code]} — ${h.label}`, comp, h.cause && h.code !== 'PROGRESS' ? `cause : ${h.cause}` : null, h.nextAction ? `geste : ${h.nextAction}` : null, ...extra]
    .filter(Boolean).join(' · ');
}
