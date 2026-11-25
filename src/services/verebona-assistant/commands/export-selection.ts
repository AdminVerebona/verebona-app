/**
 * Carte #843 (E08, W28) — SÉLECTION FINE des documents d'un export demandé à l'Assistant (module PUR, testé).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Avant #843, une demande d'export ne savait dire que « avec / sans les photos » et « avec / sans les équipements ».
 * Désormais la phrase peut aussi choisir les DOCUMENTS :
 *
 *   · nature : « les factures », « uniquement les devis », « factures et devis », « sans les devis » ;
 *   · période : « avant le 01/01/2024 », « après le 15 mars 2023 », « depuis le … », « à partir du … », « en 2023 » —
 *     attachée à la nature qu'elle suit (« sans les devis avant le 01/01/2024 » ne retire que ces devis-là) ;
 *   · équipement : « de l'équipement Chaudière », « les factures d'équipements » (documents rattachés à un
 *     équipement du bien) ;
 *   · rubrique : « de la rubrique Assurances » (référentiel V2, libellé entier) ;
 *   · document : « uniquement le document « Facture Norauto » », « sans le document « Devis toiture » ».
 *
 * Une borne NON DÉFINIE (« anciens devis », « vieilles factures », « devis récents ») n'est jamais devinée : la
 * question est posée, rien n'est lancé. Ce module ne lit rien : il rend les FILTRES compris, puis, appliqué aux
 * documents que le MOTEUR D'EXPORT OFFICIEL lit pour ce bien (`buildExportAssetSnapshot`), la liste exacte des
 * documents INCLUS et EXCLUS (avec le motif de chaque exclusion). La génération passe ensuite par ce même moteur
 * (`customDocIds`) : aucun second exporteur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { plain } from '../core/routing-text';

export type DocNature = 'invoice' | 'quote';

export interface DateBound { before?: string; after?: string }

export interface ExportDocumentFilters {
  /** Natures demandées (inclusion) ; vide : toutes. */
  include: DocNature[];
  /** Natures retirées, éventuellement bornées (« sans les devis avant le … »). */
  exclude: Array<{ nature: DocNature; bound?: DateBound }>;
  /** Période des documents inclus (« les factures de 2023 »). */
  period?: DateBound;
  /** Documents rattachés à un équipement : nommé (mots) ou n'importe lequel (`any`). */
  equipment?: { any: true } | { words: string[] };
  /** Rubrique V2 désignée par son libellé (mots). */
  rubricWords?: string[];
  /** Documents nommés à inclure seuls / à retirer (titres entre guillemets). */
  onlyTitles?: string[];
  withoutTitles?: string[];
  /** Borne floue détectée (« anciens devis ») : clarification obligatoire. */
  vague?: string;
}

/** Document tel que le moteur d'export le lit (sous-ensemble utile à la sélection). */
export interface ExportDocumentRow {
  id: number;
  title: string;
  date: string | null;
  /** Type V2 (`WORKS_INVOICE`…), sinon code historique (`FACTURE`…). */
  typeCode: string | null;
  legacyType: string | null;
  equipmentId: number | null;
  equipmentName: string | null;
  rubricCodes: string[];
  isWebLink: boolean;
}

const NATURES: ReadonlyArray<{ nature: DocNature; re: string }> = [
  { nature: 'invoice', re: String.raw`factures?` },
  { nature: 'quote', re: String.raw`devis` },
];
const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
const DATE_RE = String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}(?:er)?\s+(?:${MOIS.join('|')})\s+\d{4}|\d{4})`;
const VAGUE = /\b(?:anciens?|anciennes?|vieux|vieilles?|vieil|recents?|recentes?|derniers?|dernieres?|nouveaux?|nouvelles?|vieillots?)\s+(?:devis|factures?|documents?)\b|\b(?:devis|factures?|documents?)\s+(?:anciens?|anciennes?|recents?|recentes?|perimes?|perimees?)\b/;

/** « 01/01/2024 », « 1er mars 2024 », « 2024 » → AAAA-MM-JJ (année seule : 1er janvier, ou 31 décembre pour une fin). */
export function parseExportDate(raw: string, fin = false): string | null {
  const t = plain(raw).trim();
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valide(Number(m[3]), Number(m[2]), Number(m[1]));
  m = t.match(new RegExp(String.raw`^(\d{1,2})(?:er)?\s+(${MOIS.join('|')})\s+(\d{4})$`));
  if (m) return valide(Number(m[3]), MOIS.indexOf(m[2]) + 1, Number(m[1]));
  m = t.match(/^(\d{4})$/);
  if (m) return fin ? `${m[1]}-12-31` : `${m[1]}-01-01`;
  return null;
}
function valide(a: number, mo: number, j: number): string | null {
  const d = new Date(Date.UTC(a, mo - 1, j));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== j) return null;
  return `${a}-${String(mo).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
}

/** Borne de période juste après une position (« avant le 01/01/2024 », « en 2023 »). */
function borneApres(t: string): { bound: DateBound; length: number } | null {
  const m = t.match(new RegExp(String.raw`^\s*(?:dates?\s+)?(avant|apres|depuis|a partir|anterieure?s?|posterieure?s?|en|de|du)\s+(?:le\s+|du\s+|au\s+|l'annee\s+)?(${DATE_RE})`));
  if (!m) return null;
  const mot = m[1];
  if ((mot === 'de' || mot === 'du') && !/^\d{4}$/.test(m[2])) return null;
  if (mot === 'avant' || mot.startsWith('anterieur')) { const d = parseExportDate(m[2]); return d ? { bound: { before: d }, length: m[0].length } : null; }
  if (mot === 'apres' || mot.startsWith('posterieur')) {
    const d = parseExportDate(m[2], true);
    return d ? { bound: { after: d }, length: m[0].length } : null;
  }
  if (mot === 'depuis' || mot === 'a partir') { const d = parseExportDate(m[2]); return d ? { bound: { after: veille(d) }, length: m[0].length } : null; }
  // « en 2023 », « de 2023 » : l'année entière.
  if (/^\d{4}$/.test(m[2])) return { bound: { after: `${Number(m[2]) - 1}-12-31`, before: `${Number(m[2]) + 1}-01-01` }, length: m[0].length };
  return null;
}
function veille(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Filtres documentaires d'une phrase d'export (texte SANS accent, en minuscules, tel que `parseExportRequest` le
 * lit) et zones reconnues (à retirer avant de chercher le bien). `null` : aucun filtre documentaire. Pur.
 */
export function parseExportDocumentFilters(texte: string, original?: string): { filters: ExportDocumentFilters; consumed: Array<[number, number]> } | null {
  // Le contenu des guillemets (titre d'un document nommé) ne vaut ni nature ni période : neutralisé, mêmes positions.
  const t = texte.replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, (q) => q[0] + '_'.repeat(Math.max(0, q.length - 2)) + (q.length > 1 ? q[q.length - 1] : ''));
  const filters: ExportDocumentFilters = { include: [], exclude: [] };
  const consumed: Array<[number, number]> = [];
  const vague = t.match(VAGUE);
  if (vague) { filters.vague = vague[0]; consumed.push([vague.index ?? 0, (vague.index ?? 0) + vague[0].length]); }

  for (const { nature, re } of NATURES) {
    // Retrait : « sans (les) devis », « sauf les devis », « hors devis », éventuellement borné.
    for (const m of t.matchAll(new RegExp(String.raw`\b(?:sans|sauf|hors|excepte|pas)\s+(?:les\s+|le\s+|la\s+|de\s+|d')*(?:${re})\b`, 'g'))) {
      const fin = (m.index ?? 0) + m[0].length;
      const b = borneApres(t.slice(fin));
      filters.exclude.push({ nature, ...(b ? { bound: b.bound } : {}) });
      consumed.push([m.index ?? 0, fin + (b?.length ?? 0)]);
    }
  }
  for (const { nature, re } of NATURES) {
    // Inclusion : la nature nommée HORS d'un retrait.
    for (const m of t.matchAll(new RegExp(String.raw`\b(?:${re})\b`, 'g'))) {
      const i = m.index ?? 0;
      if (consumed.some(([a, b]) => i >= a && i < b)) continue;
      if (!filters.include.includes(nature)) filters.include.push(nature);
      const fin = i + m[0].length;
      const b = borneApres(t.slice(fin));
      if (b && !filters.period) { filters.period = b.bound; consumed.push([fin, fin + b.length]); }
      consumed.push([i, fin]);
    }
  }
  // Période dite ailleurs dans la phrase (« … de l'équipement Chaudière en 2023 ») : celle des documents inclus.
  if (!filters.period) {
    for (const m of t.matchAll(new RegExp(String.raw`\b(?:avant|apres|depuis|a partir|en)\s+(?:le\s+|du\s+)?${DATE_RE}`, 'g'))) {
      const i = m.index ?? 0;
      if (consumed.some(([a, b]) => i >= a && i < b)) continue;
      const b = borneApres(t.slice(i));
      if (!b) continue;
      filters.period = b.bound;
      consumed.push([i, i + b.length]);
      break;
    }
  }
  // Équipement nommé, ou tous les documents d'équipements.
  const eqNomme = t.match(/\bde\s+l'equipement\s+([a-z0-9' -]+?)(?=\s+(?:de|du|des|sans|avant|apres|depuis|en|pour|avec|et)\b|[,.;]|$)/);
  if (eqNomme) {
    filters.equipment = { words: eqNomme[1].split(/[^a-z0-9]+/).filter((w) => w.length >= 2) };
    consumed.push([eqNomme.index ?? 0, (eqNomme.index ?? 0) + eqNomme[0].length]);
  } else {
    const eqTous = t.match(/\b(?:d'|des\s+)equipements?\b/);
    if (eqTous && filters.include.length) {
      filters.equipment = { any: true };
      consumed.push([eqTous.index ?? 0, (eqTous.index ?? 0) + eqTous[0].length]);
    }
  }
  const rubrique = t.match(/\bde\s+la\s+rubrique\s+([a-z0-9' -]+?)(?=\s+(?:de|du|des|sans|avant|apres|pour|avec)\b|[,.;]|$)/);
  if (rubrique) {
    filters.rubricWords = rubrique[1].split(/[^a-z0-9]+/).filter(Boolean);
    consumed.push([rubrique.index ?? 0, (rubrique.index ?? 0) + rubrique[0].length]);
  }
  // Documents nommés entre guillemets (texte d'origine : titres avec leur casse).
  const source = original ?? texte;
  for (const m of source.matchAll(/\b(uniquement|seulement|sans|sauf)\s+(?:le\s+)?document\s+[«"“]\s*([^»"”]+?)\s*[»"”]/gi)) {
    const titre = m[2].trim();
    if (/^(?:uniquement|seulement)$/i.test(m[1])) (filters.onlyTitles ??= []).push(titre);
    else (filters.withoutTitles ??= []).push(titre);
  }
  if (filters.onlyTitles?.length || filters.withoutTitles?.length) {
    for (const m of t.matchAll(/\b(?:uniquement|seulement|sans|sauf)\s+(?:le\s+)?document\s+[«"“][^»"”]*[»"”]/g)) consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const rien = !filters.vague && filters.include.length === 0 && filters.exclude.length === 0 && !filters.period && !filters.equipment
    && !filters.rubricWords && !filters.onlyTitles && !filters.withoutTitles;
  return rien ? null : { filters, consumed };
}

/** Nature d'un document, par son Type V2 (ou son code historique). Pure. */
export function natureOf(d: Pick<ExportDocumentRow, 'typeCode' | 'legacyType'>): DocNature | null {
  for (const c of [d.typeCode, d.legacyType]) {
    const x = (c ?? '').toUpperCase();
    if (!x) continue;
    if (x.endsWith('_INVOICE') || x === 'FACTURE' || x.startsWith('FACTURE_')) return 'invoice';
    if (x.endsWith('_QUOTE') || x === 'DEVIS' || x.startsWith('DEVIS_')) return 'quote';
  }
  return null;
}

const NATURE_LABEL: Record<DocNature, { un: string; les: string }> = {
  invoice: { un: 'facture', les: 'factures' }, quote: { un: 'devis', les: 'devis' },
};
const dansBorne = (date: string | null, b: DateBound | undefined): boolean => {
  if (!b) return true;
  if (!date) return false;
  return (b.before === undefined || date < b.before) && (b.after === undefined || date > b.after);
};
const fr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
export function boundLabel(b: DateBound): string {
  if (b.before && b.after) return `entre le ${fr(b.after)} et le ${fr(b.before)} (exclus)`;
  if (b.before) return `avant le ${fr(b.before)}`;
  return `après le ${fr(b.after!)}`;
}

export interface ExportSelection {
  included: ExportDocumentRow[];
  excluded: Array<{ doc: ExportDocumentRow; reason: string }>;
}

/**
 * Applique les filtres aux documents du bien (ceux que le moteur d'export lit). Chaque document est INCLUS ou
 * EXCLU avec son motif — jamais écarté en silence. `rubricMatches` : la rubrique d'un document répond-elle aux mots
 * demandés (résolue par l'appelant dans le référentiel V2). Pure.
 */
export function selectExportDocuments(
  docs: readonly ExportDocumentRow[], f: ExportDocumentFilters,
  opts: { equipmentMatches?: (d: ExportDocumentRow) => boolean; rubricMatches?: (d: ExportDocumentRow) => boolean } = {},
): ExportSelection {
  const included: ExportDocumentRow[] = [];
  const excluded: ExportSelection['excluded'] = [];
  const memeTitre = (a: string, b: string) => plain(a).replace(/\s+/g, ' ').trim() === plain(b).replace(/\s+/g, ' ').trim();
  for (const d of docs) {
    const n = natureOf(d);
    const ecarte = (reason: string) => excluded.push({ doc: d, reason });
    if (f.onlyTitles?.length && !f.onlyTitles.some((t) => memeTitre(t, d.title))) { ecarte('non demandé (seuls les documents nommés)'); continue; }
    if (f.withoutTitles?.some((t) => memeTitre(t, d.title))) { ecarte('retiré à votre demande'); continue; }
    const retrait = f.exclude.find((x) => x.nature === n && dansBorne(d.date, x.bound));
    if (retrait) { ecarte(`${NATURE_LABEL[retrait.nature].un}${retrait.bound ? ` ${boundLabel(retrait.bound)}` : ''} : retiré à votre demande`); continue; }
    if (f.include.length && (!n || !f.include.includes(n))) {
      ecarte(`non demandé (seuls ${f.include.length === 1 && f.include[0] === 'quote' ? 'les devis sont demandés' : `les ${f.include.map((x) => NATURE_LABEL[x].les).join(' et les ')} sont demandés`})`);
      continue;
    }
    if (f.period && !dansBorne(d.date, f.period)) { ecarte(d.date ? `hors période (${boundLabel(f.period)})` : 'sans date : hors période demandée'); continue; }
    if (f.equipment && !(opts.equipmentMatches ? opts.equipmentMatches(d) : d.equipmentId !== null)) { ecarte('non rattaché à l’équipement demandé'); continue; }
    if (f.rubricWords && !(opts.rubricMatches?.(d) ?? false)) { ecarte('hors de la rubrique demandée'); continue; }
    included.push(d);
  }
  return { included, excluded };
}

/** Question posée pour une borne floue (« anciens devis ») — texte à valider par le PO. */
export function vagueBoundQuestion(expression: string): string {
  return `Que voulez-vous dire par « ${expression} » ? Donnez une date précise, par exemple « sans les devis avant le 01/01/2024 ». Rien n’a été lancé.`;
}

/** Liste bornée de documents, pour une réponse : « Titre » (date) — au plus `max`, puis « et N autres ». Pure. */
export function documentList(rows: ReadonlyArray<{ doc: ExportDocumentRow; reason?: string }>, max = 10): string {
  const montres = rows.slice(0, max).map(({ doc, reason }) => `« ${doc.title} »${doc.date ? ` (${fr(doc.date)})` : ''}${reason ? ` — ${reason}` : ''}`);
  const reste = rows.length - montres.length;
  return `${montres.join(' ; ')}${reste > 0 ? ` ; et ${reste} autre${reste > 1 ? 's' : ''}` : ''}`;
}
