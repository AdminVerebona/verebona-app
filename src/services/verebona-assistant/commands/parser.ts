/**
 * Reconnaissance déterministe des commandes d'écriture — sans modèle.
 *
 * Une commande n'est proposée que si l'intention est CLAIRE : verbe
 * d'action explicite + objet reconnu. Sinon, rien : la question suit le
 * parcours de réponse normal. Ce module ne lit rien et n'écrit rien ; il
 * produit un brouillon que `plan.service` résout dans le compte puis fige.
 */
import { findAssetField, parseFieldValue } from './asset-fields';
import { plain } from '../core/routing-text';
import { assetDesignationsIn } from '@/lib/asset-taxonomy';
import { ASSET_STATUSES, ASSET_STATUS_LABELS } from '@/lib/asset-status';
import { parseReferenceEventCommand, type ReferenceEventDraft } from './reference-event-parser';

import { labelKey, parseLabelledValues, type LabelledValue } from './labelled-values';
import { AGENDA_LABELS, EQUIPMENT_LABELS, SUPPLIER_LABELS, type AgendaLabelKey, type EquipmentLabelKey } from './rich-edit-labels';
import type { SupplierCommandField } from './catalog';

export type CommandDraft =
  | {
      command: 'CREATE_AGENDA_ITEM';
      title: string;
      /**
       * AAAA-MM-JJ, ou null : date non donnée ou non comprise. Lot 114B (#753,
       * CDC T2 §9.4, D26, M29) : la date est FACULTATIVE — l'événement est
       * alors créé sans date, comme depuis l'Agenda.
       */
      date: string | null;
      /** « Sans échéance » explicitement demandé (option de l'Agenda, lot 77A) — jamais déduit d'une date absente. */
      noDeadline: boolean;
      /** Mots désignant le bien (« pour ma maison »). */
      assetWords: string[];
      /** « pour cette maison » : bien du fil. */
      assetFromContext: boolean;
    }
  | {
      command: 'UPDATE_ASSET_FIELD';
      /** Clé du champ (liste fermée : asset-fields.ts). */
      field: string;
      /** Valeur comprise, ou null si elle ne l'a pas été. */
      value: string | number | null;
      /** Mots désignant le bien (« pour la polo »). */
      assetWords: string[];
      /** « pour ce véhicule » : bien du fil. */
      assetFromContext: boolean;
    }
  | ({
      command: 'UPDATE_AGENDA_ITEM';
      /** Nouvelle date (AAAA-MM-JJ) et/ou nouveau titre ; au moins l'un des deux. */
      newDate: string | null;
      newTitle: string | null;
      /** Carte #807 (E03) : champs du tiroir de l'Agenda nommés dans la demande (« … : description …, heure 14h30 »). */
      values?: Array<LabelledValue<AgendaLabelKey>>;
      /**
       * Carte #843 (E03) : la demande vise TOUTE LA SÉRIE (« toute la série », « tous les rappels … »). L'Agenda ne sait
       * pas modifier une série : la préparation le DIT, rien n'est proposé (jamais une occurrence modifiée en silence).
       */
      seriesScope?: true;
    } & AgendaTargetDraft)
  | {
      command: 'CREATE_ASSET';
      /** Famille du référentiel des biens (VEHICULE, IMMOBILIER, OBJECT). */
      family: string;
      /** Catégorie du référentiel désignée (« Voiture », « Maison », code d'objet), ou null (famille seule). */
      category: string | null;
      /** Nom donné au bien, ou null s'il n'a pas été donné. */
      name: string | null;
    }
  | {
      command: 'DELETE_ASSET';
      assetWords: string[];
      assetFromContext: boolean;
      /**
       * Carte #790 (E01) — la demande a la forme « <quelque chose> DE <bien> »
       * (« efface la couleur de la Clio ») : ce qui précède le « de » peut être
       * une PROPRIÉTÉ du bien, et non une partie de son nom. Mots de ce premier
       * segment ; absent quand la demande désigne le bien directement. La
       * résolution arbitre : nom du bien qui les porte => suppression (« la Clio
       * de Paul ») ; sinon JAMAIS une suppression, mais une question.
       */
      propertyWords?: string[];
      /** Mots du segment qui suit le « de » (le bien porteur présumé). */
      ownerWords?: string[];
    }
  | {
      command: 'CREATE_SUPPLIER';
      /** Nom du fournisseur, ou null s'il n'a pas été donné (il est alors demandé). */
      name: string | null;
      phone: string | null;
      email: string | null;
      website: string | null;
    }
  | {
      command: 'UPDATE_SUPPLIER';
      /** Mots du nom du fournisseur visé. */
      supplierWords: string[];
      /** Carte #807 (E04) : tout champ modifiable de la fiche (adresse, SIREN, SIRET, TVA, IBAN, titulaire compris). */
      field: SupplierCommandField;
      /** Nouvelle valeur ; null avec `clear` = effacement demandé ; null sans `clear` = valeur non comprise. */
      value: string | null;
      clear: boolean;
      /** Carte #807 (E04) : PLUSIEURS champs en une demande (« … : adresse …, code postal …, ville … ») ; prime sur `field`. */
      values?: Array<LabelledValue<SupplierCommandField>>;
    }
  | { command: 'ARCHIVE_SUPPLIER'; supplierWords: string[] }
  | {
      command: 'CREATE_WEB_DOCUMENT';
      /** Lien http(s) tel qu'écrit, ou null s'il manque. */
      url: string | null;
      /** Titre donné au lien, ou null (il est alors demandé). */
      title: string | null;
      assetWords: string[];
      assetFromContext: boolean;
    }
  | ({
      command: 'UPDATE_DOCUMENT';
      field: 'title' | 'date' | 'notes';
      /** Nouvelle valeur ; null avec `clear` = effacement ; null sans `clear` = valeur non comprise. */
      value: string | null;
      clear: boolean;
    } & DocumentTargetDraft)
  | ({ command: 'DELETE_DOCUMENT' } & DocumentTargetDraft)
  /**
   * Passage 114AB (W14) — supprimer PLUSIEURS documents en une demande. `documentGroups` : une liste de
   * mots par document NOMMÉ (« les documents Facture EDF et Facture GDF ») — chacun est résolu
   * séparément dans le compte, et un seul échec de désignation annule toute la demande.
   */
  | { command: 'DELETE_DOCUMENTS'; documentGroups: string[][] }
  /**
   * Passage 114AB (W12) — NATURE d'un document : sa **Rubrique** ou son **Type** (référentiel V2).
   * `requestedValue` : la valeur telle qu'écrite ; `null` quand la demande nomme le niveau sans valeur
   * exploitable — la question est alors posée avec les valeurs du référentiel.
   */
  | ({
      command: 'UPDATE_DOCUMENT_CLASSIFICATION';
      level: 'rubric' | 'type';
      requestedValue: string | null;
    } & DocumentTargetDraft)
  | ({
      /** Pièce ou équipement d'un bien (lot 114, W04 – W09). */
      command: 'CREATE_ROOM' | 'CREATE_EQUIPMENT';
      /** Nom donné, ou null (il est alors demandé). */
      name: string | null;
      /** Équipement : pièce où il se trouve (« dans la pièce Cuisine »), mots de son nom. */
      roomWords: string[];
      /** Carte #807 (E02) : informations fournies à la création d'un équipement (« … : marque …, modèle … »). */
      values?: Array<LabelledValue<EquipmentLabelKey>>;
    } & AssetScopeDraft)
  /**
   * Carte #807 (E01, W05) — modifier un équipement : champs de sa fiche nommés dans la demande, pièce (`room`)
   * et bien parent (`asset`) compris. `raw: null` = effacement demandé.
   */
  | ({ command: 'UPDATE_EQUIPMENT'; targetWords: string[]; values: Array<LabelledValue<EquipmentLabelKey>> } & AssetScopeDraft)
  | ({ command: 'RENAME_ROOM' | 'RENAME_EQUIPMENT'; targetWords: string[]; newName: string | null } & AssetScopeDraft)
  | ({ command: 'DELETE_ROOM' | 'ARCHIVE_EQUIPMENT'; targetWords: string[] } & AssetScopeDraft)
  /** Lot 114F (W02) — nouveau nom d'un bien, tel qu'écrit ; null : il est alors demandé. */
  | ({ command: 'RENAME_ASSET'; newName: string | null } & AssetScopeDraft)
  /** Lot 114F (W27) — effacer une caractéristique d'un bien : clé du champ (liste fermée : asset-fields.ts). */
  | ({ command: 'CLEAR_ASSET_FIELD'; fieldKey: string } & AssetScopeDraft)
  /**
   * Passage 114AA (W02) — CATÉGORIE DE BIEN (« Catégorie de bien » de la fiche : `subtype`). `requestedCategory` :
   * la catégorie demandée telle qu'écrite, normalisée (sans accent, minuscules) ; `null` quand la demande nomme
   * « la catégorie » sans valeur exploitable — la question est alors posée avec les catégories du référentiel.
   */
  | ({ command: 'UPDATE_ASSET_CATEGORY'; requestedCategory: string | null } & AssetScopeDraft)
  /**
   * Passage 114AA (W02) — STATUT d'un bien. `requestedStatus` : le code du référentiel des statuts
   * (`lib/asset-status`), déjà résolu ici ; `null` quand la demande nomme « le statut » sans valeur reconnue.
   */
  | ({ command: 'UPDATE_ASSET_STATUS'; requestedStatus: string | null } & AssetScopeDraft)
  /**
   * Lot 114F puis passage 114AA (W13) — rattacher un document à un BIEN, à une PIÈCE ou à un ÉQUIPEMENT, ou
   * l'en détacher. `structureTarget` : la demande nomme une pièce ou un équipement — son type et les mots de
   * son nom (le bien porteur est retrouvé ensuite, dans le compte).
   */
  | ({
      command: 'UPDATE_DOCUMENT_TARGETS'; mode: 'attach' | 'detach';
      structureTarget: { kind: 'room' | 'equipment'; words: string[] } | null;
    } & DocumentTargetDraft & AssetScopeDraft)
  | ({
      command: 'DELETE_AGENDA_ITEM';
      /** SERIES seulement si la série est demandée (« toute la série », « tous les… »). */
      scope: 'OCCURRENCE' | 'SERIES';
    } & AgendaTargetDraft)
  /** Lot 114X (W21 – W26) — événements de référence : brouillons définis avec leur analyseur (`reference-event-parser.ts`). */
  | ReferenceEventDraft;

/**
 * Lot 114B (Trello #753, W16 / W17) — brouillons « modifier » et « supprimer »
 * une échéance. L'échéance est désignée par les mots de son titre, sa date
 * et/ou son bien ; elle est retrouvée DANS LE COMPTE par `plan.service`.
 */
export type AgendaTargetDraft = {
  /** Mots du titre de l'échéance visée. */
  itemWords: string[];
  /** Date qui désigne l'échéance (« celle du 12 mars »), ou null. */
  itemDate: string | null;
  assetWords: string[];
  assetFromContext: boolean;
};

/** Lot 114 (#753, W12 / W14) — document désigné par les mots de son titre, ou « ce document » (document du fil). */
export type DocumentTargetDraft = { documentWords: string[]; documentFromContext: boolean };

/** Bien concerné par une commande de structure : mots de son nom, ou « ce bien » (bien du fil / de la page). */
export type AssetScopeDraft = { assetWords: string[]; assetFromContext: boolean };

/** Segment d'un message à plusieurs commandes. */
interface CommandSegment {
  draft: CommandDraft;
  /** « … puis … » : ne s'exécute que si le segment précédent a réussi. */
  dependsOnPrevious: boolean;
}

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

const CREATE = /\b(ajoute|ajouter|cree|creer|programme|programmer|planifie|planifier|enregistre|enregistrer)\b/;
const AGENDA_NOUN = /\b(un|une)?\s*(rappel|echeance|rendez-vous|rdv|evenement|entretien|controle|revision)s?\b/;
const DONE = /\b(marque|marquer|indique|indiquer|passe|passer|note|noter)\b[\s\S]*\b(fait|faite|faits|faites|realise|realisee|realises|realisees|termine|terminee|termines|terminees)\b/;

const STOP = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'de', 'du', 'd', 'mon', 'ma', 'mes', 'pour', 'au', 'aux', 'a', 'en',
  'comme', 'est', 'et', 'que', 'qui', 'moi', 'stp', 'svp', 'merci', 'echeance', 'echeances', 'rappel', 'rappels',
  'fait', 'faite', 'realise', 'realisee', 'termine', 'terminee', 'marque', 'marquer', 'indique', 'passe', 'note',
  'annule', 'annuler', 'rendez-vous', 'rdv', 'evenement', 'je', 'j', 'ai', 'bien', 'peux', 'tu', 'vous',
]);

/** Date « 15 octobre [2026] », « 15/10[/2026] », « le 1er mars » → AAAA-MM-JJ (prochaine occurrence). */
export function parseDateFr(message: string, today: string): string | null {
  const m = plain(message);
  const [ty, tm, td] = today.split('-').map(Number);
  const build = (d: number, mo: number, y?: number): string | null => {
    if (!d || !mo || mo > 12 || d > 31) return null;
    let year = y && y < 100 ? 2000 + y : y;
    if (!year) {
      // Sans année : la prochaine occurrence (aujourd'hui compris).
      year = ty;
      if (mo < tm || (mo === tm && d < td)) year += 1;
    }
    const dt = new Date(Date.UTC(year, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;
    return dt.toISOString().slice(0, 10);
  };
  const t = m.match(/\b(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/);
  if (t) return build(Number(t[1]), MOIS[t[2]], t[3] ? Number(t[3]) : undefined);
  const n = m.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (n) return build(Number(n[1]), Number(n[2]), n[3] ? Number(n[3]) : undefined);
  if (/\bdemain\b/.test(m)) {
    const d = new Date(Date.UTC(ty, tm - 1, td + 1));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function motsUtiles(s: string): string[] {
  return plain(s).split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)
    && !Object.prototype.hasOwnProperty.call(MOIS, w));
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Verbes de modification d'une caractéristique (« mets », « change », « renseigne »…). */
const UPDATE = /\b(mets|mettre|met|modifie|modifier|change|changer|renseigne|renseigner|indique|indiquer|corrige|corriger|actualise|actualiser|remplace|remplacer|fixe|fixer|passe|passer|note|noter)\b/;

/**
 * CDC 15 T2-37 — verbes FORTS : une demande de modification sans ambiguïté
 * (mets / modifie / change / remplace / fixe / corrige, et « actualise »).
 */
const UPDATE_FORT = /\b(mets|mettre|met|modifie|modifier|change|changer|corrige|corriger|actualise|actualiser|remplace|remplacer|fixe|fixer)\b/;

/**
 * CDC 15 T2-37 — verbes AMBIGUS (indique, note, passe, renseigne) : ils
 * servent autant à demander une information (« Indique-moi la date
 * d'achat… ») qu'à la donner. Ils ne font une commande que si une NOUVELLE
 * VALEUR explicite est présente, et jamais dans une tournure de lecture.
 */
const UPDATE_AMBIGU = /\b(renseigne|renseigner|indique|indiquer|passe|passer|note|noter)\b/;

/** « Indique-moi », « dis-moi », « donne-nous »… : demande d'information. */
const LECTURE_MOI = /\b(indique|indiquez|dis|dites|donne|donnez|rappelle|rappelez|montre|montrez)[- ](moi|nous)\b/;

/** Question ouverte par un mot interrogatif (« quand », « quel », « est-ce que »…). */
const INTERROGATIF = /^\s*(quand|quel|quelle|quels|quelles|combien|ou|est-ce|pourquoi|comment|qu'est-ce)\b/;

/** Demande polie d'ACTION : « peux-tu / tu peux / pourrais-tu / pouvez-vous… ». */
const DEMANDE_POLIE = /^\s*(?:est-ce que\s+)?(?:peux[- ]tu|tu peux|pourrais[- ]tu|tu pourrais|pouvez[- ]vous|vous pouvez|pourriez[- ]vous|vous pourriez)\b/;

/**
 * Le message est-il une demande de LECTURE formulée avec un verbe ambigu
 * (pure, testée) ? « Indique-moi… », une question ouverte par un mot
 * interrogatif, ou un « ? » final qui n'est pas une demande polie d'action.
 * Une question part au routage normal, jamais en commande.
 */
export function isReadingRequest(message: string): boolean {
  const m = plain(message).trim();
  if (UPDATE_FORT.test(m)) return false;
  if (LECTURE_MOI.test(m) || INTERROGATIF.test(m)) return true;
  return /\?\s*$/.test(m) && !DEMANDE_POLIE.test(m);
}
const DETERMINANT = String.raw`(?:(?:ma|mon|mes|la|le|l'|notre|votre|sa|son|ce|cet|cette)\s*)?`;
const BIEN_APRES = new RegExp(String.raw`\b(?:pour|de|du|sur)\s+(${DETERMINANT})([a-z][a-z0-9'-]*(?:\s+[a-z][a-z0-9'-]*){0,3}?)(?=\s*$|\s*[?.!,;]|\s+(?:au|a|le|en|par|est|avec|:)\b|\s+\d)`);

/**
 * « Mets la date d'achat le 25/05/2021 pour la Polo » : champ de la liste
 * fermée + valeur + bien. Le bien et l'ancienne valeur sont résolus ensuite
 * dans le compte (plan.service) ; rien n'est écrit sans confirmation.
 */
function parseAssetFieldUpdate(message: string, today: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const m = plain(nfc);
  if (!UPDATE.test(m) || DONE.test(m)) return null;
  const fort = UPDATE_FORT.test(m);
  // T2-37 : verbe ambigu dans une tournure de lecture (« indique-moi »,
  // question ouverte par un mot interrogatif) → question, pas commande. Un
  // « ? » final seul ne suffit pas : « Peux-tu noter le kilométrage à
  // 45 000 km ? » est une demande d'action — c'est la VALEUR qui tranche.
  if (!fort && (!UPDATE_AMBIGU.test(m) || LECTURE_MOI.test(m) || INTERROGATIF.test(m))) return null;
  const hit = findAssetField(nfc);
  if (!hit) return null;
  const debut = hit.index + hit.alias.length;
  const apresOriginal = nfc.slice(debut);
  const apres = m.slice(debut);
  const value = parseFieldValue(hit.def, apresOriginal, today, parseDateFr);
  // T2-37 : verbe ambigu sans nouvelle valeur explicite (avec ou sans « ? »)
  // → pas une commande.
  if (!fort && value === null) return null;

  // Le bien : cherché hors de la valeur (« à MAIF pour la polo », « au 12/03/2027 »).
  let zone = `${m.slice(0, hit.index)} ${apres}`;
  if (hit.def.type === 'text' && typeof value === 'string') zone = zone.replace(plain(value), ' ');
  zone = zone.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d[\d .,]*\b/g, ' ');
  const bien = BIEN_APRES.exec(zone);
  const assetFromContext = !!bien && /^(ce|cet|cette)\b/.test(bien[1].trim());
  return {
    command: 'UPDATE_ASSET_FIELD',
    field: hit.def.key,
    value,
    assetWords: bien && !assetFromContext ? motsUtiles(bien[2]) : [],
    assetFromContext,
  };
}

// ── Lot 114B (#753, W16 / W17) : modifier / supprimer une échéance ─────────

const DELETE_VERB = /\b(supprime|supprimer|efface|effacer|retire|retirer|enleve|enlever)\b/;
/** Carte #807 : verbes d'une modification à PLUSIEURS champs (« Modifie … : champ valeur, champ valeur »). */
const VERBE_MODIFIER = String.raw`(?:modifie|modifier|change|changer|corrige|corriger|complete|completer|actualise|actualiser|mets a jour|mettre a jour|renseigne|renseigner)`;
const MOVE_VERB = /\b(deplace|deplacer|reporte|reporter|decale|decaler|repousse|repousser|avance|avancer)\b/;
const RENAME_VERB = /\b(renomme|renommer)\b/;
/** Nom d'échéance, avec son déterminant (« l'échéance », « le rendez-vous », « tous les rappels »). */
const AGENDA_TARGET = /\b(?:l'|le |la |les |mon |ma |mes |ce |cet |cette |ces |un |une |tous les |toutes les )?(rappel|echeance|rendez-vous|rdv|evenement|entretien|controle|revision)s?\b/;
const SERIE = /\b(toute la serie|la serie|serie entiere|tous les|toutes les|recurrents?|recurrentes?|ce cycle|du cycle)\b/;
/** Mots du nom qui font partie du titre réel (« entretien », « contrôle », « révision »). */
const NOMS_TITRE = new Set(['entretien', 'controle', 'revision']);

/** Désignation de l'échéance dans la partie du message qui la nomme (pure). */
function agendaTarget(zone: string, today: string): AgendaTargetDraft | null {
  const noun = zone.match(AGENDA_TARGET);
  if (!noun) return null;
  const apres = zone.slice((noun.index ?? 0) + noun[0].length);
  const coupe = apres.split(/\s(?:le|du|au|pour|de la|de l'|de mon|de ma|ce|cette)\s|\s\d{1,2}(?:er)?[\s/]/)[0] ?? '';
  const itemWords = [...(NOMS_TITRE.has(noun[1]) ? [noun[1]] : []), ...motsUtiles(coupe).filter((w) => !['serie', 'entiere', 'toute', 'tous', 'toutes', 'recurrent', 'recurrents', 'cycle', 'double'].includes(w))];
  const bien = apres.match(/\b(?:pour|de|du|sur)\s+(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*([a-z][a-z0-9' -]*?)(?=\s*$|\s*[?.!,;]|\s+(?:au|a|le|du|en)\b)/);
  const assetFromContext = !!bien && /^(ce|cet|cette)$/.test(bien[1]);
  return {
    itemWords,
    itemDate: parseDateFr(zone, today),
    assetWords: bien && !assetFromContext ? motsUtiles(bien[2]).filter((w) => !itemWords.includes(w)) : [],
    assetFromContext,
  };
}

/**
 * Carte #843 (E03) : « Retire le bien Polo de l'échéance Vidange », « Détache le document Facture du rappel
 * Entretien » — RETRAIT CIBLÉ d'un lien d'une échéance (jamais la suppression de l'échéance, ni celle de l'objet :
 * « retire » désignait avant la suppression de l'échéance ; « détache le document » un rattachement à un bien).
 * Analysé AVANT les pièces, équipements et documents : l'échéance nommée en fin de phrase fait foi. Pure.
 */
export function parseAgendaLinkRemoval(message: string, today: string): CommandDraft | null {
  const m = plain(message).trim();
  const retrait = m.match(/^(?:retire|retirer|enleve|enlever|detache|detacher|dissocie|dissocier|supprime|supprimer)\s+(?:le lien (?:vers|avec)\s+)?(?:(le bien|la piece|l'equipement|le document)\s+)(.+?)\s+(?:de\s+l'|de\s+la\s+|du\s+|des\s+|de\s+)((?:echeance|rappel|rendez-vous|rdv|evenement|entretien|controle|revision)s?\b.*)$/);
  if (retrait) {
    const cible = agendaTarget(retrait[3], today);
    const nfc = message.normalize('NFC').trim();
    // Nom de l'objet repris du message d'origine (accents, casse) : même position que dans la forme sans accent.
    const debutNom = m.indexOf(retrait[2], m.indexOf(retrait[1]) + retrait[1].length);
    const nom = nfc.slice(debutNom, debutNom + retrait[2].length).replace(/^[«"“]\s*|\s*[»"”]$/g, '').trim();
    const key: AgendaLabelKey = retrait[1] === 'le bien' ? 'removeAsset' : retrait[1] === 'la piece' ? 'removeRoom' : retrait[1] === "l'equipement" ? 'removeEquipment' : 'removeDocument';
    if (cible && nom) return { command: 'UPDATE_AGENDA_ITEM', newDate: null, newTitle: null, values: [{ key, raw: nom }], ...cible, ...(SERIE.test(retrait[3]) ? { seriesScope: true as const } : {}) };
  }
  return null;
}

/**
 * « Supprime l'échéance vidange du 12 mars », « supprime toute la série des
 * rappels vidange », « reporte le contrôle technique de la Clio au 20 mars »,
 * « renomme l'échéance vidange en révision annuelle » (pure, testée).
 */
function parseAgendaChange(message: string, today: string): CommandDraft | null {
  const m = plain(message).trim();
  if (!AGENDA_TARGET.test(m)) return null;
  // Carte #807 (E03) : « Modifie l'échéance Vidange du 12 mars : description …, heure de début 14h30, situation a eu lieu ».
  const riche = m.match(new RegExp(String.raw`^${VERBE_MODIFIER}\s+(.+?)\s*(?::|\bavec\b)\s*(.+)$`));
  // Carte #843 (E03) : « Modifie toute la série des rappels Vidange : … » — la cible commence par la série.
  const zoneRiche = riche ? riche[1].replace(/^(?:toute la serie|la serie|serie entiere)\s+(?:des\s+|du\s+|de la\s+|de l'|de\s+)?/, '') : '';
  if (riche && AGENDA_TARGET.test(zoneRiche) && (zoneRiche.match(AGENDA_TARGET)?.index ?? 1) === 0) {
    const cible = agendaTarget(riche[1], today);
    const nfc = message.normalize('NFC').trim();
    const values = parseLabelledValues(nfc.slice(nfc.length - riche[2].length), AGENDA_LABELS);
    if (cible && values) return { command: 'UPDATE_AGENDA_ITEM', newDate: null, newTitle: null, values, ...cible, ...(SERIE.test(riche[1]) ? { seriesScope: true as const } : {}) };
  }
  if (DELETE_VERB.test(m)) {
    const cible = agendaTarget(m, today);
    return cible ? { command: 'DELETE_AGENDA_ITEM', scope: SERIE.test(m) ? 'SERIES' : 'OCCURRENCE', ...cible } : null;
  }
  if (RENAME_VERB.test(m)) {
    const coupe = m.search(/\s+en\s+(?!\d)/);
    if (coupe < 0) return null;
    const cible = agendaTarget(m.slice(0, coupe), today);
    // Le nouveau titre est repris du message d'origine (accents, casse).
    const original = message.normalize('NFC').split(/\s+en\s+/i).slice(1).join(' en ').replace(/[\s.!?]+$/, '').replace(/^[«"“']\s*|\s*[»"”']$/g, '').trim();
    if (!cible || !original) return null;
    return { command: 'UPDATE_AGENDA_ITEM', newDate: null, newTitle: capitalize(original), ...cible, ...(SERIE.test(m.slice(0, coupe)) ? { seriesScope: true as const } : {}) };
  }
  if (MOVE_VERB.test(m)) {
    // La NOUVELLE date suit le dernier « au / à / pour le » ; ce qui précède désigne l'échéance.
    const sep = [...m.matchAll(/\s(?:au|a|pour le|pour)\s+(?=\d|le\s+\d|demain)/g)].pop();
    if (!sep || sep.index === undefined) return null;
    const newDate = parseDateFr(m.slice(sep.index), today);
    const cible = agendaTarget(m.slice(0, sep.index), today);
    if (!cible || !newDate) return null;
    return { command: 'UPDATE_AGENDA_ITEM', newDate, newTitle: null, ...cible, ...(SERIE.test(m.slice(0, sep.index)) ? { seriesScope: true as const } : {}) };
  }
  return null;
}

// ── Lot 114B (#753, W01 / W03) : créer / supprimer un bien ─────────────────

const DET_CREATION = String.raw`(?:(?:une|un|mon|ma|le|la)\s+|l')(?:(?:nouveau|nouvelle|nouvel)\s+)?(?:bien\s+(?:de\s+type\s+)?)?`;
const NOMME = /\b(?:nomme|nommee|appele|appelee|intitule|intitulee|qui s'appelle|du nom de)\s+/;
/** Autres objets qu'un bien : leur présence exclut la création / suppression d'un BIEN. */
const AUTRE_OBJET = /\b(documents?|factures?|fichiers?|photos?|pieces?|equipements?|fournisseurs?|notes?|descriptions?|champs?|liens?|contrats?|sinistres?|interventions?|export|dossier)\b/;

/** Nom tel qu'écrit par l'utilisateur (accents, casse), après « nommé(e) » ou entre guillemets. */
function nomDonne(message: string): string | null {
  const nfc = message.normalize('NFC');
  const cite = nfc.match(/[«"“]\s*([^»"”]{1,120}?)\s*[»"”]/);
  if (cite) return cite[1].trim() || null;
  const hit = plain(nfc).match(NOMME);
  if (!hit || hit.index === undefined) return null;
  const nom = nfc.slice(hit.index + hit[0].length).replace(/[\s.!?]+$/, '').trim();
  return nom ? nom.slice(0, 120) : null;
}

/**
 * « Ajoute une voiture nommée Clio », « crée un bien de type maison "Maison de
 * Lyon" » (pure, testée). La désignation doit suivre IMMÉDIATEMENT le verbe :
 * « ajoute une facture pour ma voiture » ne crée aucun bien. La famille et la
 * catégorie viennent du référentiel des biens, jamais d'une liste locale.
 */
function parseAssetCreation(message: string): CommandDraft | null {
  const m = plain(message).trim().replace(DEMANDE_POLIE, '').trim();
  const debut = m.match(new RegExp(String.raw`^(?:ajoute|ajouter|cree|creer|enregistre|enregistrer)\s+${DET_CREATION}`));
  if (!debut || AGENDA_NOUN.test(m) || AUTRE_OBJET.test(m)) return null;
  const suite = m.slice(debut[0].length);
  // Le nom du bien n'est pas lu comme une désignation (« nommée Maison bleue »).
  const avantNom = suite.split(NOMME)[0].replace(/[«"“].*$/, '');
  const d = assetDesignationsIn(avantNom)[0];
  if (!d || !plain(avantNom).trimStart().startsWith(d.matched)) return null;
  return { command: 'CREATE_ASSET', family: d.family, category: d.kind === 'category' ? d.category ?? null : null, name: nomDonne(message) };
}

/**
 * Carte #790 (E01) — séparateur de possession d'une désignation : « la couleur
 * DE la Clio », « la date D'achat de la Clio ». Le DERNIER sépare la propriété
 * présumée du bien porteur présumé. Pure.
 */
const SEPARATEUR_POSSESSION = /\s(?:de|du|des)\s+|\sd'/g;

/** Déterminant en tête du segment du bien (« de LA Clio »), retiré avant les mots. */
const DET_EN_TETE = /^(?:ma|mon|mes|la|le|les|notre|votre|ce|cet|cette)\s+|^l'/;

/**
 * Carte #790 (E01) — ARBITRAGE D'INTENTION PAR TYPE D'OBJET.
 *
 * « Efface la couleur de la Clio » parle d'une PROPRIÉTÉ de la Clio, pas de la
 * Clio : la demande ne doit jamais basculer vers la suppression définitive du
 * bien. Cette fonction découpe la désignation en « propriété présumée » et
 * « bien porteur présumé » ; la résolution tranche dans le compte (un bien
 * nommé « Clio de Paul » reste supprimable).
 *
 * Rend `null` — et la demande garde EXACTEMENT son sens d'avant — quand :
 * le premier segment désigne lui-même un bien (famille ou catégorie du
 * référentiel : « supprime la voiture de Paul », « supprime le vélo cargo de
 * la maison »), ou quand l'un des deux segments ne porte aucun mot utile.
 */
function proprieteDeBien(reste: string): { propertyWords: string[]; ownerWords: string[] } | null {
  SEPARATEUR_POSSESSION.lastIndex = 0;
  let dernier: { debut: number; fin: number } | null = null;
  for (let h = SEPARATEUR_POSSESSION.exec(reste); h; h = SEPARATEUR_POSSESSION.exec(reste)) {
    dernier = { debut: h.index, fin: h.index + h[0].length };
  }
  if (!dernier) return null;
  const avant = reste.slice(0, dernier.debut);
  const apres = reste.slice(dernier.fin).replace(DET_EN_TETE, '');
  const propertyWords = motsUtiles(avant);
  const ownerWords = motsUtiles(apres);
  if (!propertyWords.length || !ownerWords.length) return null;
  // Le premier segment désigne un bien : la demande porte bien sur un bien.
  if (assetDesignationsIn(avant).length > 0) return null;
  return { propertyWords, ownerWords };
}

/**
 * « Supprime la Clio », « supprime mon vélo cargo », « supprime ce bien »
 * (pure, testée). Jamais si le message parle d'un autre objet (« supprime le
 * document de la Clio ») ni d'une échéance.
 *
 * Carte #790 (E01) : la forme « <propriété> de <bien> » est signalée à la
 * résolution (`propertyWords`), qui n'en fait une suppression que si le nom du
 * bien porte réellement ces mots. « Le bien … » nommé explicitement lève le
 * doute : l'intention est alors sans ambiguïté sur le TYPE D'OBJET.
 */
function parseAssetDeletion(message: string): CommandDraft | null {
  const m = plain(message).trim().replace(DEMANDE_POLIE, '').trim();
  const debut = m.match(/^(?:supprime|supprimer|efface|effacer)\s+(?:definitivement\s+)?(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*(bien\s+)?/);
  if (!debut || AGENDA_TARGET.test(m) || AUTRE_OBJET.test(m)) return null;
  const assetFromContext = /^(ce|cet|cette)$/.test(debut[1]);
  const reste = m.slice(debut[0].length);
  const mots = motsUtiles(reste).filter((w) => !['definitivement', 'compte', 'tout', 'tous'].includes(w));
  if (!assetFromContext && mots.length === 0) return null;
  const propriete = assetFromContext || debut[2] ? null : proprieteDeBien(reste);
  return {
    command: 'DELETE_ASSET', assetWords: assetFromContext ? [] : mots, assetFromContext,
    ...(propriete ?? {}),
  };
}

// ── Lot 114F (#753, W02 / W27) : renommer un bien, effacer une caractéristique ─

/** Début du message utile : après les espaces et une demande polie (« peux-tu … »). */
export function debutUtile(brut: string): number {
  const tete = brut.match(/^\s*/)![0].length;
  const poli = brut.slice(tete).match(DEMANDE_POLIE)?.[0].length ?? 0;
  return tete + poli + brut.slice(tete + poli).match(/^\s*/)![0].length;
}

const DET_BIEN = String.raw`(ma|mon|mes|la|le|l'|notre|votre|ce|cet|cette)`;

/**
 * « Renomme la Clio en Clio de Paul », « renomme ce bien en Maison de Lyon »,
 * « change le nom de la Clio en Clio de Paul » (pure, testée). Jamais si ce
 * qui est renommé est une échéance ou un autre objet (document, pièce,
 * équipement, fournisseur : leurs analyseurs passent avant). Le nouveau nom
 * est repris tel qu'écrit (accents, casse).
 */
function parseAssetRename(message: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const decalage = debutUtile(brut);
  const m = brut.slice(decalage);
  const hit = m.match(new RegExp(String.raw`^(?:renomme|renommer)\s+${DET_BIEN}\s*(.*?)\s+en\s+(.+)$`))
    ?? m.match(new RegExp(String.raw`^(?:change|changer|modifie|modifier|corrige|corriger|remplace|remplacer)\s+le\s+nom\s+(?:de\s+|du\s+|d')(?:${DET_BIEN}\s*)?(.*?)\s+(?:en|par)\s+(.+)$`));
  if (!hit) return null;
  const zone = hit[2].replace(/^bien\b\s*/, '');
  if (AGENDA_TARGET.test(hit[2]) || AUTRE_OBJET.test(hit[2])) return null;
  const assetFromContext = /^(ce|cet|cette)$/.test(hit[1] ?? '');
  const mots = assetFromContext ? [] : motsUtiles(zone);
  // Bien non désigné par un mot exploitable : pas une commande (jamais le bien de la page à la place).
  if (!assetFromContext && mots.length === 0) return null;
  const nom = sansGuillemets(origine(nfc, decalage + m.lastIndexOf(hit[3]))).replace(/\s+/g, ' ');
  return { command: 'RENAME_ASSET', newName: nom ? nom.slice(0, 120) : null, assetWords: mots, assetFromContext };
}

// ── Passage 114AA (#753, W02) : catégorie et statut d'un bien ───────────────

/** Verbes d'une modification de classement (« change », « mets », « passe »…). */
const VERBE_CLASSEMENT = String.raw`(?:change|changer|modifie|modifier|corrige|corriger|mets|mettre|met|remplace|remplacer|passe|passer|fixe|fixer)`;

/**
 * Formes reconnues d'un statut : le libellé du référentiel (`lib/asset-status`), plus ses accords simples
 * (« vendue », « vendus », « transmise ») — DÉRIVÉES du libellé, aucune liste parallèle. Pure.
 */
function statutDemande(valeur: string): string | null {
  const v = plain(valeur).replace(/[.!?]+$/, '').trim();
  if (!v) return null;
  for (const code of ASSET_STATUSES) {
    const base = plain(ASSET_STATUS_LABELS[code]);
    if (v === base || v === `${base}e` || v === `${base}s` || v === `${base}es` || v === plain(code).replace(/_/g, ' ')) return code;
  }
  // #849 : « vendu », « cédé », « archivé » — anciens statuts retirés : sortie du portefeuille = Transmis
  // (aperçu « En service → Transmis » soumis à confirmation ; la vente reste une Opération de cession).
  for (const ancien of ['vendu', 'cede', 'archive']) {
    if (v === ancien || v === `${ancien}e` || v === `${ancien}s` || v === `${ancien}es`) return 'TRANSMIS';
  }
  return null;
}

/**
 * Passage 114AA (W02) — CATÉGORIE et STATUT d'un bien (pure, testée).
 *
 *   « Change la catégorie de la Clio en moto », « Mets la catégorie de ce bien à appartement » ;
 *   « Change le statut de la Clio en vendu », « Marque la Clio comme vendue ».
 *
 * Deux formes seulement : celle qui NOMME le champ (« la catégorie », « le statut ») — reconnue même si la
 * valeur n'est pas comprise, pour pouvoir la demander —, et « marque … comme <statut du référentiel> », reconnue
 * seulement si le statut en est un. Toute autre tournure garde exactement son comportement d'avant.
 */
function parseAssetClassification(message: string): CommandDraft | null {
  const brut = plain(message.normalize('NFC'));
  const m = brut.slice(debutUtile(brut));
  if (AGENDA_TARGET.test(m) || AUTRE_OBJET.test(m)) return null;
  const bien = (det: string | undefined, zone: string): AssetScopeDraft | null => {
    const assetFromContext = /^(ce|cet|cette)$/.test(det ?? '');
    const mots = assetFromContext ? [] : motsUtiles(zone.replace(/^bien\b\s*/, ''));
    // Bien non désigné par un mot exploitable : pas une commande (jamais le bien de la page à la place).
    if (!assetFromContext && mots.length === 0) return null;
    return { assetWords: mots, assetFromContext };
  };

  const cat = m.match(new RegExp(String.raw`^${VERBE_CLASSEMENT}\s+la\s+categorie\s+(?:de\s+|du\s+|d')(?:${DET_BIEN}\s*)?(.*?)\s+(?:en|par|a|vers)\s+(.+)$`));
  if (cat) {
    const cible = bien(cat[1], cat[2]);
    if (!cible) return null;
    const valeur = plain(cat[3]).replace(/[.!?]+$/, '').trim();
    return { command: 'UPDATE_ASSET_CATEGORY', requestedCategory: valeur || null, ...cible };
  }

  const nomme = m.match(new RegExp(String.raw`^${VERBE_CLASSEMENT}\s+le\s+statut\s+(?:de\s+|du\s+|d')(?:${DET_BIEN}\s*)?(.*?)\s+(?:en|par|a|sur)\s+(.+)$`));
  if (nomme) {
    const cible = bien(nomme[1], nomme[2]);
    if (!cible) return null;
    return { command: 'UPDATE_ASSET_STATUS', requestedStatus: statutDemande(nomme[3]), ...cible };
  }

  const comme = m.match(new RegExp(String.raw`^(?:marque|marquer|indique|indiquer|signale|signaler)\s+${DET_BIEN}\s*(.*?)\s+comme\s+(.+)$`));
  if (comme) {
    // Forme implicite : reconnue SEULEMENT si la valeur est un statut du référentiel ; sinon rien ne change.
    const statut = statutDemande(comme[3]);
    if (!statut) return null;
    const cible = bien(comme[1], comme[2]);
    if (!cible) return null;
    return { command: 'UPDATE_ASSET_STATUS', requestedStatus: statut, ...cible };
  }
  return null;
}

/**
 * « Efface la date d'achat de la Clio », « supprime le kilométrage de ce
 * véhicule », « vide l'assureur de la maison » (pure, testée). Le champ —
 * liste fermée du registre — suit IMMÉDIATEMENT le verbe ; le reste ne peut
 * être que le bien. Passe AVANT la suppression d'un bien : « efface la date
 * d'achat de la Clio » ne propose jamais de supprimer la Clio.
 *
 * Une formulation qui nomme aussi une échéance (« supprime le contrôle
 * technique de la Clio », « l'échéance de l'assurance ») reste une demande
 * sur l'Agenda, comme avant — sauf si elle dit « la date du … ».
 */
function parseAssetFieldClear(message: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const decalage = debutUtile(brut);
  const m = brut.slice(decalage);
  const debut = m.match(/^(?:efface|effacer|supprime|supprimer|retire|retirer|enleve|enlever|vide|vider)\s+(?:(?:le|la|les|mon|ma|mes)\s+|l')/);
  if (!debut) return null;
  const hit = findAssetField(nfc);
  if (!hit || hit.index !== decalage + debut[0].length) return null;
  if (AGENDA_TARGET.test(hit.alias) && !hit.alias.startsWith('date')) return null;
  const reste = m.slice(debut[0].length + hit.alias.length).replace(/[.!?\s]+$/, '').trim();
  if (AUTRE_OBJET.test(reste)) return null;
  if (!reste) return { command: 'CLEAR_ASSET_FIELD', fieldKey: hit.def.key, assetWords: [], assetFromContext: false };
  const bien = reste.match(new RegExp(String.raw`^(?:pour\s+|sur\s+|de\s+|du\s+|d')(?:${DET_BIEN}\s*)?([a-z0-9][a-z0-9' -]*)$`));
  if (!bien) return null;
  const assetFromContext = /^(ce|cet|cette)$/.test(bien[1] ?? '');
  const mots = assetFromContext ? [] : motsUtiles(bien[2]);
  if (!assetFromContext && mots.length === 0) return null;
  return { command: 'CLEAR_ASSET_FIELD', fieldKey: hit.def.key, assetWords: mots, assetFromContext };
}

// ── Lot 114 (#753, W18 – W20) : créer / modifier / archiver un fournisseur ─

const FOURNISSEUR = /\b(fournisseur|prestataire)s?\b/;
const TEL = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/;
const MAIL = /[^\s@,;:«»"]+@[^\s@,;:«»"]+\.[a-z]{2,}/i;
const SITE = /(?:https?:\/\/|www\.)[^\s,;«»"]+/i;
const CHAMP_FOURNISSEUR: ReadonlyArray<{ re: RegExp; field: 'name' | 'phone' | 'email' | 'website' }> = [
  { re: /^(?:numero de telephone|telephone|numero|portable|tel)\b/, field: 'phone' },
  { re: /^(?:adresse e-mail|adresse email|adresse mail|e-mail|email|mail|courriel)\b/, field: 'email' },
  { re: /^(?:site internet|site web|site)\b/, field: 'website' },
  { re: /^nom\b/, field: 'name' },
];
/** Carte #807 (E04) : champs ajoutés (adresse, identifiants, coordonnées bancaires) — leurs libellés sont ceux de `SUPPLIER_LABELS`. */
const CHAMPS_FOURNISSEUR_HISTORIQUES: ReadonlySet<string> = new Set(['name', 'phone', 'email', 'website']);
/** Texte d'origine (accents, casse) entre deux positions du texte normalisé (mêmes longueurs en NFC). */
const origine = (message: string, from: number, to?: number) => message.normalize('NFC').slice(from, to).trim();
const motsNom = (s: string) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !['le', 'la', 'les', 'du', 'de', 'des', 'mon', 'ma', 'ce', 'cet', 'cette'].includes(w));

/**
 * « Ajoute le fournisseur Plomberie Durand, téléphone 06 12 34 56 78 »,
 * « change l'e-mail du fournisseur Durand en contact@durand.fr », « efface le
 * téléphone du fournisseur Durand », « renomme le fournisseur Durand en Durand
 * & Fils », « archive le fournisseur Durand » (pure, testée). Le nom et les
 * valeurs sont repris tels qu'écrits ; les coordonnées bancaires ne se
 * modifient jamais depuis l'Assistant.
 */
function parseSupplierCommand(message: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const poli = brut.match(/^\s*/)![0].length + (brut.trimStart().match(DEMANDE_POLIE)?.[0].length ?? 0);
  const decalage = poli + (brut.slice(poli).match(/^\s*/)![0].length);
  const m = brut.slice(decalage);
  if (!FOURNISSEUR.test(m)) return null;

  // Créer.
  const creer = m.match(/^(?:ajoute|ajouter|cree|creer|enregistre|enregistrer)\s+(?:un|une|le|la|mon|ce)\s+(?:nouveau\s+|nouvelle\s+)?(?:fournisseur|prestataire)\b\s*/);
  if (creer) {
    const reste = m.slice(creer[0].length);
    const fin = reste.search(/\s*(?:,|;|\bavec\b|\btelephone\b|\btel\b|\bportable\b|\bnumero\b|\be-?mail\b|\bmail\b|\bcourriel\b|\bsite\b|\(|$)/);
    let name = nomDonne(message);
    if (!name) {
      const zone = origine(nfc, decalage + creer[0].length, decalage + creer[0].length + (fin < 0 ? reste.length : fin));
      name = zone.replace(/^(?:nommé|nommée|appelé|appelée)\s+/i, '').replace(/[\s.!?:]+$/, '').trim() || null;
    }
    // Une coordonnée n'est jamais prise pour un nom.
    if (name && (TEL.test(name) || MAIL.test(name) || SITE.test(name))) name = null;
    return {
      command: 'CREATE_SUPPLIER', name: name ? name.slice(0, 200) : null,
      phone: nfc.match(TEL)?.[0].trim() ?? null, email: nfc.match(MAIL)?.[0] ?? null, website: nfc.match(SITE)?.[0].replace(/[.)]+$/, '') ?? null,
    };
  }

  // Renommer.
  const renommer = m.match(/^(?:renomme|renommer)\s+(?:le|la|mon|ce)\s+(?:fournisseur|prestataire)\s+(.+?)\s+en\s+(.+)$/);
  if (renommer) {
    const debutValeur = decalage + m.lastIndexOf(renommer[2]);
    const valeur = origine(nfc, debutValeur).replace(/^[«"“]\s*|\s*[»"”]?[\s.!?]*$/g, '');
    return { command: 'UPDATE_SUPPLIER', supplierWords: motsNom(renommer[1]), field: 'name', value: valeur || null, clear: false };
  }

  // Carte #807 (E04) : plusieurs champs en une demande — « Modifie le fournisseur Durand : adresse …, ville … ».
  const riche = m.match(new RegExp(String.raw`^${VERBE_MODIFIER}\s+(?:le|la|mon|ce)\s+(?:fournisseur|prestataire)\s+(.+?)\s*(?::|\bavec\b)\s*(.+)$`));
  if (riche) {
    const values = parseLabelledValues(origine(nfc, decalage + m.length - riche[2].length), SUPPLIER_LABELS);
    const mots = motsNom(riche[1]);
    if (values && mots.length) return { command: 'UPDATE_SUPPLIER', supplierWords: mots, field: values[0].key, value: values[0].raw, clear: values[0].raw === null, values };
  }

  // Modifier ou effacer une coordonnée.
  const champ = m.match(/^(modifie|modifier|change|changer|mets|mettre|met|corrige|corriger|remplace|remplacer|actualise|actualiser|renseigne|renseigner|ajoute|ajouter|efface|effacer|supprime|supprimer|retire|retirer|enleve|enlever|vide|vider)\s+(?:le\s+|la\s+|l')\s*(.+?)\s+(?:du|de mon|de ma|de la|de l'|de)\s*(?:fournisseur|prestataire)\s+(.+)$/);
  if (champ) {
    const clear = /^(efface|effacer|supprime|supprimer|retire|retirer|enleve|enlever|vide|vider)$/.test(champ[1]);
    const suite = champ[3];
    // Carte #807 (E04) : un champ ajouté (adresse, SIREN, SIRET, TVA, IBAN, titulaire…) — valeur après « en / par / à / : ».
    const ajoute = labelKey(champ[2], SUPPLIER_LABELS);
    if (ajoute && !CHAMPS_FOURNISSEUR_HISTORIQUES.has(ajoute)) {
      if (clear) return { command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite), field: ajoute, value: null, clear: true };
      const coupe = suite.match(/\s+(?:en|par|a|:|=)\s+/);
      if (!coupe || coupe.index === undefined) return { command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite), field: ajoute, value: null, clear: false };
      const debut = decalage + m.indexOf(suite) + coupe.index + coupe[0].length;
      return {
        command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite.slice(0, coupe.index)), field: ajoute, clear: false,
        value: origine(nfc, debut).replace(/^[«"“]\s*|\s*[»"”]?[\s.!?]*$/g, '') || null,
      };
    }
    const def = CHAMP_FOURNISSEUR.find((c) => c.re.test(champ[2]));
    if (!def) return null;
    if (clear) return { command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite), field: def.field, value: null, clear: true };
    const motif = def.field === 'phone' ? TEL : def.field === 'email' ? MAIL : def.field === 'website' ? SITE : null;
    if (motif) {
      const v = nfc.match(motif);
      const avant = v ? plain(nfc.slice(0, v.index)).slice(decalage + m.indexOf(suite)) : suite;
      return {
        command: 'UPDATE_SUPPLIER', field: def.field, clear: false,
        supplierWords: motsNom(avant.replace(/\s*(?::|\ba\b|\ben\b|\bpar\b|\bau\b|=|\bavec\b)\s*$/, '')),
        value: v ? v[0].trim().replace(/[.)]+$/, '') : null,
      };
    }
    // Nom : « change le nom du fournisseur Durand en Durand & Fils ».
    const sep = suite.match(/\s+(?:en|par|:)\s+/);
    if (!sep || sep.index === undefined) return { command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite), field: 'name', value: null, clear: false };
    const debutValeur = decalage + m.indexOf(suite) + sep.index + sep[0].length;
    return {
      command: 'UPDATE_SUPPLIER', supplierWords: motsNom(suite.slice(0, sep.index)), field: 'name', clear: false,
      value: origine(nfc, debutValeur).replace(/^[«"“]\s*|\s*[»"”]?[\s.!?]*$/g, '') || null,
    };
  }

  // Archiver (le retrait d'un fournisseur est un archivage : rien n'est supprimé).
  const archiver = m.match(/^(?:archive|archiver|supprime|supprimer|retire|retirer|efface|effacer|enleve|enlever)\s+(?:definitivement\s+)?(?:le|la|mon|ma)\s+(?:fournisseur|prestataire)\s+(.+)$/);
  if (archiver) {
    const mots = motsNom(archiver[1].replace(/[.!?]+$/, ''));
    return mots.length ? { command: 'ARCHIVE_SUPPLIER', supplierWords: mots } : null;
  }
  return null;
}

// ── Lot 114 (#753, W10 / W12 / W14) : lien web, modifier ou supprimer un document ─

const DOC_NOM = String.raw`(?:document web|document|fichier|lien web|lien)`;
const LIEN_HTTP = /https?:\/\/[^\s«»"<>]+/i;
const motsDocument = (s: string) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !['le', 'la', 'les', 'du', 'de', 'des', 'mon', 'ma', 'ce', 'cet', 'cette', 'document', 'fichier', 'lien', 'web', 'intitule', 'nomme', 'appele'].includes(w));
const sansGuillemets = (s: string) => s.replace(/^[«"“]\s*|\s*[»"”]?[\s.!?]*$/g, '').trim();

/**
 * Date d'un DOCUMENT : sans année écrite, la dernière occurrence passée (ou aujourd'hui) — la date d'une pièce
 * n'est pas dans le futur. L'aperçu affiche toujours la date complète avant confirmation.
 */
export function documentDateFr(valeur: string, today: string): string | null {
  const d = parseDateFr(valeur, today);
  if (!d || /\b\d{4}\b/.test(valeur) || /\/\d{2}\s*$/.test(valeur.trim()) || d <= today) return d;
  return `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
}

/** Cible « ce document » (fil) ou mots du titre. */
function cibleDocument(zone: string, contexte: boolean): DocumentTargetDraft | null {
  if (contexte) return { documentWords: [], documentFromContext: true };
  const mots = motsDocument(zone.replace(/[.!?]+$/, ''));
  return mots.length ? { documentWords: mots, documentFromContext: false } : null;
}

/**
 * « Ajoute le lien https://… intitulé « Notice chaudière » pour la maison »,
 * « renomme le document Facture EDF en Facture électricité mars », « change la
 * date du document Facture EDF au 12 mars 2025 », « ajoute la note « payée »
 * au document Facture EDF », « efface la note de ce document », « supprime le
 * document Facture EDF » (pure, testée). Le lien n'est jamais ouvert ni lu.
 */
function parseDocumentCommand(message: string, today: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const tete = brut.match(/^\s*/)![0].length;
  const poli = brut.slice(tete).match(DEMANDE_POLIE)?.[0].length ?? 0;
  const decalage = tete + poli + brut.slice(tete + poli).match(/^\s*/)![0].length;
  const m = brut.slice(decalage);
  const D = `(?:(le|la|ce|cet|cette|mon|ma)\\s+)${DOC_NOM}`;

  // Lien web : le verbe de création est suivi d'un « lien » ou d'une adresse http(s).
  const lien = m.match(/^(?:ajoute|ajouter|cree|creer|enregistre|enregistrer)\s+(?:(?:un|une|le|la|ce|cet|cette)\s+)?(?:lien web|lien|document web|site web|site|page web|page|adresse web|url)\b/)
    ?? (LIEN_HTTP.test(nfc) ? m.match(/^(?:ajoute|ajouter|cree|creer|enregistre|enregistrer)\s+(?=https?:\/\/)/) : null);
  if (lien) {
    const url = nfc.match(LIEN_HTTP)?.[0].replace(/[.,;)]+$/, '') ?? null;
    const sansUrl = url ? nfc.replace(url, ' ') : nfc;
    const titre = nomDonne(sansUrl) ?? (() => {
      const t = plain(sansUrl).match(/\b(?:sous le nom|avec le titre|avec le nom|comme titre|titre)\s*:?\s+/);
      if (!t || t.index === undefined) return null;
      return sansGuillemets(sansUrl.slice(t.index + t[0].length).split(/\s+(?:pour|sur)\s+(?:ma|mon|la|le|l'|ce|cet|cette)\b/i)[0]) || null;
    })();
    const sansTitre = titre ? plain(sansUrl).replace(plain(titre), ' ') : plain(sansUrl);
    const pour = sansTitre.match(/\b(?:pour|sur)\s+(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*([a-z0-9' -]+?)\s*[.!?]*\s*$/);
    const contexte = !!pour && /^(ce|cet|cette)$/.test(pour[1]);
    return {
      command: 'CREATE_WEB_DOCUMENT', url, title: titre ? titre.slice(0, 200) : null,
      assetWords: pour && !contexte ? motsUtiles(pour[2]) : [], assetFromContext: contexte,
    };
  }

  // Renommer.
  const renommer = m.match(new RegExp(`^(?:renomme|renommer)\\s+${D}\\s*(.*?)\\s+en\\s+(.+)$`));
  if (renommer) {
    const cible = cibleDocument(renommer[2], /^(ce|cet|cette)$/.test(renommer[1]));
    if (!cible) return null;
    const valeur = sansGuillemets(origine(nfc, decalage + m.lastIndexOf(renommer[3])));
    return { command: 'UPDATE_DOCUMENT', field: 'title', value: valeur || null, clear: false, ...cible };
  }

  // Titre, date ou note d'un document.
  const champ = m.match(new RegExp(`^(modifie|modifier|change|changer|mets|mettre|met|corrige|corriger|remplace|remplacer|actualise|actualiser|ajoute|ajouter|efface|effacer|supprime|supprimer|retire|retirer|enleve|enlever|vide|vider)\\s+(?:le\\s+|la\\s+|l'|une\\s+|un\\s+)(titre|nom|date|note|notes|commentaire|description)\\b\\s*(.*?)\\s*(?:(?:du|au)\\s+${DOC_NOM}|(?:de|a|sur|pour)\\s+${D})\\s*(.*)$`));
  if (champ) {
    const field = /^(titre|nom)$/.test(champ[2]) ? 'title' as const : champ[2] === 'date' ? 'date' as const : 'notes' as const;
    const clear = /^(efface|effacer|supprime|supprimer|retire|retirer|enleve|enlever|vide|vider)$/.test(champ[1]);
    const contexte = /^(ce|cet|cette)$/.test(champ[4] ?? '');
    const apres = champ[5];
    if (clear) {
      const cible = cibleDocument(apres, contexte);
      return cible && field !== 'title' ? { command: 'UPDATE_DOCUMENT', field, value: null, clear: true, ...cible } : null;
    }
    // Valeur placée AVANT la cible (« ajoute la note « payée » au document X ») ou APRÈS (« … du document X : payée »).
    const debutApres = decalage + m.length - apres.length;
    const sep = apres.match(field === 'date' ? /\s*(?::|\bau\b|\ba\b|\ben\b|\bpar\b)\s+(?=\S)/ : /\s*(?::|\ben\b|\bpar\b)\s+(?=\S)/);
    const avantCible = champ[3].trim();
    let zoneCible = apres;
    let valeur: string | null = null;
    if (avantCible) {
      valeur = sansGuillemets(origine(nfc, decalage + m.indexOf(champ[3], champ[1].length), decalage + m.indexOf(champ[3], champ[1].length) + champ[3].length));
    } else if (sep && sep.index !== undefined) {
      zoneCible = apres.slice(0, sep.index);
      valeur = sansGuillemets(origine(nfc, debutApres + sep.index + sep[0].length));
    }
    const cible = cibleDocument(zoneCible, contexte);
    if (!cible) return null;
    if (field === 'date') return { command: 'UPDATE_DOCUMENT', field, value: valeur ? documentDateFr(valeur, today) : null, clear: false, ...cible };
    return { command: 'UPDATE_DOCUMENT', field, value: valeur || null, clear: false, ...cible };
  }

  // Passage 114AB (W12) — NATURE d'un document : sa Rubrique ou son Type (référentiel V2).
  // « Change la rubrique du document Facture EDF en Assurances et sinistres », « Classe le document
  // Facture EDF dans la rubrique Entretien et travaux », « Change le type du document Facture EDF en
  // facture », « Mets la nature du document Facture EDF à facture ». Le document est désigné avant la
  // valeur (« du document … en … ») ou après (« … pour le document … »).
  const nature = m.match(new RegExp(`^(?:modifie|modifier|change|changer|mets|mettre|met|corrige|corriger|remplace|remplacer|actualise|actualiser|classe|classer|range|ranger)\\s+(?:le\\s+|la\\s+|l'|en\\s+)?(rubrique|type|nature|categorie)\\b\\s*(.*?)\\s*(?:(?:du|au)\\s+${DOC_NOM}|(?:de|a|sur|pour|dans)\\s+${D})\\s*(.*)$`));
  if (nature) {
    // « Catégorie » d'un document = sa Rubrique (le mot du tiroir est « Rubrique » ; « catégorie » est accepté).
    const niveau = nature[1] === 'type' || nature[1] === 'nature' ? 'type' as const : 'rubric' as const;
    const contexte = /^(ce|cet|cette)$/.test(nature[3] ?? '');
    const apres = nature[4];
    const debutApres = decalage + m.length - apres.length;
    const avantCible = nature[2].trim();
    // La valeur suit la cible après « : », « en », « à », « dans » — ou la précède (« la rubrique Médias du document … »).
    const sep = apres.match(/\s*(?::|\ben\b|\ba\b|\bdans\b|\bvers\b)\s+(?=\S)/);
    let zoneCible = apres;
    let valeur: string | null = null;
    if (avantCible) {
      const i = decalage + m.indexOf(nature[2], nature[1].length);
      valeur = sansGuillemets(origine(nfc, i, i + nature[2].length));
    } else if (sep && sep.index !== undefined) {
      zoneCible = apres.slice(0, sep.index);
      valeur = sansGuillemets(origine(nfc, debutApres + sep.index + sep[0].length));
    }
    const cible = cibleDocument(zoneCible.replace(/^(?:la\s+rubrique|le\s+type|la\s+nature)\b/, ' '), contexte);
    if (!cible) return null;
    // La valeur peut être introduite par « la rubrique … » / « le type … » : ces mots ne font pas partie du libellé.
    const propre = (valeur ?? '').replace(/^(?:la\s+rubrique|le\s+type|la\s+nature|la\s+categorie)\s+/i, '').trim();
    return { command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: niveau, requestedValue: propre || null, ...cible };
  }

  // Passage 114AB (W12) — « Classe le document Facture EDF dans la rubrique Entretien et travaux » : le
  // document est nommé d'abord, le niveau et la valeur ensuite.
  const classer = m.match(new RegExp(`^(?:classe|classer|range|ranger|deplace|deplacer)\\s+${D}\\s*(.*?)\\s+(?:dans|en|sous|vers)\\s+(?:la\\s+|le\\s+|l')?(rubrique|type|nature|categorie)\\b\\s*(?::\\s*)?(.*)$`));
  if (classer) {
    const niveau = classer[3] === 'type' || classer[3] === 'nature' ? 'type' as const : 'rubric' as const;
    const cible = cibleDocument(classer[2], /^(ce|cet|cette)$/.test(classer[1]));
    if (!cible) return null;
    const valeur = sansGuillemets(origine(nfc, decalage + m.length - classer[4].length)).trim();
    return { command: 'UPDATE_DOCUMENT_CLASSIFICATION', level: niveau, requestedValue: valeur || null, ...cible };
  }

  // Lot 114F (W13) — rattacher à un bien / détacher d'un bien : le bien est le DERNIER complément de la phrase.
  const lier = m.match(new RegExp(`^(rattache|rattacher|associe|associer|relie|relier|lie|lier|detache|detacher|dissocie|dissocier)\\s+${D}\\s*(.*)$`));
  if (lier) {
    const mode = /^(detache|detacher|dissocie|dissocier)$/.test(lier[1]) ? 'detach' : 'attach';
    const sep = mode === 'attach' ? String.raw`(?:a\s+|au\s+)` : String.raw`(?:de\s+|du\s+|d')`;
    const fin = ` ${lier[3].replace(/[.!?\s]+$/, '')}`.match(new RegExp(String.raw`^(.*)\s${sep}(?:${DET_BIEN}\s*)?([a-z0-9][a-z0-9' -]*)$`));
    if (!fin) return null;
    const cible = cibleDocument(fin[1], /^(ce|cet|cette)$/.test(lier[2]));
    if (!cible) return null;
    // Passage 114AA (W13) : « … à la pièce Cuisine », « … à l'équipement Chaudière » — le type est nommé, les
    // mots suivants désignent la pièce ou l'équipement DANS LE COMPTE (jamais un bien).
    const structure = fin[3].match(/^(pieces?|equipements?)\b\s*(.*)$/);
    const motsStructure = structure ? motsUtiles(structure[2]) : [];
    const structureTarget = structure && motsStructure.length
      ? { kind: (/^piece/.test(structure[1]) ? 'room' : 'equipment') as 'room' | 'equipment', words: motsStructure }
      : null;
    // Une pièce ou un équipement nommé sans aucun mot utile : la demande reste incomplète, rien n'est proposé.
    if (structure && !structureTarget) return null;
    const assetFromContext = !structure && /^(ce|cet|cette)$/.test(fin[2] ?? '');
    const mots = structure || assetFromContext ? [] : motsUtiles(fin[3]);
    if (!structure && !assetFromContext && mots.length === 0) return null;
    return { command: 'UPDATE_DOCUMENT_TARGETS', mode, structureTarget, assetWords: mots, assetFromContext, ...cible };
  }

  // Passage 114AB (W14) — supprimer PLUSIEURS documents : « Supprime les documents Facture EDF et Facture GDF ».
  // Les documents sont NOMMÉS un par un, séparés par « , » ou « et » ; aucune suppression « de tous les
  // documents » d'un bien n'est reconnue (une demande destructive se lit, elle ne se devine pas).
  const plusieurs = m.match(new RegExp(`^(?:supprime|supprimer|efface|effacer|retire|retirer|enleve|enlever)\\s+(?:definitivement\\s+)?(?:les|ces|mes)\\s+(?:documents|fichiers|liens)\\s+(.+)$`));
  if (plusieurs) {
    const groupes = plusieurs[1].split(/\s*,\s*|\s+et\s+/).map((z) => motsDocument(z.replace(/[.!?]+$/, ''))).filter((g) => g.length > 0);
    // Une seule désignation (« supprime les documents de la maison ») n'est pas une suppression multiple :
    // la phrase suit le parcours habituel, exactement comme avant.
    return groupes.length >= 2 ? { command: 'DELETE_DOCUMENTS', documentGroups: groupes } : null;
  }

  // Supprimer.
  const supprimer = m.match(new RegExp(`^(?:supprime|supprimer|efface|effacer|retire|retirer|enleve|enlever)\\s+(?:definitivement\\s+)?${D}\\s*(.*)$`));
  if (supprimer) {
    const cible = cibleDocument(supprimer[2], /^(ce|cet|cette)$/.test(supprimer[1]));
    return cible ? { command: 'DELETE_DOCUMENT', ...cible } : null;
  }
  return null;
}

// ── Lot 114 (#753, W04 – W09) : pièces et équipements d'un bien ────────────

/** « pièce jointe », « pièce d'identité », « pièce justificative » : des documents, jamais une pièce d'un logement. */
const PIECE_DOCUMENT = /\bpieces?\s+(?:jointes?|justificatives?|d'identite|comptables?|detachees?|de rechange)\b/;
/** Fin de phrase qui désigne le bien : « … de la maison », « … dans mon appartement », « … du garage », « … pour ce bien ». */
const BIEN_FINAL = /^(.*)\s+(?:(?:dans|a|pour|de|sur)\s+(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*|(?:du|au)\s+)([a-z0-9' -]+?)\s*[.!?]*\s*$/;

/** Sépare « <nom> de la maison » en nom et bien (dernier complément introduit par un article). */
function separerBien(zone: string): { reste: string } & AssetScopeDraft {
  // Préfixe glouton : c'est le DERNIER complément de la phrase qui désigne le bien (« … dans la pièce Cellier de la maison »).
  const hit = ` ${zone}`.match(BIEN_FINAL);
  if (!hit) return { reste: zone, assetWords: [], assetFromContext: false };
  // « dans la pièce … » situe un équipement, pas le bien.
  if (/^piece\b/.test(hit[3])) return { reste: zone, assetWords: [], assetFromContext: false };
  const contexte = /^(ce|cet|cette)$/.test(hit[2] ?? '');
  const mots = contexte ? [] : motsUtiles(hit[3]);
  if (!contexte && mots.length === 0) return { reste: zone, assetWords: [], assetFromContext: false };
  return { reste: hit[1].slice(1), assetWords: mots, assetFromContext: contexte };
}
const motsCible = (s: string) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !['le', 'la', 'les', 'du', 'de', 'des', 'mon', 'ma', 'ce', 'cet', 'cette', 'piece', 'equipement', 'nomme', 'nommee', 'appele', 'appelee'].includes(w));

/**
 * « Ajoute une pièce Cuisine dans la maison », « renomme la pièce Cuisine en
 * Cuisine d'été », « supprime la pièce Bureau de l'appartement », « ajoute un
 * équipement Chaudière dans la pièce Cellier de la maison », « renomme
 * l'équipement Chaudière en Chaudière gaz », « retire l'équipement Chaudière »
 * (pure, testée). Le nom est repris tel qu'écrit.
 */
function parseStructureCommand(message: string): CommandDraft | null {
  const nfc = message.normalize('NFC');
  const brut = plain(nfc);
  const tete = brut.match(/^\s*/)![0].length;
  const poli = brut.slice(tete).match(DEMANDE_POLIE)?.[0].length ?? 0;
  const decalage = tete + poli + brut.slice(tete + poli).match(/^\s*/)![0].length;
  const m = brut.slice(decalage).replace(/[.!?\s]+$/, '');
  if (PIECE_DOCUMENT.test(m)) return null;
  const NOM = '(piece|equipement)';
  const EQUIP = String.raw`(?:l'|le\s+|mon\s+|cet\s+)equipement`;
  const cibleEquipement = (zone: string, values: Array<LabelledValue<EquipmentLabelKey>>): CommandDraft | null => {
    const bien = separerBien(zone);
    const mots = motsCible(bien.reste);
    return mots.length && values.length ? { command: 'UPDATE_EQUIPMENT', targetWords: mots, values, assetWords: bien.assetWords, assetFromContext: bien.assetFromContext } : null;
  };

  // Carte #807 (E01, W05) — « Modifie l'équipement Chaudière de la maison : marque Viessmann, modèle Vitodens 200 ».
  const riche = m.match(new RegExp(String.raw`^${VERBE_MODIFIER}\s+${EQUIP}\s+(.+?)\s*(?::|\bavec\b)\s*(.+)$`));
  if (riche) {
    const values = parseLabelledValues(origine(nfc, decalage + m.length - riche[2].length), EQUIPMENT_LABELS);
    return values ? cibleEquipement(riche[1], values) : null;
  }
  // « Déplace l'équipement Chaudière vers l'appartement » / « … dans la pièce Cellier ».
  const deplacer = m.match(new RegExp(String.raw`^(?:deplace|deplacer|transfere|transferer|mets|mettre|range|ranger)\s+${EQUIP}\s+(.+)\s+(?:vers|dans|sur)\s+(.+)$`));
  if (deplacer) {
    const dest = deplacer[2];
    const piece = dest.match(/^(?:la\s+|sa\s+)?piece\s+(.+)$/);
    const debut = decalage + m.length - (piece ? piece[1].length : dest.length);
    const brutDest = origine(nfc, debut, decalage + m.length);
    if (piece) {
      // « … dans la pièce Cellier de la maison » : le complément final situe le bien, pas la pièce.
      const nomPiece = brutDest.slice(0, separerBien(piece[1]).reste.length).trim();
      return cibleEquipement(deplacer[1], [{ key: 'room', raw: nomPiece || null }]);
    }
    return cibleEquipement(deplacer[1], [{ key: 'asset', raw: brutDest.replace(/^(?:le\s+bien\s+|la\s+|le\s+|l['’]|mon\s+|ma\s+|notre\s+)/i, '').trim() || null }]);
  }
  // « Mets la marque de l'équipement Chaudière à Viessmann » ; « Efface le numéro de série de l'équipement Chaudière ».
  const unChamp = m.match(new RegExp(String.raw`^(mets|mettre|change|changer|modifie|modifier|corrige|corriger|renseigne|renseigner|indique|indiquer|efface|effacer|supprime|supprimer|retire|retirer|vide|vider)\s+(?:le\s+|la\s+|l')\s*(.+?)\s+de\s+${EQUIP}\s+(.+)$`));
  if (unChamp) {
    const key = labelKey(unChamp[2], EQUIPMENT_LABELS);
    if (!key) return null;
    if (/^(?:efface|effacer|supprime|supprimer|retire|retirer|vide|vider)$/.test(unChamp[1])) return cibleEquipement(unChamp[3], [{ key, raw: null }]);
    const coupe = [...unChamp[3].matchAll(/\s+(?:a|en|par|:|=)\s+/g)].pop();
    if (!coupe || coupe.index === undefined) return null;
    const valeur = sansGuillemets(origine(nfc, decalage + m.length - (unChamp[3].length - coupe.index - coupe[0].length), decalage + m.length));
    return cibleEquipement(unChamp[3].slice(0, coupe.index), [{ key, raw: valeur || null }]);
  }

  const creer = m.match(new RegExp(`^(?:ajoute|ajouter|cree|creer|enregistre|enregistrer)\\s+(?:une|un|la|le|l')\\s*(?:nouvelle\\s+|nouvel\\s+|nouveau\\s+)?${NOM}\\b\\s*`));
  if (creer) {
    const piece = creer[1] === 'piece';
    let zone = m.slice(creer[0].length);
    let roomWords: string[] = [];
    // Carte #807 (E02) : informations de la fiche fournies à la création — « … : marque Viessmann, prix d'achat 2 500 € ».
    let values: Array<LabelledValue<EquipmentLabelKey>> | undefined;
    const liste = piece ? null : zone.match(/\s*(?::|\bavec\b)\s*(.+)$/);
    if (liste && liste.index !== undefined) {
      const lus = parseLabelledValues(origine(nfc, decalage + m.length - liste[1].length, decalage + m.length), EQUIPMENT_LABELS);
      if (lus) { values = lus; zone = zone.slice(0, liste.index); }
    }
    // Guillemets : le nom est pris tel quel ; le reste de la phrase situe l'équipement et le bien.
    const cite = nomDonne(message);
    const guillemets = /[«"“]/.test(nfc);
    if (guillemets && cite) zone = zone.replace(plain(cite), ' ').replace(/[«»"“”]/g, ' ');
    const bien = separerBien(zone);
    zone = bien.reste;
    if (!piece) {
      const dans = zone.match(/\s*\bdans\s+(?:la\s+piece|le|la|l')\s*([a-z0-9' -]+?)\s*$/);
      if (dans && dans.index !== undefined) { roomWords = motsCible(dans[1]); zone = zone.slice(0, dans.index); }
    }
    let name = guillemets ? cite : null;
    if (!name) {
      const debut = decalage + creer[0].length;
      const brutNom = origine(nfc, debut, debut + zone.length).replace(/^(?:nommé|nommée|appelé|appelée)\s+/i, '').replace(/[\s.!?:,]+$/, '').trim();
      name = brutNom || null;
    }
    return {
      command: piece ? 'CREATE_ROOM' : 'CREATE_EQUIPMENT', name: name ? name.slice(0, 120) : null, roomWords,
      assetWords: bien.assetWords, assetFromContext: bien.assetFromContext, ...(values ? { values } : {}),
    };
  }

  const renommer = m.match(new RegExp(`^(?:renomme|renommer)\\s+(?:la|le|l'|ma|mon|cette|cet)\\s*${NOM}\\s+(.+?)\\s+en\\s+(.+)$`));
  if (renommer) {
    const bien = separerBien(renommer[2]);
    const cible = motsCible(bien.reste);
    if (!cible.length) return null;
    const valeur = sansGuillemets(origine(nfc, decalage + m.lastIndexOf(renommer[3])));
    return { command: renommer[1] === 'piece' ? 'RENAME_ROOM' : 'RENAME_EQUIPMENT', targetWords: cible, newName: valeur ? valeur.slice(0, 120) : null, assetWords: bien.assetWords, assetFromContext: bien.assetFromContext };
  }

  const retirer = m.match(new RegExp(`^(?:supprime|supprimer|efface|effacer|retire|retirer|enleve|enlever|archive|archiver)\\s+(?:definitivement\\s+)?(?:la|le|l'|ma|mon|cette|cet)\\s*${NOM}\\s+(.+)$`));
  if (retirer) {
    const bien = separerBien(retirer[2]);
    const cible = motsCible(bien.reste);
    if (!cible.length) return null;
    return { command: retirer[1] === 'piece' ? 'DELETE_ROOM' : 'ARCHIVE_EQUIPMENT', targetWords: cible, assetWords: bien.assetWords, assetFromContext: bien.assetFromContext };
  }
  return null;
}

/**
 * Options d'analyse (passage 114Z4, #753).
 *
 * `referenceEventAnaphora` : autorise « … à celui-ci » / « … à cet événement » à désigner l'événement de
 * référence que la commande PRÉCÉDENTE de la même phrase enregistre. Jamais activée pour un message isolé : sans
 * elle, « Rattache le document X à celui-ci » garde son sens d'avant (le bien de la page ou du fil).
 */
export interface ParseCommandOptions {
  /** Passage 114Z4 : « … à celui-ci » après une déclaration de la MÊME phrase (fournisseur et document). */
  referenceEventAnaphora?: boolean;
  /**
   * Passage 114AA : « Relie le fournisseur … à celui-ci » d'un TOUR À L'AUTRE — l'événement de référence du
   * fil. Seule forme pronominale admise hors de la même phrase : aucune autre lecture n'est possible.
   */
  referenceEventThreadAnaphora?: boolean;
}

/** Brouillon de commande, ou `null` si le message n'est pas une commande claire. */
export function parseCommand(message: string, today: string, options: ParseCommandOptions = {}): CommandDraft | null {
  const m = plain(message).trim();

  // ── Événements de référence (lot 114X, W21 – W26) : AVANT tout le reste — ces formes nomment toujours
  // l'objet (« événement de référence », ou un type : intervention, achat, contrat…) et sont ancrées en début
  // de message. « Relie le fournisseur Durand à l'intervention … » ne crée pas un fournisseur ; « rattache le
  // document … à l'intervention … » ne cherche pas un bien ; « supprime l'événement de référence … » ne vise
  // pas l'Agenda. Une caractéristique de bien du registre (« date d'achat ») reste à son analyseur.
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const evenement = parseReferenceEventCommand(message, today, options.referenceEventAnaphora === true, options.referenceEventThreadAnaphora === true);
    if (evenement) return evenement;
  }

  // ── Carte #843 (E03) : retrait CIBLÉ d'un lien d'une échéance — avant fournisseurs, pièces, équipements et documents.
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const retrait = parseAgendaLinkRemoval(message, today);
    if (retrait) return retrait;
  }

  // ── Fournisseurs (lot 114) : avant les biens — « ajoute le fournisseur … » ne crée jamais un bien.
  // Les formes reconnues sont ancrées en début de message (« ajoute un rappel pour le fournisseur … » reste une échéance).
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const fournisseur = parseSupplierCommand(message);
    if (fournisseur) return fournisseur;
  }

  // ── Pièces et équipements (lot 114) : formes ancrées en début de message.
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m) && /\b(piece|equipement)\b/.test(m)) {
    const structure = parseStructureCommand(message);
    if (structure) return structure;
  }

  // ── Documents (lot 114) : avant les échéances — « supprime le document Entretien chaudière » ne vise jamais l'Agenda.
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const document = parseDocumentCommand(message, today);
    if (document) return document;
  }

  // ── Créer / supprimer un bien (lot 114B) ──────────────────────────────
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    // Lot 114F : renommer un bien et effacer une caractéristique AVANT la suppression d'un bien —
    // « efface la date d'achat de la Clio » n'est jamais une demande de suppression de la Clio.
    // Passage 114AA : la catégorie et le statut d'un bien (W02) nomment leur champ ou un statut du référentiel ;
    // elles passent après le renommage (« change le nom … ») et avant l'effacement d'une caractéristique.
    const bien = parseAssetCreation(message) ?? parseAssetRename(message) ?? parseAssetClassification(message)
      ?? parseAssetFieldClear(message) ?? parseAssetDeletion(message);
    if (bien) return bien;
  }

  // ── Modifier / supprimer une échéance (lot 114B) ──────────────────────
  // Une question (« peux-tu me dire… ? », « quand… ») n'est jamais une commande.
  if (!(CREATE.test(m) && AGENDA_NOUN.test(m)) && !INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const agenda = parseAgendaChange(message, today);
    if (agenda) return agenda;
  }

  // ── Modifier une caractéristique d'un bien ────────────────────────────
  // « Mets le contrôle technique au … » désigne le champ du véhicule ; une
  // création (« ajoute / enregistre un contrôle technique … ») reste une
  // création d'échéance, comme avant.
  if (!(CREATE.test(m) && AGENDA_NOUN.test(m))) {
    const update = parseAssetFieldUpdate(message, today);
    if (update) return update;
  }

  // ── Créer une échéance ────────────────────────────────────────────────
  if (CREATE.test(m) && AGENDA_NOUN.test(m)) {
    const noun = m.match(AGENDA_NOUN)!;
    // Titre : ce qui suit le nom, jusqu'à la date ou au bien.
    const apres = m.slice((noun.index ?? 0) + noun[0].length);
    const coupe = apres.split(/\s(?:le|du|au|pour|a partir du|ce|cette)\s|\s\d{1,2}(?:er)?[\s/]/)[0] ?? '';
    const titreMots = motsUtiles(coupe).filter((w) => !['pour', 'maison', 'voiture'].includes(w));
    const nounWord = noun[2];
    // Les mots du titre sont repris du message d'origine (accents compris).
    const originaux = message.split(/[^\p{L}0-9-]+/u).filter(Boolean);
    const avecAccents = titreMots.map((w) => originaux.find((o) => plain(o) === w) ?? w);
    const title = titreMots.length
      ? capitalize(avecAccents.join(' ').toLowerCase())
      : capitalize(nounWord === 'rdv' ? 'rendez-vous' : nounWord);
    const pour = m.match(/\bpour\s+(?:ma|mon|mes|la|le|l'|notre)?\s*([a-z0-9' -]+?)(?:\s+le\s+\d|\s+du\s+\d|$|[?.!,])/);
    const assetFromContext = /\bpour\s+(ce|cet|cette)\s+\w+/.test(m);
    return {
      command: 'CREATE_AGENDA_ITEM',
      title,
      date: parseDateFr(m, today),
      noDeadline: /\bsans echeance\b/.test(m),
      assetWords: pour && !assetFromContext ? motsUtiles(pour[1]) : [],
      assetFromContext,
    };
  }

  // Lot 113P (#715) : plus de commande « marquer comme réalisée » / « annuler une échéance » —
  // un événement n'a plus de statut (une échéance erronée se supprime depuis l'Agenda).
  return null;
}

/** Verbes qui ouvrent une nouvelle commande dans un même message. */
const DEBUT_COMMANDE = /\s+(puis|ensuite|et ensuite|et puis|et)\s+(?=(ajoute|ajouter|crée|cree|créer|creer|programme|planifie|enregistre|marque|marquer|indique|passe|annule|annuler|mets|modifie|change|renseigne|corrige|supprime|efface|retire|enlève|enleve|déplace|deplace|reporte|décale|decale|repousse|avance|renomme|rattache|détache|detache|dissocie|associe|relie|déclare|declare|invalide)\b)/i;

/**
 * Découpe un message en commandes successives (« ajoute… et marque… »,
 * « crée… puis annule… »). `puis` / `ensuite` expriment une dépendance :
 * la commande suivante n'est exécutée que si la précédente réussit ; `et`
 * les laisse indépendantes. Rend `null` si un segment n'est pas une
 * commande claire — un plan partiellement compris n'est jamais proposé.
 */
export function parseCommands(message: string, today: string): CommandSegment[] | null {
  const segments: CommandSegment[] = [];
  let reste = message;
  let dependance = false;
  for (let i = 0; i < 10; i += 1) {
    const hit = reste.match(DEBUT_COMMANDE);
    const morceau = hit ? reste.slice(0, hit.index) : reste;
    // Passage 114Z4 : « Déclare … PUIS relie … à celui-ci » — l'anaphore n'est admise qu'après une déclaration
    // d'événement de référence dont ce segment dépend ; partout ailleurs elle n'existe pas (aucun changement).
    const precedent = segments[segments.length - 1]?.draft;
    const draft = parseCommand(morceau, today, {
      referenceEventAnaphora: dependance && precedent?.command === 'CREATE_REFERENCE_EVENT',
      // Passage 114AA : hors de ce cas, le pronom seul ne vaut que pour « relie le fournisseur … à celui-ci »,
      // et seulement si le fil porte un événement de référence (vérifié à la préparation du plan). Après une
      // déclaration de la MÊME phrase reliée par « et » (actions indépendantes), il reste inadmis : « celui-ci »
      // y désignerait l'événement du tour précédent, jamais celui que la phrase déclare (règle du passage 114Z).
      referenceEventThreadAnaphora: precedent?.command !== 'CREATE_REFERENCE_EVENT',
    });
    if (!draft) return null;
    segments.push({ draft, dependsOnPrevious: dependance });
    if (!hit) break;
    dependance = hit[1].toLowerCase() !== 'et';
    reste = reste.slice((hit.index ?? 0) + hit[0].length);
  }
  return segments.length ? segments : null;
}
