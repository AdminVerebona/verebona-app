/**
 * Demandes d'ACTIONS — lot 34 (ticket T2 « Que dois-je faire aujourd'hui ? »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI SE PASSAIT
 *
 * « Que dois-je faire aujourd'hui ? » ne correspondait à aucune règle du
 * routeur : intention inconnue, puis recherche des mots de la question dans
 * les documents (« faire », « aujourd'hui »…), puis repli générique « ces
 * éléments de votre compte semblent liés à votre question » avec trois
 * documents quelconques. Un document n'est pas une action.
 *
 * CE QUE FAIT CE MODULE (pur, testé)
 *
 *   REQUÊTE → FAMILLE (intention existante) → CONTRAT DE SOURCES ADMISSIBLES
 *           → PORTÉE TEMPORELLE (résolution commune `query-period`)
 *           → SÉLECTION DÉTERMINISTE sur les lectures canoniques
 *             (« À traiter » ouverts, échéances actives) → RÉPONSE
 *
 * Aucune intention nouvelle (catalogue fermé §9.10) :
 *   · ACTIONS / OVERDUE / URGENT / TO_PROCESS → ACCOUNT_TO_PROCESS ;
 *   · DEADLINES (« mes échéances aujourd'hui ») → ACCOUNT_SEARCH_AGENDA.
 * La FAMILLE (`intentResolution`) précise ce que l'intention demande ; chaque
 * famille a son contrat (`allowedSourceTypes`) et ses filtres : « que dois-je
 * faire » ≠ « mes échéances » ≠ « en retard » ≠ « à traiter » ≠ « cette
 * semaine ». Aucune phrase n'est codée en dur ; aucun traitement propre à
 * « aujourd'hui ».
 *
 * Les documents et les biens ne sont JAMAIS des résultats : un document ne
 * figure que comme CONTEXTE d'une action identifiée (document source d'une
 * échéance, document visé par un « À traiter »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { analyserPorteeTemporelle, type PorteeTemporelle, type TimeScope } from './query-period';
import { normalizeForRouting, word } from './routing-text';
import { comparePriorityMode } from '@/services/to-process/priority';
import type { SourceType } from '../types/sources';

// ── Familles et contrats ─────────────────────────────────────────────────

/** Famille de demande d'actions (ce que l'intention existante demande). */
export type ActionableFamily = 'ACTIONS' | 'OVERDUE' | 'URGENT' | 'TO_PROCESS' | 'DEADLINES';

/** Types de sources ACTIONNABLES (trace : TODO, DEADLINE). */
export type ActionableSourceType = 'TODO' | 'DEADLINE';

/** Correspondance avec les types de sources de T2 (§19.2). */
export const ACTIONABLE_SOURCE_TYPES: Readonly<Record<ActionableSourceType, SourceType>> = {
  TODO: 'to_process_item',
  DEADLINE: 'agenda_item',
};

/** Code de résolution tracé (`intentResolution`). */
export const FAMILY_RESOLUTION: Readonly<Record<ActionableFamily, string>> = {
  ACTIONS: 'ACTIONS_TEMPORAL',
  OVERDUE: 'ACTIONS_OVERDUE',
  URGENT: 'ACTIONS_URGENT',
  TO_PROCESS: 'TO_PROCESS_OPEN',
  DEADLINES: 'DEADLINES_PERIOD',
};

/** Intention EXISTANTE portée par chaque famille. */
export const FAMILY_INTENT: Readonly<Record<ActionableFamily, 'ACCOUNT_TO_PROCESS' | 'ACCOUNT_SEARCH_AGENDA'>> = {
  ACTIONS: 'ACCOUNT_TO_PROCESS',
  OVERDUE: 'ACCOUNT_TO_PROCESS',
  URGENT: 'ACCOUNT_TO_PROCESS',
  TO_PROCESS: 'ACCOUNT_TO_PROCESS',
  DEADLINES: 'ACCOUNT_SEARCH_AGENDA',
};

/**
 * Contrat de sources admissibles par famille : seuls ces types peuvent être
 * des RÉSULTATS PRINCIPAUX. DOCUMENT, ASSET, FOLDER n'y figurent jamais
 * (contexte seulement).
 */
export const FAMILY_ALLOWED_SOURCES: Readonly<Record<ActionableFamily, readonly ActionableSourceType[]>> = {
  ACTIONS: ['TODO', 'DEADLINE'],
  OVERDUE: ['TODO', 'DEADLINE'],
  URGENT: ['TODO', 'DEADLINE'],
  TO_PROCESS: ['TODO'],
  DEADLINES: ['DEADLINE'],
};

/** Raison d'inclusion d'un résultat (trace par résultat). */
export type InclusionReason = 'OVERDUE' | 'DUE_TODAY' | 'DUE_IN_PERIOD' | 'OPEN_TODO' | 'PRIORITY_TODO';

export interface ActionableRequest {
  family: ActionableFamily;
  intent: 'ACCOUNT_TO_PROCESS' | 'ACCOUNT_SEARCH_AGENDA';
  intentResolution: string;
  /** Portée telle que DEMANDÉE (`NONE` si la question n'en dit rien). */
  requestedTimeScope: TimeScope;
  /** Portée appliquée (« que dois-je faire ? » sans période : aujourd'hui). */
  appliedTimeScope: TimeScope;
  resolvedStartDate: string | null;
  resolvedEndDate: string | null;
  allowedSourceTypes: ActionableSourceType[];
  /** Éléments datés échus et toujours ouverts. */
  includeOverdue: boolean;
  /** Fenêtre de dates (bornes incluses) ; `null` : aucune. */
  window: { from: string; to: string } | null;
  /** Tous les éléments datés, quelle que soit la date (liste « À traiter »). */
  allDated: boolean;
  /** « À traiter » sans date : tous, seulement « À faire d'abord », aucun. */
  undatedTodos: 'ALL' | 'DO_FIRST' | 'NONE';
  /** Mots restants (désignation éventuelle d'un bien). */
  residualWords: string[];
  /** Libellé de la période pour la réponse (« aujourd'hui », « cette semaine »). */
  label: string;
}

// ── Reconnaissance ───────────────────────────────────────────────────────

/** « que dois-je faire », « qu'est-ce que j'ai à faire », « j'ai quoi à faire »… */
const ACTION_PHRASE = word(
  "(?:que|qu'est-ce que|qu'est ce que|quoi|qu') ?(?:dois-je|je dois|j'ai a|ai-je a|il (?:me )?faut|faut-il|devrais-je|je devrais|"
  + "reste-t-il a|me reste-t-il a|il me reste a|j'aurais a|on doit|nous devons) faire"
  + "|qu'ai-je a faire|j'ai quoi a faire|j'ai quoi de prevu"
  + "|(?:choses|taches|trucs|actions) a faire|a faire (?:aujourd'hui|demain|cette semaine|ce mois(?:-ci)?|la semaine prochaine)"
  + "|(?:j'ai|ai-je|y a-t-il|il y a) (?:quelque chose|qqch|des choses|un truc|des trucs) (?:a faire|de prevu|au programme)"
  + "|qu'est-ce qui (?:m'attend|est prevu|est au programme)|au programme|mon programme|mes taches|ma to-?do(?: ?list)?",
);
/** Formes faibles : ne valent qu'avec une période et sans autre mot (« J'ai quoi aujourd'hui ? »). */
const WEAK_PHRASE = word("j'ai quoi|qu'est-ce que j'ai|qu'est ce que j'ai|qu'ai-je|ai-je quelque chose|j'ai quelque chose|qu'y a-t-il|y a-t-il quelque chose");
const URGENT = word('urgent|urgente|urgents|urgentes|urgence|urgences|le plus presse|le plus pressant');
const TO_PROCESS = word("a traiter|dois-je traiter|dois je traiter|je dois traiter|reste a traiter|faut-il traiter|traiter en priorite");
const DEADLINES = word('echeances?|rendez-vous|rdv|rappels?|evenements?|agenda|planning|calendrier');
/** Retard : une question sur SES éléments (« est-ce que j'ai… », « qu'est-ce qui… »). */
const OVERDUE_SUBJECT = word("j'ai|ai-je|est-ce que j'ai|y a-t-il|il y a|qu'est-ce qui|quelque chose|qqch|quoi|quels? elements?|mes|qu'est-ce que");
/** Objets documentaires, montants, aide, explication : pas une demande d'actions. */
const EXCLUDED = word("documents?|factures?|fichiers?|pieces? jointes?|justificatifs?|notices?|manuels?|contrats? pdf|montants?|combien|prix|comment|pourquoi|a quoi sert|que signifie|que veut dire");

/** Mots de structure d'une demande d'actions, retirés avant de chercher un bien. */
const VOCABULAIRE = new Set([
  'que', 'qu', 'quoi', 'quel', 'quels', 'quelle', 'quelles', 'est-ce', 'est', 'ce', 'ces', 'ca', 'cela', 'qui', 'il', 'y', 'a', 't',
  'je', 'j', 'me', 'm', 'moi', 'mon', 'ma', 'mes', 'nous', 'on', 'notre', 'nos', 'dois', 'dois-je', 'doit', 'devons', 'devrais', 'devrais-je',
  'ai', 'ai-je', 'qu\'ai-je', 'faut', 'faut-il', 'reste', 'reste-t-il', 'faire', 'traiter', 'fait', 'aurais',
  'chose', 'choses', 'quelque', 'qqch', 'truc', 'trucs', 'tache', 'taches', 'action', 'actions', 'element', 'elements',
  'prevu', 'prevue', 'prevus', 'prevues', 'programme', 'attend', 'm\'attend', 'todo', 'to-do', 'list', 'liste',
  'urgent', 'urgente', 'urgents', 'urgentes', 'urgence', 'urgences', 'presse', 'pressant', 'plus', 'le', 'la', 'les', 'l', 'de', 'des', 'du', 'd',
  'en', 'retard', 'retards', 'depasse', 'depassee', 'depassees', 'depasses', 'echu', 'echue', 'echues', 'echus', 'souffrance', 'temps',
  'aujourd', 'hui', 'aujourd\'hui', 'aujourdhui', 'jour', 'matin', 'soir', 'apres-midi', 'demain', 'apres-demain', 'cette', 'semaine', 'semaine-ci',
  'prochaine', 'prochain', 'prochaines', 'prochains', 'mois', 'mois-ci', 'cours', 'venir', 'bientot', 'prochainement', 'arrive', 'arrivent',
  'echeance', 'echeances', 'rendez-vous', 'rdv', 'rappel', 'rappels', 'evenement', 'evenements', 'agenda', 'planning', 'calendrier',
  'priorite', 'prioritaire', 'abord', 'prioritaires', 'pour', 'dans', 'sur', 'au', 'aux', 'et', 'ou', 'un', 'une', 'svp', 'stp', 'merci', 'bonjour',
  'dis', 'dis-moi', 'donne', 'donne-moi', 'montre', 'montre-moi', 'rappelle', 'rappelle-moi', 'sont', 'quand', 'avant', 'ici', 'maintenant',
  'actuellement', 'encore', 'deja', 'tout', 'tous', 'toutes', 'bien', 'veux', 'voudrais', 'savoir', 'peux', 'pouvez', 'tu', 'vous',
]);

function residuel(t: string, portee: PorteeTemporelle): string[] {
  const sans = portee.expression ? t.replace(portee.expression, ' ') : t;
  return sans.replace(/[?!.,;:«»"()]/g, ' ').split(/\s+/)
    .flatMap((w) => (w.includes("'") && !VOCABULAIRE.has(w) ? w.split("'") : [w]))
    .map((w) => w.trim().replace(/^-+|-+$/g, '')).filter((w) => w.length >= 2 && !VOCABULAIRE.has(w) && !/^\d+$/.test(w));
}

/** Famille reconnue dans le texte normalisé, ou `null` (pure). */
function familleDe(t: string, portee: PorteeTemporelle, residu: string[]): ActionableFamily | null {
  if (DEADLINES.test(t)) {
    // « Mes prochaines échéances », « à venir », « bientôt » : la liste des
    // échéances à venir existante (T2-15) reste la réponse.
    const datee = portee.scope !== 'NONE' && portee.scope !== 'UPCOMING';
    return datee && !/(?<![\p{L}])prochaine?s?(?![\p{L}])/u.test(t) ? 'DEADLINES' : null;
  }
  if (TO_PROCESS.test(t)) return 'TO_PROCESS';
  if (portee.scope === 'OVERDUE' && (ACTION_PHRASE.test(t) || OVERDUE_SUBJECT.test(t))) return 'OVERDUE';
  if (URGENT.test(t)) return 'URGENT';
  if (ACTION_PHRASE.test(t)) return 'ACTIONS';
  if (WEAK_PHRASE.test(t) && portee.scope !== 'NONE' && residu.length === 0) return 'ACTIONS';
  return null;
}

/**
 * Analyse d'une demande d'actions (pure, testée). `null` : la question n'en
 * est pas une (la suite habituelle du routage s'applique). `intentHint` :
 * intention déjà retenue (règle, UNDERSTAND, reprise) — une intention
 * « À traiter » sans formulation reconnue vaut la liste « À traiter ».
 */
export function analyserDemandeActionnable(message: string, today: string, intentHint?: string): ActionableRequest | null {
  const t = normalizeForRouting(message ?? '');
  if (!t || EXCLUDED.test(t)) return null;
  const portee = analyserPorteeTemporelle(message, today);
  const residu = residuel(t, portee);
  let family = familleDe(t, portee, residu);
  if (!family && intentHint === 'ACCOUNT_TO_PROCESS') family = 'TO_PROCESS';
  if (!family) return null;
  if (family === 'ACTIONS' && portee.scope === 'OVERDUE') family = 'OVERDUE';
  return construire(family, portee, today, residu);
}

/** Paramètres de sélection d'une famille sur une portée (pure). */
function construire(family: ActionableFamily, portee: PorteeTemporelle, today: string, residualWords: string[]): ActionableRequest {
  const scope = portee.scope;
  const base = {
    family, intent: FAMILY_INTENT[family], intentResolution: FAMILY_RESOLUTION[family],
    requestedTimeScope: scope, allowedSourceTypes: [...FAMILY_ALLOWED_SOURCES[family]], residualWords,
  };
  const futur = portee.from != null && portee.from > today;
  const passe = portee.to != null && portee.to < today;
  const fenetre = (from: string | null, to: string | null) => (from && to ? { from, to } : null);

  if (family === 'OVERDUE' || scope === 'OVERDUE') {
    return {
      ...base, appliedTimeScope: 'OVERDUE', resolvedStartDate: null, resolvedEndDate: portee.to,
      includeOverdue: true, window: null, allDated: false, undatedTodos: 'NONE', label: 'en retard',
    };
  }
  if (family === 'URGENT') {
    return {
      ...base, appliedTimeScope: 'TODAY', resolvedStartDate: today, resolvedEndDate: today,
      includeOverdue: true, window: { from: today, to: today }, allDated: false, undatedTodos: 'DO_FIRST', label: 'urgent',
    };
  }
  if (family === 'DEADLINES') {
    // « Mes échéances aujourd'hui / cette semaine » : la période CALENDAIRE
    // calculée, rien d'autre (ni À traiter, ni retards hors période).
    return {
      ...base, appliedTimeScope: scope, resolvedStartDate: portee.from, resolvedEndDate: portee.to,
      includeOverdue: false, window: fenetre(portee.from, portee.to), allDated: false, undatedTodos: 'NONE', label: portee.label,
    };
  }
  if (family === 'TO_PROCESS') {
    if (scope === 'NONE') {
      // La liste « À traiter » telle que la page l'affiche (E2E-T2-03).
      return {
        ...base, appliedTimeScope: 'NONE', resolvedStartDate: null, resolvedEndDate: null,
        includeOverdue: true, window: null, allDated: true, undatedTodos: 'ALL', label: '',
      };
    }
    if (scope === 'TODAY') {
      return {
        ...base, appliedTimeScope: 'TODAY', resolvedStartDate: today, resolvedEndDate: today,
        includeOverdue: true, window: { from: today, to: today }, allDated: false, undatedTodos: 'ALL', label: portee.label,
      };
    }
    return {
      ...base, appliedTimeScope: scope, resolvedStartDate: portee.from, resolvedEndDate: portee.to,
      includeOverdue: !futur && !passe, window: fenetre(portee.from, portee.to), allDated: false, undatedTodos: 'NONE', label: portee.label,
    };
  }
  // ACTIONS — « que dois-je faire [période] ? ».
  if (scope === 'NONE' || scope === 'TODAY') {
    // Règle « aujourd'hui » : retards actifs + échéances du jour + À traiter
    // ouverts (sans date ou dus aujourd'hui). Sans période : aujourd'hui.
    return {
      ...base, appliedTimeScope: 'TODAY', resolvedStartDate: today, resolvedEndDate: today,
      includeOverdue: true, window: { from: today, to: today }, allDated: false, undatedTodos: 'ALL', label: 'aujourd’hui',
    };
  }
  // Période : éléments datés de la période ; retards actifs si la période
  // contient aujourd'hui (ils restent à faire), jamais pour une période
  // entièrement future (« demain ») ou passée.
  const debut = portee.from && !futur && !passe && portee.from < today ? today : portee.from;
  return {
    ...base, appliedTimeScope: scope, resolvedStartDate: portee.from, resolvedEndDate: portee.to,
    includeOverdue: !futur && !passe, window: fenetre(debut, portee.to), allDated: false, undatedTodos: 'NONE', label: portee.label,
  };
}

/** Bornes de lecture des échéances pour une demande (pure). */
export function actionableReadWindow(req: ActionableRequest, today: string): { from: string | null; to: string | null } {
  if (req.allDated) return { from: null, to: null };
  const to = req.window?.to ?? today;
  if (req.includeOverdue) return { from: null, to: to < today ? today : to };
  return { from: req.window?.from ?? today, to };
}

// ── Sélection, ordre, déduplication ──────────────────────────────────────

/** « À traiter » ouvert, tel que lu (compte, statut, disponibilité déjà appliqués). */
export interface TodoRow {
  id: number;
  title: string;
  priority: 'DO_FIRST' | 'DO_NEXT' | 'CAN_WAIT';
  actionKind: 'ARBITRATE' | 'COMPLETE';
  ruleCode: string;
  targetType: string;
  targetId: number;
  fieldKey: string | null;
  /** Échéance associée (AAAA-MM-JJ, Europe/Paris) ou `null`. */
  dueDate: string | null;
  activeSince: string;
  assetId: number | null;
  assetName: string | null;
  /** Document visé (contexte), s'il y en a un. */
  document: { id: number; title: string } | null;
}

/** Échéance active (ouverte, non HISTORICAL, biens disponibles), telle que lue. */
export interface DeadlineRow {
  id: number;
  title: string;
  date: string;
  endDate: string | null;
  forecast: boolean;
  /** Démarche datée (catégorie « action » T4) — compteur `actionCount`. */
  isAction: boolean;
  originFieldKey: string | null;
  assets: Array<{ id: number; name: string }>;
  /** Documents associés (liens et sources de l'échéance) : contexte seulement. */
  documents: Array<{ id: number; title: string }>;
}

export interface ActionableResult {
  sourceType: ActionableSourceType;
  /** Identifiant de source T2 (`todo_12`, `agenda_5`). */
  sourceId: string;
  id: number;
  title: string;
  reasonForInclusion: InclusionReason;
  /** OPEN (À traiter), ACTIVE (échéance ouverte), FORECAST (date prévisionnelle). */
  status: 'OPEN' | 'ACTIVE' | 'FORECAST';
  dueDate: string | null;
  relatedAssetId: number | null;
  relatedAssetName: string | null;
  priority: TodoRow['priority'] | null;
  isAction: boolean;
  /** Contexte : documents liés à l'action (jamais des résultats). */
  contextDocuments: Array<{ id: number; title: string }>;
  /** Autres formes du MÊME besoin fusionnées ici (relations canoniques). */
  mergedSourceIds: string[];
}

const RANG: Readonly<Record<InclusionReason, number>> = { OVERDUE: 0, DUE_TODAY: 1, DUE_IN_PERIOD: 2, PRIORITY_TODO: 3, OPEN_TODO: 3 };
const PRIO: Readonly<Record<string, number>> = { DO_FIRST: 0, DO_NEXT: 1, CAN_WAIT: 2 };

/** Raison d'un élément daté (pure). `fin` : dernier jour d'un événement sur plusieurs jours. */
function raisonDatee(debut: string, fin: string | null, today: string): InclusionReason {
  const dernier = fin && fin > debut ? fin : debut;
  if (dernier < today) return 'OVERDUE';
  if (debut <= today) return 'DUE_TODAY';
  return 'DUE_IN_PERIOD';
}

function retenueDatee(req: ActionableRequest, debut: string, fin: string | null, raison: InclusionReason): boolean {
  if (req.allDated) return true;
  if (raison === 'OVERDUE' && req.includeOverdue) return true;
  const dernier = fin && fin > debut ? fin : debut;
  return req.window != null && debut <= req.window.to && dernier >= req.window.from;
}

/**
 * Même besoin sous deux formes (pure) : un « À traiter » qui vise
 * l'échéance elle-même, ou la même donnée (clé du registre) du même bien /
 * du même document que celle dont l'échéance est issue.
 */
export function memeBesoin(todo: TodoRow, d: DeadlineRow): boolean {
  if (todo.targetType === 'AGENDA_ITEM') return todo.targetId === d.id;
  if (!todo.fieldKey || !d.originFieldKey || todo.fieldKey !== d.originFieldKey) return false;
  if (todo.targetType === 'ASSET') return d.assets.some((a) => a.id === todo.targetId);
  if (todo.targetType === 'DOCUMENT') return d.documents.some((x) => x.id === todo.targetId);
  return false;
}

/**
 * Sélection, déduplication et ordre (pure, testée).
 * Ordre (règle de l'accueil `getHomepageAgendaItems`, puis règle « Par
 * priorité » de la file À traiter) : en retard (date croissante), du jour,
 * de la période (date croissante), puis « À traiter » sans date (priorité,
 * ancienneté).
 */
export function selectionnerActionnables(
  req: ActionableRequest,
  rows: { todos: TodoRow[]; deadlines: DeadlineRow[] },
  today: string,
): ActionableResult[] {
  const veutTodo = req.allowedSourceTypes.includes('TODO');
  const veutEcheance = req.allowedSourceTypes.includes('DEADLINE');
  const out: ActionableResult[] = [];

  const echeances = veutEcheance ? rows.deadlines.flatMap((d): ActionableResult[] => {
    const raison = raisonDatee(d.date, d.endDate, today);
    if (!retenueDatee(req, d.date, d.endDate, raison)) return [];
    return [{
      sourceType: 'DEADLINE', sourceId: `agenda_${d.id}`, id: d.id, title: d.title, reasonForInclusion: raison,
      status: d.forecast ? 'FORECAST' : 'ACTIVE', dueDate: d.date,
      relatedAssetId: d.assets[0]?.id ?? null, relatedAssetName: d.assets[0]?.name ?? null,
      priority: null, isAction: d.isAction, contextDocuments: d.documents.slice(0, 3), mergedSourceIds: [],
    }];
  }) : [];
  out.push(...echeances);
  const parId = new Map(echeances.map((r) => [r.id, r]));

  if (veutTodo) {
    for (const t of rows.todos) {
      let raison: InclusionReason;
      if (t.dueDate) {
        raison = raisonDatee(t.dueDate, null, today);
        if (!retenueDatee(req, t.dueDate, null, raison)) continue;
      } else if (req.undatedTodos === 'ALL') raison = 'OPEN_TODO';
      else if (req.undatedTodos === 'DO_FIRST' && t.priority === 'DO_FIRST') raison = 'PRIORITY_TODO';
      else continue;
      // Déduplication : le besoin déjà porté par une échéance retenue y est
      // rattaché (l'échéance reste le résultat principal).
      const d = rows.deadlines.find((x) => parId.has(x.id) && memeBesoin(t, x));
      if (d) {
        const cible = parId.get(d.id)!;
        cible.mergedSourceIds.push(`todo_${t.id}`);
        if (t.document && !cible.contextDocuments.some((x) => x.id === t.document!.id)) cible.contextDocuments.push(t.document);
        continue;
      }
      out.push({
        sourceType: 'TODO', sourceId: `todo_${t.id}`, id: t.id, title: t.title, reasonForInclusion: raison, status: 'OPEN',
        dueDate: t.dueDate, relatedAssetId: t.assetId, relatedAssetName: t.assetName, priority: t.priority, isAction: true,
        contextDocuments: t.document ? [t.document] : [], mergedSourceIds: [],
      });
    }
  }

  const todoDe = new Map(rows.todos.map((t) => [t.id, t]));
  return out.sort((a, b) => {
    const r = RANG[a.reasonForInclusion] - RANG[b.reasonForInclusion];
    if (r !== 0) return r;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.sourceType !== b.sourceType) return a.sourceType === 'DEADLINE' ? -1 : 1;
    const ta = todoDe.get(a.id);
    const tb = todoDe.get(b.id);
    if (a.sourceType === 'TODO' && ta && tb) {
      const p = comparePriorityMode(
        { priority: ta.priority, actionKind: ta.actionKind, activeSince: new Date(ta.activeSince) },
        { priority: tb.priority, actionKind: tb.actionKind, activeSince: new Date(tb.activeSince) },
      );
      if (p !== 0) return p;
    } else if ((PRIO[a.priority ?? ''] ?? 3) !== (PRIO[b.priority ?? ''] ?? 3)) {
      return (PRIO[a.priority ?? ''] ?? 3) - (PRIO[b.priority ?? ''] ?? 3);
    }
    return a.id - b.id;
  });
}

// ── Compteurs (trace) ────────────────────────────────────────────────────

export interface ActionableCounts {
  todoCount: number;
  deadlineCount: number;
  actionCount: number;
  overdueCount: number;
  todayCount: number;
  resultCount: number;
}

export function compterActionnables(results: ActionableResult[]): ActionableCounts {
  return {
    todoCount: results.filter((r) => r.sourceType === 'TODO').length,
    deadlineCount: results.filter((r) => r.sourceType === 'DEADLINE').length,
    // Démarches datées (échéances de catégorie « action », T4) : Verebona
    // n'a pas d'autre objet « action planifiée » (aucune source inventée).
    actionCount: results.filter((r) => r.sourceType === 'DEADLINE' && r.isAction).length,
    overdueCount: results.filter((r) => r.reasonForInclusion === 'OVERDUE').length,
    todayCount: results.filter((r) => r.reasonForInclusion === 'DUE_TODAY').length,
    resultCount: results.length,
  };
}

// ── Réponse (rédigée par le serveur, sans modèle) ────────────────────────

/** Nombre d'éléments listés dans le texte (la trace et les sources gardent tout, bornées). */
export const MAX_LISTED_ACTIONABLES = 10;

const pluriel = (n: number, s: string, p = `${s}s`) => (n > 1 ? p : s);

function ligne(r: ActionableResult, fmtDate: (iso: string) => string): string {
  const bien = r.relatedAssetName ? ` (${r.relatedAssetName})` : '';
  const prev = r.status === 'FORECAST' ? ', date prévisionnelle' : '';
  const docs = r.contextDocuments.length
    ? ` — ${pluriel(r.contextDocuments.length, 'document associé', 'documents associés')} : ${r.contextDocuments.slice(0, 2).map((d) => `« ${d.title} »`).join(', ')}`
    : '';
  const quoi = `« ${r.title} »${bien}`;
  switch (r.reasonForInclusion) {
    case 'OVERDUE': return `En retard (prévu le ${fmtDate(r.dueDate!)}${prev}) : ${quoi}${docs}`;
    case 'DUE_TODAY': return `Aujourd’hui${prev} : ${quoi}${docs}`;
    case 'DUE_IN_PERIOD': return `Le ${fmtDate(r.dueDate!)}${prev} : ${quoi}${docs}`;
    case 'PRIORITY_TODO': return `À faire d’abord : ${quoi}${docs}`;
    default: return `À traiter : ${quoi}${docs}`;
  }
}

/** Réponse « aucun résultat » : une résolution RÉUSSIE, dite comme telle (pure). */
export function phraseAucunActionnable(req: ActionableRequest): string {
  const p = req.label;
  switch (req.family) {
    case 'OVERDUE':
      return req.allowedSourceTypes.includes('TODO')
        ? 'Rien en retard : aucune échéance ni aucun élément « À traiter » dont la date est dépassée.'
        : 'Aucune échéance en retard.';
    case 'URGENT':
      return 'Rien d’urgent : aucun retard, aucune échéance aujourd’hui et aucun élément « À faire d’abord ».';
    case 'TO_PROCESS':
      return req.appliedTimeScope === 'NONE' || req.appliedTimeScope === 'TODAY'
        ? 'Vous n’avez aucun élément « À traiter » en attente.'
        : `Vous n’avez aucun élément « À traiter » daté ${p}.`;
    case 'DEADLINES':
      return req.appliedTimeScope === 'OVERDUE' ? 'Aucune échéance en retard.' : `Vous n’avez aucune échéance ${p}.`;
    default:
      return req.appliedTimeScope === 'TODAY'
        ? 'Rien à faire pour aujourd’hui : aucun élément « À traiter » en attente, aucune échéance en retard ni prévue aujourd’hui.'
        : `Rien de prévu ${p} : aucune échéance ni aucun élément « À traiter » daté sur cette période${req.includeOverdue ? ', et aucun retard' : ''}.`;
  }
}

/** Réponse à une demande d'actions (pure, testée). */
export function formatActionnables(
  req: ActionableRequest,
  results: ActionableResult[],
  fmtDate: (iso: string) => string,
): string {
  if (results.length === 0) return phraseAucunActionnable(req);
  const n = results.length;
  const quoi = req.family === 'DEADLINES' ? `${n} ${pluriel(n, 'échéance')}`
    : req.family === 'TO_PROCESS' ? `${n} ${pluriel(n, 'élément')} « À traiter »`
      : `${n} ${pluriel(n, 'élément')}`;
  const intro = req.family === 'OVERDUE' ? `Vous avez ${quoi} en retard`
    : req.family === 'URGENT' ? `Vous avez ${quoi} urgent${n > 1 ? 's' : ''}`
      : req.family === 'TO_PROCESS' && req.appliedTimeScope === 'NONE' ? `Vous avez ${quoi} en attente`
        : req.family === 'ACTIONS' && req.appliedTimeScope === 'TODAY' ? `Pour aujourd’hui, vous avez ${quoi} à traiter`
          : `Vous avez ${quoi} ${req.label}`.trim();
  const lignes = results.slice(0, MAX_LISTED_ACTIONABLES).map((r) => `• ${ligne(r, fmtDate)}`);
  const reste = n - lignes.length;
  return `${intro} :\n${lignes.join('\n')}${reste > 0 ? `\n(et ${reste} ${pluriel(reste, 'autre')})` : ''}`;
}
