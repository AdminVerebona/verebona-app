/**
 * Stock PRÉVALIDÉ des suggestions partagées — lot 108J (ticket « Suggestions
 * de l'accueil et de T2 »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE SOURCE DE CANDIDATES, TROIS OBJECTIFS
 *
 *   A. EXPLOITER — questions personnelles sur ce que le compte contient
 *      vraiment (documents d'un bien NOMMÉ, documents non rattachés, exports
 *      prêts, analyse en cours) ;
 *   B. ANTICIPER — échéances réelles à venir (la prochaine, celles d'un bien
 *      nommé) ;
 *   C. ACCOMPAGNER puis FAIRE DÉCOUVRIR — guide progressif : prise en main
 *      (Centre d'aide), puis fonctions utiles (Centre d'aide), puis nouveaux
 *      usages et documents (Ressources), sans lien obligatoire avec les biens
 *      actuels.
 *
 * A et B NE DUPLIQUENT PAS le catalogue validé de l'assistant
 * (`capability-registry.ts`) : ils en reprennent les entrées (libellé,
 * intention T2 canonique, préconditions sur des compteurs lus côté
 * serveur), déjà couvertes par le test contractuel « affichée → cliquée →
 * intention → source → réponse » (L34). Les entrées d'action (« Que dois-je
 * faire aujourd'hui ? », « Que dois-je traiter en priorité ? ») n'en font
 * pas partie : la zone des suggestions n'est pas un « À traiter » bis.
 *
 * C est ÉDITORIAL : chaque question déclare l'article qui y répond
 * (Centre d'aide `AID-…` ou Ressource `A01…`). Elle n'est proposée comme
 * « répondable » que si cet article est publié dans le corpus de
 * l'environnement ET retrouvé par la recherche même de l'assistant pour ce
 * libellé (`answerability.ts`). Les conditions d'étape lisent des USAGES
 * constatés (biens, documents déposés par l'utilisateur, documents analysés,
 * questions posées, exports), jamais une ancienneté en jours ni un clic.
 *
 * Aucun texte n'est généré par une IA ; aucune donnée personnelle n'est
 * inventée (un compte vide ne reçoit que des questions de prise en main).
 * Les libellés ne sont pas des règles métier : ajouter ou retirer une entrée
 * ne demande aucune autre modification (le test L108J-U vérifie qu'elle est
 * répondable par le corpus de référence).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaIntent } from '@/services/verebona-assistant/types/intents';

export type SuggestionObjective = 'EXPLOIT' | 'ANTICIPATE' | 'GUIDE';
/** Étape du guide (objectif C), déduite des usages constatés. */
export type GuideStage = 'START' | 'PROGRESS' | 'ESTABLISHED';
export type SuggestionUniverse = 'HOUSING' | 'VEHICLE' | 'EQUIPMENT';

/** Usages constatés (compteurs lus côté serveur, bornés au compte ; `user*` : l'utilisateur qui regarde). */
export interface UsageSignals {
  assetsTotal: number;
  documentsTotal: number;
  /** Documents dont l'analyse est terminée. */
  documentsAnalyzed: number;
  /** Documents déposés par CET utilisateur (Duo : guide individuel). */
  userDocuments: number;
  /** Questions posées à Verebona par CET utilisateur (borné). */
  userQuestions: number;
  deadlinesUpcoming: number;
  exportsTotal: number;
}

// ── Paramètres centralisés (aucune règle en dur ailleurs) ───────────────────

/** Documents analysés à partir desquels l'utilisateur est « établi ». */
export const GUIDE_ESTABLISHED_MIN_ANALYZED = 5;
/** Documents déposés par l'utilisateur au-delà desquels « Comment ajouter un document ? » n'est plus proposé. */
export const GUIDE_ADD_DOCUMENT_HELP_MAX_USER_DOCUMENTS = 3;
/** Documents analysés au-delà desquels l'explication de l'analyse n'est plus proposée. */
export const GUIDE_ANALYSIS_HELP_MAX_ANALYZED = 3;
/** Questions posées au-delà desquelles « Comment poser une question ? » n'est plus proposé. */
export const GUIDE_ASK_HELP_MAX_QUESTIONS = 2;

/** Étape du guide (pure, testée) — usages réels seulement. */
export function guideStageOf(s: UsageSignals): GuideStage {
  if (s.assetsTotal === 0 || s.documentsTotal === 0 || s.documentsAnalyzed === 0) return 'START';
  if (s.documentsAnalyzed < GUIDE_ESTABLISHED_MIN_ANALYZED) return 'PROGRESS';
  return 'ESTABLISHED';
}

// ── A / B : entrées du catalogue validé de l'assistant ─────────────────────

export interface AccountStockEntry {
  /** Identifiant de l'entrée dans `capability-registry.ts` (rendue avec le contexte serveur). */
  catalogId: string;
  objective: 'EXPLOIT' | 'ANTICIPATE';
  /** Ordre d'utilité (plus bas = plus utile). */
  priority: number;
}

export const ACCOUNT_STOCK: readonly AccountStockEntry[] = [
  { catalogId: 'home_asset_docs', objective: 'EXPLOIT', priority: 1 },
  { catalogId: 'assets_deadlines', objective: 'ANTICIPATE', priority: 1 },
  { catalogId: 'home_next_deadline', objective: 'ANTICIPATE', priority: 2 },
  { catalogId: 'docs_unlinked', objective: 'EXPLOIT', priority: 2 },
  { catalogId: 'state_exports', objective: 'EXPLOIT', priority: 3 },
  { catalogId: 'home_analysis', objective: 'EXPLOIT', priority: 4 },
];

// ── C : guide éditorial (Centre d'aide puis Ressources) ─────────────────────

export interface GuideStockEntry {
  /** Identifiant STABLE de la suggestion (jamais le libellé). */
  id: string;
  label: string;
  /** Intention T2 imposée au clic (une question d'aide n'est jamais une recherche dans le compte). */
  canonicalIntent: Extract<VerebonaIntent, 'PRODUCT_HELP_HOW_TO' | 'PRODUCT_HELP_EXPLAIN'>;
  corpus: 'HELP' | 'RESOURCES';
  /** Article qui répond : `AID-…` (Centre d'aide) ou identifiant Ressource (`L01`…). */
  articleId: string;
  /** Étapes où la question a sa place. */
  stages: readonly GuideStage[];
  /** Univers d'usage (Ressources : rotation équitable logement / véhicules / objets). */
  universe?: SuggestionUniverse;
  /** Condition d'usage supplémentaire (pure) : la question reste utile pour CET utilisateur. */
  when?: (s: UsageSignals) => boolean;
}

export const GUIDE_STOCK: readonly GuideStockEntry[] = [
  // ── Prise en main : Centre d'aide ───────────────────────────────────────
  { id: 'guide_add_asset', label: 'Comment ajouter un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-ASSET-001',
    stages: ['START'], when: (s) => s.assetsTotal === 0 },
  { id: 'guide_add_document', label: 'Comment ajouter un document ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-DOC-001',
    stages: ['START', 'PROGRESS'], when: (s) => s.userDocuments < GUIDE_ADD_DOCUMENT_HELP_MAX_USER_DOCUMENTS },
  { id: 'guide_document_analysis', label: 'Comment fonctionne l’analyse automatique d’un document ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'HELP', articleId: 'AID-DOC-004',
    stages: ['START', 'PROGRESS'], when: (s) => s.documentsAnalyzed < GUIDE_ANALYSIS_HELP_MAX_ANALYZED },
  { id: 'guide_home_page', label: 'Que montre la page d’accueil ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'HELP', articleId: 'AID-START-004',
    stages: ['START'] },
  { id: 'guide_ask_verebona', label: 'Comment poser une question à Verebona ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-SEARCH-003',
    stages: ['START', 'PROGRESS'], when: (s) => s.userQuestions < GUIDE_ASK_HELP_MAX_QUESTIONS },
  // ── Progression : fonctions utiles (Centre d'aide) ──────────────────────
  { id: 'guide_agenda_sync', label: 'Comment synchroniser mon agenda ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-AGENDA-006',
    stages: ['PROGRESS', 'ESTABLISHED'] },
  { id: 'guide_detected_deadlines', label: 'Comment les échéances sont-elles détectées dans les documents ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'HELP', articleId: 'AID-AGENDA-005',
    stages: ['PROGRESS', 'ESTABLISHED'] },
  { id: 'guide_complete_asset', label: 'Comment compléter la fiche d’un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-ASSET-003',
    stages: ['PROGRESS'], when: (s) => s.assetsTotal > 0 },
  { id: 'guide_prepare_dossier', label: 'Comment préparer un dossier pour un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-DOSSIER-002',
    stages: ['PROGRESS', 'ESTABLISHED'], when: (s) => s.assetsTotal > 0 && s.exportsTotal === 0 },
  { id: 'guide_transfer_asset', label: 'Comment transmettre un bien ?', canonicalIntent: 'PRODUCT_HELP_HOW_TO', corpus: 'HELP', articleId: 'AID-TRANSFER-002',
    stages: ['ESTABLISHED'], when: (s) => s.assetsTotal > 0 },
  // ── Usage établi : nouveaux usages et documents (Ressources) ────────────
  { id: 'res_works_invoices', label: 'Quels documents conserver après des travaux dans un logement ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'L01',
    stages: ['ESTABLISHED'], universe: 'HOUSING' },
  { id: 'res_boiler_service', label: 'À quelle fréquence entretenir une chaudière ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'E05',
    stages: ['ESTABLISHED'], universe: 'HOUSING' },
  { id: 'res_house_documents', label: 'Quels documents conserver après l’achat d’une maison ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'O06',
    stages: ['ESTABLISHED'], universe: 'HOUSING' },
  { id: 'res_technical_inspection', label: 'Quand passer le contrôle technique d’une voiture ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'E01',
    stages: ['ESTABLISHED'], universe: 'VEHICLE' },
  { id: 'res_car_service', label: 'Quand faire la révision d’une voiture ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'E03',
    stages: ['ESTABLISHED'], universe: 'VEHICLE' },
  { id: 'res_ebike_service', label: 'Quels entretiens prévoir pour un vélo électrique ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'O04',
    stages: ['ESTABLISHED'], universe: 'VEHICLE' },
  { id: 'res_invoice_retention', label: 'Combien de temps garder une facture d’achat ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'A03',
    stages: ['ESTABLISHED'], universe: 'EQUIPMENT' },
  { id: 'res_appliance_warranty', label: 'Comment vérifier si un appareil est encore sous garantie ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'G01',
    stages: ['ESTABLISHED'], universe: 'EQUIPMENT' },
  { id: 'res_home_inventory', label: 'Comment faire l’inventaire de ses objets avant un sinistre ?', canonicalIntent: 'PRODUCT_HELP_EXPLAIN', corpus: 'RESOURCES', articleId: 'S04',
    stages: ['ESTABLISHED'], universe: 'EQUIPMENT' },
];

/**
 * Questions de prise en main SÛRES, sans aucune donnée du compte : dernier
 * repli quand les usages du compte sont illisibles (jamais d'écran vide).
 */
export const SAFE_FALLBACK_GUIDE_IDS: readonly string[] = ['guide_add_document', 'guide_ask_verebona', 'guide_document_analysis'];

/** Identifiant stable d'une suggestion A / B (préfixe + entrée du catalogue). */
export const accountSuggestionId = (catalogId: string) => `acc_${catalogId}`;
