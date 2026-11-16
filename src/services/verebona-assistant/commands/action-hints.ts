/**
 * Actions comprises par le SENS — Trello #753, CDC T2 §9.1, §9.3, §12.1, annexe A13 (bloc PO n° 40).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MODÈLE PROPOSE DES INDICES ; LE SERVEUR RECONNAÎT, RÉSOUT ET FAIT CONFIRMER
 *
 * Les commandes de l'Assistant sont reconnues sans modèle, sur des formulations
 * directes (« Renomme la Clio en … »). Une tournure libre (« j'aimerais bien
 * que la Clio s'appelle Clio de Paul ») n'était pas reconnue. Quand le prompt
 * maître T2 produit le champ `actionIntents` (bloc PO n° 40), la compréhension
 * rend des INDICES : opération, type d'objet, désignation, champs et valeurs.
 *
 * Ces indices ne sont jamais exécutés. Chacun est RÉÉCRIT par le serveur dans
 * la formulation directe correspondante, puis passe par le MÊME analyseur que
 * les phrases de l'utilisateur (`parser.ts`) et la MÊME préparation de plan
 * (`plan.service`) : catalogue fermé, cible retrouvée dans le compte (jamais
 * un identifiant du modèle), droits, valeurs relues, plan figé, boutons
 * Confirmer / Annuler. Garde-fous :
 *   · la commande reconnue doit être EXACTEMENT celle que l'indice annonce
 *     (sinon l'indice est écarté) ;
 *   · un seul indice non reconnu : rien n'est proposé (jamais un plan partiel
 *     présenté comme complet) — la demande suit le parcours déjà en place ;
 *   · EXPORT : génération directe par le service d'export (aucune écriture),
 *     comme une demande d'export écrite.
 *
 * Sans le bloc PO n° 40, le champ est absent : ce module n'est jamais appelé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ActionHint, AssistantRequestInput } from '../types/contracts';
import { plain } from '../core/routing-text';
import { findAssetField } from './asset-fields';
import { parseCommand, type CommandDraft } from './parser';
import type { WriteCommandType } from './catalog';
import { exportLabel, parseExportRequest, type ExportAnswer } from './export-request';
import { TYPE_NOUNS } from './reference-event-model';
import { assetDesignationsIn } from '@/lib/asset-taxonomy';

/** Désignation nettoyée : ni guillemets, ni ponctuation finale, ni déterminant en tête. */
function designation(hint: string | null): string | null {
  const t = (hint ?? '').normalize('NFC').replace(/[«»"“”]/g, ' ').replace(/[.!?;:]+\s*$/, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:le|la|les|mon|ma|mes|notre|votre|ce|cet|cette)\s+/i, '').replace(/^l['’]\s*/i, '').trim();
  return t && t.length <= 120 ? t : null;
}

/** Désignation privée du nom de son objet (« la pièce Cuisine » → « Cuisine ») ; `null` s'il ne reste rien. */
function sansNomObjet(hint: string | null, nom: RegExp): string | null {
  const t = designation(hint);
  return t ? t.replace(nom, '').trim() || null : null;
}

/** Valeur telle qu'elle sera écrite dans la formulation directe (une date ISO devient JJ/MM/AAAA). */
function valeur(v: string | null, unit: string | null): string | null {
  const t = (v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return unit && !plain(t).includes(plain(unit)) ? `${t} ${unit}` : t;
}

/** Nom ou valeur de texte : sans guillemets ni ponctuation finale, borné ; `null` si vide ou trop long. */
function texte(v: string | null | undefined, max = 120): string | null {
  const t = (v ?? '').normalize('NFC').replace(/[«»"“”]/g, ' ').replace(/[.!?;:,]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

const estNom = (fieldHint: string) => /^(?:nom|name|nouveau nom|titre|title|intitule|libelle)$/.test(plain(fieldHint).trim());

/**
 * Passage 114AA (W02) — champ de CLASSEMENT d'un bien désigné par un indice. « famille » est volontairement
 * exclue de la catégorie (la famille d'un bien ne se change pas), et « situation » du statut (c'est le mot des
 * événements de référence).
 */
const estCategorieDeBien = (fieldHint: string) => /^(?:categorie|category|categorie de bien|type de bien|sous-categorie)$/.test(plain(fieldHint).replace(/\s+/g, ' ').trim());
const estStatutDeBien = (fieldHint: string) => /^(?:statut|status|etat)$/.test(plain(fieldHint).replace(/\s+/g, ' ').trim());

/**
 * Passage 114AB (W12) — champ de CLASSEMENT d'un DOCUMENT désigné par un indice : sa Rubrique, ou son Type
 * (« nature » est le mot courant du Type d'un document). La valeur est contrôlée ensuite dans le référentiel V2.
 */
const estRubriqueDeDocument = (fieldHint: string) => /^(?:rubrique|rubric|categorie|category)$/.test(plain(fieldHint).replace(/\s+/g, ' ').trim());
const estTypeDeDocument = (fieldHint: string) => /^(?:type|nature|type de document|nature du document)$/.test(plain(fieldHint).replace(/\s+/g, ' ').trim());
const estClassementDeDocument = (fieldHint: string) => estRubriqueDeDocument(fieldHint) || estTypeDeDocument(fieldHint);

// ── Lot 114Z2 (#753) : indices étendus aux pièces, équipements, échéances, événements de référence, ─────────────
// rattachements et création d'un bien. Toujours la même règle : réécriture en formulation directe, analyseur
// existant, commande attendue, puis contrôle que chaque mot compris vient bien de la partie de l'indice qui le
// porte (jamais un mot du nom pris pour le bien, ni l'inverse). Au moindre écart : indice écarté.

/** Rôle d'un `fieldChanges` (liste fermée, lue sur son `fieldHint`). */
type Cle = 'nom' | 'bien' | 'piece' | 'equipement' | 'date' | 'categorie' | 'type' | 'situation' | 'prestataire' | 'debut' | 'fin' | 'prevue' | 'evenement' | 'role';
const CLES: ReadonlyArray<readonly [Cle, RegExp]> = [
  ['nom', /^(?:nom|name|nouveau nom|titre|title|nouveau titre|intitule|libelle)$/],
  ['bien', /^(?:bien|bien concerne|asset)$/],
  ['piece', /^(?:piece|room)$/],
  // Passage 114AA : niveau équipement d'un rattachement de document (W13). Les appelants qui ne l'admettent
  // pas écartent l'indice, comme avant (un rôle inconnu les écartait déjà).
  ['equipement', /^(?:equipement|equipment)$/],
  ['date', /^(?:date|nouvelle date|date de realisation|echeance)$/],
  ['categorie', /^(?:categorie|category|type de bien|famille)$/],
  ['type', /^(?:type|nature|type d'evenement)$/],
  ['situation', /^(?:situation|statut|status|etat)$/],
  ['prestataire', /^(?:prestataire|provider)$/],
  ['debut', /^(?:date de debut|debut)$/],
  ['fin', /^(?:date de fin|fin)$/],
  ['prevue', /^date prevue$/],
  ['evenement', /^(?:evenement de reference|evenement|business_operation)$/],
  ['role', /^(?:role)$/],
];
type Champs = Map<Cle, string | null>;

/** Champs d'un indice, par rôle ; `null` si l'un d'eux est inconnu, non admis ici ou donné deux fois (rien n'est ignoré en silence). */
function champsDe(h: ActionHint, admis: readonly Cle[]): Champs | null {
  const out: Champs = new Map();
  for (const c of h.fieldChanges) {
    const p = plain(c.fieldHint).replace(/\s+/g, ' ').trim();
    const cle = CLES.find(([, re]) => re.test(p))?.[0];
    if (!cle || !admis.includes(cle) || out.has(cle)) return null;
    out.set(cle, c.value);
  }
  return out;
}

const MOIS_FR = 'janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre';
/**
 * Date d'un indice, telle qu'elle sera écrite dans la formulation directe : `iso` connu seulement pour une date
 * AAAA-MM-JJ (elle est alors recontrôlée après l'analyse). `relatif` : « hier », « avant-hier », « aujourd'hui »,
 * « demain » admis (déclaration d'un événement). `null` : ce n'est pas une date — l'indice est écarté.
 */
function dateDirecte(v: string | null, relatif: boolean): { ecrite: string; iso: string | null; jour: boolean } | null {
  const t = texte(v, 40);
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.+Z-]*)?$/);
  if (iso) return { ecrite: `${iso[3]}/${iso[2]}/${iso[1]}`, iso: `${iso[1]}-${iso[2]}-${iso[3]}`, jour: false };
  const p = plain(t).replace(/^le\s+/, '');
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(p) || new RegExp(`^\\d{1,2}(?:er)?\\s+(?:${MOIS_FR})(?:\\s+\\d{4})?$`).test(p)) return { ecrite: p, iso: null, jour: false };
  if (relatif && /^(?:avant-hier|hier|aujourd'hui|demain)$/.test(p)) return { ecrite: p, iso: null, jour: true };
  return null;
}

/** Mots d'un texte (sans accent), avec et sans trait d'union : sert à contrôler d'où vient chaque mot compris. */
function motsDe(t: string | null): Set<string> {
  const out = new Set<string>();
  for (const w of plain(t ?? '').split(/[^a-z0-9-]+/)) {
    if (!w) continue;
    out.add(w);
    for (const part of w.split('-')) if (part) out.add(part);
  }
  return out;
}
/** Tous les mots compris viennent de ce texte (et il y en a, si `requis`). */
const issusDe = (compris: readonly string[], source: string | null, requis = false): boolean => {
  const mots = motsDe(source);
  return (!requis || compris.length > 0) && compris.every((w) => mots.has(w));
};
/** Bien compris par l'analyseur = bien de l'indice : ses mots (au moins un) s'il est nommé, aucun sinon. */
const memeBien = (d: { assetWords: string[] }, bien: string | null): boolean => (bien ? issusDe(d.assetWords, bien, true) : d.assetWords.length === 0);
const memeTexte = (a: string | null, b: string | null): boolean => plain(a ?? '').replace(/\s+/g, ' ').trim() === plain(b ?? '').replace(/\s+/g, ' ').trim();

/**
 * Événement de référence désigné, tel qu'il s'écrit dans une formulation directe : la désignation est gardée si
 * elle commence par le nom d'un type du référentiel (« intervention Vidange ») ou par « événement de référence » ;
 * sinon elle est précédée de « événement de référence ».
 */
function evenementDirect(cible: string): string {
  const p = plain(cible);
  const nomme = p.startsWith('evenement de reference') || [...TYPE_NOUNS.keys()].some((n) => p === n || p.startsWith(`${n} `));
  const t = nomme ? cible : `événement de référence ${cible}`;
  return /^[aeiouy]/.test(plain(t)) ? `l'${t}` : `la ${t}`;
}

/** Situation dite d'un événement : `REALIZED` (a eu lieu), `ENVISAGED` (à prévoir) ; `null` : non comprise. */
function situationDe(v: string | null): 'REALIZED' | 'ENVISAGED' | null {
  const p = plain(v ?? '');
  const eu = /\b(?:eu lieu|realisee?|effectuee?|faite?|terminee?|passee?|realized)\b/.test(p);
  const prevu = /\b(?:a prevoir|prevue?|envisagee?|a venir|a faire|envisaged)\b/.test(p);
  return eu && !prevu ? 'REALIZED' : prevu && !eu ? 'ENVISAGED' : null;
}

/** Longueur gardée de la phrase de l'utilisateur dans une déclaration (le point d'écriture borne le texte entier). */
const DECLARATION_MAX = 1000;

type Directe = { phrase: string; attendu: WriteCommandType; verifier?: (d: CommandDraft) => boolean };

/** Pièce ou équipement d'un bien (W04 – W09). */
function structureDirecte(h: ActionHint): Directe | null {
  const piece = h.entityType === 'room';
  const c = champsDe(h, piece ? ['nom', 'bien'] : ['nom', 'bien', 'piece']);
  if (!c) return null;
  const cible = sansNomObjet(h.targetHint, piece ? /^pi[eè]ces?\s+/i : /^[eé]quipements?\s+/i);
  const nom = texte(c.get('nom'));
  const bienDit = c.has('bien') ? designation(c.get('bien') ?? null) : null;
  if (c.has('bien') && !bienDit) return null;
  const objet = piece ? 'la pièce' : "l'équipement";

  if (h.operation === 'CREATE') {
    // Création : `targetHint` désigne le BIEN, « nom » le nom donné (ou, si le bien est donné à part, `targetHint` est le nom).
    const nouveau = nom ?? (bienDit ? cible : null);
    const bien = bienDit ?? (nom ? cible : null);
    const dans = c.has('piece') ? texte(c.get('piece'))?.replace(/^(?:la\s+)?pi[eè]ce\s+/i, '') ?? null : null;
    if (!nouveau || c.has('nom') !== (nom !== null) || (c.has('piece') && !dans)) return null;
    return {
      phrase: `Ajoute ${piece ? 'une pièce' : 'un équipement'} « ${nouveau} »${dans ? ` dans la pièce ${dans}` : ''} dans ${bien ? `le bien ${bien}` : 'ce bien'}`,
      attendu: piece ? 'CREATE_ROOM' : 'CREATE_EQUIPMENT',
      verifier: (d) => (d.command === 'CREATE_ROOM' || d.command === 'CREATE_EQUIPMENT') && d.name === nouveau && memeBien(d, bien)
        && d.assetFromContext === !bien && (dans ? issusDe(d.roomWords, dans, true) : d.roomWords.length === 0),
    };
  }
  if (!cible || c.has('piece')) return null;
  const duBien = bienDit ? ` de le bien ${bienDit}` : '';
  if (h.operation === 'UPDATE') {
    if (!nom) return null;
    return {
      phrase: `Renomme ${objet} ${cible}${duBien} en ${nom}`, attendu: piece ? 'RENAME_ROOM' : 'RENAME_EQUIPMENT',
      verifier: (d) => (d.command === 'RENAME_ROOM' || d.command === 'RENAME_EQUIPMENT') && d.newName === nom && issusDe(d.targetWords, cible, true) && memeBien(d, bienDit),
    };
  }
  if (h.operation === 'DELETE' && !c.has('nom')) {
    return {
      phrase: `${piece ? 'Supprime' : 'Retire'} ${objet} ${cible}${duBien}`, attendu: piece ? 'DELETE_ROOM' : 'ARCHIVE_EQUIPMENT',
      verifier: (d) => (d.command === 'DELETE_ROOM' || d.command === 'ARCHIVE_EQUIPMENT') && issusDe(d.targetWords, cible, true) && memeBien(d, bienDit),
    };
  }
  return null;
}

/** Échéance de l'Agenda (W15 – W17) : créer (date facultative), déplacer, renommer, supprimer. */
function echeanceDirecte(h: ActionHint): Directe | null {
  const c = champsDe(h, ['nom', 'bien', 'date']);
  if (!c) return null;
  const cible = sansNomObjet(h.targetHint, /^(?:[eé]ch[eé]ances?|rappels?|rendez-vous|rdv)\s+/i);
  const nom = texte(c.get('nom'));
  const bienDit = c.has('bien') ? designation(c.get('bien') ?? null) : null;
  const date = c.has('date') ? dateDirecte(c.get('date') ?? null, false) : null;
  if ((c.has('bien') && !bienDit) || (c.has('date') && !date) || c.has('nom') !== (nom !== null)) return null;
  const memeDate = (lue: string | null): boolean => (date ? lue !== null && (date.iso === null || lue === date.iso) : lue === null);

  if (h.operation === 'CREATE') {
    // Création : `targetHint` désigne le BIEN, « nom » le titre (ou, si le bien est donné à part, `targetHint` est le titre).
    const titre = nom ?? (bienDit ? cible : null);
    const bien = bienDit ?? (nom ? cible : null);
    if (!titre) return null;
    return {
      phrase: `Ajoute un rappel ${titre}${bien ? ` pour le bien ${bien}` : ''}${date ? ` le ${date.ecrite}` : ''}`,
      attendu: 'CREATE_AGENDA_ITEM',
      // Le titre compris ne porte que des mots du titre donné (l'aperçu l'affiche avant toute confirmation).
      verifier: (d) => d.command === 'CREATE_AGENDA_ITEM' && issusDe(motsDe(d.title).size ? [...motsDe(d.title)] : [], titre, true)
        && memeBien(d, bien) && !d.assetFromContext && !d.noDeadline && memeDate(d.date),
    };
  }
  if (!cible) return null;
  const pourBien = bienDit ? ` pour le bien ${bienDit}` : '';
  // Bien de l'échéance : donné à part, ou dans sa désignation (« le contrôle technique de la Clio »).
  const bienCompris = (d: { itemWords: string[]; assetWords: string[] }): boolean =>
    issusDe(d.itemWords, cible) && (bienDit ? issusDe(d.assetWords, bienDit, true) : issusDe(d.assetWords, cible)) && d.itemWords.length + d.assetWords.length > 0;
  if (h.operation === 'UPDATE') {
    if (date && !nom) {
      return {
        phrase: `Reporte l'échéance ${cible}${pourBien} au ${date.ecrite}`, attendu: 'UPDATE_AGENDA_ITEM',
        verifier: (d) => d.command === 'UPDATE_AGENDA_ITEM' && d.newTitle === null && memeDate(d.newDate) && bienCompris(d),
      };
    }
    if (nom && !date) {
      return {
        phrase: `Renomme l'échéance ${cible}${pourBien} en ${nom}`, attendu: 'UPDATE_AGENDA_ITEM',
        verifier: (d) => d.command === 'UPDATE_AGENDA_ITEM' && d.newDate === null && memeTexte(d.newTitle, nom) && bienCompris(d),
      };
    }
    return null;
  }
  if (h.operation === 'DELETE' && !nom && !date) {
    return {
      phrase: `Supprime l'échéance ${cible}${pourBien}`, attendu: 'DELETE_AGENDA_ITEM',
      verifier: (d) => d.command === 'DELETE_AGENDA_ITEM' && bienCompris(d),
    };
  }
  return null;
}

/** Événement de référence (W21 – W24) : déclarer, corriger un champ, supprimer, associer à un autre. */
function evenementDirecte(h: ActionHint): Directe | null {
  const c = champsDe(h, ['nom', 'bien', 'date', 'type', 'situation', 'prestataire', 'debut', 'fin', 'prevue', 'evenement']);
  if (!c) return null;
  const cible = designation(h.targetHint);
  const nom = texte(c.get('nom'), 200);
  if (c.has('nom') !== (nom !== null)) return null;

  if (h.operation === 'CREATE') {
    if (c.has('prestataire') || c.has('debut') || c.has('fin') || c.has('prevue') || c.has('evenement')) return null;
    const type = c.has('type') ? plain(texte(c.get('type')) ?? '').replace(/^(?:une?\s+|l'|le\s+|la\s+)/, '') : null;
    if (type !== null && !TYPE_NOUNS.has(type)) return null;
    const situation = c.has('situation') ? situationDe(c.get('situation') ?? null) : null;
    const date = c.has('date') ? dateDirecte(c.get('date') ?? null, true) : null;
    const bienDit = c.has('bien') ? designation(c.get('bien') ?? null) : null;
    if ((c.has('situation') && !situation) || (c.has('date') && !date) || (c.has('bien') && !bienDit)) return null;
    // Déclaration : `targetHint` désigne le BIEN, « nom » l'intitulé (ou, si le bien est donné à part, `targetHint` est l'intitulé).
    const intitule = nom ?? (bienDit ? cible : null);
    const bien = bienDit ?? (nom ? cible : null);
    // Un intitulé est exigé : sans lui, l'analyseur prendrait le reste de la phrase pour un intitulé.
    if (!intitule) return null;
    return {
      phrase: `Déclare un ${type ?? 'événement de référence'} « ${intitule} »${situation === 'REALIZED' ? ' réalisée' : situation === 'ENVISAGED' ? ' à prévoir' : ''}`
        + `${date ? (date.jour ? ` ${date.ecrite}` : ` le ${date.ecrite}`) : ''}${bien ? ` pour le ${bien}` : ''}`,
      attendu: 'CREATE_REFERENCE_EVENT',
      verifier: (d) => d.command === 'CREATE_REFERENCE_EVENT' && d.labelQuoted && d.label === intitule && d.status === situation
        && (d.typeCode ?? null) === (type ? TYPE_NOUNS.get(type) ?? null : null) && (d.dateText !== null) === (date !== null)
        && memeBien(d, bien) && !d.assetFromContext,
    };
  }

  if (!cible) return null;
  const evt = evenementDirect(cible);
  const memeCible = (t: { words: string[] }): boolean => issusDe(t.words, cible);
  if (h.operation === 'DELETE' && h.fieldChanges.length === 0) {
    return { phrase: `Supprime ${evt}`, attendu: 'INVALIDATE_REFERENCE_EVENT', verifier: (d) => d.command === 'INVALIDATE_REFERENCE_EVENT' && memeCible(d.target) };
  }
  if (h.operation === 'LINK' && h.fieldChanges.length === 1 && c.has('evenement')) {
    const autre = designation(c.get('evenement') ?? null);
    if (!autre) return null;
    return {
      phrase: `Associe ${evt} à ${evenementDirect(autre)}`, attendu: 'ASSOCIATE_REFERENCE_EVENTS',
      verifier: (d) => d.command === 'ASSOCIATE_REFERENCE_EVENTS' && memeCible(d.first) && issusDe(d.second.words, autre),
    };
  }
  if (h.operation !== 'UPDATE' || h.fieldChanges.length !== 1) return null;
  // Correction : UN champ à la fois, comme la formulation directe.
  const maj = (field: string, v: string | null, phrase: (v: string) => string): Directe | null => (v ? {
    phrase: phrase(v), attendu: 'UPDATE_REFERENCE_EVENT',
    verifier: (d) => d.command === 'UPDATE_REFERENCE_EVENT' && d.field === field && memeTexte(d.value, v) && memeCible(d.target),
  } : null);
  if (nom) return maj('label', nom, (v) => `Renomme ${evt} en ${v}`);
  if (c.has('prestataire')) return maj('provider', texte(c.get('prestataire'), 200), (v) => `Change le prestataire de ${evt} : ${v}`);
  if (c.has('type')) {
    const type = plain(texte(c.get('type')) ?? '').replace(/^(?:une?\s+|l'|le\s+|la\s+)/, '');
    return TYPE_NOUNS.has(type) ? maj('type', type, (v) => `Change le type de ${evt} : ${v}`) : null;
  }
  if (c.has('situation')) {
    // Seul « a eu lieu » se corrige (un événement qui a eu lieu ne redevient pas « à prévoir »).
    return situationDe(c.get('situation') ?? null) === 'REALIZED' ? {
      phrase: `Indique que ${evt} a eu lieu`, attendu: 'UPDATE_REFERENCE_EVENT',
      verifier: (d) => d.command === 'UPDATE_REFERENCE_EVENT' && d.field === 'status' && d.value === 'REALIZED' && memeCible(d.target),
    } : null;
  }
  for (const [cle, champ, field] of [['date', 'date', 'date'], ['debut', 'date de début', 'startDate'], ['fin', 'date de fin', 'endDate'], ['prevue', 'date prévue', 'plannedDate']] as const) {
    if (!c.has(cle)) continue;
    const date = dateDirecte(c.get(cle) ?? null, true);
    return date ? maj(field, date.ecrite, (v) => `Corrige la ${champ} de ${evt} : ${v}`) : null;
  }
  return null;
}

/**
 * Rattachement d'un document : à un bien ou hors d'un bien (W13), à une pièce ou à un équipement (W13, passage
 * 114AA), à un événement de référence (W25).
 */
function lienDocumentDirect(h: ActionHint, cible: string | null): Directe | null {
  const c = champsDe(h, ['bien', 'piece', 'equipement', 'evenement']);
  if (!c || h.fieldChanges.length !== 1) return null;
  const doc = cible ? `le document ${cible}` : 'ce document';
  const memeDocument = (d: { documentWords: string[]; documentFromContext: boolean }): boolean =>
    (cible ? issusDe(d.documentWords, cible, true) && !d.documentFromContext : d.documentFromContext);
  // Passage 114AA : pièce ou équipement nommé — le bien porteur est retrouvé ensuite, dans le compte.
  const piece = c.has('piece');
  if (piece || c.has('equipement')) {
    const nom = designation(c.get(piece ? 'piece' : 'equipement') ?? null);
    if (!nom) return null;
    const mode = h.operation === 'LINK' ? 'attach' : 'detach';
    const ou = piece ? `la pièce ${nom}` : `l’équipement ${nom}`;
    return {
      phrase: mode === 'attach' ? `Rattache ${doc} à ${ou}` : `Détache ${doc} de ${ou}`, attendu: 'UPDATE_DOCUMENT_TARGETS',
      verifier: (d) => d.command === 'UPDATE_DOCUMENT_TARGETS' && d.mode === mode && d.assetWords.length === 0 && !d.assetFromContext
        && d.structureTarget?.kind === (piece ? 'room' : 'equipment') && issusDe(d.structureTarget.words, nom, true) && memeDocument(d),
    };
  }
  if (c.has('bien')) {
    const bien = designation(c.get('bien') ?? null);
    if (!bien) return null;
    const mode = h.operation === 'LINK' ? 'attach' : 'detach';
    return {
      phrase: mode === 'attach' ? `Rattache ${doc} à le bien ${bien}` : `Détache ${doc} de le bien ${bien}`, attendu: 'UPDATE_DOCUMENT_TARGETS',
      verifier: (d) => d.command === 'UPDATE_DOCUMENT_TARGETS' && d.mode === mode && !d.structureTarget && !d.assetFromContext && memeBien(d, bien) && memeDocument(d),
    };
  }
  const evenement = designation(c.get('evenement') ?? null);
  if (!evenement || h.operation !== 'LINK') return null;
  return {
    phrase: `Rattache ${doc} à ${evenementDirect(evenement)}`, attendu: 'LINK_DOCUMENT_REFERENCE_EVENT',
    verifier: (d) => d.command === 'LINK_DOCUMENT_REFERENCE_EVENT' && memeDocument(d) && issusDe(d.target.words, evenement),
  };
}

/** Lien d'un fournisseur avec un événement de référence (W26) ; rôle « intervenant » s'il est dit, sinon prestataire. */
function lienFournisseurDirect(h: ActionHint, cible: string | null): Directe | null {
  const c = champsDe(h, ['evenement', 'role']);
  if (!c || !cible || h.operation !== 'LINK') return null;
  const evenement = designation(c.get('evenement') ?? null);
  const role = c.has('role') ? plain(texte(c.get('role')) ?? '') : null;
  if (!evenement || (role !== null && role !== 'intervenant' && role !== 'prestataire')) return null;
  const intervenant = role === 'intervenant';
  return {
    phrase: `Relie le fournisseur ${cible} à ${evenementDirect(evenement)}${intervenant ? ' comme intervenant' : ''}`, attendu: 'LINK_SUPPLIER_REFERENCE_EVENT',
    verifier: (d) => d.command === 'LINK_SUPPLIER_REFERENCE_EVENT' && d.role === (intervenant ? 'INTERVENER' : 'PROVIDER')
      && issusDe(d.supplierWords, cible, true) && issusDe(d.target.words, evenement),
  };
}

/** Création d'un bien (W01) : catégorie du référentiel des biens (« voiture », « maison »…) et nom donné. */
function creationBienDirecte(h: ActionHint): Directe | null {
  const c = champsDe(h, ['nom', 'categorie', 'type']);
  if (!c || (c.has('categorie') && c.has('type'))) return null;
  const nom = texte(c.get('nom'));
  if (c.has('nom') !== (nom !== null)) return null;
  const dite = c.has('categorie') ? c.get('categorie') ?? null : c.has('type') ? c.get('type') ?? null : h.targetHint;
  const categorie = designation(dite)?.replace(/^(?:un|une)\s+/i, '') ?? null;
  // La catégorie doit être une désignation du référentiel des biens, en entier.
  const d0 = categorie ? assetDesignationsIn(categorie)[0] : undefined;
  if (!categorie || !d0 || plain(categorie).replace(/\s+/g, ' ').trim() !== d0.matched) return null;
  return {
    phrase: `Ajoute un bien de type ${categorie}${nom ? ` « ${nom} »` : ''}`, attendu: 'CREATE_ASSET',
    verifier: (d) => d.command === 'CREATE_ASSET' && d.name === nom && d.family === d0.family,
  };
}

/** Formulation directe d'un indice et commande attendue ; `null` : indice non pris en charge. */
function phraseDirecte(h: ActionHint): Directe | null {
  const cible = designation(h.targetHint);
  const bien = cible ? `le bien ${cible}` : 'ce bien';
  const c = h.fieldChanges[0] ?? null;
  const lien = h.operation === 'LINK' || h.operation === 'UNLINK';

  // « relation » : l'objet rattaché est reconnu au nom qui ouvre sa désignation (document, fournisseur, type d'événement).
  if (h.entityType === 'relation') {
    if (!lien || !cible) return null;
    const p = plain(cible);
    if (/^(?:document|fichier)\s/.test(p)) return lienDocumentDirect(h, sansNomObjet(h.targetHint, /^(?:document|fichier)\s+/i));
    if (/^(?:fournisseur|prestataire)\s/.test(p)) return lienFournisseurDirect(h, sansNomObjet(h.targetHint, /^(?:fournisseur|prestataire)\s+/i));
    if (p.startsWith('evenement de reference') || [...TYPE_NOUNS.keys()].some((n) => p.startsWith(`${n} `))) return evenementDirecte({ ...h, entityType: 'business_operation' });
    return null;
  }
  if (h.entityType === 'room' || h.entityType === 'equipment') return lien ? null : structureDirecte(h);
  if (h.entityType === 'agenda_item') return lien ? null : echeanceDirecte(h);
  if (h.entityType === 'business_operation') return evenementDirecte(h);

  if (h.entityType === 'asset') {
    if (h.operation === 'CREATE') return creationBienDirecte(h);
    if (h.operation === 'DELETE' && h.fieldChanges.length === 0) return { phrase: `Supprime ${bien}`, attendu: 'DELETE_ASSET' };
    if (h.operation === 'UPDATE' && h.fieldChanges.length === 1 && c) {
      const v = valeur(c.value, c.unit);
      if (estNom(c.fieldHint)) return v ? { phrase: `Renomme ${bien} en ${v}`, attendu: 'RENAME_ASSET' } : null;
      // Passage 114AA (W02) : catégorie de bien et statut. « famille » et « situation » ne sont PAS admises
      // (la famille ne se change pas) ; une valeur hors référentiel fait écarter l'indice (jamais une question).
      if (estCategorieDeBien(c.fieldHint)) {
        return v ? {
          phrase: `Change la catégorie de ${bien} en ${v}`, attendu: 'UPDATE_ASSET_CATEGORY',
          verifier: (d) => d.command === 'UPDATE_ASSET_CATEGORY' && memeTexte(d.requestedCategory, v) && memeBien(d, cible),
        } : null;
      }
      if (estStatutDeBien(c.fieldHint)) {
        return v ? {
          phrase: `Change le statut de ${bien} en ${v}`, attendu: 'UPDATE_ASSET_STATUS',
          verifier: (d) => d.command === 'UPDATE_ASSET_STATUS' && d.requestedStatus !== null && memeBien(d, cible),
        } : null;
      }
      // Champ : celui du registre que l'indice désigne (mêmes formulations que les phrases de l'utilisateur).
      const champ = findAssetField(c.fieldHint);
      if (!champ) return null;
      const estChamp = (d: CommandDraft) => (d.command === 'UPDATE_ASSET_FIELD' && d.field === champ.def.key) || (d.command === 'CLEAR_ASSET_FIELD' && d.fieldKey === champ.def.key);
      return v
        ? { phrase: `Mets ${champ.alias} à ${v} pour ${bien}`, attendu: 'UPDATE_ASSET_FIELD', verifier: estChamp }
        : { phrase: `Efface la ${champ.alias} de ${bien}`, attendu: 'CLEAR_ASSET_FIELD', verifier: estChamp };
    }
    return null;
  }

  if (h.entityType === 'supplier') {
    const fournisseur = sansNomObjet(h.targetHint, /^(?:fournisseur|prestataire)\s+/i);
    if (lien) return lienFournisseurDirect(h, fournisseur);
    if (!cible) return null;
    if (h.operation === 'CREATE' && h.fieldChanges.length === 0) return { phrase: `Ajoute le fournisseur ${cible}`, attendu: 'CREATE_SUPPLIER' };
    if (h.operation === 'DELETE' && h.fieldChanges.length === 0) return { phrase: `Archive le fournisseur ${cible}`, attendu: 'ARCHIVE_SUPPLIER' };
    if (h.operation === 'UPDATE' && h.fieldChanges.length === 1 && c && estNom(c.fieldHint)) {
      const v = valeur(c.value, null);
      return v ? { phrase: `Renomme le fournisseur ${cible} en ${v}`, attendu: 'UPDATE_SUPPLIER', verifier: (d) => d.command === 'UPDATE_SUPPLIER' && d.field === 'name' } : null;
    }
    return null;
  }

  if (h.entityType === 'document') {
    if (lien) return lienDocumentDirect(h, sansNomObjet(h.targetHint, /^(?:document|fichier)\s+/i));
    const doc = cible ? `le document ${cible}` : 'ce document';
    if (h.operation === 'DELETE' && h.fieldChanges.length === 0) return { phrase: `Supprime ${doc}`, attendu: 'DELETE_DOCUMENT' };
    if (h.operation === 'UPDATE' && h.fieldChanges.length === 1 && c && estNom(c.fieldHint)) {
      const v = valeur(c.value, null);
      return v ? { phrase: `Renomme ${doc} en ${v}`, attendu: 'UPDATE_DOCUMENT', verifier: (d) => d.command === 'UPDATE_DOCUMENT' && d.field === 'title' } : null;
    }
    // Passage 114AB (W12) — NATURE d'un document : sa Rubrique ou son Type. La valeur est ensuite cherchée dans
    // le RÉFÉRENTIEL V2 par la préparation : une valeur inconnue n'aboutit à aucun plan.
    if (h.operation === 'UPDATE' && h.fieldChanges.length === 1 && c && estClassementDeDocument(c.fieldHint)) {
      const v = valeur(c.value, null);
      if (!v) return null;
      const niveau = estRubriqueDeDocument(c.fieldHint) ? 'rubric' : 'type';
      return {
        phrase: niveau === 'rubric' ? `Change la rubrique de ${doc} en ${v}` : `Change le type de ${doc} en ${v}`,
        attendu: 'UPDATE_DOCUMENT_CLASSIFICATION',
        verifier: (d) => d.command === 'UPDATE_DOCUMENT_CLASSIFICATION' && d.level === niveau && memeTexte(d.requestedValue, v),
      };
    }
    return null;
  }

  return null;
}

/**
 * Formulation directe d'une demande d'export comprise par le sens (pure) : l'export est nommé par son LIBELLÉ du
 * catalogue quand la nature indiquée en désigne un seul ; sinon la demande reste « un dossier » et l'Assistant
 * demandera lequel. `null` : l'indice n'est pas une demande d'export.
 */
export function exportSentenceFromHint(h: ActionHint): string | null {
  if (h.operation !== 'EXPORT' || h.entityType !== 'export') return null;
  const nature = h.fieldChanges.map((c) => c.value ?? c.fieldHint).join(' ').replace(/[.!?«»"“”]/g, ' ').replace(/\s+/g, ' ').trim();
  const codes = nature ? parseExportRequest(`Exporte ${nature}`)?.codes ?? [] : [];
  const cible = designation(h.targetHint);
  const phrase = `Exporte ${codes.length === 1 ? exportLabel(codes[0]) : 'le dossier'} de ${cible ? `le bien ${cible}` : 'ce bien'}`;
  return parseExportRequest(phrase) ? phrase : null;
}

/**
 * Brouillons de commandes d'une liste d'indices (pure, testée) : TOUS les indices doivent être reconnus, chacun par
 * la commande qu'il annonce ; sinon `null`. `phrases` : formulations directes (trace et tests).
 */
export function draftsFromActionHints(hints: ActionHint[], today: string, declaration?: string): { drafts: CommandDraft[]; phrases: string[] } | null {
  if (hints.length === 0 || hints.length > 5) return null;
  const drafts: CommandDraft[] = [];
  const phrases: string[] = [];
  for (const h of hints) {
    const p = phraseDirecte(h);
    if (!p) return null;
    const d = parseCommand(p.phrase, today);
    if (!d || d.command !== p.attendu || (p.verifier && !p.verifier(d))) return null;
    drafts.push(d);
    phrases.push(p.phrase);
  }
  // Événement de référence : la DÉCLARATION conservée comme source est la phrase de l'utilisateur, jamais la
  // formulation directe réécrite par le serveur. Plusieurs déclarations dans une même phrase : chacune est
  // complétée de sa formulation directe (deux événements distincts ne partagent pas la même déclaration).
  const dite = declaration?.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, DECLARATION_MAX) ?? '';
  if (dite) {
    const plusieurs = drafts.filter((d) => d.command === 'CREATE_REFERENCE_EVENT').length > 1;
    drafts.forEach((d, i) => {
      if (d.command !== 'CREATE_REFERENCE_EVENT' && d.command !== 'UPDATE_REFERENCE_EVENT') return;
      drafts[i] = { ...d, declaration: plusieurs && d.command === 'CREATE_REFERENCE_EVENT' ? `${dite} — ${phrases[i]}` : dite };
    });
  }
  return { drafts, phrases };
}

/** Résultat de la prise en charge d'indices d'action. */
export type ActionHintsPreparation =
  | { kind: 'plan'; preview: import('./catalog').CommandPlanPreview }
  | { kind: 'need_info'; message: string }
  | { kind: 'export'; answer: ExportAnswer };

/** Accès injectables (tests) ; par défaut ceux des commandes et de l'export. */
export interface ActionHintsDeps {
  today(): string;
  prepare(drafts: CommandDraft[], input: AssistantRequestInput): Promise<{ kind: 'plan'; preview: import('./catalog').CommandPlanPreview } | { kind: 'need_info'; message: string } | null>;
  exportAnswer(input: AssistantRequestInput): Promise<ExportAnswer | null>;
}

/**
 * Prend en charge les actions comprises par le sens. `null` : aucun indice exploitable — la demande suit le parcours
 * déjà en place (proposition de mise à jour d'une caractéristique, question, aide). `allowWrites: false` (compte en
 * lecture seule) : seules les demandes d'export sont traitées.
 */
export async function prepareFromActionHints(
  input: AssistantRequestInput, hints: ActionHint[], opts: { allowWrites: boolean }, deps: ActionHintsDeps,
): Promise<ActionHintsPreparation | null> {
  if (hints.length === 1 && hints[0].operation === 'EXPORT') {
    const phrase = exportSentenceFromHint(hints[0]);
    if (!phrase) return null;
    const answer = await deps.exportAnswer({ ...input, message: phrase });
    return answer ? { kind: 'export', answer } : null;
  }
  if (!opts.allowWrites) return null;
  const r = draftsFromActionHints(hints, deps.today(), input.message);
  if (!r) return null;
  // La préparation lit la demande d'origine nulle part : cibles et valeurs viennent des brouillons.
  const prep = await deps.prepare(r.drafts, { ...input, message: r.phrases.join(' puis ') });
  if (!prep) return null;
  return prep.kind === 'plan' ? { kind: 'plan', preview: prep.preview } : prep;
}

/** Accès de production : préparation de plan des commandes, export par la façade du service d'export. */
export async function sqlActionHintsDeps(): Promise<ActionHintsDeps> {
  const [{ prepareCommandSegments, sqlLookup }, exp] = await Promise.all([import('./plan.service'), import('./export-request')]);
  return {
    today: () => sqlLookup.today(),
    // Actions indépendantes (comme « … et … ») : une confirmation pour l'ensemble, résultat action par action.
    prepare: (drafts, input) => prepareCommandSegments(drafts.map((draft) => ({ draft, dependsOnPrevious: false })), input),
    exportAnswer: async (input) => exp.answerExportRequest(input, await exp.sqlExportDeps()),
  };
}
