/**
 * Référentiel des concepts et synonymes métier du Centre d'aide — lot 33
 * (ticket « T2 PRODUCT_HELP_HOW_TO : cascade Centre d'aide »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE RÉFÉRENTIEL
 *
 * « Comment déposer un document ? », « où joindre un fichier ? », « je veux
 * mettre une facture dans Verebona » demandent la même chose que l'article
 * « Ajouter un document » — sans en employer les mots. La recherche plein
 * texte du corpus ne pouvait pas le savoir : les variantes finissaient sous le
 * seuil, puis en repli.
 *
 * Ce module est la SOURCE UNIQUE des équivalences utilisées par la recherche
 * du Centre d'aide (niveau « recherche élargie ») :
 *
 *   · `HELP_LEXICAL_SYNONYMS` — équivalences de mots, sans ambiguïté métier
 *     (« importer », « déposer », « joindre », « téléverser » → « ajouter » ;
 *     « fichier », « pièce jointe » → « document ») ;
 *   · `HELP_CONCEPTS` — concepts fonctionnels (DOCUMENT_UPLOAD…) reconnus
 *     par un VERBE d'action ET un OBJET : « mettre » seul ne veut rien dire,
 *     « mettre une facture » est un dépôt de document. Chaque concept porte
 *     ses requêtes canoniques (vocabulaire des articles) et les libellés
 *     visibles dans l'application.
 *
 * Aucun code de requête ne doit porter sa propre liste : on ajoute ici.
 * Aucune dépendance serveur (utilisable côté client comme côté serveur).
 *
 * Le référentiel ÉLARGIT la recherche, il ne répond jamais : la vérité reste
 * le contenu des articles publiés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { assetVocabularyAlternatives } from '@/lib/asset-taxonomy';

/** Texte normalisé : minuscules, sans accents, apostrophes et ponctuation en espaces. */
export function normalizeHelpText(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'‘`´]/g, ' ')
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Équivalences de mots (formes normalisées, sans accents). La forme
 * `canonical` est celle qu'emploient les articles.
 */
export const HELP_LEXICAL_SYNONYMS: ReadonlyArray<{ canonical: string; variants: readonly string[] }> = [
  {
    canonical: 'ajouter',
    variants: [
      'ajoute', 'ajoutes', 'ajoutez', 'rajouter', 'rajoute',
      'importer', 'importe', 'importes', 'importez',
      'deposer', 'depose', 'deposes', 'deposez',
      'joindre', 'joins', 'joignez',
      'televerser', 'televerse', 'televersez',
      'uploader', 'upload', 'uploade',
      'inserer', 'insere', 'integrer', 'integre',
    ],
  },
  {
    canonical: 'document',
    variants: [
      'documents', 'doc', 'docs', 'fichier', 'fichiers',
      'piece jointe', 'pieces jointes', 'pj', 'justificatif', 'justificatifs',
    ],
  },
  { canonical: 'supprimer', variants: ['effacer', 'efface', 'retirer', 'enlever', 'supprime'] },
];

/** Identifiants des concepts fonctionnels. */
export type HelpConceptId = 'DOCUMENT_UPLOAD' | 'ASSET_CREATE' | 'AGENDA_ITEM_CREATE';

export interface HelpConcept {
  id: HelpConceptId;
  label: string;
  /**
   * Verbes d'action : un groupe de `HELP_LEXICAL_SYNONYMS` (par sa forme
   * canonique) et des verbes de contexte, qui ne valent action qu'avec un
   * objet du concept (« mettre », « envoyer »).
   */
  actionGroup: string | null;
  contextActions: readonly string[];
  /** Objets (formes normalisées). */
  objects: readonly string[];
  /** Motif d'objets supplémentaire (référentiel des biens). */
  objectPattern?: () => string;
  /** Expressions qui annulent le concept (« mettre à jour »). */
  excludes: readonly string[];
  /** Requêtes canoniques, dans le vocabulaire des articles. */
  queries: readonly string[];
  /**
   * Libellés visibles dans l'application qui DÉSIGNENT le concept (bouton,
   * raccourci) : les citer suffit à le reconnaître (« l'ajout rapide »).
   * Les libellés d'écran des articles (« Mes documents »…) sont, eux,
   * indexés avec chaque article (`screens`).
   */
  appLabels: readonly string[];
  /** Action de l'assistant qui accomplit le concept (bouton, si certain). */
  action: 'START_ADD_DOCUMENT' | 'START_ADD_ASSET' | 'START_ADD_AGENDA_ITEM';
}

export const HELP_CONCEPTS: readonly HelpConcept[] = [
  {
    id: 'DOCUMENT_UPLOAD',
    label: 'Ajouter un document',
    actionGroup: 'ajouter',
    contextActions: [
      'mettre', 'mets', 'met', 'mettez', 'envoyer', 'envoie', 'envoyez', 'charger', 'charge',
      'scanner', 'numeriser', 'enregistrer', 'enregistre', 'glisser', 'stocker', 'ranger', 'archiver',
      'creer', 'cree',
    ],
    objects: [
      'document', 'documents', 'doc', 'docs', 'fichier', 'fichiers', 'piece jointe', 'pieces jointes', 'pj',
      'justificatif', 'justificatifs', 'facture', 'factures', 'contrat', 'contrats', 'garantie', 'garanties',
      'devis', 'ticket', 'tickets', 'recu', 'recus', 'pdf', 'scan', 'scans', 'notice', 'notices',
      'manuel', 'manuels', 'certificat', 'certificats', 'attestation', 'attestations', 'quittance', 'quittances',
      'releve', 'releves', 'carte grise', 'bon de garantie', 'avis', 'diagnostic', 'diagnostics',
    ],
    excludes: ['mettre a jour', 'met a jour', 'mets a jour', 'mise a jour'],
    queries: ['ajouter un document', 'importer un document'],
    appLabels: ['Ajouter un document', 'Ajout rapide'],
    action: 'START_ADD_DOCUMENT',
  },
  {
    id: 'AGENDA_ITEM_CREATE',
    label: 'Créer un élément d’agenda',
    actionGroup: 'ajouter',
    contextActions: ['creer', 'cree', 'programmer', 'planifier', 'noter', 'mettre', 'enregistrer', 'prevoir'],
    objects: ['echeance', 'echeances', 'rappel', 'rappels', 'rendez-vous', 'rdv', 'evenement', 'evenements', 'element d agenda', 'tache', 'taches'],
    excludes: ['mettre a jour', 'mise a jour'],
    queries: ['créer un élément d’agenda', 'ajouter une échéance'],
    appLabels: ['Créer une échéance'],
    action: 'START_ADD_AGENDA_ITEM',
  },
  {
    id: 'ASSET_CREATE',
    label: 'Créer un bien',
    actionGroup: 'ajouter',
    contextActions: ['creer', 'cree', 'enregistrer', 'declarer', 'referencer', 'mettre'],
    objects: ['bien', 'biens', 'patrimoine'],
    objectPattern: () => assetVocabularyAlternatives(),
    excludes: ['mettre a jour', 'mise a jour'],
    queries: ['créer un bien', 'ajouter un bien'],
    appLabels: ['Ajouter un bien'],
    action: 'START_ADD_ASSET',
  },
];

// ── Détection ───────────────────────────────────────────────────────────────

const esc = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]/g, '[ -]');
const alternatives = (forms: readonly string[]) => [...forms].sort((a, b) => b.length - a.length).map(esc).join('|');
const borne = (alts: string) => new RegExp(`(?<![a-z0-9])(?:${alts})(?![a-z0-9])`, 'g');

function groupForms(canonical: string | null): string[] {
  if (!canonical) return [];
  const g = HELP_LEXICAL_SYNONYMS.find((x) => x.canonical === canonical);
  return g ? [g.canonical, ...g.variants] : [];
}

function premiere(re: RegExp, text: string): { index: number; match: string } | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? { index: m.index, match: m[0] } : null;
}

export interface HelpConceptMatch {
  concept: HelpConcept;
  /** Verbe et objet reconnus tous deux : l'action est comprise avec certitude. */
  certain: boolean;
  action: string;
  object: string;
}

/**
 * Concept fonctionnel de la question (pur). Il faut un VERBE d'action et un
 * OBJET du concept ; plusieurs concepts possibles : celui dont l'objet suit
 * le plus près le verbe (« ajouter un document à ma voiture » → document).
 * `null` : aucun concept certain — la recherche reste plein texte.
 */
export function detectHelpConcept(message: string): HelpConceptMatch | null {
  const t = normalizeHelpText(message);
  if (!t) return null;
  let best: { m: HelpConceptMatch; distance: number } | null = null;
  for (const concept of HELP_CONCEPTS) {
    const libelle = premiere(borne(alternatives(concept.appLabels.map(normalizeHelpText))), t);
    if (libelle) {
      const m: HelpConceptMatch = { concept, certain: true, action: libelle.match, object: libelle.match };
      // Libellé de l'application cité : reconnaissance la plus sûre.
      if (!best || best.distance >= 0) best = { m, distance: -1 };
      continue;
    }
    if (concept.excludes.some((x) => premiere(borne(esc(x)), t))) continue;
    const verbe = premiere(borne(alternatives([...groupForms(concept.actionGroup), ...concept.contextActions])), t);
    if (!verbe) continue;
    const objets = alternatives(concept.objects) + (concept.objectPattern ? `|${concept.objectPattern()}` : '');
    const re = borne(objets);
    re.lastIndex = 0;
    let objet: { index: number; match: string } | null = null;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const o = { index: m.index, match: m[0] };
      // L'objet qui suit le verbe prime ; à défaut, le premier cité.
      if (!objet || (objet.index < verbe.index && o.index > verbe.index)) objet = o;
      if (objet.index > verbe.index) break;
    }
    if (!objet) continue;
    const distance = objet.index > verbe.index ? objet.index - verbe.index : 1000 + verbe.index - objet.index;
    if (!best || distance < best.distance) {
      best = { m: { concept, certain: true, action: verbe.match, object: objet.match }, distance };
    }
  }
  return best?.m ?? null;
}

/**
 * Question réécrite dans le vocabulaire des articles (pure) : chaque variante
 * de `HELP_LEXICAL_SYNONYMS` remplacée par sa forme canonique (« comment
 * déposer un fichier » → « comment ajouter un document »). Identique au
 * texte normalisé si rien ne change.
 */
export function canonicalizeHelpQuery(message: string): string {
  let t = normalizeHelpText(message);
  for (const g of HELP_LEXICAL_SYNONYMS) {
    t = t.replace(borne(alternatives(g.variants)), g.canonical);
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Requêtes de la RECHERCHE ÉLARGIE (pures, dédoublonnées, sans la question
 * d'origine) : la question réécrite, puis — concept certain — ses requêtes
 * canoniques et le nom de la fonctionnalité.
 */
export function expandHelpQueries(message: string): { queries: string[]; concept: HelpConceptMatch | null } {
  const concept = detectHelpConcept(message);
  const original = normalizeHelpText(message);
  const out: string[] = [];
  const add = (q: string) => {
    const n = normalizeHelpText(q);
    if (n && n !== original && !out.some((x) => normalizeHelpText(x) === n)) out.push(q);
  };
  add(canonicalizeHelpQuery(message));
  if (concept?.certain) {
    concept.concept.queries.forEach(add);
    add(concept.concept.label);
  }
  return { queries: out.slice(0, 6), concept };
}
