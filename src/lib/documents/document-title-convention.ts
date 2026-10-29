/**
 * Convention UNIQUE des titres automatiques de documents — règles pures,
 * partagées client / serveur (lot 87D, ticket P1 « Documents — Uniformiser les
 * titres des factures périodiques et fiabiliser leur affichage »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE LE CODE DÉCIDE — ET CE QU'IL NE DÉCIDE PAS
 *
 * Le code COMPOSE le titre (typographie, ordre, séparateurs, désambiguïsation)
 * à partir des données métier persistées ; il n'INTERPRÈTE pas la période :
 *
 *   · facture périodique (nature récurrente + fournisseur + période facturée
 *     ou mois principal) : « {Nature} {Fournisseur} — {Période} » ;
 *   · {Période} = REPRÉSENTATION TEMPORELLE décidée par la branche T3
 *     DOCUMENT_NAMING (lot 99C, `document-title-period.ts` : mois, plage de
 *     dates, plusieurs mois ou rien), validée par le serveur ; à défaut, le
 *     mois EXPLICITEMENT désigné par le document (preuve T1), sinon la
 *     période facturée PRÉSENTÉE EXACTEMENT (`presentBilledPeriod`) — jamais
 *     déduite du premier jour, jamais « les deux mois » par principe, aucune
 *     règle « du 5 au 4 », aucune règle « mois majoritaire », aucun mois
 *     inventé ;
 *   · deux factures distinctes du même fournisseur, de même période :
 *     désambiguïsation DÉTERMINISTE et symétrique (`disambiguatorFor`) par le
 *     numéro de facture, sinon la date d'émission — jamais « (2) », jamais de
 *     fusion de documents.
 *
 * Aucune dépendance serveur (importable par les composants).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { normalizeTitle } from './document-title-rules';

/** Séparateur unique des éléments d'un titre automatique (« Facture Homiris — Février 2026 »). */
export const TITLE_SEPARATOR = ' — ';

/** Ancien séparateur du moteur v2 (« Facture fibre Orange _ Septembre 2026 ») — reconnu pour la reprise du stock. */
const LEGACY_TITLE_SEPARATOR = ' _ ';

/** Natures dont un document se répète par période (convention périodique). */
export const PERIODIC_NATURES: ReadonlySet<string> = new Set(['Facture', 'Avis d’échéance', 'Quittance', 'Relevé', 'Échéancier']);

/** Version de la convention (journal, empreinte du contexte). */
export const TITLE_CONVENTION_PERIODIC = 'PERIODIC' as const;
export type TitleConvention = typeof TITLE_CONVENTION_PERIODIC;

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const cap = (s: string) => (s ? s.charAt(0).toLocaleUpperCase('fr-FR') + s.slice(1) : s);

interface Ymd { y: number; m: number; d: number }
function ymd(iso: string | null | undefined): Ymd | null {
  const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!r) return null;
  const [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? { y, m, d } : null;
}
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** « Février 2026 » d'un mois `AAAA-MM` (null si illisible). */
export function formatTitleMonth(ym: string | null | undefined): string | null {
  const r = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(ym ?? '').slice(0, 7));
  return r ? `${cap(MOIS[Number(r[2]) - 1])} ${r[1]}` : null;
}

/** « 6 février 2026 », « 1er mars 2026 » d'une date ISO (null si illisible). */
export function formatTitleDate(iso: string | null | undefined): string | null {
  const t = ymd(iso);
  return t ? `${t.d === 1 ? '1er' : t.d} ${MOIS[t.m - 1]} ${t.y}` : null;
}

type BilledPeriodPresentation = 'MONTH' | 'MONTH_RANGE' | 'EXACT_RANGE';

/**
 * Période facturée PRÉSENTÉE EXACTEMENT (pure) — règle de présentation, sans
 * interprétation :
 *   · contenue dans un seul mois civil → « Février 2026 » ;
 *   · mois civils complets (du 1er au dernier jour) → « Février à mars 2026 »,
 *     « Septembre 2025 à août 2026 » ;
 *   · sinon, au jour près → « 5 février au 4 mars 2026 »,
 *     « 15 décembre 2025 au 14 janvier 2026 ».
 * Borne manquante, illisible ou inversée → null (aucune période affichée).
 */
export function presentBilledPeriod(start: string | null | undefined, end: string | null | undefined): { label: string; kind: BilledPeriodPresentation } | null {
  const a = ymd(start);
  const b = ymd(end);
  if (!a || !b) return null;
  if (a.y * 10000 + a.m * 100 + a.d > b.y * 10000 + b.m * 100 + b.d) return null;
  if (a.y === b.y && a.m === b.m) return { label: `${cap(MOIS[a.m - 1])} ${a.y}`, kind: 'MONTH' };
  if (a.d === 1 && b.d === lastDay(b.y, b.m)) {
    return {
      label: a.y === b.y ? `${cap(MOIS[a.m - 1])} à ${MOIS[b.m - 1]} ${b.y}` : `${cap(MOIS[a.m - 1])} ${a.y} à ${MOIS[b.m - 1]} ${b.y}`,
      kind: 'MONTH_RANGE',
    };
  }
  const debut = `${a.d === 1 ? '1er' : a.d} ${MOIS[a.m - 1]}${a.y === b.y ? '' : ` ${a.y}`}`;
  return { label: `${debut} au ${b.d === 1 ? '1er' : b.d} ${MOIS[b.m - 1]} ${b.y}`, kind: 'EXACT_RANGE' };
}

/** Mois principal décidé par l'IA, avec sa provenance. */
export interface PrincipalMonth {
  /** `AAAA-MM`. */
  value: string;
  /** Fondement déclaré par l'IA (`STATED_ON_DOCUMENT`, `MAJORITY_OF_PERIOD`…), conservé tel quel. */
  basis: string | null;
  source: 'T1_BILLING_PERIOD';
  /** Citation (bornée) du document. */
  quote: string | null;
}

/**
 * Mois de rattachement principal lu dans le résultat PERSISTÉ d'une analyse T1
 * (`document.billingPeriod.principalMonth`, contrat T1 `t1-billing-period-v1`
 * depuis le lot 97A, demande 87D-mois-principal-factures ; conservé seulement
 * si le prompt T1 effectif porte le contrat — `billing-period/contract.ts`). Seule une décision `certain` est
 * retenue ; absente, illisible ou moins sûre → null. Jamais calculé ici.
 */
export function principalMonthFromAnalysis(raw: unknown): PrincipalMonth | null {
  const doc = (raw && typeof raw === 'object' ? (raw as { document?: unknown }).document : null) as Record<string, unknown> | null;
  const bp = doc && typeof doc === 'object' ? doc.billingPeriod as Record<string, unknown> | undefined : undefined;
  if (!bp || typeof bp !== 'object') return null;
  const value = typeof bp.principalMonth === 'string' ? bp.principalMonth.trim() : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || bp.confidence !== 'certain') return null;
  const ev = bp.evidence && typeof bp.evidence === 'object' ? bp.evidence as Record<string, unknown> : null;
  return {
    value,
    basis: typeof bp.principalMonthBasis === 'string' ? bp.principalMonthBasis.slice(0, 40) : null,
    source: 'T1_BILLING_PERIOD',
    quote: typeof ev?.quote === 'string' ? ev.quote.slice(0, 200) : null,
  };
}

/**
 * Lot 99C — période facturée lue dans le résultat PERSISTÉ d'une analyse T1
 * (`document.billingPeriod.start / end`, contrat `t1-billing-period-v1`) :
 * deux bornes lisibles, ordonnées, confiance autre que « conflictual ». Une
 * DONNÉE documentaire — jamais une décision de nommage. Pure.
 */
export function billedPeriodFromAnalysis(raw: unknown): { start: string; end: string; quote: string | null } | null {
  const doc = (raw && typeof raw === 'object' ? (raw as { document?: unknown }).document : null) as Record<string, unknown> | null;
  const bp = doc && typeof doc === 'object' ? doc.billingPeriod as Record<string, unknown> | undefined : undefined;
  if (!bp || typeof bp !== 'object' || bp.confidence === 'conflictual') return null;
  const start = typeof bp.start === 'string' ? bp.start.slice(0, 10) : '';
  const end = typeof bp.end === 'string' ? bp.end.slice(0, 10) : '';
  if (!presentBilledPeriod(start, end)) return null;
  const ev = bp.evidence && typeof bp.evidence === 'object' ? bp.evidence as Record<string, unknown> : null;
  return { start, end, quote: typeof ev?.quote === 'string' ? ev.quote.slice(0, 200) : null };
}

/**
 * Casse du fournisseur : un nom entièrement en capitales de cinq lettres ou
 * plus prend une capitale initiale (« HOMIRIS » → « Homiris ») ; les sigles
 * courts restent tels quels (« EDF », « SFR »).
 */
export function presentSupplier(name: string): string {
  const s = name.trim().replace(/\s+/g, ' ');
  if (s !== s.toLocaleUpperCase('fr-FR')) return s;
  return s.split(' ').map((w) => (/^\p{Lu}{5,}$/u.test(w) ? w.charAt(0) + w.slice(1).toLocaleLowerCase('fr-FR') : w)).join(' ');
}

/** Clé canonique (pure) d'un titre périodique : même nature, même fournisseur, même période. */
export function canonicalTitleKey(nature: string, supplier: string, period: string): string {
  return [nature, supplier, period].map(normalizeTitle).join('|');
}

/** Document d'un même groupe canonique (désambiguïsation). */
export interface DisambiguationMember {
  id: number;
  invoiceReferences: readonly string[];
  issueDate: string | null;
}

const refKey = (r: string) => r.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Première référence de facture (ordre stable) d'un membre. */
function referenceOf(m: DisambiguationMember): string | null {
  const refs = [...m.invoiceReferences].map((r) => r.trim()).filter((r) => refKey(r).length > 0).sort((x, y) => refKey(x).localeCompare(refKey(y)));
  return refs[0] ?? null;
}

/**
 * Discriminant DÉTERMINISTE et SYMÉTRIQUE d'un document dans son groupe
 * canonique (pure) — ne dépend que de l'ensemble des documents, jamais de
 * l'ordre de traitement :
 *   · seul dans son groupe → null ;
 *   · numéro de facture unique dans le groupe → « n° 94741361 » ;
 *   · sinon date d'émission unique dans le groupe → « émise le 6 février 2026 » ;
 *   · sinon numéro de facture (même s'il n'est pas unique) ; sinon null —
 *     deux documents distincts restent deux documents (aucune fusion).
 */
export function disambiguatorFor(self: DisambiguationMember, siblings: readonly DisambiguationMember[]): string | null {
  const autres = siblings.filter((s) => s.id !== self.id);
  if (autres.length === 0) return null;
  const ref = referenceOf(self);
  if (ref && !autres.some((s) => { const r = referenceOf(s); return r !== null && refKey(r) === refKey(ref); })) return `n° ${ref}`;
  const date = formatTitleDate(self.issueDate);
  if (date && !autres.some((s) => (s.issueDate ?? '').slice(0, 10) === (self.issueDate ?? '').slice(0, 10))) return `émise le ${date}`;
  return ref ? `n° ${ref}` : null;
}

/**
 * Titre périodique composé (pure) : « Facture Homiris — Février 2026 (n° 94741361) ».
 * Lot 99C : `period` null — représentation « NONE » décidée par T3 — « Facture Homiris (n° 94741361) ».
 */
export function composePeriodicTitle(p: { nature: string; supplier: string; period: string | null; disambiguator?: string | null }): string {
  const base = p.period ? `${p.nature} ${presentSupplier(p.supplier)}${TITLE_SEPARATOR}${p.period}` : `${p.nature} ${presentSupplier(p.supplier)}`;
  return p.disambiguator ? `${base} (${p.disambiguator})` : base;
}

/** Le titre porte-t-il l'ancienne typographie du moteur v2 (« … _ Septembre 2026 ») ? */
export function hasLegacyTitleTypography(title: string | null | undefined): boolean {
  return String(title ?? '').includes(LEGACY_TITLE_SEPARATOR);
}
