/**
 * La mascotte parle — Direction D v2 §3.2, §4.2, §12ter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MOTEUR DÉCIDE, LA BULLE ASSEMBLE
 *
 * Les sujets restent choisis par le moteur de la mascotte (collecte, ordre,
 * 2 sujets au plus) et formulés par T6 ou leur texte de secours. Ce module,
 * pur et lisible côté client, en fait la bulle de la Direction D :
 *
 *   · UNE phrase en langage naturel à partir des sujets (« Deux sujets
 *     méritent votre attention aujourd'hui : …, et … ») ;
 *   · au plus 2 tuiles d'action : icône colorée par sévérité, libellé,
 *     « bien · statut » ;
 *   · la pose de la mascotte selon la situation.
 *
 * `tileFor` tourne côté serveur (il lit les faits du sujet, jamais exposés
 * tels quels) ; le reste côté client, à partir de `MascotPresentation`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { MascotParagraph, MascotPresentation, MascotSecondary, MascotSubject, MascotTile, MascotTodoItem } from './types';

// ── Tuiles (serveur) ────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Métadonnées de tuile d'un sujet : sévérité (amber = à vérifier, rouge = en
 * retard), libellé de l'action, bien et statut. `today` : AAAA-MM-JJ.
 */
export interface TileOptions {
  /**
   * CDC 15 T4-12 : une échéance passée sans statut est
   * NON PROUVÉE, pas « non réalisée ». Tuile ambre « à confirmer », nature
   * `verify` (pose `questioning`), au lieu de rouge « en retard »
   * (`alert-folder`). Absent / false : comportement historique.
   */
  unprovenOverdueIsQuestion?: boolean;
}

export function tileFor(s: MascotSubject, today: string, opts: TileOptions = {}): MascotTile {
  const f = s.facts;
  const asset = s.assetName ?? str(f.assetName) ?? str(f.targetLabel);
  const code = s.sourceCode;

  if (code.startsWith('ATP-')) {
    const arbitrage = f.actionKind === 'arbitrage';
    return {
      tone: 'amber', icon: 'circle-alert', attention: true, assetName: asset,
      label: arbitrage ? 'Vérifier l’information' : 'Compléter l’information',
      status: arbitrage ? 'À vérifier' : 'À compléter',
      kind: arbitrage ? 'verify' : 'action',
    };
  }
  if (code === 'MASC-EXT-ACTION') {
    const date = str(f.date);
    const retard = date ? daysBetween(date, today) : 0;
    if (retard > 0 && opts.unprovenOverdueIsQuestion) {
      return { tone: 'amber', icon: 'clock', attention: true, assetName: asset, label: 'Confirmer ou reporter', status: `Prévue il y a ${retard} j — à confirmer`, kind: 'verify' };
    }
    return retard > 0
      ? { tone: 'red', icon: 'clock', attention: true, assetName: asset, label: 'Reporter ou marquer fait', status: `En retard (${retard} j)`, kind: 'overdue' }
      : { tone: 'amber', icon: 'clock', attention: true, assetName: asset, label: 'Reporter ou marquer fait', status: 'Aujourd’hui', kind: 'action' };
  }
  if (code === 'MASC-BLOCKED') {
    return { tone: 'amber', icon: 'circle-alert', attention: true, assetName: asset, label: 'Préciser l’échéance', status: 'À préciser', kind: 'action' };
  }
  if (code === 'DATE-NEXT' || code === 'DATE-NEXT-2') {
    const label = str(f.dateLabel);
    const estimee = f.dateNature === 'prévisionnelle' ? ' (estimée)' : '';
    return {
      tone: 'blue', icon: 'calendar-days', attention: false,
      assetName: asset ?? str(f.firstAssetName),
      label: code === 'DATE-NEXT-2' ? 'Voir les échéances' : 'Voir l’échéance',
      status: label ? `Le ${label}${estimee}` : 'À venir',
      kind: 'info',
    };
  }
  if (code === 'PROC-DOC-UPLOAD' || code === 'PROC-DOC-ANALYSIS') {
    return {
      tone: 'blue', icon: 'file-text', attention: false, assetName: str(f.documentTitle),
      label: 'Voir le document', status: code === 'PROC-DOC-UPLOAD' ? 'En cours d’envoi' : 'En analyse', kind: 'info',
    };
  }
  if (code === 'PROC-EXPORT') {
    return { tone: 'blue', icon: 'file-text', attention: false, assetName: asset, label: 'Voir les exports', status: 'En préparation', kind: 'info' };
  }
  if (code === 'ONB-ASSET') {
    return { tone: 'blue', icon: 'plus', attention: true, assetName: null, label: 'Ajouter un premier bien', status: 'Maison, véhicule, objet…', kind: 'action' };
  }
  if (code === 'ONB-DOC') {
    return { tone: 'green', icon: 'download', attention: true, assetName: asset, label: 'Déposer un document', status: 'Je le lis et le range pour vous', kind: 'action' };
  }
  return { tone: 'blue', icon: 'circle-alert', attention: s.requiresAttention, assetName: asset, label: s.actions[0]?.label ?? 'Voir', status: 'À voir', kind: s.requiresAttention ? 'action' : 'info' };
}

/** AAAA-MM-JJ, Europe/Paris (même référence que le collecteur). */
export function parisDay(now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ── Phrase (client) ─────────────────────────────────────────────────────────

export const CLEAR_SPEECH = 'Tout est à jour. Aucune échéance dépassée, aucun document en attente : je vous préviens dès que quelque chose change.';
export const EMPTY_ACCOUNT_SPEECH = 'Je suis Verebona. Votre espace est prêt, mais encore vide. Ajoutez un premier bien ou déposez un document : je le lis, je range les informations au bon endroit et je vous préviens avant chaque échéance importante.';
export const DEGRADED_SPEECH = 'Certaines informations n’ont pas pu être actualisées. Je réessaie dans un instant.';

/** Mots qui peuvent perdre leur majuscule en milieu de phrase. */
const MOTS_COURANTS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'deux', 'trois', 'quatre', 'votre', 'vos',
  'ce', 'cet', 'cette', 'ces', 'il', 'elle', 'ils', 'elles', 'j', 'je', 'on', 'pour', 'à', 'au', 'aux',
  'en', 'dans', 'sur', 'si', 'une', 'aucun', 'aucune', 'plusieurs', 'n', 'ne', 'votre',
]);

/**
 * Minuscule initiale pour enchaîner après « : », seulement si le premier mot
 * est un mot courant (« Votre », « Deux », « L'échéance ») : un nom propre
 * (« Ferrari ») ou un sigle garde sa majuscule.
 */
export function lowerFirst(text: string): string {
  const m = /^([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ][a-zàâäéèêëîïôöùûüç]*)/.exec(text);
  if (!m) return text;
  if (!MOTS_COURANTS.has(m[1].toLowerCase())) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Une seule phrase, terminée par un point, sans autre fin de phrase. */
function isSingleSentence(t: string): boolean {
  const s = t.trim();
  return /[.!]$/.test(s) && !/[.!?…]\s+\S/.test(s.slice(0, -1));
}

const NOMBRES = ['Aucun', 'Un', 'Deux', 'Trois'];
const NOMBRES_TODO = ['Aucun', 'Un', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six', 'Sept', 'Huit', 'Neuf', 'Dix'];

/**
 * Niveau 1 de la bulle (MASC2) : « Deux sujets nécessitent votre attention
 * aujourd’hui. » — le nombre est celui de la file (= pastille, = page).
 */
export function todoSummary(n: number): string {
  const nombre = NOMBRES_TODO[n] ?? String(n);
  return n > 1
    ? `${nombre} sujets nécessitent votre attention aujourd’hui.`
    : `${nombre} sujet nécessite votre attention aujourd’hui.`;
}

export interface Speech {
  text: string;
  /** Segments à mettre en valeur (T6-010), présents dans `text`. */
  highlights: string[];
}

export interface SpeechInput {
  presentation: MascotPresentation | null;
  /** Compte vide : aucun bien, aucun document (§12ter). */
  empty: boolean;
  failed?: boolean;
}

/** Sujets réels (hors « tout est à jour »). */
export function realParagraphs(p: MascotPresentation | null): MascotParagraph[] {
  return (p?.paragraphs ?? []).filter((x) => x.sourceCode !== 'CLEAR');
}

/**
 * Phrase de la bulle (§3.2) :
 *   · 2 sujets : « Deux sujets méritent votre attention aujourd'hui : a, et b. »
 *   · 1 sujet  : « Un sujet mérite votre attention aujourd'hui : a. »
 *   · 0 sujet  : « Tout est à jour. … »
 * Un sujet seulement informatif (échéance à venir, analyse en cours) ne
 * « mérite pas l'attention » : il suit « Tout est à jour. ». Des textes de
 * plusieurs phrases sont juxtaposés plutôt qu'enchaînés après « : ».
 */
export function composeSpeech({ presentation, empty, failed }: SpeechInput): Speech {
  if (empty) return { text: EMPTY_ACCOUNT_SPEECH, highlights: [] };
  if (!presentation) return { text: failed ? DEGRADED_SPEECH : '', highlights: [] };
  const paras = realParagraphs(presentation);
  const highlights = paras.map((p) => p.highlight).filter((h): h is string => !!h);
  // Lot 32 (MASC2) — niveau 1 : une phrase qui COMPTE les « À traiter », sans
  // les répéter (ils sont les éléments du niveau 2) ; les autres sujets
  // (échéances, analyses, recommandations) gardent leur phrase.
  const todoTotal = presentation.todo?.total ?? 0;
  if (todoTotal > 0) {
    const autres = paras.map((p) => p.text.trim()).filter(Boolean);
    return { text: [todoSummary(todoTotal), ...autres].join(' '), highlights };
  }
  if (paras.length === 0) {
    return { text: presentation.status === 'degraded' ? DEGRADED_SPEECH : CLEAR_SPEECH, highlights: [] };
  }
  const attention = paras.filter((p) => p.tile?.attention ?? true);
  const info = paras.filter((p) => !(p.tile?.attention ?? true));
  const texts = (list: MascotParagraph[]) => list.map((p) => p.text.trim()).filter(Boolean);

  if (attention.length === 0) {
    return { text: ['Tout est à jour.', ...texts(info)].join(' '), highlights };
  }
  const n = attention.length;
  const intro = `${NOMBRES[n] ?? n} ${n > 1 ? 'sujets méritent' : 'sujet mérite'} votre attention aujourd’hui`;
  const at = texts(attention);
  let phrase: string;
  if (at.every(isSingleSentence)) {
    const clauses = at.map((t) => lowerFirst(t.replace(/[.!]$/, '')));
    phrase = `${intro} : ${clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')}, et ${clauses[clauses.length - 1]}` : clauses[0]}.`;
  } else {
    phrase = `${intro}. ${at.join(' ')}`;
  }
  return { text: [phrase, ...texts(info)].join(' '), highlights };
}

/**
 * Découpe la phrase autour de plusieurs segments mis en valeur, dans
 * l'ordre où ils apparaissent ; un segment absent est ignoré.
 */
export function splitHighlights(text: string, highlights: string[]): Array<{ text: string; strong: boolean }> {
  const out: Array<{ text: string; strong: boolean }> = [];
  let rest = text;
  const restants = highlights.filter(Boolean);
  while (rest) {
    let best: { i: number; h: string } | null = null;
    for (const h of restants) {
      const i = rest.indexOf(h);
      if (i !== -1 && (!best || i < best.i)) best = { i, h };
    }
    if (!best) { out.push({ text: rest, strong: false }); break; }
    if (best.i > 0) out.push({ text: rest.slice(0, best.i), strong: false });
    out.push({ text: best.h, strong: true });
    rest = rest.slice(best.i + best.h.length);
    restants.splice(restants.indexOf(best.h), 1);
  }
  return out;
}

// ── Tuiles (client) ─────────────────────────────────────────────────────────

export const MAX_TILES = 2;

export interface ActionTile {
  key: string;
  paragraph: MascotParagraph;
  label: string;
  /** « Ferrari Testarossa · À vérifier » */
  sub: string;
  tone: MascotTile['tone'];
  icon: MascotTile['icon'];
}

/**
 * Au plus 2 tuiles (§3.2), une par sujet portant une action, masquées s'il
 * n'y a rien à traiter. Le reste se trouve dans « À traiter ».
 */
export function actionTiles(p: MascotPresentation | null): ActionTile[] {
  return realParagraphs(p)
    .filter((x) => x.actions.length > 0)
    .slice(0, MAX_TILES)
    .map((x) => {
      const t = x.tile;
      return {
        key: x.occurrenceKey,
        paragraph: x,
        label: t?.label ?? x.actions[0].label,
        sub: [t?.assetName, t?.status].filter(Boolean).join(' · '),
        tone: t?.tone ?? 'blue',
        icon: t?.icon ?? 'circle-alert',
      };
    });
}

// ── Niveau 2 : éléments d'action homogènes (lot 32, MASC2) ──────────────────

/** Éléments de niveau 2 affichés au plus. */
export const MAX_HOME_ITEMS = 5;

interface HomeItemBase {
  key: string;
  /** Ligne principale (« Numéro d’immatriculation à vérifier »). */
  title: string;
  /** Ligne secondaire (« Vélo Jean Fourche »), ou null. */
  sub: string | null;
  /** Appel à l'action (« Vérifier »). */
  cta: string;
  tone: MascotTile['tone'];
  icon: MascotTile['icon'];
}

/**
 * Un élément = un seul niveau de composant, quelle que soit sa nature :
 *   · `todo`      — action de la file « À traiter » (contrat structuré) ;
 *   · `subject`   — sujet du discours portant une action (échéance…) ;
 *   · `secondary` — recommandation ou étape d'accueil (ex-pastilles du
 *                   3e niveau, supprimées comme liste indépendante).
 */
export type HomeItem =
  | (HomeItemBase & { kind: 'todo'; todo: MascotTodoItem })
  | (HomeItemBase & { kind: 'subject'; tile: ActionTile })
  | (HomeItemBase & { kind: 'secondary'; secondary: MascotSecondary });

function todoIcon(t: MascotTodoItem): MascotTile['icon'] {
  if (t.entityType === 'DOCUMENT') return 'file-text';
  if (t.entityType === 'AGENDA_ITEM') return 'calendar-days';
  return 'circle-alert';
}

/** Élément de niveau 2 d'une action « À traiter » (pure). */
export function todoHomeItem(t: MascotTodoItem): HomeItem {
  return {
    kind: 'todo', key: `todo:${t.todoId}`, todo: t,
    title: t.title, sub: t.subtitle, cta: t.cta,
    tone: t.priority === 'DO_FIRST' ? 'red' : t.actionKind === 'ARBITRATE' ? 'amber' : 'blue',
    icon: todoIcon(t),
  };
}

/**
 * Niveau 2 de la bulle : « À traiter » d'abord (ordre de la file), puis les
 * sujets portant une action, puis les recommandations et l'étape d'accueil —
 * même composant, au plus `MAX_HOME_ITEMS`. Compte vide : rien (tuiles
 * d'amorce côté écran).
 */
export function homeItems(p: MascotPresentation | null, empty: boolean): HomeItem[] {
  if (empty || !p) return [];
  const out: HomeItem[] = (p.todo?.items ?? []).map(todoHomeItem);
  for (const t of actionTiles(p)) {
    out.push({
      kind: 'subject', key: `subject:${t.key}`, tile: t, title: t.label,
      sub: t.sub || null, cta: 'Voir', tone: t.tone, icon: t.icon,
    });
  }
  for (const s of secondaryActions(p, empty)) {
    const onboarding = s.kind === 'onboarding';
    out.push({
      kind: 'secondary', key: `secondary:${s.id}`, secondary: s, title: s.action.label, sub: null,
      cta: onboarding ? 'Commencer' : 'Voir',
      tone: onboarding ? 'blue' : 'amber', icon: onboarding ? 'plus' : 'clock',
    });
  }
  return out.slice(0, MAX_HOME_ITEMS);
}

/** Actions « À traiter » au-delà des éléments affichés (lien « Tout voir »). */
export function todoRemaining(p: MascotPresentation | null): number {
  const t = p?.todo;
  if (!t) return 0;
  return Math.max(0, t.total - t.items.length);
}

// ── Pose (§3.2) ─────────────────────────────────────────────────────────────

export type HomePose =
  | 'welcome-wave' | 'alert-folder' | 'questioning' | 'reminder-bell' | 'success-check' | 'neutral';

/** Nature d'un sujet, y compris sans métadonnées de tuile (présentation ancienne). */
function kindOf(x: MascotParagraph): NonNullable<MascotTile['kind']> {
  if (x.tile?.kind) return x.tile.kind;
  if (x.tile?.tone === 'red') return 'overdue';
  return (x.tile?.attention ?? true) ? 'action' : 'info';
}

/**
 * Pose de la grande mascotte, graduée selon ce qu'il y a à traiter :
 *   compte vide → `welcome-wave` ;
 *   au moins une action en retard → `alert-folder` ;
 *   sinon une information à vérifier (incohérence) → `questioning` ;
 *   sinon un autre sujet d'attention (rappel, à compléter) → `reminder-bell` ;
 *   rien à traiter → `success-check` ;
 *   discours indisponible → `neutral` (jamais « tout est à jour » sur une panne).
 *
 * Cohérence avec les 4 statuts de T4 (CDC 15 T4-12) :
 *   · completed     → l'élément est réalisé, il ne remonte plus ;
 *   · not_completed → jamais écrit : PROPOSÉ via « À traiter » (carte ATP,
 *                     pose `questioning` ou `reminder-bell` selon la carte) ;
 *   · not_proven / unknown → statut inchangé ; une échéance passée est « à
 *                     confirmer » (tuile ambre, `verify` → `questioning`),
 *                     JAMAIS « en retard » (`alert-folder`) : l'absence de
 *                     preuve n'est pas un constat de non-réalisation.
 * `alert-folder` reste la pose d'une échéance en retard dans le mode
 * historique (et de toute tuile rouge future qui établirait un retard).
 */
export function homePose(p: MascotPresentation | null, empty: boolean, failed = false): HomePose {
  if (empty) return 'welcome-wave';
  if (!p) return failed ? 'neutral' : 'success-check';
  const kinds = realParagraphs(p).map(kindOf);
  // Lot 32 (MASC2) : les « À traiter » ne sont plus des paragraphes — leur
  // nature compte toujours pour la pose (arbitrage → vérifier, sinon action).
  for (const t of p.todo?.items ?? []) kinds.push(t.actionKind === 'ARBITRATE' ? 'verify' : 'action');
  if ((p.todo?.total ?? 0) > 0 && !(p.todo?.items.length)) kinds.push('action');
  if (kinds.includes('overdue')) return 'alert-folder';
  if (kinds.includes('verify')) return 'questioning';
  if (kinds.includes('action')) return 'reminder-bell';
  if (p.status === 'degraded' && kinds.length === 0) return 'neutral';
  return 'success-check';
}

/** Texte alternatif de la mascotte d'accueil, selon sa pose. */
export function homePoseLabel(pose: HomePose): string {
  switch (pose) {
    case 'welcome-wave': return 'Verebona vous souhaite la bienvenue';
    case 'alert-folder': return 'Verebona vous signale une échéance en retard';
    case 'questioning': return 'Verebona vous demande de vérifier une information';
    case 'reminder-bell': return 'Verebona vous rappelle un sujet à traiter';
    case 'success-check': return 'Verebona : tout est à jour';
    default: return 'Verebona';
  }
}

// ── Suggestions « Ou demandez-moi : » ───────────────────────────────────────

export const EMPTY_ACCOUNT_SUGGESTIONS = [
  'Que pouvez-vous faire pour moi ?',
  'Quels documents ajouter en premier ?',
  'Mes données sont-elles en sécurité ?',
];

export interface HomeSuggestion {
  label: string;
  context?: { intent: string; assetId?: number };
  /** Élément secondaire du moteur (télémétrie « cliqué ») ; absent : catalogue. */
  secondary?: MascotSecondary;
}

/**
 * 3 pastilles « Ou demandez-moi : » : les questions proposées par le moteur
 * (secondaires de type `ask`), complétées par les suggestions de la page ;
 * compte vide : les trois questions d'amorce (§12ter).
 */
export function homeSuggestions(
  p: MascotPresentation | null,
  empty: boolean,
  pageSuggestions: string[],
): HomeSuggestion[] {
  if (empty) return EMPTY_ACCOUNT_SUGGESTIONS.map((label) => ({ label }));
  const out: HomeSuggestion[] = [];
  const vus = new Set<string>();
  for (const s of p?.secondaries ?? []) {
    if (s.action.target.kind !== 'ask' || vus.has(s.action.target.question)) continue;
    vus.add(s.action.target.question);
    out.push({ label: s.action.target.question, context: s.action.target.context, secondary: s });
  }
  for (const label of pageSuggestions) {
    if (!vus.has(label)) { vus.add(label); out.push({ label }); }
  }
  return out.slice(0, 3);
}

/**
 * Secondaires qui ne sont PAS des questions (onboarding — place réservée
 * SEC-001 —, recommandations) : affichés en pastilles d'action, exécutées
 * par le parcours réel du moteur. Compte vide : les tuiles d'amorce les
 * remplacent.
 */
export function secondaryActions(p: MascotPresentation | null, empty: boolean): MascotSecondary[] {
  if (empty) return [];
  return (p?.secondaries ?? []).filter((s) => s.action.target.kind !== 'ask');
}

/**
 * Secondaires réellement affichés — la télémétrie « affiché » ne compte
 * qu'eux (LOG-001) : actions, puis questions retenues parmi les 3 pastilles.
 */
export function displayedSecondaries(p: MascotPresentation | null, empty: boolean): MascotSecondary[] {
  const questions = homeSuggestions(p, empty, []).map((x) => x.secondary).filter((x): x is MascotSecondary => !!x);
  return [...secondaryActions(p, empty), ...questions];
}
