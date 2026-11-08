/**
 * Lot 113AB (Trello #725, §2 D et §3) — PÉRIODES MÉTIER SUR LES SURFACES :
 * fiche de l'événement de référence (y compris sans élément d'agenda),
 * détail d'une dépense, Assistant (T2) et dossiers / exports utilisateur.
 * PUR (aucune dépendance serveur) : textes et mises en forme partagés par
 * les écrans (desktop et mobile), la récupération T2 et les mappeurs V12.
 *
 * Les libellés des périodes eux-mêmes (« Période couverte : du… au… »…)
 * viennent du module du lot 113W (`business-periods.ts`, propriété 113AA) :
 * on ne les réécrit jamais ici. Ce module ne fait qu'ASSEMBLER des faits
 * déjà qualifiés :
 *   · aucune comparaison avec la date du jour (jamais « en cours »,
 *     « expiré », « dernière période connue ») ;
 *   · aucune prolongation : une couverture n'est citée que si un
 *     justificatif l'établit ; la phrase « aucune prolongation déduite » est
 *     un FAIT explicite pour T2 (reconduction tacite ≠ couverture, D5) ;
 *   · le mot « Opération » n'apparaît jamais (« événement de référence »).
 *
 * Textes nouveaux : « à valider par le PO » (recette 113AB).
 */

/** Titre de la fiche de l'événement de référence (à valider par le PO). */
export const REFERENCE_EVENT_TITLE = 'Événement de référence';
/** Rubrique des justificatifs de l'événement de référence (à valider par le PO). */
export const REFERENCE_EVENT_DOCUMENTS_TITLE = 'Justificatifs';
/** Lien vers l'élément d'agenda relié, quand il existe (à valider par le PO). */
export const REFERENCE_EVENT_AGENDA_LINK = 'Ouvrir dans l’agenda';
/** Message d'une fiche devenue introuvable (à valider par le PO). */
export const REFERENCE_EVENT_NOT_FOUND = 'Impossible d’ouvrir cet événement de référence : il a peut-être été regroupé ou supprimé.';

/**
 * Faits explicites fournis à T2 (à valider par le PO) — jamais un statut,
 * jamais une prolongation : « couverture établie du … au … ».
 */
export const T2_COVERAGE_PREFIX = 'Périodes de couverture établies par les justificatifs';
export const T2_NO_EXTENSION = 'aucune prolongation n’est déduite (une reconduction tacite n’établit pas de nouvelle période)';
export const T2_USER_CORRECTED = 'corrigée par l’utilisateur';
export const T2_NO_COVERAGE = 'aucune période de couverture établie par un justificatif';

export interface SurfacePeriodLine {
  /** Libellé déjà formé par `periodLine` (lot 113W). */
  line: string;
  userCorrected?: boolean;
  /** Titre du justificatif (historique de couverture). */
  documentTitle?: string | null;
  /**
   * Lot 113AC (D11, 113AA) : période REMPLACÉE (avenant, rectificatif, choix de l'utilisateur) ou en
   * CONFLICT entre justificatifs — jamais présentée comme établie. `note` : texte de la fiche.
   */
  resolution?: { status: 'REPLACED' | 'CONFLICT'; note: string };
  /** Lot 113AC : autres justificatifs du MÊME fait (sources réunies). */
  otherSources?: ReadonlyArray<{ documentTitle: string }>;
}

/**
 * Lot 113AC — faits D11 fournis à T2 (à valider par le PO) : une période en conflit n'est jamais
 * choisie ; une période remplacée est citée comme historique, avec la raison de la fiche.
 */
export const T2_CONFLICT_PREFIX = 'Périodes différentes selon les justificatifs';
export const T2_CONFLICT_UNSETTLED = 'aucune n’est retenue tant que ce point n’est pas tranché';
export const T2_HISTORY_PREFIX = 'Historique (périodes remplacées)';
export const T2_DOC_REPLACED = 'période remplacée';

/** « Période couverte : du 01/04/2025 au 31/03/2026 » → « du 01/04/2025 au 31/03/2026 » (pure). */
export function periodBody(line: string): string {
  const i = line.indexOf(' : ');
  return i === -1 ? line : line.slice(i + 3);
}

/**
 * Faits de couverture d'un événement de référence, en une phrase destinée à
 * T2 et aux sources consultables (pure). Rien à dire : `null` (le contenu
 * existant de la source reste inchangé, jamais « aucune couverture » inventé
 * pour un événement qui n'en a pas le sens).
 */
export function coverageFactsText(coverages: readonly SurfacePeriodLine[]): string | null {
  if (!coverages.length) return null;
  const item = (c: SurfacePeriodLine, withNote = false) => {
    const titres = [c.documentTitle, ...(c.otherSources ?? []).map((o) => o.documentTitle)].filter((t): t is string => !!t);
    return [
      periodBody(c.line),
      titres.length === 1 ? ` (justificatif : ${titres[0]})` : titres.length > 1 ? ` (justificatifs : ${titres.join(' ; ')})` : '',
      c.userCorrected ? `, ${T2_USER_CORRECTED}` : '',
      withNote && c.resolution ? ` — ${c.resolution.note}` : '',
    ].join('');
  };
  const etablies = coverages.filter((c) => !c.resolution);
  const conflits = coverages.filter((c) => c.resolution?.status === 'CONFLICT');
  const remplacees = coverages.filter((c) => c.resolution?.status === 'REPLACED');
  const blocs = [
    etablies.length ? `${T2_COVERAGE_PREFIX} : ${etablies.map((c) => item(c)).join(' ; ')}` : null,
    // Lot 113AC (D11) : jamais une période choisie parmi des justificatifs divergents.
    conflits.length ? `${T2_CONFLICT_PREFIX} : ${conflits.map((c) => item(c)).join(' ; ')} — ${T2_CONFLICT_UNSETTLED}` : null,
    // Lot 113AC : la période retenue est celle du document remplaçant ; l'ancienne est citée comme historique.
    remplacees.length ? `${T2_HISTORY_PREFIX} : ${remplacees.map((c) => item(c, true)).join(' ; ')}` : null,
  ].filter(Boolean);
  return `${blocs.join(' · ')} — ${T2_NO_EXTENSION}`;
}

/**
 * Périodes d'un document en une phrase (pure) : période principale puis
 * détails — pour l'extrait de source T2. Les libellés sont ceux de la fiche.
 */
export function documentPeriodsText(p: { principal: SurfacePeriodLine & { segments?: readonly SurfacePeriodLine[] } | null; secondary: readonly SurfacePeriodLine[] }): string | null {
  const parts: string[] = [];
  if (p.principal) {
    const segs = p.principal.segments ?? [];
    parts.push(segs.length > 1
      ? `${p.principal.line} (${segs.map((s) => periodBodyWithMark(s)).join(' ; ')})`
      : withMark(p.principal.line, segs[0]?.userCorrected ?? p.principal.userCorrected, segs[0]?.resolution ?? p.principal.resolution));
  }
  for (const s of p.secondary) parts.push(withMark(s.line, s.userCorrected, s.resolution));
  return parts.length ? parts.join(' · ') : null;
}

const withMark = (line: string, corrected?: boolean, resolution?: SurfacePeriodLine['resolution']) => {
  const marques = [
    corrected ? T2_USER_CORRECTED : null,
    // Lot 113AC (D11) : une couverture non établie n'est jamais dite sans réserve.
    resolution?.status === 'CONFLICT' ? T2_CONFLICT_PREFIX.toLowerCase() : resolution?.status === 'REPLACED' ? `${T2_DOC_REPLACED} : ${resolution.note}` : null,
  ].filter(Boolean);
  return marques.length ? `${line} (${marques.join(' ; ')})` : line;
};
const periodBodyWithMark = (s: SurfacePeriodLine) => withMark(s.line, s.userCorrected, s.resolution);

/**
 * Ligne d'un justificatif dans un dossier / export utilisateur (pure) : la
 * période principale telle qu'affichée sur la fiche, ou rien. Jamais les
 * Notes / Description (113Z), jamais une période secondaire.
 */
export function exportPeriodDetail(principalLine: string | null | undefined): string | null {
  const l = (principalLine ?? '').trim();
  return l ? l : null;
}
