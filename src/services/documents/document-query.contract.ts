/**
 * Contrat commun de consultation documentaire — CDC 5 §8.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRAT POUR DEUX ÉCRANS
 *
 * Le §1.3 relève que « la page globale et l'onglet d'un bien possèdent des
 * implémentations distinctes », et demande de les unifier. Deux implémentations
 * du même besoin dérivent toujours : un filtre corrigé d'un côté, un compteur
 * calculé autrement de l'autre, et l'utilisateur voit deux vérités selon
 * l'écran d'où il regarde.
 *
 * Ce module définit donc UNE requête et UNE réponse. La page globale est le cas
 * `assetIds: []` ; l'onglet d'un bien est le cas `assetIds: [42]`. Rien d'autre
 * ne les distingue.
 *
 * ── CE QUI NE SORT JAMAIS D'ICI ───────────────────────────────────────────
 *
 * Le §8.2 est formel sur les scores de confiance : « jamais exposé au front
 * utilisateur ». Ils ne figurent donc pas dans le type de réponse — l'omission
 * est structurelle, pas une discipline à tenir à chaque route.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Tri unique, appliqué à toutes les catégories (§8.3). */
export type DocumentSort = 'createdAt' | 'documentDate' | 'title';
export type SortDirection = 'asc' | 'desc';

export interface DocumentQuery {
  accountId: number;
  /** Vide = page globale ; un ou plusieurs identifiants = onglet de bien(s). */
  assetIds?: number[];
  equipmentIds?: number[];
  /** Codes de catégorie. Vide = toutes. */
  categoryCodes?: string[];
  /** Codes de type documentaire. */
  typeCodes?: string[];
  /** `pdf` | `image` | `word` | `excel` | `web` | `autre`. */
  formats?: string[];
  /** Période sur `documentDate`, bornes incluses. */
  dateFrom?: string;
  dateTo?: string;
  /** Recherche plein texte. */
  search?: string;
  /** N'afficher que les documents à classer. */
  onlyToClassify?: boolean;
  sort?: DocumentSort;
  direction?: SortDirection;
  /** Documents par catégorie. Le §8.3 impose une pagination serveur. */
  pageSize?: number;
  /** Décalage, par code de catégorie. `__TO_CLASSIFY__` pour le groupe système. */
  offsets?: Record<string, number>;
}

/** Identifiant du groupe « À classer ». Jamais un code de catégorie (§2.2). */
export const TO_CLASSIFY_GROUP = '__TO_CLASSIFY__';

export interface DocumentAssociation {
  id: number;
  name: string;
  /** `asset` ou `equipment`. */
  kind: 'asset' | 'equipment';
}

export interface DocumentView {
  id: number;
  retainedTitle: string;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  /** Le document peut-il être prévisualisé sans téléchargement ? */
  previewable: boolean;
  createdAt: string;
  classification: {
    categoryCode: string | null;
    categoryLabel: string | null;
    classificationState: 'CLASSIFIED' | 'TO_CLASSIFY';
    // Volontairement absent : `categoryConfidence` et `typeConfidence` (§8.2).
  };
  associations: {
    assets: DocumentAssociation[];
    elements: DocumentAssociation[];
  };
}

export interface DocumentGroup {
  /** Code de catégorie, ou `__TO_CLASSIFY__`. */
  code: string;
  /** Libellé contextualisé quand un seul bien est ciblé (§3.3). */
  label: string;
  displayOrder: number;
  /** Nombre de documents du groupe APRÈS filtres (§8.3). */
  count: number;
  documents: DocumentView[];
  /** Reste-t-il des documents au-delà de la page servie ? */
  hasMore: boolean;
}

export interface DocumentListResponse {
  groups: DocumentGroup[];
  /** Total filtré, « incluant À classer » (§8.3). */
  totalCount: number;
  toClassifyCount: number;
  sort: DocumentSort;
  direction: SortDirection;
  pageSize: number;
}

/** Extensions reconnues par famille de format. */
const FORMAT_EXTENSIONS: Record<string, string[]> = {
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'tif', 'tiff'],
  word: ['doc', 'docx', 'odt', 'rtf'],
  excel: ['xls', 'xlsx', 'ods', 'csv'],
};

/**
 * Famille de format d'un fichier.
 *
 * Pure et exportée : c'est le filtre le plus susceptible de diverger entre
 * deux implémentations, chacune ajoutant ses extensions dans son coin.
 */
export function resolveFormat(fileName: string | null, mimeType: string | null): string {
  if (mimeType === 'text/html' || (!fileName && mimeType === null)) return 'web';

  const ext = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  for (const [format, extensions] of Object.entries(FORMAT_EXTENSIONS)) {
    if (extensions.includes(ext)) return format;
  }
  return 'autre';
}

/** Le document peut-il être prévisualisé dans le navigateur ? */
export function isPreviewable(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return mimeType === 'application/pdf' || mimeType.startsWith('image/');
}

/**
 * Titre affiché.
 *
 * Le §8.3 demande `retainedTitle`. Il n'est pas toujours renseigné — un
 * document déposé et non encore analysé n'en a pas. L'ordre de repli est fixé
 * ici, une fois, plutôt que dans chaque composant : sans quoi la page globale
 * et l'onglet d'un bien afficheraient des titres différents pour un même
 * document.
 */
export function resolveTitle(doc: {
  retainedTitle: string | null;
  webLinkTitle: string | null;
  originalFilename: string | null;
  fileName: string | null;
}): string {
  return (
    doc.retainedTitle?.trim() ||
    doc.webLinkTitle?.trim() ||
    doc.originalFilename?.trim() ||
    doc.fileName?.trim() ||
    'Document sans titre'
  );
}

/** Bornes de pagination, avec des valeurs sûres. */
export function normalizePagination(pageSize?: number): number {
  if (!pageSize || pageSize < 1) return 20;
  // Le §1.3 signale des quotas jusqu'à 225 documents. Un plafond évite qu'un
  // appelant ne demande l'intégralité d'un compte en une requête.
  return Math.min(pageSize, 100);
}

export function normalizeSort(sort?: string): DocumentSort {
  return sort === 'documentDate' || sort === 'title' ? sort : 'createdAt';
}

export function normalizeDirection(direction?: string): SortDirection {
  // §8.3 : « défaut createdAt DESC ».
  return direction === 'asc' ? 'asc' : 'desc';
}
