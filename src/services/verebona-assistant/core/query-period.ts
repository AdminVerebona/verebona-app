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
