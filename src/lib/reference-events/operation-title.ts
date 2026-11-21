/**
 * Carte #813 — NOM d'un achat (opération ACQUISITION) et de son éventuel
 * événement d'Agenda. PUR (aucune dépendance serveur) : partagé par la
 * consolidation T3 (libellé enregistré), la projection T4 (titre d'un
 * événement d'achat légitime), les libellés de lecture (fiche, Timeline,
 * recherche, mobile) et les tests.
 *
 * Le nom dérive de la DÉSIGNATION réellement extraite du justificatif — le
 * sujet retenu par le moteur de titrage documentaire existant
 * (`planBusinessTitle`, persisté dans `asset_files.title_basis`) — jamais du
 * seul type « Achat », jamais du seul nom du bien, jamais d'un texte rédigé
 * pour l'occasion :
 *
 *   désignation « Polisport groovy coussin gris »  → « Achat Polisport groovy coussin gris »
 *   plusieurs articles, aucun intitulé d'ensemble  → « Achat Polisport groovy coussin gris et autres articles »
 *   aucune désignation                             → null : les replis EXISTANTS s'appliquent
 *                                                    (résumé du justificatif, titre du premier
 *                                                    justificatif, prestataire, puis type + bien)
 *
 * Le bien associé (« Vélo Jean Fourche ») est le rattachement : il n'entre
 * dans le nom qu'en DERNIER repli, quand rien ne dit ce qui a été acheté.
 *
 * Textes nouveaux : « à valider par le PO » (fiche de recette 116g).
 *
 * Carte #821 : le nom désigne l'OBJET réellement acheté (`acquisitionName`) —
 * désignation, sinon catégorie de dépense, sinon bien dont l'acquisition est
 * établie ; le bien associé et le fournisseur ne nomment jamais l'achat, et
 * le dernier repli « type + bien » ci-dessus ne vaut plus pour l'événement
 * d'Agenda (fiche de recette 116i).
 */

/** Nom utilisateur du type ACQUISITION (même mot que `referenceEventLabel` et le catalogue d'événements). */
export const ACQUISITION_TYPE_NAME = 'Achat';

/** Longueur maximale d'un nom d'achat (même borne que le complément d'un libellé d'opération). */
const MAX_NAME = 80;

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const propre = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/** Le texte dit-il déjà qu'il s'agit d'un achat (« Achat … », « Acquisition … ») ? */
export function startsWithAcquisitionName(text: string | null | undefined): boolean {
  const n = norm(propre(text));
  return /^(achat|achats|acquisition)( |$)/.test(n);
}

/**
 * Nom d'un achat depuis la désignation extraite (pure). `otherArticles` : le
 * justificatif porte d'autres articles et aucun intitulé d'ensemble.
 * Désignation absente, vide ou sans lettre : null (rien n'est inventé).
 */
export function acquisitionLabelFromDesignation(designation: string | null | undefined, o: { otherArticles?: boolean } = {}): string | null {
  const d = propre(designation);
  if (!d || !/\p{L}{2,}/u.test(d)) return null;
  const suite = o.otherArticles ? ' et autres articles' : '';
  const tete = startsWithAcquisitionName(d)
    ? d.charAt(0).toLocaleUpperCase('fr-FR') + d.slice(1)
    : `${ACQUISITION_TYPE_NAME} ${d}`;
  const coupe = tete.length > MAX_NAME - suite.length ? tete.slice(0, MAX_NAME - suite.length).replace(/\s+\S*$/, '') : tete;
  return `${coupe}${suite}`;
}

/**
 * Libellé de lecture d'un achat (pur) : « Achat Polisport groovy coussin
 * gris » tel qu'enregistré quand l'intitulé dit déjà « Achat » ; sinon la
 * forme existante « Achat — intitulé ». Jamais « Achat — Achat … ».
 */
export function acquisitionDisplayLabel(label: string): string {
  const t = propre(label).slice(0, MAX_NAME);
  return startsWithAcquisitionName(t) ? t : `${ACQUISITION_TYPE_NAME} — ${t}`;
}

/** L'intitulé n'est QUE le nom du type (« Achat », « Achats », « Acquisition ») : il ne dit pas ce qui a été acheté. */
export function isBareAcquisitionName(text: string | null | undefined): boolean {
  return /^(achat|achats|acquisition)$/.test(norm(propre(text)));
}

/**
 * Titre d'un événement d'Agenda d'achat LÉGITIME (pur).
 *
 * RÈGLE REMPLACÉE (carte #821) : l'événement porte l'intitulé de l'opération
 * quand il dit ce qui a été acheté ; sinon le libellé NEUTRE « Achat ». Les
 * replis de la carte #813 (« Achat — <prestataire> », « Achat — <bien> »)
 * sont retirés : ni le fournisseur ni le bien associé ne désignent l'objet de
 * l'achat (un plein de carburant rattaché à la Cupra n'est pas « Achat —
 * Cupra »). Le nom du bien n'entre dans le titre que par l'intitulé de
 * l'opération, quand l'acquisition du bien lui-même est établie
 * (`acquisitionName`, fondement `ASSET_ACQUISITION`).
 */
export function acquisitionEventTitle(o: { label: string | null }): string {
  const label = propre(o.label);
  return label && !isBareAcquisitionName(label) ? acquisitionDisplayLabel(label) : ACQUISITION_TYPE_NAME;
}

// ── Carte #821 : OBJET réellement acheté ────────────────────────────────────

/**
 * Carte #821 — fondement du nom d'un achat :
 *   DESIGNATION        désignation de l'objet acheté (moteur de titrage du justificatif) ;
 *   CATEGORY           seule une CATÉGORIE de dépense est établie (référentiel des dépenses d'usage) ;
 *   ASSET_ACQUISITION  l'acquisition du bien lui-même est établie (preuve canonique d'acquisition).
 */
export type AcquisitionNameBasis = 'DESIGNATION' | 'CATEGORY' | 'ASSET_ACQUISITION';

/** Mots de liaison en tête d'un complément (« de carburant », « d’électricité ») — grammaire, jamais du métier. */
const LEADING_LINK = /^(?:de la|de l[’']|du|des|de|d[’'])\s*/i;
const TRAILING_SEPARATORS = /[\s\-–—:_,;/|]+$/;
/** Mot de liaison resté en fin de désignation après le retrait d'un nom — grammaire, jamais du métier. */
const TRAILING_LINK = /\s+(?:de la|de l[’']|du|des|de|d[’']|chez|pour|et)$/i;

/** Retire la tête « Achat … » / « Acquisition … » et le mot de liaison d'un texte (pur) : « Achat de carburant » → « carburant ». */
function objectWording(text: string): string {
  let t = propre(text);
  if (startsWithAcquisitionName(t)) t = t.replace(/^\S+\s*/, '');
  return t.replace(LEADING_LINK, '').trim();
}

/**
 * Désignation privée des NOMS qui ne sont pas l'objet acheté (pure) : le
 * fournisseur et le bien associé ne remplacent jamais l'objet (carte #821).
 * Une désignation ÉGALE à l'un de ces noms n'en est pas une (null) ; un nom
 * placé en FIN de désignation est retiré (« de carburant TotalEnergies » →
 * « de carburant »). Rien d'autre n'est modifié.
 */
export function designationWithoutNames(designation: string | null | undefined, names: ReadonlyArray<string | null | undefined>): string | null {
  let mots = propre(designation).split(' ').filter(Boolean);
  const cles = [...new Set(names.map((n) => norm(propre(n))).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  let nomRetire = false;
  let encore = true;
  while (encore && mots.length) {
    encore = false;
    const normes = mots.map((m) => norm(m));
    for (const cle of cles) {
      // Plus petite fin de désignation dont la forme normalisée est exactement ce nom.
      for (let i = mots.length - 1; i >= 0; i--) {
        const fin = normes.slice(i).filter(Boolean).join(' ');
        if (fin === cle) { mots = mots.slice(0, i); encore = true; nomRetire = true; break; }
        if (fin.length > cle.length) break;
      }
      if (encore) break;
    }
  }
  let reste = mots.join(' ').replace(TRAILING_SEPARATORS, '').trim();
  // Le mot de liaison qui introduisait le nom retiré part avec lui (« carburant chez <fournisseur> »).
  if (nomRetire) reste = reste.replace(TRAILING_LINK, '').replace(TRAILING_SEPARATORS, '').trim();
  return reste && /\p{L}{2,}/u.test(objectWording(reste)) ? reste : null;
}

/**
 * Nom d'un achat par CATÉGORIE (pur) : « Achat de carburant », « Achat de
 * recharge électrique », « Achat d’… » devant une voyelle. Le libellé vient
 * d'un RÉFÉRENTIEL existant (jamais d'un texte rédigé) ; seule son initiale
 * est mise en minuscule (un sigle reste tel quel). null : libellé vide.
 * Forme « à valider par le PO » (fiche de recette 116i).
 */
export function acquisitionLabelFromCategory(categoryLabel: string | null | undefined): string | null {
  const c = propre(categoryLabel);
  if (!c || !/\p{L}{2,}/u.test(c)) return null;
  const sigle = /^\p{Lu}[\p{Lu}\d]/u.test(c);
  const bas = sigle ? c : c.charAt(0).toLocaleLowerCase('fr-FR') + c.slice(1);
  const liaison = /^[aeiouyàâäéèêëîïôöùûüœ]/i.test(bas) ? 'd’' : 'de ';
  return `${ACQUISITION_TYPE_NAME} ${liaison}${bas}`.slice(0, MAX_NAME);
}

export interface AcquisitionNameInput {
  /** Désignation retenue par le moteur de titrage du justificatif (`asset_files.title_basis.subject`) ; null : aucune. */
  designation?: string | null;
  /** Le justificatif porte d'autres articles et aucun intitulé d'ensemble. */
  otherArticles?: boolean;
  /** Résumé du candidat (texte de l'analyse) : lu SEULEMENT pour y reconnaître une catégorie, jamais recopié ici. */
  summary?: string | null;
  /** Fournisseur de l'achat : ne désigne jamais l'objet. */
  provider?: string | null;
  /** Biens associés à l'achat (rattachement) : ne désignent jamais l'objet. */
  assetNames?: ReadonlyArray<string | null | undefined>;
  /** Nom du bien dont l'ACQUISITION est établie par ce justificatif (preuve canonique) ; null : rattachement seul. */
  acquiredAssetName?: string | null;
  /**
   * Référentiel de catégories de dépense : libellé de la catégorie quand le
   * texte N'EST QUE la formulation de cette catégorie (« carburant », « sans
   * plomb »), sinon null. Fourni par l'appelant (référentiel côté serveur).
   */
  categoryOf?: (wording: string) => string | null;
}

/**
 * Carte #821 — NOM d'un achat d'après ce qui a RÉELLEMENT été acheté (pur).
 *
 *   1. désignation fiable de l'objet                → « Achat <désignation> »            (DESIGNATION)
 *      … qui n'est que la formulation d'une catégorie → « Achat de <catégorie> »        (CATEGORY)
 *   2. acquisition du bien lui-même établie         → « Achat <nom du bien> »            (ASSET_ACQUISITION)
 *   3. seule une catégorie est établie (résumé)     → « Achat de <catégorie> »           (CATEGORY)
 *   4. rien de fiable                               → null : replis existants (résumé du justificatif),
 *                                                     puis libellé neutre — jamais un produit inventé.
 *
 * Le fournisseur et le bien associé ne nomment jamais l'achat : ils sont
 * retirés de la désignation, sauf le bien dont l'acquisition est établie.
 */
export function acquisitionName(o: AcquisitionNameInput): { label: string; basis: AcquisitionNameBasis } | null {
  const acquis = propre(o.acquiredAssetName) || null;
  const d = designationWithoutNames(o.designation, [o.provider, ...(acquis ? [] : o.assetNames ?? [])]);
  if (d) {
    const categorie = acquis ? null : o.categoryOf?.(objectWording(d)) ?? null;
    const parCategorie = categorie ? acquisitionLabelFromCategory(categorie) : null;
    if (parCategorie) return { label: parCategorie, basis: 'CATEGORY' };
    const label = acquisitionLabelFromDesignation(d, { otherArticles: o.otherArticles });
    if (label && !isBareAcquisitionName(label)) return { label, basis: 'DESIGNATION' };
  }
  if (acquis && /\p{L}{2,}/u.test(acquis)) return { label: `${ACQUISITION_TYPE_NAME} ${acquis}`.slice(0, MAX_NAME), basis: 'ASSET_ACQUISITION' };
  const resume = objectWording(o.summary ?? '');
  const categorie = resume ? o.categoryOf?.(resume) ?? null : null;
  const parCategorie = categorie ? acquisitionLabelFromCategory(categorie) : null;
  return parCategorie ? { label: parCategorie, basis: 'CATEGORY' } : null;
}
