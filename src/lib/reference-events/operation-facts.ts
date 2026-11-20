/**
 * Carte Trello #806, volet B §8 (CDC « Opérations / Agenda V2.0 » §5, §14,
 * §18 ; AC41 à AC43) — FAITS QUALIFIÉS de la fiche d'une opération : type,
 * montants par nature, source de chaque fait, valeurs différentes relevées.
 * PUR (aucune dépendance serveur) : partagé par la lecture de la fiche, la
 * page et les tests.
 *
 * Rien n'est calculé de nouveau : les montants sont les composantes ACTIVES
 * du moteur financier existant, regroupées par NATURE (jamais additionnées
 * entre natures : un devis n'est pas une dépense, une indemnité n'est pas un
 * coût) ; les sources et les valeurs différentes sont celles que la
 * consolidation a déjà enregistrées (`attribute_provenance`). Aucune IA,
 * aucune écriture, aucune date ni aucun montant inventés.
 *
 * Vocabulaire (décision du PO du 17/11/2026, carte #806 §1) : textes NOUVEAUX,
 * « à valider par le PO » (fiche de recette 116C, §8).
 */

/** Fait daté ou désigné d'une opération dont la source est connue. */
export type OperationFactField = 'PLANNED' | 'START' | 'REALIZED' | 'END' | 'PROVIDER';

/** Colonne de provenance enregistrée par la consolidation → fait de la fiche. */
export const OPERATION_FACT_OF_PROVENANCE: Readonly<Record<string, OperationFactField>> = {
  plannedDate: 'PLANNED', startDate: 'START', realizedDate: 'REALIZED', endDate: 'END', provider: 'PROVIDER',
};

/** D'où vient la valeur affichée d'un fait. */
export interface OperationFactSource {
  field: OperationFactField;
  /** DOCUMENT : un justificatif (ouvrable) ; USER : saisie ou déclaration de l'utilisateur. */
  origin: 'DOCUMENT' | 'USER';
  fileId: number | null;
  title: string | null;
}

/** Valeurs DIFFÉRENTES relevées pour un même fait, avec les justificatifs qui les portent. */
export interface OperationFactConflict {
  field: OperationFactField;
  values: Array<{ value: string; sources: Array<{ fileId: number; title: string }> }>;
  /** Valeur affichée par la fiche (null : aucune retenue). */
  retained: string | null;
  /**
   * L'écart reste À CONFIRMER (contradiction non résolue relevée par la consolidation : une question peut être posée
   * dans « À traiter »). Faux : différence déjà qualifiée (révision, même jour économique, valeur choisie) — consultable
   * seulement.
   */
  pending: boolean;
}

/** Montants d'UNE nature (composantes actives du moteur existant). */
export interface OperationAmount {
  kind: string;
  /** Nombre de composantes de cette nature. */
  count: number;
  /** Somme en centimes d'euro des composantes en euros ou à contre-valeur connue ; null : aucune. */
  eurCents: number | null;
  /** Composantes dans une autre devise SANS contre-valeur connue : jamais converties, jamais comptées. */
  unconverted: number;
}

/** Ordre d'affichage des natures (les coûts d'abord, puis ce qui les diminue). */
export const OPERATION_AMOUNT_KINDS = ['REALIZED_COST', 'FORECAST_COST', 'REDUCTION', 'REFUND', 'INDEMNITY', 'PROCEED'] as const;

export const OPERATION_FACT_LABELS = {
  type: 'Type',
  amountsTitle: 'Montants',
  amountKinds: {
    REALIZED_COST: 'Coûts réalisés',
    FORECAST_COST: 'Prévisions (devis, commandes, échéances à venir)',
    REDUCTION: 'Remises',
    REFUND: 'Remboursements',
    INDEMNITY: 'Indemnités',
    PROCEED: 'Produits (vente, reprise)',
  } as Readonly<Record<string, string>>,
  amountsNote: 'Ces montants viennent des justificatifs de cette opération. Les natures ne sont pas additionnées entre elles : une prévision n’est pas une dépense.',
  amountUnconverted: (n: number): string => (n === 1
    ? '1 montant dans une autre devise, non converti'
    : `${n} montants dans une autre devise, non convertis`),
  roomsTitle: 'Pièces',
  sourceDocument: (title: string): string => `Source : ${title}`,
  sourceUser: 'Source : votre saisie',
  openSource: (title: string): string => `Ouvrir le justificatif source : ${title}`,
  conflictsTitle: 'Valeurs différentes selon les justificatifs',
  conflictsHint: 'Ces justificatifs ne donnent pas la même valeur. La fiche affiche la valeur retenue ; vous pouvez la corriger avec « Corriger ».',
  conflictFields: {
    PLANNED: 'Date prévue', START: 'Date de début', REALIZED: 'Date de réalisation', END: 'Date de fin', PROVIDER: 'Prestataire',
  } as Readonly<Record<OperationFactField, string>>,
  conflictRetained: 'valeur affichée',
  conflictNoSource: 'sans justificatif consultable',
  conflictPending: 'À confirmer : une question peut vous être posée dans « À traiter ».',
  conflictPendingLink: 'Ouvrir « À traiter »',
  navTitle: 'Aller à',
  navAgenda: 'Mon agenda',
  navToProcess: 'À traiter',
  navDocuments: 'Mes documents',
  navOperations: 'Toutes les opérations',
} as const;

/** Adresses des écrans voisins de la fiche : la liste des opérations (carte #806) et trois écrans existants. */
export const OPERATION_NAV_ROUTES = { operations: '/agenda/evenements-reference', agenda: '/agenda', toProcess: '/accueil/a-traiter', documents: '/documents' } as const;

/**
 * Montants par nature (pur). Les composantes d'une même nature sont sommées en
 * euros quand elles sont en euros ou portent une contre-valeur ; les autres
 * sont comptées à part, jamais converties. Une nature sans composante n'est
 * pas rendue (aucune ligne à zéro inventée).
 */
export function operationAmountsOf(
  components: ReadonlyArray<{ kind: string; amountMinor: number; currency: string; amountEurCents: number | null }>,
): OperationAmount[] {
  const par = new Map<string, OperationAmount>();
  for (const c of components) {
    const a = par.get(c.kind) ?? { kind: c.kind, count: 0, eurCents: null, unconverted: 0 };
    a.count += 1;
    const eur = c.currency === 'EUR' ? c.amountMinor : c.amountEurCents;
    if (eur === null || eur === undefined || !Number.isFinite(eur)) a.unconverted += 1;
    else a.eurCents = (a.eurCents ?? 0) + eur;
    par.set(c.kind, a);
  }
  const ordre = OPERATION_AMOUNT_KINDS as readonly string[];
  return [...par.values()].sort((x, y) => {
    const ix = ordre.indexOf(x.kind);
    const iy = ordre.indexOf(y.kind);
    return (ix === -1 ? ordre.length : ix) - (iy === -1 ? ordre.length : iy) || x.kind.localeCompare(y.kind);
  });
}

/** Valeur d'un fait telle que la fiche l'écrit : une date `AAAA-MM-JJ` devient `JJ/MM/AAAA`, le reste est rendu tel quel. */
export function operationFactValueText(v: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v;
}
