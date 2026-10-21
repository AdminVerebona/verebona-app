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
 *   · lot 68 : UN BLOC PAR SUJET (`subjectBlocks`) — sa formulation
 *     courte (objet, bien et date une seule fois), ses actions (« Voir »,
 *     « Rappels ») ; plus d'introduction de comptage (« Un sujet mérite
 *     votre attention… »), plus de carte imbriquée qui répète le message ;
 *   · une phrase d'en-tête (`bubbleLead`) seulement quand elle dit autre
 *     chose que les sujets : évaluation en cours ou indisponible, source en
 *     panne, éléments non prioritaires, rien à signaler — lot 71F : jamais
 *     de comptage des « À traiter », de l'invitation Duo ou des sujets ;
 *   · la pose de la mascotte selon la situation.
 *
 * Lot 61 : la bulle ASSEMBLE un état de présentation explicite
 * (`MascotPresentationState`, calculé côté serveur à partir des décisions
 * validées) — elle ne recrée aucune décision et n'affirme rien qu'il
 * n'établisse : ni « Tout est à jour », ni « aucun document en attente »,
 * ni « des échéances dépassées sont à vérifier » sur un simple compteur.
 *
 * `tileFor` tourne côté serveur (il lit les faits du sujet, jamais exposés
 * tels quels) ; le reste côté client, à partir de `MascotPresentation`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type {
  MascotAction, MascotDuoInvite, MascotParagraph, MascotPresentation, MascotPresentationState, MascotReminderRef, MascotSecondary, MascotSubject,
  MascotTile, MascotTodoItem,
} from './types';
import { emptyAccountSuggestions } from '@/services/verebona-assistant/registries/capability-registry';
import { displayableText, hasCountingIntro } from './counting-intro';

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
  // Lot 61 : échéance retenue par une décision IA VALIDÉE — la carte dit la
  // nature réellement retenue (vérification justifiée, action, anticipation),
  // jamais un retard ni une vérification génériques déduits de la date.
  const decided = s.interpellation && s.interpellation.mode !== 'LEGACY' ? s.interpellation : null;
  // Lot 68 : rappel informatif — tuile d'INFORMATION (bleue, sans « Action à
  // prévoir », sans attention prioritaire) : il ne porte pas le statut visuel
  // d'une action et ne compte pas parmi les actions retenues.
  if (decided?.mode === 'INFORM') {
    const label = str(f.dateLabel);
    const estimee = f.dateNature === 'prévisionnelle' ? ' (estimée)' : '';
    return {
      tone: 'blue', icon: 'calendar-days', attention: false, assetName: asset,
      label: str(s.tileTitle) ?? str(f.title) ?? 'Échéance',
      status: label ? `${label}${estimee}` : 'À venir',
      kind: 'info',
    };
  }
  if (decided && (code === 'DATE-NEXT' || code === 'MASC-EXT-ACTION')) {
    const label = str(f.dateLabel);
    const estimee = f.dateNature === 'prévisionnelle' ? ' (estimée)' : '';
    const verifier = decided.reasonCode === 'VERIFICATION_REQUIRED';
    const quoi = verifier ? 'À vérifier' : decided.mode === 'ANTICIPATE' || decided.category === 'TO_ANTICIPATE' ? 'À anticiper' : 'Action à prévoir';
    return {
      tone: 'amber', icon: code === 'DATE-NEXT' ? 'calendar-days' : 'clock', attention: true, assetName: asset,
      label: str(s.tileTitle) ?? str(f.title) ?? 'Échéance',
      status: label ? `${quoi} · ${label}${estimee}` : quoi,
      kind: verifier ? 'verify' : 'action',
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
  if (code === 'DATE-NEXT') {
    // Lot 55A (T6 / T2) : intitulé MÉTIER (« Contrôle technique »), bien et
    // date complète (« Cupra · 18 avril 2028 ») — l'action « Voir → » est
    // portée par la carte, jamais répétée dans le titre. Une date
    // prévisionnelle le reste (DAT-003). Lot 61 : plus de sujet composé
    // DATE-NEXT-2 (titres concaténés « X et Y ») — une échéance, une carte.
    const label = str(f.dateLabel);
    const estimee = f.dateNature === 'prévisionnelle' ? ' (estimée)' : '';
    return {
      tone: 'blue', icon: 'calendar-days', attention: false, assetName: asset,
      label: str(s.tileTitle) ?? str(f.title) ?? 'Prochaine échéance',
      status: label ? `${label}${estimee}` : 'À venir',
      kind: 'info',
    };
  }
  if (code === 'PROC-DOC-UPLOAD' || code === 'PROC-DOC-ANALYSIS') {
    // Lot 55A : le document est l'intitulé (plus de « Voir le document » + « Voir »).
    return {
      tone: 'blue', icon: 'file-text', attention: false, assetName: null,
      label: str(s.tileTitle) ?? str(f.documentTitle) ?? 'Document', status: code === 'PROC-DOC-UPLOAD' ? 'En cours d’envoi' : 'En analyse', kind: 'info',
    };
  }
  if (code === 'PROC-EXPORT') {
    return { tone: 'blue', icon: 'file-text', attention: false, assetName: asset, label: str(s.tileTitle) ?? 'Export', status: 'En préparation', kind: 'info' };
  }
  if (code === 'ONB-ASSET') {
    return { tone: 'blue', icon: 'plus', attention: true, assetName: null, label: 'Ajouter un premier bien', status: 'Maison, véhicule, objet…', kind: 'action' };
  }
  if (code === 'ONB-DOC') {
    return { tone: 'green', icon: 'download', attention: true, assetName: asset, label: 'Déposer un document', status: 'Je le lis et le range pour vous', kind: 'action' };
  }
  return { tone: 'blue', icon: 'circle-alert', attention: s.requiresAttention, assetName: asset, label: str(s.tileTitle) ?? str(s.secondaryLabel) ?? s.actions[0]?.label ?? 'Information', status: 'À voir', kind: s.requiresAttention ? 'action' : 'info' };
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

/**
 * Lot 61 : aucune interpellation pertinente — formulation PROPORTIONNÉE.
 * Jamais « Tout est à jour », « aucune échéance dépassée » ni « aucun
 * document en attente » : l'absence de sujet retenu n'établit rien de tel.
 */
export const NOTHING_TO_REPORT_SPEECH = 'Rien de particulier à vous signaler pour le moment.';
/** @deprecated lot 61 — conservé pour compatibilité : même texte que `NOTHING_TO_REPORT_SPEECH`. */
export const CLEAR_SPEECH = NOTHING_TO_REPORT_SPEECH;
/** Lot 61 : échéances proches en cours d'évaluation (première visite, changement). */
export const EVALUATION_PENDING_SPEECH = 'J’examine encore vos prochaines échéances : elles restent consultables dans l’agenda.';
/** Lot 61 : évaluation des échéances indisponible (T6 coupé, panne) — jamais présenté comme un compte sans problème. */
export const EVALUATION_UNAVAILABLE_SPEECH = 'Je ne peux pas examiner vos échéances pour le moment : elles restent consultables dans l’agenda.';
export const EMPTY_ACCOUNT_SPEECH = 'Je suis Verebona. Votre espace est prêt, mais encore vide. Ajoutez un premier bien ou déposez un document : je le lis, je range les informations au bon endroit et je vous préviens avant chaque échéance importante.';
export const DEGRADED_SPEECH = 'Certaines informations n’ont pas pu être actualisées. Je réessaie dans un instant.';
/**
 * Lot 72A (AC04) : la dernière lecture a échoué — la présentation affichée est
 * celle d'un passage précédent, jamais présentée comme actualisée.
 */
export const STALE_SPEECH = 'Je n’ai pas pu actualiser ces informations : elles datent de mon dernier passage.';

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

/*
 * Lot 71F : `todoSummary` (« Un sujet nécessite votre attention
 * aujourd'hui. », « Deux sujets nécessitent… ») est SUPPRIMÉ — plus aucune
 * introduction de comptage dans la bulle, sans phrase de remplacement : les
 * « À traiter » et « Inviter quelqu'un » sont présentés directement par
 * leurs cartes. Garde : `hasCountingIntro` (counting-intro.ts).
 */

/**
 * MASC3 : la file contient des actions, mais aucune « À faire en premier » —
 * on ne dit ni leur nombre, ni « Tout est à jour ».
 * Lot 50 : les sujets Verebona sont PRIORISÉS, jamais qualifiés
 * d'« urgents » (même règle que le validateur T6) : formulation en priorité.
 */
export const NOTHING_PRIORITY = 'Aucun sujet à traiter en priorité pour le moment.';

/**
 * Lot 53 (retour PO D25) : une source en panne n'autorise jamais une
 * assurance catégorique — on le dit. Lot 61 : la phrase « Des échéances
 * dépassées sont à vérifier dans l'agenda », ajoutée dès qu'un compteur de
 * dates passées était positif, est SUPPRIMÉE (`nothingPriorityText`) : une
 * date dépassée n'établit ni un événement non résolu, ni une action à faire.
 */
export const PARTIAL_DATA_SPEECH = 'Certaines informations n’ont pas pu être actualisées.';

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

/** Sujets réels (hors paragraphe « rien à signaler »). */
export function realParagraphs(p: MascotPresentation | null): MascotParagraph[] {
  return (p?.paragraphs ?? []).filter((x) => x.sourceCode !== 'CLEAR');
}

/** Le paragraphe mérite-t-il l'attention (carte d'action) ? */
const isAttention = (p: MascotParagraph) => p.tile?.attention ?? true;

/**
 * Lot 71F — texte d'un sujet tel qu'affiché : sans introduction de comptage
 * (« Un sujet mérite votre attention aujourd'hui : … »), quelle que soit son
 * origine (T6, cache, texte de secours, présentation d'une version
 * antérieure du serveur). Dernier rempart côté écran, pur.
 */
export function subjectText(p: Pick<MascotParagraph, 'text'> & Partial<Pick<MascotParagraph, 'fallbackText' | 'tile' | 'actions'>>): string {
  // Lot 75E : la formulation, sinon le texte de secours du sujet (si la
  // séparation du préambule n'est pas fiable ou s'il ne reste rien), sinon
  // ses données structurées — jamais un texte vide pour un sujet affiché.
  return displayableText([p.text, p.fallbackText]) || structuredSubjectText(p);
}

/**
 * Lot 75E — texte d'un sujet reconstruit à partir de ses DONNÉES
 * STRUCTURÉES fiables, sans rien inventer (pure) : intitulé, bien et date de
 * la tuile (« Ramonage cheminée · Maison · 4 novembre 2026 ») ; sans tuile,
 * le libellé de sa première action (« Déposer un document ») ; sinon vide.
 * Même composition que l'intitulé des fenêtres de rappel.
 */
export function structuredSubjectText(p: Partial<Pick<MascotParagraph, 'tile' | 'actions'>>): string {
  const t = p.tile;
  if (t?.label) {
    const date = (t.status ?? '').split(' · ').pop() ?? '';
    return [t.label, t.assetName, /\d{4}/.test(date) ? date : null].filter(Boolean).join(' · ');
  }
  return p.actions?.[0]?.label?.trim() ?? '';
}

/**
 * Lot 75E (§5) — la présentation peut-elle être AFFICHÉE telle quelle (pure) ?
 * Non si un sujet porte une introduction de comptage (formulation reçue d'un
 * serveur antérieur, d'un cache, d'une mémoire de session).
 */
export function presentationDisplayable(p: MascotPresentation | null): boolean {
  return !!p && realParagraphs(p).every((x) => !hasCountingIntro(x.text));
}

/**
 * Lot 75E (§5) — garder la présentation DÉJÀ affichée plutôt que la réponse
 * reçue (pure, partagée par le hook client) : même contexte métier
 * (`contextHash`, RUN-001 : jamais de texte remplacé sous les yeux), même
 * RÉVISION du contrat de présentation, et aucune formulation interdite. Une
 * règle d'affichage corrigée côté serveur n'est donc jamais masquée par un
 * contexte inchangé ; la stabilité des formulations T6 est conservée.
 */
export function keepDisplayedPresentation(prev: MascotPresentation | null, next: MascotPresentation): boolean {
  return !!prev && prev.contextHash === next.contextHash
    && (prev.presentationRevision ?? null) === (next.presentationRevision ?? null)
    && presentationDisplayable(prev);
}

/**
 * Lot 61 — état de présentation EXPLICITE (pur, partagé serveur / client).
 * Les compteurs viennent des sujets RETENUS encore affichés (le client retire
 * aussitôt un sujet reporté), des « À faire en premier » et de l'invitation
 * Duo ; l'évaluation et le dégradé viennent du serveur (`p.state`). Jamais du
 * total « À traiter », du nombre de paragraphes seul ni du compteur des
 * échéances dépassées.
 */
export function presentationState(p: MascotPresentation | null): MascotPresentationState {
  const paras = realParagraphs(p);
  const todoShown = (p?.todo?.items.length ?? 0) + (p?.duoInvite ? 1 : 0);
  const actions = paras.filter(isAttention).length + todoShown;
  const information = paras.filter((x) => !isAttention(x)).length;
  const openNotPriority = (p?.todo?.total ?? 0) > (p?.todo?.items.length ?? 0);
  const evaluation = p?.state?.evaluation ?? 'OK';
  const degraded = p?.status === 'degraded' || (p?.state?.degraded ?? false);
  // Lot 72A (AC03) : sources en panne distinguées (présentation antérieure : métier).
  const degradedSources = p?.state?.degradedSources ?? (degraded ? ['business' as const] : []);
  const kind: MascotPresentationState['kind'] = actions > 0 ? 'ACTIONS'
    : information > 0 ? 'INFORMATION'
      : degraded || evaluation !== 'OK' ? 'DEGRADED'
        : openNotPriority ? 'OPEN_NOT_PRIORITY' : 'NOTHING_TO_REPORT';
  return { schemaVersion: 'mascot-state-v1', kind, actions, information, openNotPriority, evaluation, degraded, degradedSources };
}

/** Phrase sur l'évaluation des échéances proches, ou null. */
function evaluationNote(st: MascotPresentationState): string | null {
  if (st.evaluation === 'PENDING') return EVALUATION_PENDING_SPEECH;
  if (st.evaluation === 'UNAVAILABLE') return EVALUATION_UNAVAILABLE_SPEECH;
  return null;
}

/**
 * Phrase de la bulle (§3.2), ASSEMBLÉE à partir de l'état de présentation
 * (lot 61) — mêmes sujets que les blocs, rien d'autre :
 *   · « À faire en premier » / « Inviter quelqu'un » : présentés
 *     directement par leurs cartes — lot 71F : PLUS de « Deux sujets
 *     nécessitent votre attention aujourd'hui. » ; puis les textes des
 *     sujets retenus (jamais « rien à signaler ») ;
 *   · sujets retenus : leurs textes — lot 68 : PLUS d'introduction de
 *     comptage (« Un sujet mérite votre attention aujourd'hui : … ») ni de
 *     clause reformulée ; lot 71F : une introduction de comptage portée par
 *     un texte (T6, cache, secours) est retirée, sans remplacement ;
 *   · informations seules (analyse en cours, export, rappel informatif) :
 *     leurs textes, précédés de « Aucun sujet à traiter en priorité pour le
 *     moment. » si des éléments non prioritaires sont ouverts — jamais
 *     « Tout est à jour » ;
 *   · rien de retenu : « Aucun sujet à traiter en priorité… » (éléments
 *     ouverts), sinon « Rien de particulier à vous signaler pour le moment. » ;
 *   · évaluation des échéances en cours / indisponible : dit explicitement ;
 *   · source en panne : dit explicitement.
 * `composeSpeech` rend le message COMPLET (questions suggérées, trace) ;
 * l'accueil affiche `bubbleLead` puis un bloc par sujet (`subjectBlocks`).
 */
function compose({ presentation, empty, failed }: SpeechInput, withSubjects: boolean): Speech {
  if (empty) return { text: EMPTY_ACCOUNT_SPEECH, highlights: [] };
  if (!presentation) return { text: failed ? DEGRADED_SPEECH : '', highlights: [] };
  const paras = realParagraphs(presentation);
  const st = presentationState(presentation);
  const highlights = withSubjects ? paras.map((p) => p.highlight).filter((h): h is string => !!h) : [];
  const texts = (list: MascotParagraph[]) => (withSubjects ? list.map((p) => subjectText(p)).filter(Boolean) : []);
  const note = evaluationNote(st);
  const attention = paras.filter(isAttention);
  const info = paras.filter((p) => !isAttention(p));
  const join = (parts: Array<string | null>) => parts.filter((x): x is string => !!x).join(' ');
  // Lot 72A (AC03, AC04) — défaillances DISTINCTES, jamais masquées par une
  // action, un document ou Duo affichés : présentation conservée après un
  // rafraîchissement en échec (jamais présentée comme actualisée), sinon
  // source partiellement indisponible (métier ou décision T6) ; puis
  // l'évaluation en cours / indisponible (`note`).
  const alerte = failed ? STALE_SPEECH : st.degraded ? PARTIAL_DATA_SPEECH : null;

  // Lot 32 (MASC2) / lot 34 (MASC3) / lot 49A : « À traiter » affichés
  // (DO_FIRST, au plus deux) et invitation Duo. Lot 71F : AUCUNE phrase qui
  // les compte — leurs cartes les présentent directement ; puis les sujets
  // retenus. Jamais « rien à signaler » quand une carte est affichée.
  const todoShown = (presentation.todo?.items.length ?? 0) + (presentation.duoInvite ? 1 : 0);
  if (todoShown > 0) {
    return { text: join([...texts(attention), ...texts(info), alerte, note]), highlights };
  }
  if (attention.length > 0) {
    // Lot 68 : le fait utile, une seule fois — aucune introduction de comptage.
    return { text: join([...texts(attention), ...texts(info), alerte, note]), highlights };
  }
  if (info.length > 0) {
    // Information seule (document en analyse, rappel informatif…) : elle est
    // dite, sans annoncer au préalable que tout est à jour (D25 : source en
    // panne → dit).
    const tete = alerte ?? (st.openNotPriority ? NOTHING_PRIORITY : null);
    return { text: join([tete, ...texts(info), note]), highlights };
  }
  if (presentation.status === 'degraded') return { text: join([failed ? STALE_SPEECH : DEGRADED_SPEECH, note]), highlights: [] };
  // Lot 72A : jamais « rien à signaler » quand l'examen n'a pas pu se faire.
  const parts = [alerte, st.openNotPriority ? NOTHING_PRIORITY : null, note];
  return { text: parts.some(Boolean) ? join(parts) : NOTHING_TO_REPORT_SPEECH, highlights: [] };
}

/** Message complet de la bulle (en-tête et textes des sujets), pur. */
export function composeSpeech(input: SpeechInput): Speech {
  return compose(input, true);
}

/**
 * Lot 68 — phrase d'EN-TÊTE de la bulle, sans les textes des sujets (dits
 * une seule fois, dans leur bloc) : évaluation en cours ou indisponible,
 * source en panne, éléments non prioritaires, rien à signaler. Vide quand
 * les sujets ou les cartes (« À traiter », Duo) suffisent — lot 71F : plus
 * aucune phrase qui les compte. Jamais « rien à signaler » si un sujet ou
 * une carte est affiché. Pure.
 */
export function bubbleLead(input: SpeechInput): Speech {
  return compose(input, false);
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

// ── Blocs de sujet (lot 68) ─────────────────────────────────────────────────

/** Action d'un bloc : libellé court (« Voir »), action réelle du moteur. */
export interface SubjectBlockAction { action: MascotAction; label: string; primary: boolean }

/**
 * Lot 68 — UN bloc par sujet retenu : sa formulation (objet, bien et date
 * une seule fois), ses actions (« Voir » ouvre le détail ; « C’est fait »…)
 * et, pour une échéance décidée, le menu « Rappels ». Plus de carte qui
 * répète intitulé, bien et date sous le message.
 */
export interface SubjectBlock {
  key: string;
  paragraph: MascotParagraph;
  text: string;
  highlights: string[];
  actions: SubjectBlockAction[];
  reminder: MascotReminderRef | null;
  /** Rappel informatif / information : jamais le statut visuel d'une action. */
  informative: boolean;
  /**
   * Nature d'une ACTION retenue (« Action à prévoir », « À vérifier »,
   * « À anticiper », « En retard (2 j) »…), sans la date déjà dite ; null
   * pour une information (jamais « Action à prévoir » sur un rappel).
   */
  badge: string | null;
  tone: MascotTile['tone'];
  icon: MascotTile['icon'];
}

/** Libellé court d'une action de bloc : « Voir l’échéance » → « Voir ». */
export function blockActionLabel(a: MascotAction): string {
  return /^Voir\b/.test(a.label) ? 'Voir' : a.label;
}

const CODES_ECHEANCE = new Set(['DATE-NEXT', 'MASC-EXT-ACTION', 'MASC-BLOCKED']);

/** Blocs de sujet de la bulle, dans l'ordre des sujets retenus (pure). */
export function subjectBlocks(p: MascotPresentation | null): SubjectBlock[] {
  return realParagraphs(p).slice(0, MAX_TILES).map((x) => {
    const t = x.tile;
    const informative = !(t?.attention ?? true);
    const statut = (t?.status ?? '').split(' · ')[0].trim();
    const text = subjectText(x);
    return {
      key: x.occurrenceKey,
      paragraph: x,
      text,
      // Mise en valeur seulement si elle figure dans le texte affiché.
      highlights: x.highlight && text.includes(x.highlight) ? [x.highlight] : [],
      actions: x.actions.map((a, i) => ({ action: a, label: blockActionLabel(a), primary: i === 0 })),
      reminder: x.reminder ?? null,
      informative,
      badge: !informative && CODES_ECHEANCE.has(x.sourceCode) && statut ? statut : null,
      tone: t?.tone ?? 'blue',
      icon: t?.icon ?? 'circle-alert',
    };
  // Lot 75E : un bloc sans texte NI action serait inutilisable — jamais rendu.
  }).filter((b) => b.text !== '' || b.actions.length > 0 || b.reminder != null);
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
  | (HomeItemBase & { kind: 'duo-invite'; invite: MascotDuoInvite })
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
 * Lot 49A (ticket 13) — « Inviter quelqu'un » (Premium Duo, personne
 * invitée) : PREMIER élément, y compris sur un compte encore vide (pure).
 */
export function duoInviteHomeItem(p: MascotPresentation | null): HomeItem | null {
  const d = p?.duoInvite;
  if (!d) return null;
  return { kind: 'duo-invite', key: 'duo-invite', invite: d, title: d.title, sub: d.subtitle, cta: d.cta, tone: 'blue', icon: 'plus' };
}

/**
 * Niveau 2 de la bulle : « Inviter quelqu'un » (lot 49A) puis « À traiter » d'abord (ordre de la file), puis les
 * recommandations et l'étape d'accueil — même composant, au plus
 * `MAX_HOME_ITEMS`. Lot 68 : les sujets retenus n'y sont PLUS (carte qui
 * répétait le message) — ils ont chacun leur bloc (`subjectBlocks`).
 * Compte vide : rien (tuiles d'amorce côté écran).
 */
export function homeItems(p: MascotPresentation | null, empty: boolean): HomeItem[] {
  if (empty || !p) return [];
  const invite = duoInviteHomeItem(p);
  const out: HomeItem[] = [...(invite ? [invite] : []), ...(p.todo?.items ?? []).map(todoHomeItem)];
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
 *   aucune interpellation pertinente établie → `success-check` ;
 *   information seule, éléments ouverts non prioritaires, évaluation en cours
 *   ou indisponible, discours indisponible → `neutral` (lot 61 : jamais une
 *   réussite trompeuse).
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
  // Chargement ou panne : jamais une réussite (lot 61).
  if (!p) return 'neutral';
  const kinds = realParagraphs(p).map(kindOf);
  // Lot 32 (MASC2) : les « À traiter » ne sont plus des paragraphes — leur
  // nature compte toujours pour la pose (arbitrage → vérifier, sinon action).
  // Lot 34 (MASC3) : seuls les « À traiter » affichés (DO_FIRST) comptent.
  for (const t of p.todo?.items ?? []) kinds.push(t.actionKind === 'ARBITRATE' ? 'verify' : 'action');
  if (p.duoInvite) kinds.push('action');
  if (kinds.includes('overdue')) return 'alert-folder';
  if (kinds.includes('verify')) return 'questioning';
  if (kinds.includes('action')) return 'reminder-bell';
  // Lot 61 : la pose suit l'état de présentation — information seule,
  // éléments ouverts non prioritaires, évaluation en cours ou indisponible,
  // source en panne : pose neutre. Seule l'absence établie d'interpellation
  // pertinente donne la pose positive (sans affirmer que tout est résolu).
  // Lot 72A (AC04) : présentation conservée après un échec de rafraîchissement : jamais la pose positive.
  return !failed && presentationState(p).kind === 'NOTHING_TO_REPORT' ? 'success-check' : 'neutral';
}

/** Texte alternatif de la mascotte d'accueil, selon sa pose. */
export function homePoseLabel(pose: HomePose): string {
  switch (pose) {
    case 'welcome-wave': return 'Verebona vous souhaite la bienvenue';
    case 'alert-folder': return 'Verebona vous signale une échéance en retard';
    case 'questioning': return 'Verebona vous demande de vérifier une information';
    case 'reminder-bell': return 'Verebona vous rappelle un sujet à traiter';
    case 'success-check': return 'Verebona : rien de particulier à signaler';
    default: return 'Verebona';
  }
}

// ── Suggestions « Ou demandez-moi : » ───────────────────────────────────────

/**
 * Compte vide : questions du catalogue unique (lot 34) — les anciennes
 * (« Que pouvez-vous faire pour moi ? »…) n'avaient aucune intention T2
 * déterministe ni réponse garantie.
 */
export const EMPTY_ACCOUNT_SUGGESTIONS: string[] = emptyAccountSuggestions().map((s) => s.label);

export interface HomeSuggestion {
  label: string;
  context?: { intent: string; assetId?: number };
  /** Élément secondaire du moteur (télémétrie « cliqué ») ; absent : catalogue. */
  secondary?: MascotSecondary;
}

/**
 * Jusqu'à 3 pastilles « Ou demandez-moi : » : les questions proposées par le
 * moteur (secondaires de type `ask`, catalogue unique rendu côté serveur),
 * puis les suggestions de la page qui ne dépendent d'aucune donnée — jamais
 * d'autres questions pour atteindre 3 (lot 34) ; compte vide : les questions
 * d'amorce du catalogue (§12ter).
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
