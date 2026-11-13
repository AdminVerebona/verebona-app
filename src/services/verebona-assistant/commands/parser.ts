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
    }
  | ({
      command: 'DELETE_AGENDA_ITEM';
      /** SERIES seulement si la série est demandée (« toute la série », « tous les… »). */
      scope: 'OCCURRENCE' | 'SERIES';
    } & AgendaTargetDraft);

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
 * « Supprime l'échéance vidange du 12 mars », « supprime toute la série des
 * rappels vidange », « reporte le contrôle technique de la Clio au 20 mars »,
 * « renomme l'échéance vidange en révision annuelle » (pure, testée).
 */
function parseAgendaChange(message: string, today: string): CommandDraft | null {
  const m = plain(message).trim();
  if (!AGENDA_TARGET.test(m)) return null;
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
    return { command: 'UPDATE_AGENDA_ITEM', newDate: null, newTitle: capitalize(original), ...cible };
  }
  if (MOVE_VERB.test(m)) {
    // La NOUVELLE date suit le dernier « au / à / pour le » ; ce qui précède désigne l'échéance.
    const sep = [...m.matchAll(/\s(?:au|a|pour le|pour)\s+(?=\d|le\s+\d|demain)/g)].pop();
    if (!sep || sep.index === undefined) return null;
    const newDate = parseDateFr(m.slice(sep.index), today);
    const cible = agendaTarget(m.slice(0, sep.index), today);
    if (!cible || !newDate) return null;
    return { command: 'UPDATE_AGENDA_ITEM', newDate, newTitle: null, ...cible };
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
 * « Supprime la Clio », « supprime mon vélo cargo », « supprime ce bien »
 * (pure, testée). Jamais si le message parle d'un autre objet (« supprime le
 * document de la Clio ») ni d'une échéance.
 */
function parseAssetDeletion(message: string): CommandDraft | null {
  const m = plain(message).trim().replace(DEMANDE_POLIE, '').trim();
  const debut = m.match(/^(?:supprime|supprimer|efface|effacer)\s+(?:definitivement\s+)?(ma|mon|mes|la|le|l'|notre|ce|cet|cette)\s*(?:bien\s+)?/);
  if (!debut || AGENDA_TARGET.test(m) || AUTRE_OBJET.test(m)) return null;
  const assetFromContext = /^(ce|cet|cette)$/.test(debut[1]);
  const mots = motsUtiles(m.slice(debut[0].length)).filter((w) => !['definitivement', 'compte', 'tout', 'tous'].includes(w));
  if (!assetFromContext && mots.length === 0) return null;
  return { command: 'DELETE_ASSET', assetWords: assetFromContext ? [] : mots, assetFromContext };
}

/** Brouillon de commande, ou `null` si le message n'est pas une commande claire. */
export function parseCommand(message: string, today: string): CommandDraft | null {
  const m = plain(message).trim();

  // ── Créer / supprimer un bien (lot 114B) ──────────────────────────────
  if (!INTERROGATIF.test(m) && !LECTURE_MOI.test(m)) {
    const bien = parseAssetCreation(message) ?? parseAssetDeletion(message);
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
const DEBUT_COMMANDE = /\s+(puis|ensuite|et ensuite|et puis|et)\s+(?=(ajoute|ajouter|crée|cree|créer|creer|programme|planifie|enregistre|marque|marquer|indique|passe|annule|annuler|mets|modifie|change|renseigne|corrige|supprime|efface|retire|enlève|enleve|déplace|deplace|reporte|décale|decale|repousse|avance|renomme)\b)/i;

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
    const draft = parseCommand(morceau, today);
    if (!draft) return null;
    segments.push({ draft, dependsOnPrevious: dependance });
    if (!hit) break;
    dependance = hit[1].toLowerCase() !== 'et';
    reste = reste.slice((hit.index ?? 0) + hit[0].length);
  }
  return segments.length ? segments : null;
}
