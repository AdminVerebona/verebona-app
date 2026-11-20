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

/**
 * Titre d'un événement d'Agenda d'achat LÉGITIME (pur) — jamais « Achat »
 * nu tant qu'un élément descriptif existe : intitulé de l'opération, sinon
 * prestataire, sinon bien associé (dernier repli, décision PO n° 2 de la
 * carte #744 : « type + bien »).
 */
export function acquisitionEventTitle(o: { label: string | null; provider: string | null; assetNames?: readonly string[] }): string {
  const label = propre(o.label);
  if (label) return acquisitionDisplayLabel(label);
  const tiers = propre(o.provider);
  if (tiers) return `${ACQUISITION_TYPE_NAME} — ${tiers.slice(0, MAX_NAME)}`;
  const bien = (o.assetNames ?? []).map(propre).find((n) => n.length > 0);
  return bien ? `${ACQUISITION_TYPE_NAME} — ${bien.slice(0, MAX_NAME)}` : ACQUISITION_TYPE_NAME;
}
