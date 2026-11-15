/**
 * Reconnaissance déterministe des commandes sur les ÉVÉNEMENTS DE RÉFÉRENCE
 * (lot 114X, Trello #753, CDC T2 §14.3 W21 – W26) — sans modèle, pure.
 *
 * Formes reconnues, toutes ANCRÉES en début de message (après une éventuelle
 * demande polie) et qui NOMMENT l'objet : « événement de référence », ou le nom
 * d'un type du référentiel (intervention, achat, contrat, financement,
 * sinistre, cession / vente) :
 *
 *   W21  « Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio »
 *        « Enregistre un événement de référence … »
 *        « J'ai fait la vidange de la Clio hier »            (intervention qui a eu lieu)
 *   W22  « Corrige la date de l'intervention Vidange : 14 mars 2025 »
 *        « Change le prestataire de l'intervention Vidange en Garage Martin »
 *        « Renomme l'intervention Vidange en Vidange et filtres »
 *        « Change le type de l'événement de référence Vidange en contrat »
 *        « Indique que l'intervention Vidange a eu lieu »
 *   W23  « Supprime l'intervention Vidange de la Clio »      (invalidation, jamais un DELETE)
 *   W24  « Associe le financement Prêt auto à l'achat de la Clio »
 *   W25  « Rattache le document Facture Norauto à l'intervention Vidange »
 *   W26  « Relie le fournisseur Garage Martin à l'intervention Vidange [comme intervenant] »
 *
 * Ce module ne lit rien : l'événement désigné (type, mots, date) est retrouvé
 * DANS LE COMPTE par `reference-events.ts`. Non-régression : une formulation
 * qui désigne une caractéristique de bien connue du registre (« date d'achat »,
 * « prix d'achat »…) n'est JAMAIS prise ici — elle reste à l'analyseur
 * existant ; et une phrase qui nomme un type sans désigner aucun événement du
 * compte n'est pas une commande (`isReferenceEventCommand`). Une tournure libre relève de la compréhension par le sens (champ
 * `actions`, étape de prompt 40) : hors de ce module.
 */
import { plain } from '../core/routing-text';
import { findAssetField } from './asset-fields';
import { debutUtile, documentDateFr, parseDateFr, type AssetScopeDraft, type DocumentTargetDraft } from './parser';
import { TYPE_NOUNS, type DeclarableTypeCode, type DeclaredStatus, type ReferenceEventSupplierRole } from './reference-event-model';

/** Événement de référence désigné : type nommé (ou `null` : « événement de référence »), mots, date complète éventuelle. */
export type ReferenceEventTargetDraft = { typeCode: DeclarableTypeCode | null; words: string[]; date: string | null };

/** Champ visé par une correction ; `date` : LA date de l'événement (le champ exact dépend de sa situation, résolu ensuite). */
export type ReferenceEventFieldDraft = 'date' | 'plannedDate' | 'startDate' | 'endDate' | 'provider' | 'label' | 'type' | 'status';

export type ReferenceEventDraft =
  | ({
      command: 'CREATE_REFERENCE_EVENT';
      typeCode: DeclarableTypeCode | null;
      /** Situation DITE par l'utilisateur ; `null` : non dite — elle est alors demandée (jamais déduite d'une date). */
      status: DeclaredStatus | null;
      /** Date telle qu'écrite (« 12 mars 2025 », « hier ») ; `null` : aucune — l'événement est alors non daté. */
      dateText: string | null;
      /** Intitulé (sans le bien final) ; `quoted` : donné entre guillemets — pris tel quel. */
      label: string | null;
      labelQuoted: boolean;
      /** Intitulé y compris le complément final (« … de la chaudière ») : retenu si ce complément n'est pas un bien du compte. */
      fullLabel: string | null;
      /** Message de l'utilisateur : la DÉCLARATION, source durable de l'événement. */
      declaration: string;
      /**
       * Déclaration IMPLICITE (« j'ai fait … de la Clio hier ») : elle n'est une commande que si son bien est
       * réellement un bien du compte — sinon la phrase suit le parcours de réponse normal (`isReferenceEventCommand`).
       */
      implicit: boolean;
    } & AssetScopeDraft)
  | { command: 'UPDATE_REFERENCE_EVENT'; field: ReferenceEventFieldDraft; /** Valeur telle qu'écrite ; `null` : non donnée. */ value: string | null; declaration: string; target: ReferenceEventTargetDraft }
  | { command: 'INVALIDATE_REFERENCE_EVENT'; target: ReferenceEventTargetDraft }
  | { command: 'ASSOCIATE_REFERENCE_EVENTS'; first: ReferenceEventTargetDraft; second: ReferenceEventTargetDraft }
  | ({ command: 'LINK_DOCUMENT_REFERENCE_EVENT'; target: ReferenceEventTargetDraft } & DocumentTargetDraft)
  | { command: 'LINK_SUPPLIER_REFERENCE_EVENT'; supplierWords: string[]; role: ReferenceEventSupplierRole; target: ReferenceEventTargetDraft };

const EDR = 'evenement de reference';
const MOIS = 'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre';
/** Nom de l'objet : « événement de référence », ou le nom d'un type (référentiel) — le plus long d'abord. */
const N = `(${[EDR, ...[...TYPE_NOUNS.keys()].sort((a, b) => b.length - a.length)].join('|')})`;
const DET = String.raw`(?:l'|le\s+|la\s+|cet\s+|cette\s+|ce\s+|mon\s+|ma\s+)`;
const DET2 = String.raw`(?:l'|le\s+|la\s+|cet\s+|cette\s+|mon\s+|ma\s+)`;
/** « à l'… », « au … », « avec le … ». */
const VERS = String.raw`(?:a\s+${DET2}|au\s+|avec\s+${DET2})`;
/** « de l'… », « du … ». */
const DE = String.raw`(?:de\s+${DET2}|du\s+)`;
const DOC = String.raw`(?:document web|document|fichier|lien web|lien)`;

const VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'mon', 'ma', 'mes', 'ce', 'cet', 'cette', 'pour', 'sur', 'au', 'aux', 'en', 'et', 'qui', 'que', 'dans',
  'evenement', 'reference', ...MOIS.split('|'),
]);
/** Mots qui désignent un événement (intitulé, prestataire, document, bien) : ≥ 2 lettres, hors articles, mois et petits nombres. */
const motsEvenement = (s: string): string[] =>
  plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !VIDES.has(w) && !/^\d{1,2}$/.test(w));
const motsNom = (s: string): string[] =>
  plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !['le', 'la', 'les', 'du', 'de', 'des', 'mon', 'ma', 'ce', 'cet', 'cette'].includes(w));
const motsDocument = (s: string): string[] =>
  plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !['le', 'la', 'les', 'du', 'de', 'des', 'mon', 'ma', 'ce', 'cet', 'cette', 'document', 'fichier', 'lien', 'web', 'intitule', 'nomme', 'appele'].includes(w));
const motsBien = (s: string): string[] =>
  plain(s).split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !VIDES.has(w) && !/^\d+$/.test(w));
const sansGuillemets = (s: string): string => s.replace(/^[«"“]\s*|\s*[»"”]?[\s.!?]*$/g, '').trim();

/** Date COMPLÈTE (avec l'année) : seule une date complète désigne un événement existant. */
const DATE_COMPLETE = new RegExp(String.raw`\b\d{1,2}(?:er)?\s+(?:${MOIS})\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b`);
/** Date écrite, avec ou sans année. */
const DATE_ECRITE = new RegExp(String.raw`\b(?:(?:le|du|au|depuis le|a partir du)\s+)?(\d{1,2}(?:er)?\s+(?:${MOIS})(?:\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b`);
const JOUR_RELATIF = /\b(avant-hier|hier|aujourd'hui|demain)\b/;

function cible(nom: string, zone: string, today: string): ReferenceEventTargetDraft {
  const hit = zone.match(DATE_COMPLETE);
  return {
    typeCode: TYPE_NOUNS.get(nom) ?? null,
    words: motsEvenement(hit ? zone.replace(hit[0], ' ') : zone),
    date: hit ? parseDateFr(hit[0], today) : null,
  };
}

/** Le message désigne-t-il une caractéristique de BIEN du registre dont le nom porte ce mot (« date d'achat », « fin de contrat ») ? */
function champDeBien(nfc: string, nom: string): boolean {
  if (nom === EDR) return false;
  const hit = findAssetField(nfc);
  return !!hit && plain(hit.alias).split(/[^a-z0-9]+/).includes(nom);
}

const REALISE = /\b(?:qui a eu lieu|a eu lieu|deja eu lieu|realisee?s?|effectuee?s?|faite?s?|terminee?s?)\b/;
const PREVU = /\b(?:a prevoir|prevue?s?|envisagee?s?|a venir|a faire)\b/;
const DET_INTITULE = /^(?:l['’]|le\s+|la\s+|les\s+|un\s+|une\s+|des\s+|mon\s+|ma\s+|mes\s+|notre\s+|nos\s+)/i;
/** Dernier complément de la phrase : il désigne le bien (« … de la maison », « … pour ce véhicule », « … du garage »). */
const BIEN_FINAL = /^(.*)\s+(?:(?:dans|pour|de|sur)\s+(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*|(?:du)\s+)([a-z0-9' -]+?)\s*$/;

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Intitulé propre : sans déterminant initial, sans ponctuation ni mot de liaison en bout, borné. */
function intitule(brut: string): string | null {
  const t = brut.replace(/\s+/g, ' ').trim()
    .replace(/^(?:nommée?|intitulée?|appelée?)\s+/i, '')
    .replace(DET_INTITULE, '')
    .replace(/[\s,;:.!?-]+$/, '')
    .replace(/\s+(?:le|du|au|de|pour|sur|dans|a|à)$/i, '')
    .trim();
  return t ? capitalize(t).slice(0, 200) : null;
}

/**
 * Brouillon de création à partir de ce qui suit le nom de l'objet. `o` (texte d'origine) et `p` (texte normalisé)
 * ont la même longueur : ce qui est compris (guillemets, situation, date, bien) est masqué, le reste est l'intitulé.
 */
function creation(
  o: string, p: string, typeCode: DeclarableTypeCode | null, force: DeclaredStatus | null, declaration: string, implicit: boolean,
): Extract<ReferenceEventDraft, { command: 'CREATE_REFERENCE_EVENT' }> {
  const masque = new Array<boolean>(p.length).fill(false);
  let reste = p;
  const masquer = (from: number, length: number): void => {
    for (let i = from; i < from + length; i += 1) masque[i] = true;
    reste = `${reste.slice(0, from)}${' '.repeat(length)}${reste.slice(from + length)}`;
  };
  const lire = (to: number): string => Array.from({ length: Math.max(0, Math.min(to, o.length)) }, (_, i) => (masque[i] ? ' ' : o[i])).join('');

  // Intitulé entre guillemets : pris tel quel.
  const cite = o.match(/[«"“]\s*([^»"”]{1,200}?)\s*[»"”]/);
  const entreGuillemets = cite?.[1].trim() || null;
  if (cite && cite.index !== undefined) masquer(cite.index, cite[0].length);

  // Situation dite (jamais déduite d'une date).
  const eu = reste.match(REALISE);
  if (eu && eu.index !== undefined) masquer(eu.index, eu[0].length);
  const prevu = reste.match(PREVU);
  if (prevu && prevu.index !== undefined) masquer(prevu.index, prevu[0].length);
  const status: DeclaredStatus | null = force ?? (eu && !prevu ? 'REALIZED' : prevu && !eu ? 'ENVISAGED' : null);

  // Date : jour relatif ou date écrite, reprise telle quelle (résolue ensuite avec la date du jour).
  let dateText: string | null = null;
  const relatif = reste.match(JOUR_RELATIF);
  const ecrite = reste.match(DATE_ECRITE);
  if (relatif && relatif.index !== undefined) { dateText = relatif[1]; masquer(relatif.index, relatif[0].length); }
  else if (ecrite && ecrite.index !== undefined) { dateText = ecrite[1]; masquer(ecrite.index, ecrite[0].length); }

  // Bien : dernier complément.
  const fin = reste.replace(/[\s,;:.!?]+$/, '');
  const bien = ` ${fin}`.match(BIEN_FINAL);
  const contexte = !!bien && /^(ce|cet|cette)$/.test(bien[2] ?? '');
  const mots = bien && !contexte ? motsBien(bien[3]) : [];
  const avecBien = !!bien && (contexte || mots.length > 0);
  const complet = entreGuillemets ?? intitule(lire(fin.length));
  return {
    command: 'CREATE_REFERENCE_EVENT', typeCode, status, dateText, declaration, implicit,
    label: entreGuillemets ?? (avecBien && bien ? intitule(lire(bien[1].length - 1)) : complet),
    labelQuoted: entreGuillemets !== null, fullLabel: complet,
    assetWords: avecBien ? mots : [], assetFromContext: avecBien && contexte,
  };
}

/** Brouillon d'une commande sur un événement de référence, ou `null` (pure, testée). */
export function parseReferenceEventCommand(message: string, today: string): ReferenceEventDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const decalage = debutUtile(brut);
  const m = brut.slice(decalage).replace(/[.!?\s]+$/, '');
  if (!new RegExp(String.raw`\b${N}\b`).test(m) && !/^j'ai\s/.test(m)) return null;
  const origine = (from: number): string => nfc.slice(decalage + from).trim();
  const declaration = nfc.replace(/\s+/g, ' ').trim();

  // W26 — relier un fournisseur à un événement de référence.
  const fournisseur = m.match(new RegExp(String.raw`^(?:relie|relier|lie|lier|associe|associer|rattache|rattacher|ajoute|ajouter)\s+(?:le|la|ce|mon)\s+(?:fournisseur|prestataire)\s+(.+?)\s+${VERS}${N}\b\s*(.*)$`));
  if (fournisseur) {
    let zone = fournisseur[3];
    const role = zone.match(/(?:^|\s+)comme\s+(prestataire|intervenant)\s*$/);
    if (role && role.index !== undefined) zone = zone.slice(0, role.index);
    const supplierWords = motsNom(fournisseur[1]);
    if (!supplierWords.length) return null;
    return {
      command: 'LINK_SUPPLIER_REFERENCE_EVENT', supplierWords, role: role?.[1] === 'intervenant' ? 'INTERVENER' : 'PROVIDER',
      target: cible(fournisseur[2], zone, today),
    };
  }

  // W25 — rattacher un document à un événement de référence.
  const document = m.match(new RegExp(String.raw`^(?:rattache|rattacher|associe|associer|relie|relier|lie|lier)\s+(le|la|ce|cet|cette|mon|ma)\s+${DOC}\s*(.*?)(?:^|\s)${VERS}${N}\b\s*(.*)$`));
  if (document) {
    const contexte = /^(ce|cet|cette)$/.test(document[1]);
    const documentWords = contexte ? [] : motsDocument(document[2]);
    if (!contexte && documentWords.length === 0) return null;
    return { command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords, documentFromContext: contexte, target: cible(document[3], document[4], today) };
  }

  // W24 — associer deux événements de référence (jamais une fusion).
  const associer = m.match(new RegExp(String.raw`^(?:associe|associer|relie|relier|lie|lier|rattache|rattacher)\s+${DET}${N}\b\s*(.*?)(?:^|\s)${VERS}${N}\b\s*(.*)$`));
  if (associer) {
    return { command: 'ASSOCIATE_REFERENCE_EVENTS', first: cible(associer[1], associer[2], today), second: cible(associer[3], associer[4], today) };
  }

  // W23 — supprimer (invalider) un événement de référence.
  const retirer = m.match(new RegExp(String.raw`^(?:supprime|supprimer|efface|effacer|retire|retirer|enleve|enlever|invalide|invalider|annule|annuler)\s+(?:definitivement\s+)?${DET}${N}\b\s*(.*)$`));
  if (retirer) {
    if (champDeBien(nfc, retirer[1])) return null;
    return { command: 'INVALIDATE_REFERENCE_EVENT', target: cible(retirer[1], retirer[2], today) };
  }

  // W22 — intitulé.
  const renommer = m.match(new RegExp(String.raw`^(?:renomme|renommer)\s+${DET}${N}\b\s*(.*?)\s+en\s+(.+)$`));
  if (renommer) {
    const valeur = sansGuillemets(origine(m.lastIndexOf(renommer[3])));
    return { command: 'UPDATE_REFERENCE_EVENT', field: 'label', value: valeur || null, declaration, target: cible(renommer[1], renommer[2], today) };
  }

  // W22 — date, prestataire, intitulé ou type.
  const champ = m.match(new RegExp(String.raw`^(?:corrige|corriger|modifie|modifier|change|changer|mets|mettre|met|remplace|remplacer|actualise|actualiser)\s+(?:le\s+|la\s+|l')(date de debut|date de fin|date prevue|date|debut|fin|prestataire|intitule|titre|nom|type)\s+${DE}${N}\b\s*(.*)$`));
  if (champ) {
    if (champDeBien(nfc, champ[2])) return null;
    const field: ReferenceEventFieldDraft = /debut/.test(champ[1]) ? 'startDate' : /fin/.test(champ[1]) ? 'endDate' : champ[1] === 'date prevue' ? 'plannedDate'
      : champ[1] === 'date' ? 'date' : champ[1] === 'prestataire' ? 'provider' : champ[1] === 'type' ? 'type' : 'label';
    const reste = champ[3];
    const debutReste = m.length - reste.length;
    const estDate = field === 'date' || field === 'plannedDate' || field === 'startDate' || field === 'endDate';
    // La valeur suit « : », sinon le DERNIER « au / à / en / par » (date) ou « en / par » (texte).
    const deuxPoints = reste.match(/\s*:\s*/);
    const liaisons = [...reste.matchAll(estDate ? /(?:^|\s)(?:au|a|en|pour le)\s+(?=\d|le\s+\d|hier|avant-hier|aujourd'hui|demain)/g : /(?:^|\s)(?:en|par)\s+/g)];
    const sep = deuxPoints ?? liaisons[liaisons.length - 1] ?? null;
    if (!sep || sep.index === undefined) return { command: 'UPDATE_REFERENCE_EVENT', field, value: null, declaration, target: cible(champ[2], reste, today) };
    const valeur = sansGuillemets(origine(debutReste + sep.index + sep[0].length));
    return { command: 'UPDATE_REFERENCE_EVENT', field, value: valeur || null, declaration, target: cible(champ[2], reste.slice(0, sep.index), today) };
  }

  // W22 — situation : « indique que l'intervention … a eu lieu ».
  const euLieu = m.match(new RegExp(String.raw`^(?:indique|indiquer|note|noter|marque|marquer|declare|declarer)\s+que\s+${DET}${N}\b\s*(.*?)\s*(?:a eu lieu|a ete realisee?|a ete effectuee?|a ete faite?|est realisee?|est faite?|est terminee?)$`));
  if (euLieu) {
    return { command: 'UPDATE_REFERENCE_EVENT', field: 'status', value: 'REALIZED', declaration, target: cible(euLieu[1], euLieu[2], today) };
  }

  // W21 — déclarer un événement de référence.
  const declarer = m.match(new RegExp(String.raw`^(?:declare|declarer)\s+(?:une?\s+|l'|le\s+|la\s+)(?:nouveau\s+|nouvelle\s+|nouvel\s+)?${N}\b\s*(.*)$`))
    ?? m.match(new RegExp(String.raw`^(?:enregistre|enregistrer|ajoute|ajouter|cree|creer)\s+(?:une?\s+|l'|le\s+|la\s+)(?:nouveau\s+|nouvelle\s+|nouvel\s+)?(${EDR})\b\s*(.*)$`));
  if (declarer) {
    const debut = m.length - declarer[2].length;
    return creation(nfc.slice(decalage + debut, decalage + m.length), declarer[2], TYPE_NOUNS.get(declarer[1]) ?? null, null, declaration, false);
  }

  // W21 — « j'ai fait la vidange de la Clio hier » : une intervention qui a eu lieu, SUR UN BIEN DÉSIGNÉ.
  const fait = m.match(/^j'ai\s+(?:fait faire|fait realiser|fait effectuer|fait|effectue|realise)\s+(?=(?:le|la|les|mon|ma|mes|notre|nos)\s|l')(.+)$/);
  if (fait) {
    const debut = m.length - fait[1].length;
    const d = creation(nfc.slice(decalage + debut, decalage + m.length), fait[1], 'INTERVENTION', 'REALIZED', declaration, true);
    // Sans bien désigné, ce n'est pas une commande : la phrase suit le parcours de réponse normal.
    return d.assetWords.length || d.assetFromContext ? d : null;
  }
  return null;
}

/** Date d'une déclaration : « hier », « avant-hier », « aujourd'hui », « demain », ou date écrite. `past` : sans année, la dernière occurrence passée. */
export function declaredDate(text: string, today: string, past: boolean): string | null {
  const t = plain(text).trim();
  const [y, mo, d] = today.split('-').map(Number);
  const decale = (n: number): string => new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
  if (t === 'avant-hier') return decale(-2);
  if (t === 'hier') return decale(-1);
  if (t === "aujourd'hui") return decale(0);
  if (t === 'demain') return decale(1);
  return past ? documentDateFr(text, today) : parseDateFr(text, today);
}
