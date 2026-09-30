/**
 * Support vérifiable de chaque affirmation — CDC 15 T2-31.
 *
 * « La présence d'un sourceId valide ne garantit pas que la source justifie
 *   la phrase. » Un `sourceId` appartenant aux sources fournies ne suffit
 * plus : le serveur vérifie que ce que la phrase AFFIRME figure dans ce que
 * la source PORTE.
 *
 *   · support déclaré par le modèle (facultatif) :
 *       - `field`      : source `asset_field:<id>:<clé>` (X, T2-32) citée, et
 *                        valeur égale à sa valeur / son affichage ;
 *       - `excerpt`    : extrait littéral présent dans le contenu de la source ;
 *       - `table_cell` : source citée, valeur présente dans son contenu ;
 *       - `value`      : valeur structurée présente dans la source ;
 *   · sans support déclaré : chaque DONNÉE de la phrase (date, nombre,
 *     montant, immatriculation ou numéro) doit figurer dans au moins une des
 *     sources citées. Une phrase sans donnée (qualitative) est soutenue par
 *     ses seules sources — il n'y a rien de plus à comparer.
 *
 * Une affirmation non soutenue est REJETÉE (T2-31 : « rejeter les claims sans
 * support compatible ») et le rejet est tracé par l'appelant.
 */
import type { RetrievedSource } from '@/services/verebona-assistant/types/sources';
import type { T2ClaimSupport } from './master/t2-contract';
import { parseAssetFieldSourceId } from '@/services/verebona-assistant/canonical/source-ids';

const MOIS: Record<string, string> = {
  janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07',
  aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12',
};
const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const pad = (n: string) => n.padStart(2, '0');

export interface DataTokens {
  /** Dates canoniques `AAAA-MM-JJ` (et `MM-JJ` sans année). */
  dates: Set<string>;
  /** Nombres canoniques (séparateurs retirés, virgule → point, zéros inutiles ôtés). */
  numbers: Set<string>;
  /** Codes alphanumériques (immatriculation, n° de contrat) en majuscules sans séparateur. */
  codes: Set<string>;
}

function canonNumber(raw: string): string | null {
  const s = raw.replace(/[\s  ]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

/** Données d'un texte : dates, nombres et codes, normalisés pour comparaison. */
export function extractDataTokens(text: string): DataTokens {
  const out: DataTokens = { dates: new Set(), numbers: new Set(), codes: new Set() };
  let t = sansAccents(String(text ?? '')).toLowerCase();

  // Dates ISO, JJ/MM/AAAA, « 25 mai 2021 », « 25 mai ».
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y, mo, d) => { out.dates.add(`${y}-${mo}-${d}`); out.dates.add(`${mo}-${d}`); out.numbers.add(String(Number(y))); return ' '; });
  t = t.replace(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, (_m, d, mo, y) => { out.dates.add(`${y}-${pad(mo)}-${pad(d)}`); out.dates.add(`${pad(mo)}-${pad(d)}`); out.numbers.add(String(Number(y))); return ' '; });
  const moisRe = Object.keys(MOIS).join('|');
  t = t.replace(new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${moisRe})(?:\\s+(\\d{4}))?\\b`, 'g'), (_m, d, mo, y) => {
    if (y) { out.dates.add(`${y}-${MOIS[mo]}-${pad(d)}`); out.numbers.add(String(Number(y))); }
    out.dates.add(`${MOIS[mo]}-${pad(d)}`);
    return ' ';
  });

  // Codes : lettres ET chiffres mêlés, avec ou sans tirets (AB-123-CD, H-4417).
  const brut = sansAccents(String(text ?? '')).toUpperCase();
  for (const m of brut.matchAll(/\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)) {
    const code = m[0].replace(/-/g, '');
    if (code.length >= 4) out.codes.add(code);
  }
  t = t.replace(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)*\b/g, ' ');

  // Nombres (montants, kilométrages…) : « 48 250 », « 1 234,56 », « 480 ».
  for (const m of t.matchAll(/\d{1,3}(?:[\s  .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)) {
    const n = canonNumber(m[0]);
    if (n !== null) out.numbers.add(n);
  }
  return out;
}

function union(a: DataTokens, b: DataTokens): DataTokens {
  return {
    dates: new Set([...a.dates, ...b.dates]),
    numbers: new Set([...a.numbers, ...b.numbers]),
    codes: new Set([...a.codes, ...b.codes]),
  };
}

/**
 * Métadonnées qui peuvent servir de PREUVE (liste blanche). Tout le reste —
 * identifiants (`id`, `fileId`, `assetId`, `documentId`, `supplierId`…),
 * empreintes, tailles, références techniques — est ignoré : « 55 € » ne
 * doit jamais être « soutenu » par `fileId: 55`.
 *
 *   · valeurs : value, display, unit, label, date, from, to, startDate,
 *     endDate, dueDate, year, status, statusLabel, nature, theme, supplier,
 *     documentType, assetName ;
 *   · comptes et totaux calculés PAR LE SERVEUR : count, events,
 *     documentCount, interventionCount, unqualifiedCount, excludedCount,
 *     total, totalEur, amount, amountEur (dépenses qualifiées, chronologie,
 *     échéances à venir, fournisseurs) ;
 *   · montants en centimes (`totalCents`, `amountCents`) : convertis en
 *     euros avant comparaison, jamais comparés bruts.
 */
export const PROOF_META_KEYS: readonly string[] = [
  'value', 'display', 'unit', 'label', 'date', 'from', 'to', 'startDate', 'endDate', 'dueDate', 'year',
  'status', 'statusLabel', 'nature', 'theme', 'supplier', 'documentType', 'assetName',
  'count', 'events', 'documentCount', 'interventionCount', 'unqualifiedCount', 'excludedCount',
  'total', 'totalEur', 'amount', 'amountEur',
];
export const PROOF_CENTS_KEYS: readonly string[] = ['totalCents', 'amountCents'];

/** Valeurs de métadonnées admises comme preuve (centimes convertis en euros). */
export function proofMetaValues(s: Pick<RetrievedSource, 'meta'>): string[] {
  const meta = s.meta ?? {};
  const out: string[] = [];
  for (const k of PROOF_META_KEYS) {
    const v = meta[k];
    if (v !== null && v !== undefined && typeof v !== 'boolean') out.push(String(v));
  }
  for (const k of PROOF_CENTS_KEYS) {
    const v = meta[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n)) out.push(String(n / 100));
  }
  return out;
}

/**
 * Tout ce qu'une source PORTE : titre, contenu, métadonnées de preuve.
 * Valeurs séparées par « ; » : « 2 » puis « 450 » ne doivent pas se lire
 * « 2 450 » (séparateur de milliers).
 */
export function sourceTokens(s: RetrievedSource): DataTokens {
  return extractDataTokens(`${s.title ?? ''} ${s.content ?? ''} ${proofMetaValues(s).join(' ; ')}`);
}

const norm = (s: string) => sansAccents(s).toLowerCase().replace(/[«»"“”'’]/g, '').replace(/\s+/g, ' ').trim();

function sourceText(s: RetrievedSource): string {
  return norm(`${s.title ?? ''} ${s.content ?? ''} ${proofMetaValues(s).join(' ; ')}`);
}

/** Une valeur figure-t-elle dans la source (texte ou données normalisées) ? */
function valuePresent(value: string, s: RetrievedSource): boolean {
  if (!value.trim()) return false;
  if (sourceText(s).includes(norm(value))) return true;
  const v = extractDataTokens(value);
  const st = sourceTokens(s);
  const total = v.dates.size + v.numbers.size + v.codes.size;
  return total > 0
    && [...v.dates].every((x) => st.dates.has(x))
    && [...v.numbers].every((x) => st.numbers.has(x))
    && [...v.codes].every((x) => st.codes.has(x));
}

export type ClaimSupportReason =
  | 'SUPPORTED_BY_DECLARED_SUPPORT' | 'SUPPORTED_BY_DATA' | 'SUPPORTED_QUALITATIVE'
  | 'NO_SOURCE' | 'SUPPORT_SOURCE_NOT_CITED' | 'SUPPORT_NOT_IN_SOURCE' | 'DATA_NOT_IN_SOURCES';

export interface ClaimSupportResult {
  supported: boolean;
  reason: ClaimSupportReason;
  /** Données de la phrase absentes des sources citées (trace, sans contenu sensible). */
  missing?: string[];
}

/**
 * Vérifie qu'une affirmation est soutenue par les sources QU'ELLE CITE, parmi
 * celles fournies. Pure.
 */
export function verifyClaimSupport(
  claim: { text: string; sourceIds: string[]; support?: T2ClaimSupport },
  sources: readonly RetrievedSource[],
): ClaimSupportResult {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const citees = claim.sourceIds.map((id) => byId.get(id)).filter((s): s is RetrievedSource => Boolean(s));
  if (citees.length === 0) return { supported: false, reason: 'NO_SOURCE' };

  if (claim.support) {
    const sup = claim.support;
    if (!claim.sourceIds.includes(sup.sourceId)) return { supported: false, reason: 'SUPPORT_SOURCE_NOT_CITED' };
    const src = byId.get(sup.sourceId);
    if (!src) return { supported: false, reason: 'SUPPORT_SOURCE_NOT_CITED' };
    let ok: boolean;
    if (sup.kind === 'field') {
      const meta = src.meta ?? {};
      const valeurs = [meta.value, meta.display].filter((v): v is string | number | boolean => v !== null && v !== undefined).map(String);
      // Support « field » : seulement une source de champ canonique bien formée
      // (`asset_field:<assetId>:<clé>`, X) — jamais un autre identifiant.
      ok = parseAssetFieldSourceId(sup.sourceId) !== null && src.type === 'asset_field' && (valeurs.some((v) => norm(v) === norm(sup.value) || valuePresent(sup.value, { ...src, content: v, title: '', meta: {} })));
    } else if (sup.kind === 'excerpt') {
      ok = norm(sup.text).length >= 4 && sourceText(src).includes(norm(sup.text));
    } else {
      ok = valuePresent(sup.value, src);
    }
    if (!ok) return { supported: false, reason: 'SUPPORT_NOT_IN_SOURCE' };
  }

  const phrase = extractDataTokens(claim.text);
  const dispo = citees.map(sourceTokens).reduce(union);
  const missing = [
    ...[...phrase.dates].filter((d) => !dispo.dates.has(d)),
    ...[...phrase.numbers].filter((n) => !dispo.numbers.has(n)),
    ...[...phrase.codes].filter((c) => !dispo.codes.has(c)),
  ];
  // Une date « JJ mois » sans année est soutenue par la date complète.
  const reste = missing.filter((m) => !(/^\d{2}-\d{2}$/.test(m) && dispo.dates.has(m)));
  if (reste.length > 0) return { supported: false, reason: 'DATA_NOT_IN_SOURCES', missing: reste.slice(0, 5) };
  const aDesDonnees = phrase.dates.size + phrase.numbers.size + phrase.codes.size > 0;
  if (claim.support) return { supported: true, reason: 'SUPPORTED_BY_DECLARED_SUPPORT' };
  return { supported: true, reason: aDesDonnees ? 'SUPPORTED_BY_DATA' : 'SUPPORTED_QUALITATIVE' };
}
