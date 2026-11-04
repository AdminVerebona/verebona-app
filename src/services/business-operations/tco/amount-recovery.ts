/**
 * Lot 108B — RÉCUPÉRATION AUTOMATIQUE DES MONTANTS INCONNUS avant toute
 * alerte du TCO (ticket TCO-646 §B, message « Des justificatifs de dépense
 * n’ont pas de montant lisible… »). FONCTIONS PURES : aucune base, aucun
 * modèle — le contrôle de cohérence `COH-TCO-AMOUNT-RECOVERY` les applique
 * (`amount-recovery.service.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PO : un montant financier manquant déclenche D'ABORD une tentative
 * de récupération automatique ; une demande à l'utilisateur est un dernier
 * recours. Chaîne, pour un justificatif financier dont le moteur TCO ne
 * connaît pas le montant (`AMOUNT_UNKNOWN` de `qualifyDocumentLines`) :
 *
 *   1. sources PERSISTÉES, sans IA : extraction T1 (montant du document),
 *      unité « montant » de la couche A, candidats T1 non établis, composante
 *      d'un événement de référence qui ne cite QUE ce document, total lu dans
 *      la transcription persistée (rôles `projection/amount-roles.ts`, lot
 *      107 : total TTC ≠ HT ≠ TVA ≠ remise ≠ acompte ≠ paiement) ;
 *   2. un SEUL montant établi, sans contradiction → posé sur le document
 *      (jamais sur une saisie de l'utilisateur), avec sa preuve et sa
 *      provenance ; le TCO (recalculé à la lecture) le compte une fois ;
 *   3. sinon → relance T1 sur le document ORIGINAL par la file T1 existante
 *      (traitement technique, non facturé), au plus `maxPerFingerprint` fois
 *      par empreinte (fichier, configuration T1, règles) et `maxTotal` fois
 *      au total : une source, un modèle ou un traitement qui évolue rouvre
 *      une tentative ; jamais à la consultation ;
 *   4. après relance : montant retrouvé (RECOVERED, provenance T1), échec
 *      technique (Supervision BO), ou échec réel → « Montant à confirmer »
 *      (contradiction / rôle incertain) ou « Montant introuvable ».
 * Jamais de montant inventé, jamais « inconnu » assimilé à 0.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version des règles de récupération : la changer rouvre une tentative (empreinte). */
export const AMOUNT_RECOVERY_RULES_VERSION = '108b.1';

/** Paramètres centralisés (variables d'environnement documentées dans la recette 108B). */
export interface AmountRecoveryLimits {
  /** Relances T1 par empreinte (fichier × configuration T1 × règles). */
  maxPerFingerprint: number;
  /** Relances T1 au total pour un document (toutes empreintes). */
  maxTotal: number;
  /** Échecs techniques tolérés avant de demander le montant à l'utilisateur. */
  maxTechnicalFailures: number;
  /** Délai minimal entre deux relances après un échec technique (heures). */
  technicalBackoffHours: number;
}

const envInt = (env: Record<string, string | undefined>, k: string, d: number, min = 0): number => {
  const v = env[k];
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? Math.max(min, Math.trunc(n)) : d;
};

export function amountRecoveryLimits(env: Record<string, string | undefined> = process.env): AmountRecoveryLimits {
  return {
    maxPerFingerprint: envInt(env, 'TCO_AMOUNT_RECOVERY_T1_PER_FINGERPRINT', 1),
    maxTotal: envInt(env, 'TCO_AMOUNT_RECOVERY_T1_MAX', 3),
    maxTechnicalFailures: envInt(env, 'TCO_AMOUNT_RECOVERY_TECHNICAL_MAX', 3, 1),
    technicalBackoffHours: envInt(env, 'TCO_AMOUNT_RECOVERY_BACKOFF_HOURS', 6),
  };
}

/** Provenance d'un montant candidat. */
export type AmountSourceKind =
  | 'T1_EXTRACTION' | 'T1_METADATA_UNIT' | 'T1_CANDIDATE' | 'OPERATION_COMPONENT' | 'SOURCE_TEXT_TOTAL' | 'T1_RELAUNCH';

/**
 * Rôle du montant dans le justificatif. Seuls TOTAL_TTC, DOCUMENT_TOTAL,
 * DEPOSIT, BALANCE et CREDIT_NOTE peuvent devenir le montant du document ;
 * les autres sont des PROPOSITIONS (jamais écrites).
 */
export type AmountRecoveryRole =
  | 'DOCUMENT_TOTAL' | 'TOTAL_TTC' | 'DEPOSIT' | 'BALANCE' | 'CREDIT_NOTE'
  | 'TOTAL_HT' | 'TAX' | 'PAYMENT' | 'DISCOUNT' | 'LINE';

const ROLES_MONTANT_DU_DOCUMENT: ReadonlySet<AmountRecoveryRole> = new Set(['DOCUMENT_TOTAL', 'TOTAL_TTC', 'DEPOSIT', 'BALANCE', 'CREDIT_NOTE']);

export interface AmountSourceCandidate {
  kind: AmountSourceKind;
  /** Centimes ; le signe d'un avoir est porté par le rôle, jamais par la valeur (valeur absolue). */
  cents: number;
  currency: string | null;
  role: AmountRecoveryRole;
  /** certain / probable / conflictual (T1), ou `corroborated` (texte recoupé). */
  confidence: 'certain' | 'probable' | 'conflictual' | 'uncorroborated';
  /** Référence de la preuve (unité de la couche A, extraction, candidat, composante). */
  ref: string;
}

/** Statut persisté (`document_amount_recoveries.status`). */
export type AmountRecoveryStatus = 'PENDING' | 'T1_PENDING' | 'RECOVERED' | 'TO_CONFIRM' | 'NOT_FOUND' | 'TECHNICAL_FAILURE' | 'USER_OWNED';

export interface AmountRecoveryRow {
  status: AmountRecoveryStatus;
  fingerprint: string | null;
  fingerprintAttempts: number;
  totalAttempts: number;
  technicalFailures: number;
  lastRequestedAt: string | null;
}

export interface AmountRecoveryInput {
  fileId: number;
  /** Le moteur TCO ne connaît pas le montant (`AMOUNT_UNKNOWN`). */
  amountUnknown: boolean;
  /** Montant courant du document. */
  amountCents: number | null;
  /** Montant marqué « modifié par l'utilisateur » (jamais remplacé). */
  userEditedAmount: boolean;
  /** État d'analyse du document (`asset_files.analysis_state`). */
  analysisState: string | null;
  /** Un travail T1 est en attente ou en cours pour ce document. */
  t1JobLive: boolean;
  /** Sources persistées examinées. */
  sources: readonly AmountSourceCandidate[];
  row: AmountRecoveryRow | null;
  /** Empreinte courante (fichier, configuration T1, règles). */
  fingerprint: string;
  /** Relance T1 permise pour ce compte (droits Premium / essai : le TCO y est visible). */
  t1Allowed: boolean;
  /** Budget de relances IA du contrôle encore disponible. */
  budgetLeft: boolean;
  now: Date;
  limits: AmountRecoveryLimits;
}

/** Action décidée (inspection en lecture seule ; écritures par le service). */
export type AmountRecoveryAction =
  /** Rien à faire (montant connu, document hors sujet). */
  | { kind: 'NONE'; state: AmountRecoveryStatus | null }
  /** Montant établi : écrire sur le document avec sa preuve. */
  | { kind: 'APPLY'; candidate: AmountSourceCandidate; corroboratedBy: AmountSourceCandidate[] }
  /** Montant apparu (relance T1 ou saisie) : consigner la provenance. */
  | { kind: 'RECORD_RESULT'; state: 'RECOVERED' | 'USER_OWNED'; amountCents: number | null }
  /** Relancer T1 sur le document original. */
  | { kind: 'RELAUNCH_T1'; attempt: number; retryAfterTechnical: boolean }
  /** Relance en cours : attendre (aucune action). */
  | { kind: 'WAIT'; state: 'T1_PENDING' | 'PENDING'; reason: string }
  /** Échec constaté (dernier recours : l'utilisateur ; ou échec technique). */
  | { kind: 'FAIL'; state: 'TO_CONFIRM' | 'NOT_FOUND' | 'TECHNICAL_FAILURE' | 'USER_OWNED'; reason: string; proposals: AmountSourceCandidate[] };

/** Montants candidats acceptables comme montant du document (rôle et confiance). */
export function acceptableSources(sources: readonly AmountSourceCandidate[]): AmountSourceCandidate[] {
  return sources.filter((s) => Number.isSafeInteger(s.cents) && s.cents > 0 && ROLES_MONTANT_DU_DOCUMENT.has(s.role)
    && (s.confidence === 'certain' || s.confidence === 'probable'));
}

/**
 * Montant ÉTABLI par les sources persistées : un seul montant (en valeur
 * absolue, même devise connue) parmi les sources acceptables, et AUCUNE source
 * acceptable ou incertaine qui le contredise sur le même rôle de document.
 * `null` : rien d'établi (absent, contradictoire, ou seulement incertain).
 */
export function establishedAmount(sources: readonly AmountSourceCandidate[]): { candidate: AmountSourceCandidate; corroboratedBy: AmountSourceCandidate[] } | { conflict: AmountSourceCandidate[] } | null {
  const ok = acceptableSources(sources);
  if (!ok.length) return null;
  const valeurs = new Set(ok.map((s) => s.cents));
  const devises = new Set(ok.map((s) => (s.currency ?? '').toUpperCase()).filter(Boolean));
  // Un montant incertain (conflictuel / non recoupé) de même rôle mais de valeur différente contredit aussi.
  const doutes = sources.filter((s) => ROLES_MONTANT_DU_DOCUMENT.has(s.role) && s.cents > 0 && !ok.includes(s) && !valeurs.has(s.cents));
  if (valeurs.size > 1 || devises.size > 1 || doutes.length) return { conflict: [...ok, ...doutes] };
  // Rôles d'un même montant contradictoires (acompte ici, solde là) : à confirmer.
  const roles = new Set(ok.map((s) => (s.role === 'DOCUMENT_TOTAL' || s.role === 'TOTAL_TTC' ? 'TOTAL' : s.role)));
  if (roles.size > 1) return { conflict: ok };
  // Préférence de la preuve écrite : extraction T1 > unité T1 > composante > candidat > texte recoupé.
  const rang: Record<AmountSourceKind, number> = { T1_EXTRACTION: 0, T1_METADATA_UNIT: 1, OPERATION_COMPONENT: 2, T1_CANDIDATE: 3, SOURCE_TEXT_TOTAL: 4, T1_RELAUNCH: 5 };
  const tri = [...ok].sort((a, b) => rang[a.kind] - rang[b.kind] || a.ref.localeCompare(b.ref));
  return { candidate: tri[0], corroboratedBy: tri.slice(1) };
}

/** Relance T1 encore permise (tentatives par empreinte et au total). */
export function t1AttemptsLeft(row: AmountRecoveryRow | null, fingerprint: string, limits: AmountRecoveryLimits): { allowed: boolean; attempt: number } {
  const total = row?.totalAttempts ?? 0;
  const surEmpreinte = row && row.fingerprint === fingerprint ? row.fingerprintAttempts : 0;
  return { allowed: total < limits.maxTotal && surEmpreinte < limits.maxPerFingerprint, attempt: total + 1 };
}

/**
 * Décision pour UN document (pure, testée L108B-U-*). Ordre : montant
 * apparu → décision utilisateur → relance en cours → sources persistées →
 * relance T1 → échec (technique ou réel).
 */
export function planAmountRecovery(x: AmountRecoveryInput): AmountRecoveryAction {
  const row = x.row;
  // Montant désormais connu du moteur (montant du document ou indices T1 établis après la relance) :
  // consigner l'issue d'une récupération en cours (provenance).
  if (!x.amountUnknown) {
    if (row && row.status !== 'RECOVERED' && row.status !== 'USER_OWNED') {
      return { kind: 'RECORD_RESULT', state: x.userEditedAmount ? 'USER_OWNED' : 'RECOVERED', amountCents: x.amountCents };
    }
    return { kind: 'NONE', state: row?.status ?? null };
  }
  // Montant retiré par l'utilisateur : jamais remplacé automatiquement (dernier recours : lui).
  if (x.userEditedAmount) return { kind: 'FAIL', state: 'USER_OWNED', reason: 'USER_CLEARED_AMOUNT', proposals: [...x.sources] };

  // Analyse en cours (dépôt, relance) : attendre son issue — jamais deux analyses.
  if (x.t1JobLive || x.analysisState === 'UPLOADED' || x.analysisState === 'ANALYZING') {
    return { kind: 'WAIT', state: row?.status === 'T1_PENDING' ? 'T1_PENDING' : 'PENDING', reason: 'ANALYSIS_IN_PROGRESS' };
  }

  const etabli = establishedAmount(x.sources);
  if (etabli && 'candidate' in etabli) return { kind: 'APPLY', candidate: etabli.candidate, corroboratedBy: etabli.corroboratedBy };

  // Issue technique de la dernière relance (le document est en échec d'analyse).
  const echecTechnique = row?.status === 'T1_PENDING' && x.analysisState === 'ANALYSIS_FAILED';
  const echecsTech = (row?.technicalFailures ?? 0) + (echecTechnique ? 1 : 0);
  const propositions = etabli && 'conflict' in etabli ? etabli.conflict : x.sources.filter((s) => s.cents > 0);

  const tentatives = t1AttemptsLeft(row, x.fingerprint, x.limits);
  if (echecTechnique || row?.status === 'TECHNICAL_FAILURE') {
    if (echecsTech >= x.limits.maxTechnicalFailures) {
      return { kind: 'FAIL', state: 'TO_CONFIRM', reason: 'TECHNICAL_FAILURES_EXHAUSTED', proposals: propositions };
    }
    const depuis = row?.lastRequestedAt ? x.now.getTime() - new Date(row.lastRequestedAt).getTime() : Infinity;
    const attendu = depuis >= x.limits.technicalBackoffHours * 3_600_000;
    // Reprise technique : ne consomme pas de tentative « métier » (même empreinte), bornée par `maxTechnicalFailures`.
    if (attendu && x.t1Allowed && x.budgetLeft && !echecTechnique) return { kind: 'RELAUNCH_T1', attempt: row?.totalAttempts ?? 1, retryAfterTechnical: true };
    return { kind: 'FAIL', state: 'TECHNICAL_FAILURE', reason: echecTechnique ? 'T1_RELAUNCH_FAILED' : 'TECHNICAL_RETRY_DEFERRED', proposals: propositions };
  }

  if (tentatives.allowed && x.t1Allowed) {
    if (!x.budgetLeft) return { kind: 'WAIT', state: 'PENDING', reason: 'T1_BUDGET_EXHAUSTED' };
    return { kind: 'RELAUNCH_T1', attempt: tentatives.attempt, retryAfterTechnical: false };
  }
  // Dernier recours : l'utilisateur. Montants trouvés mais non établis → « à confirmer » ; rien → « introuvable ».
  if (propositions.length) return { kind: 'FAIL', state: 'TO_CONFIRM', reason: etabli ? 'AMOUNTS_CONTRADICTORY' : 'AMOUNT_ROLE_UNCERTAIN', proposals: propositions };
  return { kind: 'FAIL', state: 'NOT_FOUND', reason: x.t1Allowed ? 'NO_AMOUNT_AFTER_T1' : 'NO_AMOUNT_T1_NOT_ALLOWED', proposals: [] };
}

// ── Lecture du total dans la transcription persistée (rôles du lot 107) ────

/** Forme minimale du profil `projection/amount-roles#ReceiptProfile` utilisée ici. */
export interface ReceiptProfileLike {
  summaries: ReadonlyArray<{ role: string; cents: number; unitId: string | null }>;
  articles: ReadonlyArray<{ netCents: number; refund: boolean }>;
  reconciled: boolean;
}

/**
 * Montants de synthèse lus dans la transcription persistée, typés par leur
 * rôle (TOTAL_TTC, TOTAL_HT, TAX, PAYMENT, DEPOSIT, DISCOUNT). Un total TTC
 * n'est « recoupé » que si la source le démontre : somme des lignes, HT + TVA,
 * ou paiement du même montant. Un total non recoupé reste une proposition.
 * Un justificatif portant un acompte : aucun total n'est tenu pour le montant
 * du document (acompte / solde à confirmer).
 */
export function textTotalsOfProfile(p: ReceiptProfileLike | null, currency: string | null): AmountSourceCandidate[] {
  if (!p) return [];
  const out: AmountSourceCandidate[] = [];
  const parRole = (r: string) => p.summaries.filter((s) => s.role === r && s.cents > 0);
  const totaux = [...new Map(parRole('TOTAL_PAID').map((s) => [s.cents, s])).values()];
  const ht = parRole('SUBTOTAL');
  const tva = parRole('TAX');
  const paiements = parRole('PAYMENT');
  const acompte = parRole('DEPOSIT').length > 0;
  const ref = (s: { unitId: string | null }, i: number) => `unit:${s.unitId ?? `ligne-${i}`}`;
  totaux.forEach((t, i) => {
    const recoupe = totaux.length === 1 && !acompte && (p.reconciled
      || ht.some((h) => tva.some((v) => Math.abs(h.cents + v.cents - t.cents) <= 1))
      || paiements.some((x) => x.cents === t.cents));
    out.push({ kind: 'SOURCE_TEXT_TOTAL', cents: t.cents, currency, role: 'TOTAL_TTC', confidence: recoupe ? 'probable' : 'uncorroborated', ref: ref(t, i) });
  });
  const propose = (r: string, role: AmountRecoveryRole) => parRole(r).forEach((s, i) => out.push({ kind: 'SOURCE_TEXT_TOTAL', cents: s.cents, currency, role, confidence: 'uncorroborated', ref: ref(s, i) }));
  propose('SUBTOTAL', 'TOTAL_HT');
  propose('TAX', 'TAX');
  propose('DEPOSIT', 'DEPOSIT');
  if (!totaux.length) propose('PAYMENT', 'PAYMENT');
  return out;
}

/** Rôle d'un indice financier T1 (`financialHints`) comme montant du document. */
export function roleOfHint(role: string, scope: string | null): AmountRecoveryRole | null {
  if (role === 'REDUCTION' || role === 'REFUND') return scope === 'TOTAL' || scope == null ? 'CREDIT_NOTE' : null;
  if (role !== 'REALIZED_COST') return role === 'PAYMENT' ? 'PAYMENT' : null;
  if (scope === 'DEPOSIT') return 'DEPOSIT';
  if (scope === 'BALANCE') return 'BALANCE';
  if (scope === 'TOTAL' || scope == null) return 'TOTAL_TTC';
  return null;
}

// ── Vue du TCO (fiche du bien) ─────────────────────────────────────────────

/** État présenté à l'utilisateur pour un justificatif sans montant. */
export type AmountRecoveryViewState = 'IN_PROGRESS' | 'TO_CONFIRM' | 'NOT_FOUND';

export interface AmountRecoveryViewItem {
  fileId: number;
  title: string;
  state: AmountRecoveryViewState;
}

export interface TcoAmountRecoveryView {
  items: AmountRecoveryViewItem[];
  inProgress: number;
  toConfirm: number;
  notFound: number;
}

/**
 * État présenté (pure). Pas d'état persisté : le contrôle n'est pas encore
 * passé → « en cours » (la campagne quotidienne et le contrôle ciblé à
 * l'analyse le garantissent). Un échec TECHNIQUE reste « en cours » tant que
 * des reprises sont permises (jamais une faute de l'utilisateur), puis le
 * montant lui est demandé (« à confirmer »).
 */
export function viewStateOf(row: Pick<AmountRecoveryRow, 'status' | 'technicalFailures'> | null, limits: Pick<AmountRecoveryLimits, 'maxTechnicalFailures'>): AmountRecoveryViewState {
  if (!row) return 'IN_PROGRESS';
  switch (row.status) {
    case 'TO_CONFIRM': case 'USER_OWNED': return 'TO_CONFIRM';
    case 'NOT_FOUND': return 'NOT_FOUND';
    case 'TECHNICAL_FAILURE': return row.technicalFailures >= limits.maxTechnicalFailures ? 'TO_CONFIRM' : 'IN_PROGRESS';
    default: return 'IN_PROGRESS';
  }
}

export const AMOUNT_RECOVERY_VIEW_LABELS: Readonly<Record<AmountRecoveryViewState, { title: string; text: string; action: string | null }>> = {
  IN_PROGRESS: {
    title: 'Lecture du montant en cours',
    text: 'Verebona relit automatiquement ce justificatif pour retrouver son montant. Le coût sera mis à jour dès que la lecture aboutit : rien à faire pour l’instant.',
    action: null,
  },
  TO_CONFIRM: {
    title: 'Montant à confirmer',
    text: 'Plusieurs montants possibles, ou un montant incertain, ont été lus sur ce justificatif. Ouvrez-le pour indiquer le bon montant.',
    action: 'Ouvrir le justificatif pour indiquer le montant',
  },
  NOT_FOUND: {
    title: 'Montant introuvable',
    text: 'Le montant de ce justificatif n’a pas pu être lu, même après une nouvelle lecture. Ouvrez-le pour saisir le montant.',
    action: 'Ouvrir le justificatif pour saisir le montant',
  },
};

/**
 * Avertissements du TCO après récupération (pure) : l'alerte « montant
 * illisible » (`AMOUNTS_UNKNOWN`) n'est levée qu'après un ÉCHEC réel ; tant
 * que la récupération est en cours, avertissement neutre
 * `AMOUNTS_RECOVERY_PENDING` (non montré comme alerte). Le statut du TCO
 * reste INCOMPLETE (le montant est réellement inconnu) — jamais « complet ».
 */
export function warningsAfterRecovery<W extends string>(warnings: readonly W[], view: TcoAmountRecoveryView): W[] {
  if (!warnings.includes('AMOUNTS_UNKNOWN' as W) || !view.items.length) return [...warnings];
  const out = warnings.filter((w) => w !== ('AMOUNTS_UNKNOWN' as W));
  if (view.toConfirm + view.notFound > 0) out.push('AMOUNTS_UNKNOWN' as W);
  if (view.inProgress > 0) out.push('AMOUNTS_RECOVERY_PENDING' as W);
  return out;
}
