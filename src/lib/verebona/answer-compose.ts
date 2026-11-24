/**
 * Réponse COMPOSÉE par le code — carte #790, relance du 21/11/2026 (E03 : réponses « monobloc »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT, ET CE QUE FAIT CE MODULE
 *
 * Les blocs affichés (`answer-blocks.ts`) sont DÉRIVÉS du texte validé de la réponse : c'est le
 * contrat accepté (passages 114Y, 114Z, 114AA — rien n'est stocké en plus, le rejeu et l'historique
 * redonnent les mêmes blocs). Mais les réponses écrites par le code assemblaient leurs phrases
 * sur UNE ligne (`phrases.join(' ')`) : le texte ne portait aucune structure, donc le rendu n'en
 * recevait aucune — un paragraphe dense, quel que soit le prompt.
 *
 * Une réponse déterministe DÉCLARE désormais ses parties (chiffre clé, paragraphe, liste, titre,
 * tableau — les formes du contrat existant, aucune autre). `composeAnswer` en écrit le TEXTE
 * canonique (une partie par bloc de lignes), et rend les blocs que `buildAnswerBlocks` dérive de
 * CE texte. Il n'y a donc toujours qu'UNE source — le texte enregistré — et la structure est
 * transmise de bout en bout par lui : production, persistance, API, historique, rejeu, rendu.
 *
 * Garanties (testées) :
 *   · `buildAnswerBlocks(composeAnswer(parties).answer)` est exactement `composeAnswer(parties).blocks` ;
 *   · une partie qui ne peut pas prendre sa forme (chiffre clé trop long, tableau irrégulier) est
 *     écrite en paragraphe ou en liste : rien n'est perdu, rien n'est inventé ;
 *   · aucun retour à la ligne, aucune barre de tableau ne peut venir d'une donnée (nom d'un bien,
 *     titre d'un document) et casser la forme : ils sont neutralisés à l'écriture.
 *
 * Module PUR (ni navigateur ni serveur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { buildAnswerBlocks, ETIQUETTE_CHIFFRE_CLE, type AnswerBlock } from './answer-blocks';

/** Partie d'une réponse écrite par le code : une des formes du contrat des blocs. */
export type AnswerPart =
  | { kind: 'paragraph'; text: string }
  /** Liste ; `intro` : ligne d'annonce (« Ventilation »), écrite suivie de « : ». */
  | { kind: 'list'; items: string[]; intro?: string | null; ordered?: boolean }
  | { kind: 'heading'; text: string }
  /** Chiffre clé : la valeur mise en avant seule, la légende la précise. */
  | { kind: 'metric'; value: string; caption?: string | null }
  /** Tableau de comparaison ; `header` : première ligne (libellés des colonnes). */
  | { kind: 'table'; header: string[] | null; rows: string[][] };

export interface ComposedAnswer {
  /** Texte de la réponse : seule source (enregistré, copié, lu, exporté, journalisé). */
  answer: string;
  /** Blocs dérivés de `answer` — ceux que l'API transmet et que l'écran présente. */
  blocks: AnswerBlock[];
}

const PUCE_ECRITE = '•';
/** Trois chiffres clés au plus par réponse (même borne que la dérivation). */
const MAX_CHIFFRES = 3;

/** Une donnée ne porte jamais de retour à la ligne : une partie tient sur ses propres lignes. */
const uneLigne = (t: string | null | undefined): string => String(t ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
const majuscule = (t: string): string => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t);
/** Annonce d'une liste : sans ponctuation finale, « : » ajouté à l'écriture. */
const annonce = (t: string): string => `${uneLigne(t).replace(/\s*[:：.]+$/, '')} :`;
const cellule = (t: string): string => uneLigne(t).replace(/\|/g, '/');

/** Lignes canoniques d'une partie (sans contrôle de forme). */
function lignesDe(p: AnswerPart): string[] {
  switch (p.kind) {
    case 'paragraph': return [uneLigne(p.text)].filter(Boolean);
    case 'heading': return uneLigne(p.text) ? [`## ${uneLigne(p.text)}`] : [];
    case 'metric': {
      const legende = uneLigne(p.caption);
      return [`${ETIQUETTE_CHIFFRE_CLE} : ${uneLigne(p.value)}${legende ? ` — ${legende}` : ''}`];
    }
    case 'list': {
      const items = p.items.map(uneLigne).filter(Boolean);
      // Une liste sans élément n'annonce rien : ni annonce orpheline, ni bloc vide.
      if (!items.length) return [];
      const ecrits = items.map((it, i) => (p.ordered ? `${i + 1}. ${it}` : `${PUCE_ECRITE} ${it}`));
      return p.intro && uneLigne(p.intro) ? [annonce(p.intro), ...ecrits] : ecrits;
    }
    case 'table': {
      const ligne = (r: string[]) => `| ${r.map(cellule).join(' | ')} |`;
      const separateur = (n: number) => `|${Array.from({ length: n }, () => ' --- ').join('|')}|`;
      return [...(p.header ? [ligne(p.header), separateur(p.header.length)] : []), ...p.rows.map(ligne)];
    }
  }
}

/** Formes attendues à l'écran pour une partie (une liste annoncée : paragraphe puis liste). */
function formesDe(p: AnswerPart): AnswerBlock['kind'][] {
  if (p.kind === 'list') return p.intro && uneLigne(p.intro) ? ['paragraph', 'list'] : ['list'];
  return [p.kind];
}

/** Partie de repli quand la forme demandée ne peut pas être tenue : même contenu, forme plus simple. */
function repli(p: AnswerPart): AnswerPart {
  if (p.kind === 'metric') {
    const legende = uneLigne(p.caption);
    return { kind: 'paragraph', text: legende ? `${majuscule(legende)} : ${uneLigne(p.value)}.` : `${uneLigne(p.value)}.` };
  }
  if (p.kind === 'table') {
    // Une ligne du tableau par élément de liste : « Libellé — valeur — valeur ».
    return { kind: 'list', intro: p.header ? p.header.map(cellule).join(' — ') : null, items: p.rows.map((r) => r.map(cellule).join(' — ')) };
  }
  if (p.kind === 'heading') return { kind: 'paragraph', text: p.text };
  return p;
}

/**
 * Compose une réponse à partir de ses parties (pure, testée). Les parties vides sont ignorées ;
 * les blocs sont séparés par une ligne vide, une liste suit son annonce sans ligne vide.
 */
export function composeAnswer(parts: readonly AnswerPart[]): ComposedAnswer {
  const groupes: string[] = [];
  let chiffres = 0;
  for (const demandee of parts) {
    let p: AnswerPart = demandee;
    if (p.kind === 'metric') {
      if (chiffres >= MAX_CHIFFRES) p = repli(p);
      else chiffres += 1;
    }
    let lignes = lignesDe(p);
    if (!lignes.length) continue;
    // La forme est vérifiée sur le texte écrit, par la dérivation même que l'écran appliquera.
    const tient = (q: AnswerPart, l: string[]) => {
      const obtenues = buildAnswerBlocks(l.join('\n')).map((b) => b.kind);
      const attendues = formesDe(q);
      return obtenues.length === attendues.length && obtenues.every((k, i) => k === attendues[i]);
    };
    if (!tient(p, lignes) && (p.kind === 'metric' || p.kind === 'table' || p.kind === 'heading')) {
      if (p.kind === 'metric') chiffres -= 1;
      p = repli(p);
      lignes = lignesDe(p);
      if (!lignes.length) continue;
    }
    groupes.push(lignes.join('\n'));
  }
  const answer = groupes.join('\n\n');
  return { answer, blocks: buildAnswerBlocks(answer) };
}

/** Texte seul d'une réponse composée (raccourci des stratégies). */
export function composeAnswerText(parts: readonly AnswerPart[]): string {
  return composeAnswer(parts).answer;
}

/** Frontière entre deux lignes d'une réponse du modèle : paragraphe par affirmation, ou une ligne par élément. */
export type AnswerLineSeparator = '\n\n' | '\n';

/** Longueur au-delà de laquelle un fragment sans ponctuation finale n'est plus « un morceau de phrase ». */
const FRAGMENT_MAX = 160;
/** Fin de phrase : ponctuation finale, éventuellement suivie d'une fermeture (guillemet, parenthèse). */
const FIN_DE_PHRASE = /[.!?…][»”"')\]]*$/;

/**
 * Deux lignes ordinaires du modèle forment-elles UNE MÊME PHRASE (pure, testée) ? Oui si la première ne
 * termine pas sa phrase (« La Clio a 45 000 km », « Voici ce que j'ai trouvé : ») ou si la seconde commence
 * en minuscule (« mais son contrôle technique est dépassé. »). Un fragment long n'est plus un morceau de phrase.
 */
export function continuesSentence(previous: string, next: string): boolean {
  const p = previous.trim();
  const n = next.trim();
  if (!p || !n) return false;
  if (!FIN_DE_PHRASE.test(p)) return p.length <= FRAGMENT_MAX;
  return /^\p{Ll}/u.test(n);
}

/**
 * Assemble les LIGNES d'une réponse rédigée par le modèle (voie IA), sans rien y ajouter.
 *
 * Carte #790 recentrée (22/11/2026, §2.B) — règle remplacée : « les phrases ordinaires se suivent dans un même
 * paragraphe ». Une ligne = une affirmation (`claim`) du contrat de sortie, vérifiée séparément avec ses propres
 * sources : la FRONTIÈRE entre deux affirmations est désormais conservée dans le texte.
 *   · UNE affirmation par paragraphe (ligne vide entre deux), dès qu'il y en a plusieurs ;
 *   · une seule affirmation : le texte tel quel — rien n'est forcé (ni titre, ni liste, ni chiffre clé) ;
 *   · deux lignes qui forment ensemble une même phrase (`continuesSentence`) restent dans le même paragraphe ;
 *   · une ligne qui porte elle-même une forme du contrat — puce, numéro, titre « ## », ligne de tableau,
 *     « Chiffre clé : … » — garde sa propre ligne ; les éléments d'une liste restent sur des lignes consécutives,
 *     collés à l'annonce « … : » qui les précède (règle du 21/11, inchangée).
 * `separator: '\n'` (comparaison, chronologie) : une ligne par élément, inchangé.
 * `separator: '\n\n'` (affirmations, par défaut) : la règle ci-dessus. Il n'existe plus d'assemblage par une espace.
 */
export function joinAnswerLines(lines: readonly string[], separator: AnswerLineSeparator = '\n\n'): string {
  const propres = lines.map((l) => String(l ?? '').trim()).filter(Boolean);
  if (separator === '\n') return propres.join('\n');
  const ELEMENT = /^(?:[•·▪◦*]\s|[-–—]\s|\d{1,2}[.)]\s|\|)/;
  const STRUCTUREE = /^(?:#{1,4}\s|Chiffre\s+clé\s*:)/i;
  const estStructuree = (l: string) => l.includes('\n') || ELEMENT.test(l) || STRUCTUREE.test(l) || /^\*\*[^*\n]+\*\*$/.test(l);
  const annonceListe = (l: string) => /[:：]$/.test(l);
  let out = '';
  let precedente: string | null = null;
  for (const l of propres) {
    if (precedente === null) out = l;
    else if (estStructuree(l) || estStructuree(precedente)) {
      // Les éléments d'une même liste (ou d'un même tableau), et la liste après son annonce, restent sur des
      // lignes consécutives ; un chiffre clé, un titre ou un paragraphe voisin s'en détachent par une ligne vide.
      const suite = ELEMENT.test(l) && !l.includes('\n') && !precedente.includes('\n') && (ELEMENT.test(precedente) || annonceListe(precedente));
      out += suite ? `\n${l}` : `\n\n${l}`;
    } else out += continuesSentence(precedente, l) ? ` ${l}` : `\n\n${l}`;
    precedente = l;
  }
  return out;
}
