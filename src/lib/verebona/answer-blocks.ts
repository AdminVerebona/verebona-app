/**
 * Réponse de l'Assistant présentée en BLOCS — Trello #753, CDC T2 §8.1, §8.3, §8.5, §12.3, §12.4, §13.8 (D05, M11, M12).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTENU FACTUEL
 *
 * La réponse s'affichait dans un seul paragraphe, retours à la ligne compris :
 * une énumération, des étapes ou une réserve formaient un bloc compact. Elle
 * est désormais présentée en paragraphes, listes à puces et listes numérotées,
 * avec les montants mis en évidence.
 *
 * Les blocs sont DÉRIVÉS du texte de la réponse, celui que le serveur a validé
 * (affirmations étayées, contrôle final) et enregistré. Ils n'ajoutent, ne
 * retirent et ne reformulent rien : chaque caractère affiché vient de ce texte
 * (`answerBlocksText` le vérifie dans les tests). Conséquences :
 *   · la présentation ne peut introduire aucun fait non validé ;
 *   · une réponse rejouée (même demande) ou relue dans l'historique donne
 *     exactement les mêmes blocs, sans rien stocker de plus (aucune migration) ;
 *   · une ancienne réponse, enregistrée avant ce lot, est présentée de la même
 *     façon ; un client qui ignore les blocs lit toujours `answer`.
 * Aucun HTML, aucun lien, aucun balisage libre : seuls du texte et une mise en
 * évidence sortent d'ici.
 *
 * Module PUR (ni navigateur ni serveur) : le serveur s'en sert pour l'API, le
 * client pour l'affichage.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Fragment de texte ; `strong` : mis en évidence (montant, passage marqué). */
export interface AnswerSpan { text: string; strong?: true }

export type AnswerBlock =
  | { kind: 'paragraph'; spans: AnswerSpan[] }
  | { kind: 'list'; ordered: boolean; items: AnswerSpan[][] }
  /** Titre de section de petite taille (CDC T2 §8.1) : « ## Comparaison », ou une ligne entièrement marquée. */
  | { kind: 'heading'; spans: AnswerSpan[] }
  /** Tableau de comparaison (CDC T2 §8.1) : lignes « | … | … | » du texte validé ; `header` : première ligne. */
  | { kind: 'table'; header: AnswerSpan[][] | null; rows: AnswerSpan[][][] }
  /**
   * CHIFFRE CLÉ (CDC T2 §8.1, « chiffre clé si cela apporte de la clarté ») — passage 114AA.
   * Dérivé d'une ligne « Chiffre clé : <valeur> — <légende> » du texte validé : la valeur est mise en avant,
   * la légende la précise. Le libellé « Chiffre clé » est rendu par l'interface (c'est l'étiquette de la forme,
   * comme la puce d'une liste) et `answerBlocksText` le restitue : la ligne se relit à l'identique.
   */
  | { kind: 'metric'; value: AnswerSpan[]; caption: AnswerSpan[] | null };

/** Bornes de sécurité : une réponse n'est jamais un document. */
const MAX_BLOCKS = 60;
const MAX_ITEMS = 60;
/** Au-delà, un tableau n'est plus lisible (surtout sur mobile) : les lignes restent des paragraphes. */
const MAX_COLONNES = 6;
/** Au-delà, une ligne marquée n'est pas un titre de section mais une phrase. */
const TITRE_MAX = 80;
/** Un chiffre clé est COURT : au-delà, la ligne est une phrase et reste un paragraphe. */
const CHIFFRE_MAX = 40;
const LEGENDE_MAX = 80;
/** Au-delà, ce ne sont plus des chiffres CLÉS : les lignes suivantes restent des paragraphes. */
const MAX_CHIFFRES = 3;

const PUCE = /^\s*(?:[•·▪◦*]|[-–—])\s+(\S.*)$/;
const NUMERO = /^\s*(\d{1,2})[.)]\s+(\S.*)$/;
/** Ligne d'annonce : « Chronologie pour la Clio : », « J'ai trouvé 3 échéances : ». */
const ANNONCE = /[:：]\s*$/;
/** Titre de section écrit en tête de ligne (« ## Comparaison ») ; les marqueurs ne sont jamais affichés. */
const TITRE = /^\s*#{1,4}\s+(\S.*?)\s*$/;
/** Ligne entièrement marquée (« **Comparaison** ») : titre de section si elle n'annonce pas une liste. */
const TITRE_MARQUE = /^\s*\*\*(\S[^*\n]*?)\*\*\s*$/;
/** Ligne d'un tableau : « | Clio | Polo | ». */
const LIGNE_TABLEAU = /^\s*\|(.+)\|\s*$/;
/** Ligne de séparation d'un tableau (« |---|---| ») : elle fait de la ligne précédente l'en-tête. */
const SEPARATEUR_TABLEAU = /^\s*\|[\s|:-]+\|\s*$/;
/**
 * Chiffre clé (CDC T2 §8.1) : une ligne « Chiffre clé : <valeur> » — éventuellement « … — <légende> ».
 * L'étiquette est le seul marqueur ; elle est restituée à l'affichage et par `answerBlocksText`.
 */
export const ETIQUETTE_CHIFFRE_CLE = 'Chiffre clé';
const CHIFFRE_CLE = /^\s*Chiffre\s+clé\s*:\s*(\S.*?)\s*$/i;
/** Séparateur valeur / légende : un tiret entouré d'espaces (« 2 974,53 € — coût documenté »). */
const LEGENDE = /\s+[—–-]\s+/;
/** Montant en euros : « 2 023 € », « 2 974,53 € », « 12 EUR ». */
const MONTANT = /(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:,\d{1,2})?[ \u00a0\u202f]?(?:€|EUR\b)/g;

/** Fragments d'un texte : passages « **marqués** », et montants si `amounts`. */
function spansOf(text: string, amounts: boolean): AnswerSpan[] {
  const out: AnswerSpan[] = [];
  const push = (t: string, strong: boolean) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && Boolean(prev.strong) === strong) prev.text += t;
    else out.push(strong ? { text: t, strong: true } : { text: t });
  };
  const plain = (t: string) => {
    if (!amounts) { push(t, false); return; }
    let i = 0;
    for (const m of t.matchAll(MONTANT)) {
      // Un nombre collé à une lettre ou à un autre chiffre n'est pas un montant isolé.
      const avant = t[m.index! - 1];
      if (avant && /[\w,.]/.test(avant)) continue;
      push(t.slice(i, m.index), false);
      push(m[0], true);
      i = m.index! + m[0].length;
    }
    push(t.slice(i), false);
  };
  // « **texte** » : mise en évidence explicite ; les marqueurs ne sont jamais affichés.
  const parts = text.split(/\*\*(?=\S)([^*\n]+?)\*\*/);
  parts.forEach((p, i) => (i % 2 === 1 ? push(p, true) : plain(p.replace(/\*\*/g, ''))));
  return out.length ? out : [{ text: '' }];
}

/**
 * Découpe le texte d'une réponse en blocs (pure, testée) :
 *   · ligne vide : séparation de paragraphes ; chaque ligne isolée est un paragraphe ;
 *   · lignes consécutives commençant par une puce (« • », « - », « – », « * ») : liste à puces ;
 *   · lignes numérotées à partir de 1 (« 1. », « 2) ») : liste numérotée ;
 *   · ligne d'annonce terminée par « : » suivie de lignes : ces lignes forment une liste ;
 *   · « ## Titre », ou une ligne entièrement marquée : titre de section (Trello #753, CDC §8.1) ;
 *   · lignes « | … | … | » qui se suivent : tableau de comparaison, en-tête si une ligne « |---|---| » suit ;
 *   · « Chiffre clé : <valeur> — <légende> » : chiffre clé (CDC §8.1), trois au plus par réponse ;
 *   · montants en euros mis en évidence dans les paragraphes (jamais dans une liste ni un tableau, où ils le seraient tous).
 */
export function buildAnswerBlocks(answer: string | null | undefined): AnswerBlock[] {
  const lines = String(answer ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks: AnswerBlock[] = [];
  const paragraph = (t: string) => blocks.push({ kind: 'paragraph', spans: spansOf(t.trim(), true) });
  const list = (ordered: boolean, items: string[]) =>
    blocks.push({ kind: 'list', ordered, items: items.slice(0, MAX_ITEMS).map((t) => spansOf(t.trim(), false)) });
  /** Cellules d'une ligne de tableau, telles qu'elles sont écrites (les barres ne sont jamais affichées). */
  const cellules = (line: string): string[] => line.match(LIGNE_TABLEAU)![1].split('|').map((c) => c.trim());

  let i = 0;
  let chiffres = 0;
  while (i < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // Chiffre clé (CDC §8.1) : « Chiffre clé : 2 974,53 € — coût documenté de la Clio ». La valeur doit porter
    // un chiffre et rester courte : sinon la ligne est une phrase, et reste un paragraphe (rien n'est perdu).
    const cle = line.match(CHIFFRE_CLE)?.[1];
    if (cle && chiffres < MAX_CHIFFRES) {
      const coupe = cle.search(LEGENDE);
      const brut = coupe === -1 ? cle : cle.slice(0, coupe);
      const legende = coupe === -1 ? null : cle.slice(coupe).replace(LEGENDE, '');
      const valeur = brut.replace(/\*\*/g, '');
      // Un tiret final sans légende (« Chiffre clé : 12 € — ») est une ligne tronquée : elle reste un paragraphe.
      if (/\d/.test(valeur) && valeur.length <= CHIFFRE_MAX && !/[—–-]$/.test(valeur)
        && (legende === null || (legende.length > 0 && legende.length <= LEGENDE_MAX))) {
        blocks.push({
          kind: 'metric',
          // La valeur est déjà mise en avant par la forme : aucun montant n'y est mis en gras en plus.
          value: spansOf(brut, false),
          caption: legende === null ? null : spansOf(legende, false),
        });
        chiffres += 1;
        i += 1;
        continue;
      }
    }

    // Titre de section : « ## Comparaison », ou une ligne entièrement marquée qui n'annonce pas une liste
    // (« **Factures :** ») et qui est suivie de quelque chose (une ligne marquée seule reste une phrase).
    const marque = line.match(TITRE_MARQUE)?.[1];
    const titre = line.match(TITRE)?.[1]
      ?? (marque && !ANNONCE.test(marque) && lines.slice(i + 1).some((l) => l.trim()) ? marque : undefined);
    if (titre && titre.length <= TITRE_MAX) {
      blocks.push({ kind: 'heading', spans: spansOf(titre.trim(), false) });
      i += 1;
      continue;
    }

    // Tableau : au moins deux lignes « | … | … | », toutes de même largeur (sinon ce sont des paragraphes).
    if (LIGNE_TABLEAU.test(line) && !SEPARATEUR_TABLEAU.test(line)) {
      const brutes: string[] = [];
      let j = i;
      while (j < lines.length && LIGNE_TABLEAU.test(lines[j]) && brutes.length <= MAX_ITEMS) { brutes.push(lines[j]); j += 1; }
      const entete = brutes.length >= 2 && SEPARATEUR_TABLEAU.test(brutes[1]);
      const corps = brutes.filter((l) => !SEPARATEUR_TABLEAU.test(l));
      const largeur = corps.length ? cellules(corps[0]).length : 0;
      if (corps.length >= 2 && largeur >= 2 && largeur <= MAX_COLONNES && corps.every((l) => cellules(l).length === largeur)) {
        const ligne = (l: string) => cellules(l).map((c) => spansOf(c, false));
        blocks.push({
          kind: 'table',
          header: entete ? ligne(corps[0]) : null,
          rows: (entete ? corps.slice(1) : corps).map(ligne),
        });
        i = j;
        continue;
      }
    }

    // Liste numérotée : commence à 1 et se suit.
    const n = line.match(NUMERO);
    if (n && Number(n[1]) === 1) {
      const items: string[] = [];
      let attendu = 1;
      while (i < lines.length) {
        const m = lines[i].match(NUMERO);
        if (!m || Number(m[1]) !== attendu) break;
        items.push(m[2]); attendu += 1; i += 1;
      }
      if (items.length >= 2) { list(true, items); continue; }
      // Un « 1. » isolé reste un paragraphe, tel qu'écrit.
      paragraph(line);
      continue;
    }

    // Liste à puces.
    if (PUCE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && PUCE.test(lines[i])) { items.push(lines[i].match(PUCE)![1]); i += 1; }
      list(false, items);
      continue;
    }

    // Annonce suivie de lignes : ces lignes sont les éléments d'une liste.
    const suivantes: string[] = [];
    if (ANNONCE.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !ANNONCE.test(lines[j]) && !/^\s*\(/.test(lines[j])) { suivantes.push(lines[j]); j += 1; }
      if (suivantes.length >= 2 || (suivantes.length === 1 && (PUCE.test(suivantes[0]) || NUMERO.test(suivantes[0])))) {
        paragraph(line);
        const numerotees = suivantes.every((s) => NUMERO.test(s));
        list(numerotees, suivantes.map((s) => (numerotees ? s.match(NUMERO)![2] : s.match(PUCE)?.[1] ?? s)));
        i = j;
        continue;
      }
    }

    paragraph(line);
    i += 1;
  }
  return blocks;
}

/** Texte porté par des blocs, dans l'ordre d'affichage (accessibilité, tests : rien d'ajouté, rien de perdu). */
export function answerBlocksText(blocks: AnswerBlock[]): string {
  const texte = (spans: AnswerSpan[]) => spans.map((s) => s.text).join('');
  const cellules = (row: AnswerSpan[][]) => row.map(texte).join(' ');
  return blocks.map((b) => {
    switch (b.kind) {
      case 'paragraph':
      case 'heading': return texte(b.spans);
      case 'list': return b.items.map(texte).join('\n');
      case 'table': return [...(b.header ? [b.header] : []), ...b.rows].map(cellules).join('\n');
      // L'étiquette et le séparateur sont restitués : la ligne d'origine se relit mot pour mot.
      case 'metric': return `${ETIQUETTE_CHIFFRE_CLE} : ${texte(b.value)}${b.caption ? ` — ${texte(b.caption)}` : ''}`;
    }
  }).join('\n');
}

/** Un seul paragraphe sans mise en évidence : la réponse est déjà lisible telle quelle (aucun bloc à transmettre). */
export function isPlainAnswer(blocks: AnswerBlock[]): boolean {
  return blocks.length === 0 || (blocks.length === 1 && blocks[0].kind === 'paragraph' && blocks[0].spans.every((s) => !s.strong));
}

const estSpan = (s: unknown): s is AnswerSpan =>
  !!s && typeof s === 'object' && typeof (s as AnswerSpan).text === 'string'
  && ((s as AnswerSpan).strong === undefined || (s as AnswerSpan).strong === true);
/** Ligne d'un tableau reçu : des cellules, chacune faite de fragments. */
const estLigne = (r: unknown): r is AnswerSpan[][] =>
  Array.isArray(r) && r.length >= 2 && r.length <= MAX_COLONNES && r.every((c) => Array.isArray(c) && c.every(estSpan));
const copieSpan = (s: AnswerSpan): AnswerSpan => (s.strong ? { text: s.text, strong: true } : { text: s.text });

/**
 * Blocs reçus du serveur, contrôlés avant affichage (pure) : forme exacte, bornes ; `null` si quoi que ce soit
 * s'en écarte — le client présente alors la réponse à partir de son texte (`buildAnswerBlocks`).
 */
export function parseAnswerBlocks(raw: unknown): AnswerBlock[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BLOCKS) return null;
  const out: AnswerBlock[] = [];
  for (const b of raw as Array<Record<string, unknown>>) {
    if (!b || typeof b !== 'object') return null;
    if (b.kind === 'paragraph' && Array.isArray(b.spans) && b.spans.every(estSpan)) {
      out.push({ kind: 'paragraph', spans: (b.spans as AnswerSpan[]).map((s) => (s.strong ? { text: s.text, strong: true } : { text: s.text })) });
    } else if (b.kind === 'list' && typeof b.ordered === 'boolean' && Array.isArray(b.items) && b.items.length <= MAX_ITEMS
      && b.items.every((it) => Array.isArray(it) && it.every(estSpan))) {
      out.push({
        kind: 'list', ordered: b.ordered,
        items: (b.items as AnswerSpan[][]).map((it) => it.map((s) => (s.strong ? { text: s.text, strong: true } : { text: s.text }))),
      });
    } else if (b.kind === 'heading' && Array.isArray(b.spans) && b.spans.every(estSpan)) {
      out.push({ kind: 'heading', spans: (b.spans as AnswerSpan[]).map(copieSpan) });
    } else if (b.kind === 'table' && (b.header === null || b.header === undefined || estLigne(b.header)) && Array.isArray(b.rows)
      && b.rows.length > 0 && b.rows.length <= MAX_ITEMS && b.rows.every(estLigne)) {
      const header = b.header ? (b.header as AnswerSpan[][]).map((c) => c.map(copieSpan)) : null;
      const rows = (b.rows as AnswerSpan[][][]).map((r) => r.map((c) => c.map(copieSpan)));
      // Toutes les lignes de même largeur, bornée : un tableau irrégulier n'est pas affichable.
      const largeur = (header ?? rows[0]).length;
      if (largeur < 2 || largeur > MAX_COLONNES || (header && header.length !== largeur) || rows.some((r) => r.length !== largeur)) return null;
      out.push({ kind: 'table', header, rows });
    } else if (b.kind === 'metric' && Array.isArray(b.value) && b.value.length > 0 && b.value.every(estSpan)
      && (b.caption === null || b.caption === undefined || (Array.isArray(b.caption) && b.caption.every(estSpan)))) {
      const value = (b.value as AnswerSpan[]).map(copieSpan);
      const caption = Array.isArray(b.caption) ? (b.caption as AnswerSpan[]).map(copieSpan) : null;
      // Bornes du chiffre clé : une valeur longue ou sans chiffre n'est pas affichable sous cette forme.
      const brut = value.map((s) => s.text).join('');
      const legende = caption?.map((s) => s.text).join('') ?? '';
      if (!/\d/.test(brut) || brut.length > CHIFFRE_MAX || legende.length > LEGENDE_MAX) return null;
      out.push({ kind: 'metric', value, caption: caption && legende ? caption : null });
    } else return null;
  }
  return out;
}

/**
 * Blocs à afficher pour un message : ceux du serveur s'ils sont valides ET portent exactement le texte de la
 * réponse ; sinon ceux dérivés du texte. Dans les deux cas, rien d'autre que le texte validé n'est affiché.
 */
export function answerBlocksFor(content: string, fromServer?: unknown): AnswerBlock[] {
  const local = buildAnswerBlocks(content);
  const recus = fromServer === undefined || fromServer === null ? null : parseAnswerBlocks(fromServer);
  const serre = (t: string) => t.replace(/\s+/g, '');
  return recus && serre(answerBlocksText(recus)) === serre(answerBlocksText(local)) ? recus : local;
}
