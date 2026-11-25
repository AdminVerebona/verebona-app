/**
 * Carte #838 (B1, AC08/AC13) — MOTIF CODIFIÉ de l'absence de valeur littérale
 * (`rawValue`) d'un fait T1, validé APRÈS lecture et AVANT persistance.
 *
 * Le contrat T1 v7 garde `rawValue` FACULTATIF (aucune évolution du contrat,
 * aucun changement d'empreinte ni du prompt actif) : la règle est appliquée
 * côté Verebona, sur le fait prêt à écrire.
 *
 *   1. la source fournit un littéral et le modèle l'a rendu → `rawValue`
 *      conservé EXACTEMENT (aucun motif) ;
 *   2. sinon, un motif EXPLICITE et VÉRIFIABLE est persisté avec le fait
 *      (`document_facts.raw_value_absence`), chacun avec sa précondition
 *      contrôlée sur la preuve du même fait :
 *
 *   · `VISUAL_ONLY`           observation visuelle (`VISUAL_ANALYSIS` avec
 *                             description) : aucun littéral textualisable ;
 *   · `ILLEGIBLE`             observation visuelle signalée ILLISIBLE par
 *                             l'amont (jamais déduite ici) : exige
 *                             `VISUAL_ANALYSIS` et l'absence d'extrait ;
 *   · `SOURCE_UNIT_REFERENCE` littéral non recopié (valeur longue…) mais
 *                             référencé de façon PÉRENNE par les unités source
 *                             du fait (`source_unit_ids`) : exige au moins une
 *                             unité et un extrait ;
 *   · `LITERAL_IN_EXCERPT`    littéral présent dans la citation littérale
 *                             (`excerpt`) persistée avec le fait, sans unité
 *                             source : exige un extrait non vide ;
 *   · `DERIVED_BY_RULE`       valeur produite par une règle déterministe de
 *                             projection : exige `projection_origin` =
 *                             `DETERMINISTIC_RULE` ;
 *   · `NO_LITERAL`            valeur sans littéral par nature (booléen de
 *                             présence) : exige `value_type` = `boolean` ;
 *   · `UNJUSTIFIED`           AUCUN motif vérifiable : le fait est conservé
 *                             (aucune perte d'information) mais SIGNALÉ —
 *                             jamais un `null` silencieux.
 *
 * Aucune valeur n'est inventée : un motif dit POURQUOI il n'y a pas de
 * littéral, il ne remplace jamais la valeur. Les faits écrits avant cette
 * carte gardent `raw_value_absence` NULL et sont lus `LEGACY_UNSPECIFIED`
 * (motif non renseigné) — aucune migration ne leur attribue de motif.
 *
 * Carte #863 (P1-B1) — PRÉCONDITIONS RENFORCÉES (aucun motif de convenance) :
 *   · `LITERAL_IN_EXCERPT` exige une CORRESPONDANCE VÉRIFIABLE entre la
 *     citation et la valeur du fait (« Total TTC » ne prouve pas
 *     « 1 234,50 € ») ;
 *   · `SOURCE_UNIT_REFERENCE` exige une unité réellement PERSISTÉE dont le
 *     texte contient la valeur (et la citation, si elle existe) ;
 *   · `NO_LITERAL` ne découle plus du seul type booléen : un « Oui » écrit est
 *     un littéral ;
 *   · `VISUAL_ONLY` ne découle plus d'une seule description : une description
 *     qui rapporte un texte lisible (étiquette, mention citée) n'en relève pas ;
 *   · `ILLEGIBLE` exige la preuve d'une zone illisible (description qui le dit
 *     ET zone localisée) — le contrat v7 ne le porte pas, rien n'est inventé ;
 *   · `DERIVED_BY_RULE` exige une origine déterministe ÉTABLIE (règle nommée).
 * Littéral absent du champ mais RÉCUPÉRABLE sans ambiguïté depuis la preuve
 * (une seule occurrence de la valeur dans la citation, ou dans le texte de
 * l'unité source) : il est conservé EXACTEMENT (`RECOVERED`), jamais
 * normalisé à la place. Sinon : `UNJUSTIFIED` explicite.
 */

export const RAW_VALUE_ABSENCE_CODES = [
  'VISUAL_ONLY', 'ILLEGIBLE', 'SOURCE_UNIT_REFERENCE', 'LITERAL_IN_EXCERPT', 'DERIVED_BY_RULE', 'NO_LITERAL', 'UNJUSTIFIED',
] as const;
export type RawValueAbsenceCode = (typeof RAW_VALUE_ABSENCE_CODES)[number];

/** Lecture d'un fait antérieur à la carte #838 (colonne NULL et `raw_value` absent) : motif non renseigné. */
export const LEGACY_RAW_VALUE_ABSENCE = 'LEGACY_UNSPECIFIED' as const;

export const RAW_VALUE_ABSENCE_LABELS: Record<RawValueAbsenceCode | typeof LEGACY_RAW_VALUE_ABSENCE, string> = {
  VISUAL_ONLY: 'Observation visuelle : aucun texte littéral à recopier',
  ILLEGIBLE: 'Zone illisible : valeur observée, littéral non transcriptible',
  SOURCE_UNIT_REFERENCE: 'Littéral conservé par référence aux unités de la source',
  LITERAL_IN_EXCERPT: 'Littéral présent dans la citation conservée',
  DERIVED_BY_RULE: 'Valeur produite par une règle déterministe',
  NO_LITERAL: 'Valeur sans littéral par nature (présence / absence)',
  UNJUSTIFIED: 'Absence de littéral NON JUSTIFIÉE — à vérifier',
  LEGACY_UNSPECIFIED: 'Motif non renseigné (fait antérieur à la carte #838)',
};

/** Ce que le contrôle lit d'un fait prêt à persister (forme `DocumentFactRecord`). */
export interface RawValueAbsenceInput {
  rawValue?: string | number | boolean | null;
  excerpt?: string | null;
  evidenceOrigin?: string | null;
  visualEvidence?: { description?: string | null; page?: number | null; region?: unknown } | null;
  /** Unités source PERSISTÉES avec le fait (provenance réellement écrite). */
  sourceUnitIds?: readonly string[] | null;
  projectionOrigin?: string | null;
  /** Carte #863 (B1) : règle déterministe nommée (`DERIVED_BY_RULE` exige une origine établie). */
  projectionRule?: string | null;
  valueType?: string | null;
  /** Motif proposé par l'amont (ex. `ILLEGIBLE`) — validé, jamais cru sur parole. */
  rawValueAbsence?: string | null;
  /** Carte #863 (B1) : valeur du fait — la correspondance d'une preuve se vérifie contre ELLE. */
  valueText?: string | null;
  valueNumber?: number | string | null;
  normalizedValue?: string | null;
  /** Carte #863 (B1) : texte des unités source persistées (identifiant → texte intégral). */
  sourceUnitTexts?: ReadonlyMap<string, string | null> | null;
}

/** Carte #863 (B1) : longueur au-delà de laquelle un littéral est conservé PAR RÉFÉRENCE à l'unité source. */
export const RAW_LITERAL_MAX = 2_000;

const vide = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Un littéral est-il présent ? (`0` et `false` sont des littéraux.) */
export function hasRawLiteral(f: Pick<RawValueAbsenceInput, 'rawValue'>): boolean {
  return !vide(f.rawValue);
}

// ── Carte #863 (B1) — correspondance VÉRIFIABLE entre une preuve et la valeur du fait ───────────────────────

/** Nombre lu dans un littéral français ou anglais (`1 234,50`, `1.234,50`, `1,234.50`, `1234.5`). `null` : illisible. */
export function parseLiteralNumber(raw: string): number | null {
  let t = raw.replace(/[\s  ]/g, '');
  if (!/^-?[\d.,]+$/.test(t)) return null;
  const virgule = t.lastIndexOf(',');
  const point = t.lastIndexOf('.');
  if (virgule >= 0 && point >= 0) {
    const dec = virgule > point ? ',' : '.';
    t = t.replace(dec === ',' ? /\./g : /,/g, '').replace(dec, '.');
  } else if (virgule >= 0) {
    // « 1,234 » (milliers anglais) n'est pas distinguable de « 1,234 » (décimales) : décimale française retenue
    // seulement si elle n'a pas exactement trois chiffres après une partie entière ≥ 1 chiffre — sinon ambigu.
    const apres = t.length - virgule - 1;
    t = apres === 3 && (t.match(/,/g)?.length ?? 0) > 1 ? t.replace(/,/g, '') : t.replace(/,/g, '.');
  } else if ((t.match(/\./g)?.length ?? 0) > 1) {
    t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const NOMBRE = /-?\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:[.,]\d+)?/g;
const UNITE_APRES = /^[   ]?(?:€|\$|£|%|EUR\b|euros?\b|m²|m2\b|m³|km\b|kWh\b|kW\b|kg\b)/i;
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const BOOLEENS = /(?<![\p{L}\p{N}])(oui|non|vrai|faux|yes|no|☑|☒|✓|✔|✗)(?![\p{L}\p{N}])/giu;

/** Valeur numérique du fait (`valueNumber`, sinon `normalizedValue` / `valueText` numériques). */
function nombreDuFait(f: RawValueAbsenceInput): number | null {
  for (const v of [f.valueNumber, f.normalizedValue, f.valueText]) {
    if (v === null || v === undefined || v === '') continue;
    const n = typeof v === 'number' ? v : parseLiteralNumber(String(v));
    if (n !== null && Number.isFinite(n)) return n;
  }
  return null;
}

/** Date ISO du fait (`AAAA-MM-JJ`), si elle en porte une. */
function dateDuFait(f: RawValueAbsenceInput): { y: number; m: number; d: number } | null {
  for (const v of [f.normalizedValue, f.valueText]) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
    if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  return null;
}

const echapper = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Carte #863 (B1) — OCCURRENCES EXACTES de la valeur du fait dans un texte de preuve (pur) : sous-chaînes du
 * texte, telles qu'écrites (ponctuation, casse, espaces, unité ou symbole adjacents), qui correspondent à la
 * valeur — montant ou quantité (même nombre), date (même jour), booléen écrit, texte (mêmes mots). Aucune
 * occurrence : la preuve ne porte pas la valeur. Plusieurs DIFFÉRENTES : ambiguïté (rien n'est choisi).
 */
export function literalOccurrences(text: string | null | undefined, f: RawValueAbsenceInput): string[] {
  if (vide(text)) return [];
  const t = String(text);
  const trouves: string[] = [];
  const date = dateDuFait(f);
  if (date) {
    const formes = [
      new RegExp(`(?<!\\d)0?${date.d}[/.\\-]0?${date.m}[/.\\-](?:${date.y}|${String(date.y).slice(2)})(?!\\d)`, 'g'),
      new RegExp(`(?<!\\d)${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}(?!\\d)`, 'g'),
      new RegExp(`(?<!\\d)(?:1er|0?${date.d})\\s+${MOIS[date.m - 1]}\\s+${date.y}(?!\\d)`, 'giu'),
    ];
    for (const re of formes) for (const m of t.matchAll(re)) trouves.push(m[0]);
    return [...new Set(trouves)];
  }
  if (f.valueType === 'boolean') {
    for (const m of t.matchAll(BOOLEENS)) trouves.push(m[0]);
    return [...new Set(trouves)];
  }
  const n = nombreDuFait(f);
  const texte = String(f.valueText ?? f.normalizedValue ?? '').trim();
  const numerique = n !== null && (f.valueNumber !== null && f.valueNumber !== undefined || /^-?[\d\s  .,]+$/.test(texte));
  if (numerique && n !== null) {
    for (const m of t.matchAll(NOMBRE)) {
      const v = parseLiteralNumber(m[0]);
      if (v === null || Math.abs(v - n) > 1e-9 * Math.max(1, Math.abs(n))) continue;
      const suite = UNITE_APRES.exec(t.slice((m.index ?? 0) + m[0].length));
      trouves.push(m[0] + (suite ? suite[0] : ''));
    }
    return [...new Set(trouves)];
  }
  if (!texte) return [];
  // Texte : mêmes mots, dans l'ordre (casse et espaces du document conservés dans la sous-chaîne rendue).
  const mots = texte.split(/\s+/).filter(Boolean).map(echapper);
  if (mots.length === 0) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${mots.join('[\\s\\u00a0\\u202f]+')}(?![\\p{L}\\p{N}])`, 'giu');
  for (const m of t.matchAll(re)) trouves.push(m[0]);
  return [...new Set(trouves)];
}

/** Carte #863 (B1) : une description visuelle rapporte-t-elle un texte LISIBLE (étiquette, mention citée) ? */
export function describesReadableText(description: string | null | undefined): boolean {
  if (vide(description)) return false;
  const d = String(description);
  return /[«“"„][^«»“”"„]{1,200}[»”"]/.test(d)
    || /\b(lisibles?|inscriptions?|inscrite?s?|indiquant|indique|mentionn\p{L}*|libellée?s?|portant la mention|texte|écrite?s?)\b/iu.test(d);
}

/** Carte #863 (B1) : preuve d'une zone ILLISIBLE — description qui le dit ET zone localisée (page ou région). */
export function provesIllegibleZone(v: RawValueAbsenceInput['visualEvidence']): boolean {
  if (!v || vide(v.description)) return false;
  const dit = /\b(illisibles?|indéchiffrables?|effacée?s?|masquée?s?|floue?s?|tronquée?s?|raturée?s?)\b/iu.test(String(v.description));
  const localise = (v.page !== null && v.page !== undefined) || (v.region !== null && v.region !== undefined);
  return dit && localise;
}

/** Textes des unités source persistées du fait (dans l'ordre de ses références). */
function textesUnites(f: RawValueAbsenceInput): string[] {
  if (!f.sourceUnitIds?.length || !f.sourceUnitTexts) return [];
  return f.sourceUnitIds.map((id) => f.sourceUnitTexts!.get(id)).filter((x): x is string => !vide(x));
}

/** Précondition VÉRIFIABLE d'un motif sur la preuve du même fait (pure). */
export function rawValueAbsenceHolds(code: RawValueAbsenceCode, f: RawValueAbsenceInput): boolean {
  const visuel = f.evidenceOrigin === 'VISUAL_ANALYSIS';
  switch (code) {
    case 'VISUAL_ONLY': return visuel && !vide(f.visualEvidence?.description) && !describesReadableText(f.visualEvidence?.description);
    case 'ILLEGIBLE': return visuel && vide(f.excerpt) && provesIllegibleZone(f.visualEvidence);
    case 'SOURCE_UNIT_REFERENCE': {
      if (visuel || (f.sourceUnitIds?.length ?? 0) === 0) return false;
      const textes = textesUnites(f);
      // Unité persistée dont le texte porte la valeur, et la citation (si elle existe) localisable dans ce texte.
      return textes.some((t) => literalOccurrences(t, f).length > 0 && (vide(f.excerpt) || t.includes(String(f.excerpt).trim())));
    }
    case 'LITERAL_IN_EXCERPT': return !visuel && literalOccurrences(f.excerpt, f).length > 0;
    case 'DERIVED_BY_RULE': return f.projectionOrigin === 'DETERMINISTIC_RULE' && !vide(f.projectionRule);
    case 'NO_LITERAL': {
      if (f.valueType !== 'boolean') return false;
      // Un booléen ÉCRIT (« Oui », case cochée) est un littéral ; la preuve doit exister et ne pas en porter.
      const preuve = !vide(f.excerpt) || (visuel && !vide(f.visualEvidence?.description));
      return preuve && literalOccurrences(f.excerpt, f).length === 0 && textesUnites(f).every((t) => literalOccurrences(t, f).length === 0)
        && !(visuel && describesReadableText(f.visualEvidence?.description));
    }
    case 'UNJUSTIFIED': return true;
  }
}

export type RawValueAbsenceCheck =
  /** Littéral présent : conservé tel quel, aucun motif. */
  | { status: 'LITERAL'; code: null }
  /**
   * Carte #863 (B1) : littéral absent du champ mais RÉCUPÉRÉ exactement, sans ambiguïté, depuis la preuve du fait
   * (citation ou texte de l'unité source persistée) — conservé tel qu'écrit, jamais normalisé.
   */
  | { status: 'RECOVERED'; code: null; rawValue: string; from: 'EXCERPT' | 'SOURCE_UNIT' }
  /** Absence justifiée par un motif vérifié. */
  | { status: 'JUSTIFIED'; code: Exclude<RawValueAbsenceCode, 'UNJUSTIFIED'> }
  /** Aucun motif vérifiable : fait conservé et SIGNALÉ. `rejected` : motif proposé par l'amont invalide. */
  | { status: 'UNJUSTIFIED'; code: 'UNJUSTIFIED'; rejected: string | null };

/** Littéral UNIQUE (une seule forme écrite) et de longueur conservable ; `null` : absent ou ambigu. */
function unique(occ: readonly string[]): string | null {
  return occ.length === 1 && occ[0].length <= RAW_LITERAL_MAX ? occ[0] : null;
}

/**
 * Règle de validation métier (pure) : motif proposé par l'amont s'il est
 * vérifiable, sinon littéral récupéré exactement depuis la preuve, sinon
 * motif déduit de la preuve (ordre du plus spécifique au plus général),
 * sinon `UNJUSTIFIED` signalé.
 */
export function checkRawValueAbsence(f: RawValueAbsenceInput): RawValueAbsenceCheck {
  if (hasRawLiteral(f)) return { status: 'LITERAL', code: null };
  const propose = f.rawValueAbsence ?? null;
  let rejete: string | null = null;
  if (propose !== null) {
    if ((RAW_VALUE_ABSENCE_CODES as readonly string[]).includes(propose) && propose !== 'UNJUSTIFIED'
      && rawValueAbsenceHolds(propose as RawValueAbsenceCode, f)) {
      return { status: 'JUSTIFIED', code: propose as Exclude<RawValueAbsenceCode, 'UNJUSTIFIED'> };
    }
    rejete = propose;
  }
  if (rawValueAbsenceHolds('DERIVED_BY_RULE', f)) return { status: 'JUSTIFIED', code: 'DERIVED_BY_RULE' };
  if (f.evidenceOrigin === 'VISUAL_ANALYSIS') {
    if (rawValueAbsenceHolds('ILLEGIBLE', f)) return { status: 'JUSTIFIED', code: 'ILLEGIBLE' };
    if (rawValueAbsenceHolds('VISUAL_ONLY', f)) return { status: 'JUSTIFIED', code: 'VISUAL_ONLY' };
    if (rawValueAbsenceHolds('NO_LITERAL', f)) return { status: 'JUSTIFIED', code: 'NO_LITERAL' };
    return { status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: rejete };
  }
  // Littéral récupérable sans ambiguïté : d'abord la citation, puis le texte des unités persistées.
  const dansCitation = literalOccurrences(f.excerpt, f);
  const lu = unique(dansCitation);
  if (lu !== null) return { status: 'RECOVERED', code: null, rawValue: lu, from: 'EXCERPT' };
  if (dansCitation.length === 0) {
    const parUnite = [...new Set(textesUnites(f).flatMap((t) => literalOccurrences(t, f)))];
    const luUnite = unique(parUnite);
    if (luUnite !== null && (vide(f.excerpt) || textesUnites(f).some((t) => t.includes(String(f.excerpt).trim())))) {
      return { status: 'RECOVERED', code: null, rawValue: luUnite, from: 'SOURCE_UNIT' };
    }
  }
  for (const code of ['SOURCE_UNIT_REFERENCE', 'LITERAL_IN_EXCERPT', 'NO_LITERAL'] as const) {
    if (rawValueAbsenceHolds(code, f)) return { status: 'JUSTIFIED', code };
  }
  return { status: 'UNJUSTIFIED', code: 'UNJUSTIFIED', rejected: rejete };
}

/**
 * Lecture (API, export) d'un fait persisté : motif écrit, `null` si le
 * littéral est présent, `LEGACY_UNSPECIFIED` pour un fait antérieur sans
 * motif — jamais un motif inventé.
 */
export function readRawValueAbsence(row: { rawValue?: unknown; rawValueAbsence?: unknown }): RawValueAbsenceCode | typeof LEGACY_RAW_VALUE_ABSENCE | null {
  if (!vide(row.rawValue)) return null;
  const v = typeof row.rawValueAbsence === 'string' ? row.rawValueAbsence : null;
  if (v && (RAW_VALUE_ABSENCE_CODES as readonly string[]).includes(v)) return v as RawValueAbsenceCode;
  return LEGACY_RAW_VALUE_ABSENCE;
}

/**
 * Carte #863 (B1) — COUVERTURE LITTÉRALE d'un ensemble de faits lus (rapport BO, export) :
 * `COMPLETE` seulement si chaque fait porte son littéral ou un motif justifié ; une absence non justifiée
 * → `INCOMPLETE` ; un fait antérieur sans motif → `NOT_ESTABLISHED` (jamais déclaré complet).
 */
export function literalCoverageOf(rows: ReadonlyArray<{ rawValue?: unknown; rawValueAbsence?: unknown }>): {
  status: 'COMPLETE' | 'INCOMPLETE' | 'NOT_ESTABLISHED'; literal: number; justified: number; unjustified: number; legacy: number;
} {
  let literal = 0; let justified = 0; let unjustified = 0; let legacy = 0;
  for (const r of rows) {
    const m = readRawValueAbsence(r);
    if (m === null) literal++;
    else if (m === LEGACY_RAW_VALUE_ABSENCE) legacy++;
    else if (m === 'UNJUSTIFIED') unjustified++;
    else justified++;
  }
  return { status: unjustified > 0 ? 'INCOMPLETE' : legacy > 0 ? 'NOT_ESTABLISHED' : 'COMPLETE', literal, justified, unjustified, legacy };
}
