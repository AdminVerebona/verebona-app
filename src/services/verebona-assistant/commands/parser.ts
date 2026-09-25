/**
 * Reconnaissance déterministe des commandes d'écriture — sans modèle.
 *
 * Une commande n'est proposée que si l'intention est CLAIRE : verbe
 * d'action explicite + objet reconnu. Sinon, rien : la question suit le
 * parcours de réponse normal. Ce module ne lit rien et n'écrit rien ; il
 * produit un brouillon que `plan.service` résout dans le compte puis fige.
 */
import type { WriteCommandType } from './catalog';
import { findAssetField, parseFieldValue } from './asset-fields';

export type CommandDraft =
  | {
      command: 'CREATE_AGENDA_ITEM';
      title: string;
      /** AAAA-MM-JJ, ou null si la date n'a pas été comprise. */
      date: string | null;
      /** Mots désignant le bien (« pour ma maison »). */
      assetWords: string[];
      /** « pour cette maison » : bien du fil. */
      assetFromContext: boolean;
    }
  | {
      command: Extract<WriteCommandType, 'MARK_AGENDA_DONE' | 'CANCEL_AGENDA_ITEM'>;
      /** Mots désignant l'échéance (« le ramonage »). */
      targetWords: string[];
      /** « le deuxième », « cette échéance » : référence du fil. */
      targetFromContext: boolean;
      /**
       * Action EN MASSE (« toutes les échéances passées de ma Clio ») : un
       * résultat par échéance visée.
       */
      bulk?: { scope: 'past' | 'open'; assetWords: string[] };
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
    };

/** Segment d'un message à plusieurs commandes. */
export interface CommandSegment {
  draft: CommandDraft;
  /** « … puis … » : ne s'exécute que si le segment précédent a réussi. */
  dependsOnPrevious: boolean;
}

const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’]/g, "'");

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

const CREATE = /\b(ajoute|ajouter|cree|creer|programme|programmer|planifie|planifier|enregistre|enregistrer)\b/;
const AGENDA_NOUN = /\b(un|une)?\s*(rappel|echeance|rendez-vous|rdv|evenement|entretien|controle|revision)s?\b/;
const DONE = /\b(marque|marquer|indique|indiquer|passe|passer|note|noter)\b[\s\S]*\b(fait|faite|faits|faites|realise|realisee|realises|realisees|termine|terminee|termines|terminees)\b/;
const CANCEL = /\b(annule|annuler|supprime l'echeance|annulez)\b/;
const REFERENCE = /\b(le|la)\s+(premier|premiere|deuxieme|second|seconde|troisieme|dernier|derniere)\b|\b(ce|cette|cet)\s+(rappel|echeance|rendez-vous|evenement|entretien)\b|\bcelle-ci\b|\bcelui-ci\b/;

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
  const hit = findAssetField(nfc);
  if (!hit) return null;
  const debut = hit.index + hit.alias.length;
  const apresOriginal = nfc.slice(debut);
  const apres = m.slice(debut);
  const value = parseFieldValue(hit.def, apresOriginal, today, parseDateFr);

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

/** Brouillon de commande, ou `null` si le message n'est pas une commande claire. */
export function parseCommand(message: string, today: string): CommandDraft | null {
  const m = plain(message).trim();

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
      assetWords: pour && !assetFromContext ? motsUtiles(pour[1]) : [],
      assetFromContext,
    };
  }

  // ── Marquer comme réalisée / annuler ──────────────────────────────────
  const done = DONE.test(m);
  const cancel = !done && CANCEL.test(m) && AGENDA_NOUN.test(m.replace(CANCEL, ''));
  if (done || cancel) {
    const command = done ? 'MARK_AGENDA_DONE' : 'CANCEL_AGENDA_ITEM';
    const masse = m.match(/\btou(?:te)?s\s+(?:les|mes)\s+(?:echeances|rappels|rendez-vous|evenements|entretiens)\b/);
    if (masse) {
      const bien = m.match(/\b(?:de|du|pour)\s+(?:ma|mon|la|le|l')\s*([a-z0-9-]+)/);
      return {
        command, targetWords: [], targetFromContext: false,
        bulk: {
          scope: /\b(passee?s|en retard|depassee?s|echue?s)\b/.test(m) ? 'past' : 'open',
          assetWords: bien ? motsUtiles(bien[1]) : [],
        },
      };
    }
    const targetFromContext = REFERENCE.test(m);
    const targetWords = motsUtiles(m.replace(REFERENCE, ' '));
    return { command, targetWords, targetFromContext };
  }
  return null;
}

/** Verbes qui ouvrent une nouvelle commande dans un même message. */
const DEBUT_COMMANDE = /\s+(puis|ensuite|et ensuite|et puis|et)\s+(?=(ajoute|ajouter|crée|cree|créer|creer|programme|planifie|enregistre|marque|marquer|indique|passe|annule|annuler|mets|modifie|change|renseigne|corrige)\b)/i;

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
