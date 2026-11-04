/**
 * Suivi d'une « vérification incomplète » T1 — lot 53 (retour PO D19).
 * Module PUR (aucun accès base) : partagé par l'écriture de la couche A, la
 * reprise planifiée et l'écran BO › Exécutions IA › Complétude T1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE PAS QUALIFIER DE COMPLÈTE CE QUI N'EST PAS VÉRIFIÉ
 *
 * Une analyse dont la couverture du document original n'est pas vérifiable
 * est `VERIFICATION_INCOMPLETE`. Pour chaque document, le BO dit :
 *   · le MOTIF (source illisible, image, pages non vérifiées…) ;
 *   · les PAGES concernées quand elles sont connues ;
 *   · le STATUT (vérification incomplète, reprise programmée ou non) ;
 *   · la PROCHAINE ACTION de contrôle.
 *
 * REPRISE (organisée, jamais en boucle) :
 *   · source momentanément illisible (téléchargement en échec) : reprise
 *     AUTOMATIQUE — le document repasse dans la file T1 (relecture du
 *     fichier, traitement technique non annoncé), au plus
 *     `T1_COMPLETENESS_MAX_RETRIES` fois, délai croissant (tâche existante
 *     `t1-completeness-retry`) ;
 *   · autres motifs (image, PDF non sondable, pages scannées non citées,
 *     couverture reconstruite) : une relecture automatique ne lèverait pas
 *     l'incertitude et coûterait des appels IA — reprise MANUELLE depuis le
 *     BO (« Relancer l'analyse »), tracée sur la ligne de couverture.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Motifs de vérification (`SourceVerification.reason`) → libellé BO. */
const VERIFICATION_REASON_LABEL: Readonly<Record<string, string>> = {
  source_unreadable: 'fichier source momentanément illisible (téléchargement)',
  pdf_unreadable: 'PDF illisible ou corrompu : pages impossibles à compter',
  source_too_large: 'fichier trop volumineux pour être sondé',
  image_not_checkable: 'image ou scan : aucun texte original à confronter',
  image_without_content: 'image sans contenu lu',
  multiple_files: 'document composé de plusieurs fichiers',
  format_not_checkable: 'format non vérifiable page par page',
  pages_unverified: 'pages non vérifiées (scannées ou texte illisible, non citées)',
  backfill: 'couverture reconstruite d’une analyse antérieure, jamais confrontée au fichier',
};

/**
 * Lot 109K (COR-01) : motif exact PAR PAGE (`PageVerification.reason`) →
 * libellé BO. Une page MISSING est une omission objectivée (le texte original
 * de la page n'est pas dans la lecture T1) ; une page UNVERIFIABLE est un
 * échec technique du contrôle, jamais une perte prouvée.
 */
export const PAGE_REASON_LABEL: Readonly<Record<string, string>> = {
  text_matched: 'texte original retrouvé dans la lecture',
  empty_page: 'page vide',
  targeted_reread: 'page relue par une reprise ciblée',
  partial_match_cited: 'texte original partiellement retrouvé, page citée',
  single_page_partial_match: 'document d’une page, texte original partiellement retrouvé',
  text_absent_from_transcription: 'texte original absent de la lecture (omission)',
  page_absent_from_paginated_transcription: 'page absente de la lecture paginée (omission)',
  scanned_no_text_layer: 'page scannée sans couche texte : rien à confronter',
  text_not_decodable: 'texte de la page non décodable (police non lisible)',
  no_text_layer: 'page sans texte décodable (image ou dessin)',
  partial_match_not_cited: 'texte original trop partiellement retrouvé pour conclure',
  beyond_probe_limit: 'page au-delà de la limite de contrôle',
  probe_failed: 'contrôle de la page en échec technique',
};

interface PageDetailInput { page: number; status: string; reason: string; method?: string }

/** Pages non vérifiées regroupées par motif, en mots simples (pure). */
export function pageReasonsText(details: readonly PageDetailInput[] | null | undefined): string | null {
  const groupes = new Map<string, number[]>();
  for (const d of details ?? []) {
    if (d.status === 'VERIFIED') continue;
    const l = groupes.get(d.reason) ?? [];
    l.push(d.page);
    groupes.set(d.reason, l);
  }
  if (groupes.size === 0) return null;
  return [...groupes.entries()].map(([r, pages]) => `${pages.length > 1 ? 'pages' : 'page'} ${pages.slice(0, 10).join(', ')}${pages.length > 10 ? '…' : ''} : ${PAGE_REASON_LABEL[r] ?? r}`).join(' ; ');
}

/** Motifs pour lesquels une relecture AUTOMATIQUE du fichier peut lever l'incertitude. */
const AUTO_RETRY_REASONS: ReadonlySet<string> = new Set(['source_unreadable']);

interface VerificationFollowupInput {
  qualityState: string;
  sourceVerification?: string | null;
  verificationReason?: string | null;
  pagesUnverified?: readonly number[] | null;
  pagesExpected?: number | null;
  retryAttempts?: number;
  maxRetries?: number;
  /** Reprise automatique déjà programmée (`next_retry_at`). */
  retryScheduled?: boolean;
  /** Lot 109K : verdict par page (statut, motif). */
  pageDetails?: readonly PageDetailInput[] | null;
}

interface VerificationFollowup {
  /** Statut lisible. */
  status: string;
  /** Motif lisible. */
  reason: string;
  /** Pages concernées (connues), sinon null. */
  pages: number[] | null;
  /** Prochaine action de contrôle. */
  nextAction: string;
  /** Reprise automatique possible (motif transitoire, tentatives restantes). */
  autoRetry: boolean;
  /** Reprise manuelle proposée dans le BO. */
  manualRetry: boolean;
  /** Lot 109K : motif exact page par page (null : vérification antérieure, sans détail). */
  pageReasons: string | null;
}

/** Reprise automatique due pour ce document ? (pure) */
export function verificationAutoRetryDue(p: { qualityState: string; verificationReason?: string | null; retryAttempts?: number; maxRetries?: number }): boolean {
  return p.qualityState === 'VERIFICATION_INCOMPLETE'
    && AUTO_RETRY_REASONS.has(p.verificationReason ?? '')
    && (p.retryAttempts ?? 0) < (p.maxRetries ?? 2);
}

/**
 * Lot 54G (point 2) : une relecture du FICHIER reste-t-elle due ? Unités
 * NEEDS_SOURCE (plafond non atteint) et reprises automatiques restantes (pure).
 */
export function needsSourceRetryDue(p: { needsSourceUnits: number; retryAttempts: number; maxRetries: number }): boolean {
  return p.needsSourceUnits > 0 && p.retryAttempts < p.maxRetries;
}

/** Suivi d'un document `VERIFICATION_INCOMPLETE` ; `null` pour un autre état (pure). */
export function verificationFollowup(p: VerificationFollowupInput): VerificationFollowup | null {
  if (p.qualityState !== 'VERIFICATION_INCOMPLETE') return null;
  const motif = p.verificationReason ?? (p.sourceVerification === 'RECONSTRUCTED' ? 'backfill' : null);
  const pageReasons = pageReasonsText(p.pageDetails);
  const reason = (motif === 'pages_unverified' && pageReasons) || ((motif && VERIFICATION_REASON_LABEL[motif])
    ?? (p.sourceVerification === 'UNVERIFIABLE' ? 'source non vérifiable' : 'couverture de la source non vérifiée'));
  const pages = p.pagesUnverified && p.pagesUnverified.length > 0 ? [...p.pagesUnverified].sort((a, b) => a - b) : null;
  const autoRetry = verificationAutoRetryDue({
    qualityState: p.qualityState, verificationReason: motif, retryAttempts: p.retryAttempts, maxRetries: p.maxRetries,
  });
  let nextAction: string;
  if (autoRetry) {
    nextAction = p.retryScheduled
      ? 'Relecture automatique du fichier programmée.'
      : 'Relecture automatique du fichier à programmer (prochain passage de la reprise T1).';
  } else if (pages) {
    nextAction = `Contrôler ${pages.length > 1 ? 'les pages' : 'la page'} ${pages.slice(0, 10).join(', ')}${pages.length > 10 ? '…' : ''} dans le document, puis relancer l’analyse si une information manque.`;
  } else if (motif === 'backfill') {
    nextAction = 'Relancer l’analyse pour confronter la couverture au fichier original, si ce document est utile.';
  } else if (motif === 'pdf_unreadable' || motif === 'source_too_large') {
    nextAction = 'Vérifier le fichier (ouverture, taille) ; si besoin, demander un nouveau dépôt puis relancer l’analyse.';
  } else {
    nextAction = 'Contrôler visuellement le document ; relancer l’analyse si une information manque.';
  }
  return {
    status: autoRetry ? 'vérification incomplète — reprise automatique' : 'vérification incomplète — contrôle manuel',
    reason, pages, nextAction, autoRetry, manualRetry: true, pageReasons,
  };
}
