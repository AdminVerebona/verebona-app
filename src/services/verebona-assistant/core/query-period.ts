/**
 * Période demandée dans une question — CDC §13.7, §20.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA PÉRIODE N'ÉTAIT NI COMPRISE NI DEMANDÉE
 *
 * « Mes factures de 2024 » cherchait le mot « 2024 » dans le texte des
 * documents : un document daté de 2024 dont le texte ne répétait pas l'année
 * passait derrière un document de 2021 qui la citait. Le score composite du
 * §13.7 doit tenir compte de la « date ou période demandée ».
 *
 * Et « mes factures de mars » (sans année), « le devis de l'autre jour » :
 * la période n'est pas identifiable, et le §20.1 impose alors une
 * clarification — pas un choix arbitraire.
 *
 * Module PUR : la date du jour est passée par l'appelant (tests stables).
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface PeriodeResolue {
  kind: 'resolved';
  /** Bornes ISO incluses (AAAA-MM-JJ). */
  from: string;
  to: string;
  /** Libellé lisible (« mars 2024 », « l’année 2025 »). */
  label: string;
  /** Expression retrouvée dans la question (texte normalisé). */
  expression: string;
}

export interface PeriodeAmbigue {
  kind: 'ambiguous';
  expression: string;
  /** Choix proposés en clarification (libellés substituables à l'expression). */
  choices: Array<{ id: string; label: string; replacement: string }>;
}

export type Periode = PeriodeResolue | PeriodeAmbigue | null;

const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const MOIS_AFFICHES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");
const pad = (n: number) => String(n).padStart(2, '0');
const finDeMois = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const iso = (d: Date) => d.toISOString().slice(0, 10);

function mois(a: number, m: number, expression: string): PeriodeResolue {
  return { kind: 'resolved', from: `${a}-${pad(m)}-01`, to: `${a}-${pad(m)}-${pad(finDeMois(a, m))}`, label: `${MOIS_AFFICHES[m - 1]} ${a}`, expression };
}
function annee(a: number, expression: string): PeriodeResolue {
  return { kind: 'resolved', from: `${a}-01-01`, to: `${a}-12-31`, label: `l’année ${a}`, expression };
}
function jour(a: number, m: number, j: number, expression: string): PeriodeResolue | null {
  if (m < 1 || m > 12 || j < 1 || j > finDeMois(a, m)) return null;
  const d = `${a}-${pad(m)}-${pad(j)}`;
  return { kind: 'resolved', from: d, to: d, label: `${j} ${MOIS_AFFICHES[m - 1]} ${a}`, expression };
}

/** Expressions vagues : la période ne peut pas être fixée sans l'utilisateur. */
const VAGUE = /(?<![\p{L}])(recemment|dernierement|l'autre jour|il y a (?:quelque temps|un moment|longtemps)|a l'epoque|l'an dernier ou l'annee d'avant)(?![\p{L}])/u;

/**
 * Lit la période d'une question. `today` : date du jour ISO (fuseau de
 * l'application). Rend `null` sans mention de période.
 */
export function analyserPeriode(message: string, today: string): Periode {
  const t = plain(message);
  const [ay, am, ad] = today.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(ay, am - 1, ad));

  // Date complète : 12/03/2024, 12 mars 2024, 2024-03-12.
  let m = t.match(/(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/);
  if (m) { const p = jour(Number(m[3]), Number(m[2]), Number(m[1]), m[0]); if (p) return p; }
  m = t.match(new RegExp(`(?<!\\d)(\\d{1,2})(?:er)? (${MOIS.join('|')}) (\\d{4})(?!\\d)`));
  if (m) { const p = jour(Number(m[3]), MOIS.indexOf(m[2]) + 1, Number(m[1]), m[0]); if (p) return p; }
  m = t.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (m) { const p = jour(Number(m[1]), Number(m[2]), Number(m[3]), m[0]); if (p) return p; }

  // Mois et année : « mars 2024 ».
  m = t.match(new RegExp(`(?<![\\p{L}])(${MOIS.join('|')}) (\\d{4})(?!\\d)`, 'u'));
  if (m) return mois(Number(m[2]), MOIS.indexOf(m[1]) + 1, m[0]);

  // Périodes relatives, calculées sur la date du jour.
  if (/(?<![\p{L}])(cette annee|l'annee en cours)(?![\p{L}])/u.test(t)) return annee(ay, 'cette annee');
  m = t.match(/(?<![\p{L}])(l'annee derniere|l'an dernier|l'an passe|l'annee passee)(?![\p{L}])/u);
  if (m) return annee(ay - 1, m[1]);
  if (/(?<![\p{L}])ce mois(?:-ci)?(?![\p{L}])/u.test(t)) return mois(ay, am, 'ce mois');
  m = t.match(/(?<![\p{L}])(le mois dernier|le mois passe)(?![\p{L}])/u);
  if (m) return mois(am === 1 ? ay - 1 : ay, am === 1 ? 12 : am - 1, m[1]);
  m = t.match(/(?<![\p{L}])ces (\d{1,3}) derniers (jours|mois)(?![\p{L}])/u);
  if (m) {
    const n = Number(m[1]);
    const debut = new Date(base);
    if (m[2] === 'jours') debut.setUTCDate(debut.getUTCDate() - n);
    else debut.setUTCMonth(debut.getUTCMonth() - n);
    return { kind: 'resolved', from: iso(debut), to: today.slice(0, 10), label: `ces ${n} derniers ${m[2]}`, expression: m[0] };
  }

  // Année seule : « en 2024 », « de 2024 », « factures 2024 ».
  // Un montant ou une mesure (« 2000 € », « 2024 km ») n'est pas une année.
  m = t.match(/(?<![\d,.])(19[5-9]\d|20\d{2})(?![\d,.])(?! ?(?:€|eur|euros?|km|kw|kwh|m2|m²|l|kg)(?![\p{L}]))/u);
  if (m) return annee(Number(m[1]), m[1]);

  // Mois sans année : ambigu — cette année (si déjà passé) ou l'an dernier.
  m = t.match(new RegExp(`(?<![\\p{L}])(?:en |de |d'|du mois de )?(${MOIS.join('|')})(?![\\p{L}])(?! \\d)`, 'u'));
  // « mai » est aussi un mot courant rare en question ; « mars » la planète
  // n'a pas sa place ici : on accepte le risque, la clarification tranche.
  if (m) {
    const n = MOIS.indexOf(m[1]) + 1;
    const recent = n <= am ? ay : ay - 1;
    return {
      kind: 'ambiguous',
      expression: m[1],
      choices: [recent, recent - 1].map((a) => ({
        id: `period_${a}-${pad(n)}`, label: `${MOIS_AFFICHES[n - 1].replace(/^./, (c) => c.toUpperCase())} ${a}`, replacement: `${MOIS[n - 1]} ${a}`,
      })),
    };
  }

  m = t.match(VAGUE);
  if (m) {
    return {
      kind: 'ambiguous',
      expression: m[1],
      choices: [
        { id: 'period_30d', label: 'Ces 30 derniers jours', replacement: 'ces 30 derniers jours' },
        { id: 'period_12m', label: 'Ces 12 derniers mois', replacement: 'ces 12 derniers mois' },
        { id: 'period_all', label: 'Toute la période', replacement: '' },
      ],
    };
  }
  return null;
}

/** La date ISO est-elle dans la période ? (`null` : inconnue.) */
export function dansPeriode(date: string | null | undefined, p: { from: string; to: string } | null | undefined): boolean | null {
  if (!p || !date) return null;
  const d = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d >= p.from && d <= p.to;
}

/**
 * Retire l'expression de période d'une question (texte normalisé) : la
 * période est passée à part, elle ne doit plus être cherchée comme un mot
 * dans le texte des documents.
 */
export function sansExpressionDePeriode(message: string, p: PeriodeResolue): string {
  // Le texte rendu est normalisé (minuscules, sans accents) : il ne sert
  // qu'au découpage en termes, qui normalise de toute façon.
  const t = plain(message);
  const i = t.indexOf(p.expression);
  if (i < 0) return message;
  return `${t.slice(0, i)} ${t.slice(i + p.expression.length)}`.replace(/\s+/g, ' ').trim();
}

// ══════════════════════════════════════════════════════════════════════════
// PORTÉE TEMPORELLE D'UNE DEMANDE D'ACTIONS — lot 34 (ticket T2 « Que dois-je
// faire aujourd'hui ? »)
//
// `analyserPeriode` lit les périodes CALENDAIRES (mois, année, date, « ce
// mois-ci »…) qui filtrent une recherche de documents. Une demande d'actions
// parle aussi en JOURS relatifs (« aujourd'hui », « demain », « cette
// semaine ») et en ÉTATS (« en retard », « à venir »). Ces expressions ne
// sont PAS ajoutées à `analyserPeriode` : elles filtreraient par date les
// documents de « quel est le kilométrage aujourd'hui ? ». La portée ci-dessous
// les ajoute, et délègue tout le reste à `analyserPeriode` — une seule
// résolution des dates, même date du jour, mêmes bornes ISO incluses.
// ══════════════════════════════════════════════════════════════════════════

export type TimeScope =
  | 'TODAY' | 'TOMORROW' | 'THIS_WEEK' | 'NEXT_WEEK' | 'THIS_MONTH' | 'NEXT_MONTH'
  | 'OVERDUE' | 'UPCOMING' | 'PERIOD' | 'NONE';

export interface PorteeTemporelle {
  scope: TimeScope;
  /** Bornes ISO incluses ; `from` nul pour « en retard » (tout le passé). */
  from: string | null;
  to: string | null;
  label: string;
  /** Expression retrouvée (texte normalisé), `null` sans mention. */
  expression: string | null;
}

/** Horizon de « à venir » / « bientôt » : même défaut que les échéances (30 jours, T2-15). */
export const UPCOMING_WINDOW_DAYS = 30;

function decaler(today: string, jours: number): string {
  const [a, m, j] = today.slice(0, 10).split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  d.setUTCDate(d.getUTCDate() + jours);
  return iso(d);
}

/** Lundi de la semaine (ISO, semaine du lundi au dimanche) de `today`. */
function lundi(today: string): string {
  const [a, m, j] = today.slice(0, 10).split('-').map(Number);
  const jourSemaine = (new Date(Date.UTC(a, m - 1, j)).getUTCDay() + 6) % 7; // 0 = lundi
  return decaler(today, -jourSemaine);
}

const RE_RETARD = /(?<![\p{L}])(en retard|retards?|depasse(?:e|es|s)?|echu(?:e|es|s)?|en souffrance|pas (?:ete )?fait(?:e|es|s)? a temps|aurai(?:s|t)? du (?:faire|etre fait))(?![\p{L}])/u;
const RE_AUJOURDHUI = /(?<![\p{L}])(aujourd'hui|aujourd hui|aujourdhui|ce jour|ce matin|cet apres-midi|ce soir|today)(?![\p{L}])/u;
const RE_APRES_DEMAIN = /(?<![\p{L}])apres-demain(?![\p{L}])/u;
const RE_DEMAIN = /(?<![\p{L}-])demain(?![\p{L}])/u;
const RE_SEMAINE = /(?<![\p{L}])(cette semaine(?:-ci)?|la semaine en cours)(?![\p{L}])/u;
const RE_SEMAINE_PROCHAINE = /(?<![\p{L}])(la semaine prochaine|semaine prochaine)(?![\p{L}])/u;
const RE_MOIS_PROCHAIN = /(?<![\p{L}])(le mois prochain|mois prochain)(?![\p{L}])/u;
const RE_A_VENIR = /(?<![\p{L}])(a venir|bientot|prochainement|dans les prochains jours|qui arrive(?:nt)?)(?![\p{L}])/u;

/**
 * Portée temporelle d'une demande d'actions (pure, testée). `today` : date
 * du jour ISO (fuseau de l'application, `aujourdhuiParis`). Une période
 * ambiguë (« en mars ») n'est pas résolue ici : la clarification du routage
 * (§20.1) s'en charge.
 */
export function analyserPorteeTemporelle(message: string, today: string): PorteeTemporelle {
  const t = plain(message);
  const j = today.slice(0, 10);
  let m: RegExpMatchArray | null;
  if ((m = t.match(RE_RETARD))) return { scope: 'OVERDUE', from: null, to: decaler(j, -1), label: 'en retard', expression: m[1] };
  if ((m = t.match(RE_AUJOURDHUI))) return { scope: 'TODAY', from: j, to: j, label: 'aujourd’hui', expression: m[1] };
  if ((m = t.match(RE_APRES_DEMAIN))) { const d = decaler(j, 2); return { scope: 'PERIOD', from: d, to: d, label: 'après-demain', expression: m[0] }; }
  if ((m = t.match(RE_DEMAIN))) { const d = decaler(j, 1); return { scope: 'TOMORROW', from: d, to: d, label: 'demain', expression: m[0] }; }
  if ((m = t.match(RE_SEMAINE_PROCHAINE))) {
    const debut = decaler(lundi(j), 7);
    return { scope: 'NEXT_WEEK', from: debut, to: decaler(debut, 6), label: 'la semaine prochaine', expression: m[1] };
  }
  if ((m = t.match(RE_SEMAINE))) { const debut = lundi(j); return { scope: 'THIS_WEEK', from: debut, to: decaler(debut, 6), label: 'cette semaine', expression: m[1] }; }
  if ((m = t.match(RE_MOIS_PROCHAIN))) {
    const [a, mo] = j.split('-').map(Number);
    const p = mois(mo === 12 ? a + 1 : a, mo === 12 ? 1 : mo + 1, m[1]);
    return { scope: 'NEXT_MONTH', from: p.from, to: p.to, label: 'le mois prochain', expression: m[1] };
  }
  // Périodes calendaires communes (« ce mois-ci », « mars 2026 », « 2026 »…).
  const p = analyserPeriode(message, j);
  if (p?.kind === 'resolved') {
    return p.expression === 'ce mois'
      ? { scope: 'THIS_MONTH', from: p.from, to: p.to, label: 'ce mois-ci', expression: t.match(/(?<![\p{L}])ce mois(?:-ci)?(?![\p{L}])/u)?.[0] ?? p.expression }
      : { scope: 'PERIOD', from: p.from, to: p.to, label: p.label, expression: p.expression };
  }
  if ((m = t.match(RE_A_VENIR))) return { scope: 'UPCOMING', from: j, to: decaler(j, UPCOMING_WINDOW_DAYS), label: 'à venir', expression: m[1] };
  return { scope: 'NONE', from: null, to: null, label: '', expression: null };
}

/**
 * Formateur construit une seule fois, au chargement du module : sa
 * construction (données de fuseau) coûte plusieurs dizaines de
 * millisecondes, à ne pas payer dans le délai de chaque demande (§30.2).
 */
const FORMAT_PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Date du jour ISO, fuseau Europe/Paris. */
export function aujourdhuiParis(now: Date = new Date()): string {
  return FORMAT_PARIS.format(now);
}
