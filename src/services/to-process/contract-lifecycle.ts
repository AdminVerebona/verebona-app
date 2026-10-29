/**
 * Qualification PURE du cycle de vie d'un contrat et lecture des dates d'un
 * texte — extraite telle quelle de `document-field-evidence.ts` (lots 61, 72,
 * 76 C2) au lot 99D pour être réutilisée sans dépendance à la base par les
 * récurrences de l'Agenda (`ai/agenda/rules/recurrence-end.ts`). Aucune
 * règle n'a changé ; `document-field-evidence.ts` ré-exporte ces symboles.
 */

// ══════════════════════════════════════════════════════════════════════════
// DATES — fonctions pures
// ══════════════════════════════════════════════════════════════════════════

export type DateParseStatus = 'ISO' | 'NORMALIZED' | 'ORDER_AMBIGUOUS' | 'REFUSED_AMBIGUOUS' | 'INVALID' | 'NOT_A_DATE';
interface DateParse { iso: string | null; status: DateParseStatus }

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};
export const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const pad = (n: number) => String(n).padStart(2, '0');

function jour(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2200
    ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * Date lue dans un document → ISO, avec le statut de normalisation. Pure.
 *   ISO (AAAA-MM-JJ[…]) · NORMALIZED (forme non ISO sans ambiguïté) ·
 *   ORDER_AMBIGUOUS (JJ/MM/AAAA avec jour et mois ≤ 12 et différents : lu à
 *   la française, jamais certain) · REFUSED_AMBIGUOUS (année sur deux
 *   chiffres, séparateurs mêlés) · INVALID (31/02…) · NOT_A_DATE.
 */
export function parseDocumentDate(raw: unknown): DateParse {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? { iso: null, status: 'INVALID' } : { iso: raw.toISOString().slice(0, 10), status: 'ISO' };
  if (typeof raw !== 'string') return { iso: null, status: 'NOT_A_DATE' };
  const s = sansAccents(raw.trim().toLowerCase()).replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[t ])/.exec(s);
  if (m) { const iso = jour(+m[1], +m[2], +m[3]); return iso ? { iso, status: 'ISO' } : { iso: null, status: 'INVALID' }; }
  m = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
  if (m) { const iso = jour(+m[1], +m[3], +m[4]); return iso ? { iso, status: 'NORMALIZED' } : { iso: null, status: 'INVALID' }; }
  m = /^(\d{1,2})([/.\-: ])(\d{1,2})\2(\d{4})$/.exec(s);
  if (m) {
    const d = +m[1], mo = +m[3];
    const iso = jour(+m[4], mo, d);
    if (!iso) return { iso: null, status: 'INVALID' };
    return { iso, status: d <= 12 && mo <= 12 && d !== mo ? 'ORDER_AMBIGUOUS' : 'NORMALIZED' };
  }
  if (/^\d{1,2}[/.\-: ]\d{1,2}[/.\-: ]\d{4}$/.test(s) || /^\d{1,2}[/.\-:]\d{1,2}[/.\-:]\d{2}$/.test(s)) return { iso: null, status: 'REFUSED_AMBIGUOUS' };
  m = /^(1er|\d{1,2}) ([a-z]+) (\d{4})$/.exec(s);
  if (m && MOIS[m[2]]) {
    const iso = jour(+m[3], MOIS[m[2]], m[1] === '1er' ? 1 : +m[1]);
    return iso ? { iso, status: 'NORMALIZED' } : { iso: null, status: 'INVALID' };
  }
  return { iso: null, status: 'NOT_A_DATE' };
}

const RE_DATES = new RegExp([
  String.raw`(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)`,
  String.raw`(?<!\d)\d{4}([/.])\d{1,2}\1\d{1,2}(?!\d)`,
  String.raw`(?<![\d/.:-])\d{1,2}([/.\-:])\d{1,2}\2\d{4}(?!\d)`,
  String.raw`(?<![\p{L}\d])(?:1er|\d{1,2})\s+[\p{L}]+\s+\d{4}(?!\d)`,
].join('|'), 'giu');

/** Dates NON refusées mentionnées dans un texte (ISO, dédoublonnées, dans l'ordre). Pure. */
export function datesMentionedIn(text: string | null | undefined): Array<{ raw: string; iso: string; status: DateParseStatus }> {
  if (!text) return [];
  const out = new Map<string, { raw: string; iso: string; status: DateParseStatus }>();
  for (const m of text.matchAll(RE_DATES)) {
    const p = parseDocumentDate(m[0]);
    if (p.iso && !out.has(p.iso)) out.set(p.iso, { raw: m[0], iso: p.iso, status: p.status });
  }
  return [...out.values()];
}

/**
 * Lot 72 (C2) — signaux de CYCLE DE VIE du contrat lus dans la connaissance
 * persistée (faits actifs, unités source) : jamais l'âge du document.
 *   · renewal   : reconduction / renouvellement prévu (« reconduit
 *                 tacitement », « renouvelable ») — un contrat ancien peut
 *                 rester actif ;
 *   · terminated: fin effective constatée (résiliation effective, contrat
 *                 « a pris fin », dossier soldé, échu sans reconduction) ;
 *   · residual  : obligation qui survit à la fin (restituer, régler un
 *                 solde, rendre le matériel…).
 * Vocabulaire générique du français contractuel, aucune règle propre à un
 * fournisseur ou à un contrat.
 */
export interface LifecycleSignals {
  renewal: boolean;
  /**
   * Lot 76 (C2) : fin effective du contrat PROUVÉE — constat (« a été
   * résilié », « a pris fin », « résiliation effective », « prêt soldé ») sans
   * négation, sans condition, portant sur ce contrat, daté au plus aujourd'hui,
   * lu dans une preuve FIABLE (fait certain, unité couverte). Seul signal qui
   * autorise une décision déterministe « contrat terminé ».
   */
  terminated: boolean;
  residual: boolean;
  signals: string[];
  /**
   * Lot 75I (A) : CLAUSES lues qui portent ces signaux (≤ 5 × 300 caractères,
   * dédoublonnées) — transmises à T4 pour juger une obligation, même quand
   * elles ne sont pas dans l'extrait associé à la date.
   */
  clauses?: string[];
  /** Lot 76 (C2) : non-renouvellement (« non renouvelable », « sans tacite reconduction ») — jamais une fin effective. */
  nonRenewal?: boolean;
  /** Lot 76 (C2) : fins PRÉVUES lues (« prend fin le 31/12/2030 »), ISO. */
  scheduledEnd?: string[];
  /**
   * Lot 76 (C2) : INDICE d'une fin (fin prévue déjà passée, constat lu dans
   * une preuve peu fiable) — jamais une preuve : décision différée, motivée.
   */
  terminationHint?: boolean;
  /** Lot 76 (C2) : résiliation niée (« n'est pas résilié »). */
  negatedTermination?: boolean;
  /** Lot 76 (C6) : CONTENUS (sans libellé) des clauses porteuses — base de la clé de preuve. */
  clauseBodies?: string[];
  /** Lot 76 (C2) : clause de résiliation conditionnelle ou générique (« peut être résilié en cas de… »). */
  conditionalTermination?: boolean;
  /**
   * Lot 99D (Agenda, fin de récurrence) — dates portées par les phrases de
   * fin EFFECTIVE prouvée (`terminated`), dans l'ordre de lecture. Sortie
   * additionnelle : aucune décision « À traiter » ne la lit.
   */
  terminatedDates?: string[];
  /**
   * Lot 99D — CONSTAT fiable d'une fin dont l'effet est à venir (« a été
   * résilié avec effet au 31/03/2027 ») : dates de la phrase. Jamais une fin
   * effective (`terminated` reste faux) ; une simple fin prévue (« prend fin
   * le… ») n'en est pas une.
   */
  confirmedFutureEndDates?: string[];
  /**
   * Lot 99D — PROPOSITIONS de non-reconduction (« sans tacite reconduction »,
   * « ne sera pas renouvelé ») : conditionnelle ou non (même lecture des
   * conditions que `terminationKindOf`), et dates de la proposition.
   */
  nonRenewalClauses?: Array<{ conditional: boolean; dates: string[] }>;
}

/**
 * Texte lu et sa fiabilité (lot 76, C2) : la fin effective exige une preuve
 * fiable. `body` : CONTENU lu seul (valeur, extrait — sans libellé ni clé),
 * base de la clé de preuve (C6) : un libellé renommé n'est pas un nouveau problème.
 */
export interface LifecycleText { text: string | null | undefined; confidence?: string | null; source?: string | null; body?: string | null }

/** Clauses transmises à T4 au plus (lot 75I). */
export const MAX_OBLIGATION_CLAUSES = 5;

const RE_SANS_RECONDUCTION = /\b(sans|non|pas|pas de|aucune?|ni|jamais)\s+(\w+\s){0,2}(reconduction|reconduit\w*|reconductible|renouvel\w*)/;
const RE_RECONDUCTION = /\b(reconduction|reconduit\w*|reconductible\w*|renouvel\w*|tacite\w*|prorogation|proroge\w*)\b/;
/** Vocabulaire d'une FIN (effective, prévue ou envisagée) — à qualifier. */
const RE_FIN = /\b(resili\w*|pris fin|prend fin|prendra fin|prendre fin|termine\w*|cloture\w*|expire\w*|expirera|arrive\w* a (son )?(terme|echeance)|fin effective|solde\w*|rompu\w*|rupture)\b/;
/** CONSTAT d'une fin survenue (passé composé, état) — Lot 76 (C2). */
const RE_FIN_CONSTATEE = new RegExp([
  String.raw`\b(a ete|ont ete|est|sont|etait|etaient|fut|avait ete|se trouve)\s+(definitivement\s+|bien\s+|effectivement\s+)?(resilie\w*|termine\w*|cloture\w*|expire\w*|rompu\w*)\b`,
  String.raw`\b(a|ont|avait|avaient)\s+(definitivement\s+|bien\s+)?pris fin\b`, String.raw`\bayant pris fin\b`,
  String.raw`\bresiliation (effective|prise en compte|enregistree|confirmee|acceptee)\b`, String.raw`\bfin effective\b`,
  String.raw`\b(integralement|definitivement|totalement)\s+solde\w*\b`, String.raw`\b(pret|credit|dossier|compte|emprunt|contrat)\s+(est\s+|a ete\s+)?solde\w*\b`,
  String.raw`\b(est|a ete)\s+arrive\w* a (son )?terme\b`,
].join('|'));
/** FIN PRÉVUE (présent ou futur) : « prend fin le », « expirera le », « valable jusqu'au ». */
const RE_FIN_PREVUE = /\b(prend fin|prendra fin|expire le|expirera|arrive a echeance|arrivera a (son )?(terme|echeance)|se termine|se terminera|valable jusqu|jusqu au|prendre fin)\b/;
/** Négation portée par la phrase (« n'est pas résilié », « aucune résiliation », « non résilié »). */
const RE_NEGATION = /\bn (est|a|ont|etait|avait|sont|etaient|fut|sera|aura|y a)\b|\b(ne|pas|non|aucune?|jamais|ni|nullement)\b/;
/** Condition, faculté, éventualité (« en cas de », « si », « peut être résilié »). */
const RE_CONDITION = /\b(en cas d\w*|si|sauf|peut|peuvent|pourra|pourront|pourrait|possibilite|faculte|droit de|a defaut|sous reserve|lorsque|des lors|en l absence|eventuel\w*|le cas echeant|modalites|conditions de|preavis)\b/;
/** Portée : la phrase vise un AUTRE contrat (ancien, précédent, remplacé). */
const RE_AUTRE_CONTRAT = /\b(ancien|precedent|remplace\w*|anterieur|annule et remplace)\b/;
const RE_OBLIGATION_RESIDUELLE = /\b(restitu\w*|rendre|retourner|rembourser|regler|reste a payer|reste du|solde restant|solde du|penalite\w*|frais de resiliation|indemnite\w*)\b/;
/**
 * Lot 75I (A) — vocabulaire générique d'une OBLIGATION possible (démarche,
 * préavis, paiement, restitution, reconduction…) : ouvre l'examen par T4
 * d'une échéance connue. Jamais une décision à lui seul.
 */
const RE_OBLIGATION_POSSIBLE = /\b(restitu\w*|rendre|retourn\w*|rembours\w*|regler|payer|paiement\w*|verser|versement\w*|solde\w*|penalit\w*|indemnit\w*|frais de \w+|preavis|resili\w*|denonc\w*|reconduc\w*|reconduit\w*|renouvel\w*|tacite\w*|prorog\w*|remettre|remise des cles|etat des lieux|obligation\w*|tenu de|tenue de|au plus tard)\b/;

const normCycle = (t: string) => ` ${sansAccents(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** Un texte mentionne-t-il une obligation possible ? (pure) */
export const mentionsObligation = (texte: string | null | undefined): boolean =>
  !!texte && RE_OBLIGATION_POSSIBLE.test(normCycle(String(texte)));

/**
 * Lot 76 (C2) — qualification d'une PHRASE qui parle de fin du contrat (pure) :
 * EFFECTIVE (constat sans négation ni condition, daté au plus aujourd'hui),
 * SCHEDULED (fin prévue, avec ses dates), NEGATED, CONDITIONAL, OTHER_CONTRACT
 * ou null (aucune fin évoquée).
 */
function terminationKindOf(phrase: string, today: string): { kind: 'EFFECTIVE' | 'SCHEDULED' | 'NEGATED' | 'CONDITIONAL' | 'OTHER_CONTRACT' | null; dates: string[]; constat?: boolean } {
  const t = normCycle(phrase);
  const dates = datesMentionedIn(phrase).map((d) => d.iso);
  if (!RE_FIN.test(t)) return { kind: null, dates };
  // Négation proche du mot de fin (« n'est pas résilié », « non résilié », « aucune résiliation »).
  const m = RE_FIN.exec(t)!;
  const avant = t.slice(Math.max(0, m.index - 40), m.index);
  if (RE_NEGATION.test(avant)) return { kind: 'NEGATED', dates };
  if (RE_AUTRE_CONTRAT.test(t)) return { kind: 'OTHER_CONTRACT', dates };
  if (RE_CONDITION.test(t)) return { kind: 'CONDITIONAL', dates };
  if (RE_FIN_CONSTATEE.test(t) && !RE_FIN_PREVUE.test(t)) {
    // Lot 99D : `constat` — fin CONSTATÉE dont l'effet est à venir (même qualification qu'avant).
    return dates.some((d) => d > today) ? { kind: 'SCHEDULED', dates, constat: true } : { kind: 'EFFECTIVE', dates };
  }
  if (RE_FIN_PREVUE.test(t)) return { kind: 'SCHEDULED', dates };
  // Mot de fin sans constat ni prévision (« Résiliation : … », « solde ») : clause générique.
  return { kind: 'CONDITIONAL', dates };
}

/**
 * Signaux de cycle de vie d'un ensemble de textes lus (pure). Lot 76 (C2) :
 * chaque PHRASE est qualifiée (`terminationKindOf`) — non-renouvellement, fin
 * prévue, résiliation envisagée ou niée ne sont jamais une fin effective ;
 * une fin constatée dans une preuve peu fiable n'est qu'un indice.
 */
export function lifecycleSignalsOf(textes: Array<string | LifecycleText | null | undefined>, today: string = todayParis()): LifecycleSignals {
  const out: LifecycleSignals = {
    renewal: false, terminated: false, residual: false, signals: [], clauses: [], clauseBodies: [],
    nonRenewal: false, scheduledEnd: [], terminationHint: false, negatedTermination: false, conditionalTermination: false,
  };
  const signal = (k: string, brut: string) => { if (out.signals.length < 8) out.signals.push(`${k}:${brut.slice(0, 60)}`); };
  for (const entree of textes) {
    if (!entree) continue;
    const brut = typeof entree === 'string' ? entree : entree.text;
    if (!brut) continue;
    // Texte transmis tel quel (recette, appelant) : fiable ; lu en base : sa confiance.
    const fiable = typeof entree === 'string' || !entree.confidence || entree.confidence === 'certain';
    const t = normCycle(String(brut));
    let porteur = false;
    const sans = RE_SANS_RECONDUCTION.test(t);
    if (sans) { porteur = true; out.nonRenewal = true; signal('nonRenewal', String(brut)); }
    else if (RE_RECONDUCTION.test(t)) { porteur = true; out.renewal = true; signal('renewal', String(brut)); }
    // Phrases, puis propositions (virgule, point-virgule, parenthèse, deux-points suivi d'un espace) :
    // une négation ou une condition ne déborde jamais sur la proposition voisine.
    for (const phrase of String(brut).split(/(?<=[.;!?])\s+|\n+|[,;()]|:\s/)) {
      // Lot 99D : proposition de non-reconduction qualifiée (condition, dates) — sortie additionnelle.
      const tp = normCycle(phrase);
      if (sans && RE_SANS_RECONDUCTION.test(tp)) {
        (out.nonRenewalClauses ??= []).push({ conditional: RE_CONDITION.test(tp), dates: datesMentionedIn(phrase).map((d) => d.iso) });
      }
      const q = terminationKindOf(phrase, today);
      if (!q.kind) continue;
      porteur = true;
      if (q.kind === 'EFFECTIVE') {
        if (fiable) {
          out.terminated = true; signal('terminated', phrase);
          // Lot 99D : dates de la phrase (champ absent tant qu'aucune n'est lue).
          for (const d of q.dates) if (!(out.terminatedDates ??= []).includes(d)) out.terminatedDates!.push(d);
        } else { out.terminationHint = true; signal('terminationHint', phrase); }
      } else if (q.kind === 'SCHEDULED') {
        for (const d of q.dates) if (!out.scheduledEnd!.includes(d)) out.scheduledEnd!.push(d);
        // Lot 99D : constat FIABLE d'une fin à effet futur (« a été résilié avec effet au… »).
        if (q.constat && fiable) for (const d of q.dates) if (!(out.confirmedFutureEndDates ??= []).includes(d)) out.confirmedFutureEndDates!.push(d);
        // Fin prévue DÉJÀ passée : indice d'une fin, jamais une preuve.
        if (q.dates.length && q.dates.every((d) => d < today)) { out.terminationHint = true; signal('terminationHint', phrase); }
        else signal('scheduledEnd', phrase);
      } else if (q.kind === 'NEGATED') { out.negatedTermination = true; signal('negatedTermination', phrase); }
      else if (q.kind === 'CONDITIONAL') { out.conditionalTermination = true; signal('conditionalTermination', phrase); }
    }
    if (RE_OBLIGATION_RESIDUELLE.test(t)) { porteur = true; out.residual = true; signal('residual', String(brut)); }
    if (!porteur && RE_OBLIGATION_POSSIBLE.test(t)) porteur = true;
    // Lot 75I (A) : la clause elle-même (texte lu, borné) — preuve transmise à T4.
    const clause = String(brut).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (porteur && clause && out.clauses!.length < MAX_OBLIGATION_CLAUSES && !out.clauses!.includes(clause)) out.clauses!.push(clause);
    const corps = typeof entree === 'string' ? null : entree.body?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? null;
    if (porteur && corps && out.clauseBodies!.length < 20 && !out.clauseBodies!.includes(corps)) out.clauseBodies!.push(corps);
  }
  // Une fin effective prouvée l'emporte sur un indice ; une reconduction lue n'est jamais effacée.
  if (out.terminated) out.terminationHint = false;
  return out;
}

/** Date du jour à Paris (AAAA-MM-JJ) — même calcul que `todayParis` de `document-field-evidence`. */
function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
