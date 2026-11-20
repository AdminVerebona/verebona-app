/**
 * Carte #807 (E01 – E04) — lecture d'une LISTE « libellé valeur, libellé valeur » (pure, testée).
 *
 *   « marque Viessmann, modèle Vitodens 200 et numéro de série AB-123 »
 *   « adresse : 12 rue de la Paix ; code postal 75002 ; ville Paris »
 *
 * Un libellé n'est reconnu qu'en DÉBUT de liste ou après un séparateur (virgule, point-virgule, « et ») : un mot
 * de libellé au milieu d'une valeur (« marque Type R ») reste dans la valeur. Une valeur entre guillemets est
 * prise telle quelle. La liste doit COMMENCER par un libellé : sinon ce n'est pas une liste (`null`) et la phrase
 * suit son parcours habituel. Les valeurs sont reprises du texte d'origine (accents, casse).
 */
import { plain } from '../core/routing-text';

/** `re` : source d'expression régulière sur le texte SANS accent, en minuscules — sans groupe capturant. */
export interface LabelDef<K extends string> { key: K; re: string }
/** `raw: null` : valeur absente ou « aucune » / « vide » — un effacement demandé. */
export interface LabelledValue<K extends string> { key: K; raw: string | null }

const VIDE = /^(?:aucune?|vide|rien|neant|non renseignee?)$/;

export function parseLabelledValues<K extends string>(texte: string, defs: ReadonlyArray<LabelDef<K>>): Array<LabelledValue<K>> | null {
  const nfc = texte.normalize('NFC');
  // Le contenu des guillemets est neutralisé pour la recherche des libellés (mêmes positions).
  const brut = plain(nfc).replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, (q) => q[0] + '_'.repeat(Math.max(0, q.length - 2)) + (q.length > 1 ? q[q.length - 1] : ''));
  const alt = defs.map((d) => `(${d.re})`).join('|');
  const re = new RegExp(String.raw`(?:^\s*|\s*[,;]\s*|\s+et\s+)(?:(?:le|la|les|son|sa|ses|un|une)\s+|l')?(?:${alt})(?![a-z0-9])\s*(?:[:=]\s*|(?:est|a|vaut)\s+)?`, 'g');
  const hits: Array<{ key: K; start: number; valueStart: number }> = [];
  for (const m of brut.matchAll(re)) {
    const i = m.slice(1).findIndex((g) => g !== undefined);
    if (i < 0 || m.index === undefined) continue;
    hits.push({ key: defs[i].key, start: m.index, valueStart: m.index + m[0].length });
  }
  if (hits.length === 0 || brut.slice(0, hits[0].start).trim() !== '') return null;
  return hits.map((h, n) => {
    const fin = n + 1 < hits.length ? hits[n + 1].start : nfc.length;
    const valeur = nfc.slice(h.valueStart, fin).trim().replace(/^[«"“]\s*|\s*[»"”]$/g, '').replace(/[\s.!?;,]+$/, '').replace(/\s*[»"”]$/, '').trim();
    return { key: h.key, raw: valeur === '' || VIDE.test(plain(valeur)) ? null : valeur };
  });
}

/** Libellé UNIQUE reconnu sur tout le texte (« numéro de série » → `serialNumber`), ou `null`. */
export function labelKey<K extends string>(texte: string, defs: ReadonlyArray<LabelDef<K>>): K | null {
  const t = plain(texte).trim().replace(/^(?:(?:le|la|les|son|sa)\s+|l')/, '');
  return defs.find((d) => new RegExp(`^(?:${d.re})$`).test(t))?.key ?? null;
}

/** « 2 500,50 € », « 2500 euros », « 1 800€ » → centimes entiers ; `null` : montant non compris ou négatif. */
export function parseAmountCents(raw: string): number | null {
  const t = plain(raw).replace(/\s| | /g, '').replace(/(?:€|euros?|eur)$/, '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t.replace(',', '.')) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 2_147_483_647 ? cents : null;
}

/** « 14h30 », « 14:30 », « 9 h », « 9h » → « HH:MM » ; `null` : heure non comprise. */
export function parseTimeFr(raw: string): string | null {
  const m = plain(raw).trim().match(/^(\d{1,2})\s*(?:h|:|heures?)\s*(\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
