/**
 * Lot 58B — ticket P1 « À traiter : questions inutiles sur des échéances
 * passées et données déjà connues ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE PROUVÉE (voir `l58b-a-traiter-echeances.e2e.ts`, ECH-01 à ECH-04)
 *
 *   1. Une date lue « 20:06:2026 » était refusée PARTOUT : le registre
 *      (`normalizeDateValue`) n'acceptait que « / . - », la projection T1
 *      requalifiait donc le fait `contractEndDate` en connaissance GÉNÉRIQUE
 *      (VALUE_NOT_NORMALIZABLE), et le pont documentaire (`toIsoDate`, ISO
 *      seul ; `rawValueOf`, sans « : ») l'écartait aussi : la date connue
 *      devenait « absente » → carte « À compléter ».
 *   2. La création INITIALE ignorait la connaissance persistée : l'analyse
 *      ne lisait que les faits canoniques de la sortie (ni alias, ni fait
 *      générique, ni unité « libellé : valeur ») et le balayage horaire
 *      créait la carte sur la seule absence de `document_field_values`.
 *      Seul le passage T3 (57B) relisait la connaissance — après coup.
 *   3. Aucune notion de pertinence : une échéance PASSÉE sans action
 *      produisait la même question qu'un contrat en cours.
 *
 * CE MODULE (sans règle propre à un type de contrat, sans liste de
 * formulations) :
 *   · `parseDocumentDate` — dates NON ambiguës normalisées (20:06:2026,
 *     20/06/2026, 20.06.2026, 20-06-2026, 20 juin 2026, 2026/06/20) ; refus
 *     des formes ambiguës (année sur deux chiffres, séparateurs mêlés) ; une
 *     forme JJ/MM où jour et mois sont tous deux ≤ 12 est lue à la française
 *     mais ne vaut jamais « certaine » (ORDER_AMBIGUOUS) ;
 *   · `gatherFieldEvidence` — faits actifs (clé canonique, alias, clé brute,
 *     libellé), faits non intégrés, unités « libellé : valeur », et indice du
 *     TITRE / nom de fichier : il oriente la recherche mais ne prouve jamais
 *     seul — une date du titre n'est proposée que si elle est RETROUVÉE dans
 *     le contenu du document, et jamais écrite sans validation ;
 *   · `assessDeadlinePertinence` — échéance passée : la branche IA EXISTANTE
 *     T4 CLASSIFY_EVENT (prompt inchangé) dit si l'événement exige une
 *     action (`homeCategory = action`) ou n'est qu'une information
 *     historique. Information → aucune question ; action, abstention, refus
 *     ou échec technique → la question reste (variante prudente). La
 *     décision est mémorisée (signature des éléments) : ni rappel de l'IA,
 *     ni recréation de carte aux balayages suivants ;
 *   · `recordRuleEvaluation` — diagnostic par règle (migration 0418), lu
 *     par le BO (Diagnostic des « À traiter »).
 *
 * ── LOT 61 — ÉCARTS RÉSIDUELS DU 58B ET PERTINENCE DES CARTES ─────────────
 *
 *   · décision CENTRALE `assessDeadlinePertinence` : AUTO_RESOLVED /
 *     NO_ACTION / DEFER / CREATE_ACTION, hybride (code : préconditions,
 *     temps, historique, mémoire ; T4 `t4_output_v3` : intervention concrète,
 *     justification, preuve — contrôlée par `checkInterventionCoherence`) ;
 *     contrat de décision interne versionné (`DecisionContract`) ;
 *   · date du TITRE seule : indice, jamais preuve (écart 7) ; date absente :
 *     contexte documentaire examiné avant toute question (écart 3) ;
 *   · lecture en échec distinguée d'une donnée absente (`errors`, écart 5) ;
 *   · mémoire invalidée par l'empreinte des preuves, la révision de
 *     connaissance et la configuration IA (écart 4) ;
 *   · consolidation entre documents d'un MÊME contrat (référence exacte) ;
 *   · diagnostic : issue, contrat de décision, écriture, cartes, passages
 *     (migration 0444, écart 6).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import { getField, resolveAlias } from '@/services/canonical/registry';
import { documentBridgeRules, type ProcessingRule } from './rules-catalog';
import { checkInterventionCoherence, type InterventionDecision } from './intervention-check';
import {
  DEFAULT_TO_PROCESS_THRESHOLDS, composeConfigRef, deferThresholdsRef, loadToProcessThresholds, type ToProcessThresholds,
} from './relevance-thresholds';

/** Version du traitement (diagnostic, BO). */
export const DOCUMENT_RULE_ENGINE_VERSION = 'l61-1';

// ══════════════════════════════════════════════════════════════════════════
// DATES — fonctions pures
// ══════════════════════════════════════════════════════════════════════════

export type DateParseStatus = 'ISO' | 'NORMALIZED' | 'ORDER_AMBIGUOUS' | 'REFUSED_AMBIGUOUS' | 'INVALID' | 'NOT_A_DATE';
export interface DateParse { iso: string | null; status: DateParseStatus }

const MOIS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};
const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
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

// ══════════════════════════════════════════════════════════════════════════
// CLÉS — registre canonique (pures)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Clé d'une donnée documentaire du pont pour une clé d'écran ou une clé lue
 * (`warrantyEndDate`, `dateFinContrat`…), sinon null.
 */
export function documentBridgeFieldKey(screenKey: string): string | null {
  const keys = new Set(documentBridgeRules().filter((r) => r.fieldKey).map((r) => r.fieldKey!));
  if (keys.has(screenKey)) return screenKey;
  const canonique = resolveAlias(screenKey);
  return canonique && keys.has(canonique) ? canonique : null;
}

/** Une clé lue par T1 désigne-t-elle la donnée `key` du pont ? (pure, registre canonique) */
export function t1KeyDesignates(raw: string | null | undefined, key: string): boolean {
  if (!raw) return false;
  if (raw === key) return true;
  return documentBridgeFieldKey(raw) === key;
}

const normLabel = (v: string) => sansAccents(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Libellé LU dans le document (unité « libellé : valeur ») qui désigne la
 * donnée `key` : clé ou alias du registre, ou libellé du registre contenu
 * dans le libellé lu (« Date de fin de contrat » ⊃ « Fin de contrat »). Pure.
 */
export function t1LabelDesignates(label: string | null | undefined, key: string, registryLabel: string | null): boolean {
  if (!label) return false;
  if (t1KeyDesignates(label, key)) return true;
  if (!registryLabel) return false;
  const l = ` ${normLabel(label)} `;
  const r = normLabel(registryLabel);
  return r.length >= 6 && l.includes(` ${r} `);
}

/** La donnée est-elle une DATE du registre ? */
export const isDateKey = (key: string) => getField(key)?.valueType === 'date';

/** Règle d'ÉCHÉANCE (date dont l'approche est suivie) : sa pertinence dépend du temps. */
export const isDeadlineRule = (rule: ProcessingRule) => rule.dueSoonDays != null && !!rule.fieldKey && isDateKey(rule.fieldKey);

// ══════════════════════════════════════════════════════════════════════════
// CONNAISSANCE PERSISTÉE — faits, faits non intégrés, unités, titre
// ══════════════════════════════════════════════════════════════════════════

export type EvidenceConfidence = 'certain' | 'probable' | 'conflictual';

export interface EvidenceFact {
  value: string | number | boolean | null;
  confidence: EvidenceConfidence | string;
  excerpt?: string | null;
  source: string;
  /** Lot 61 : clé (canonique ou lue) ou libellé qui a désigné la donnée. */
  key?: string | null;
}

/** Valeur lue, pour le diagnostic (jamais un texte intégral). */
export interface EvidenceObservation {
  source: string;
  key: string | null;
  raw: string | null;
  normalized: string | null;
  status: DateParseStatus | 'TEXT' | 'EMPTY';
}

export interface FieldEvidence {
  hasExtraction: boolean;
  facts: EvidenceFact[];
  sources: Record<string, number>;
  /** Sources ABSENTES (migration non appliquée, couche non construite) : la donnée peut exister ailleurs. */
  missing: string[];
  /**
   * Lot 61 (écart 5) : sources dont la LECTURE a échoué (erreur technique).
   * Jamais confondue avec une donnée absente : aucune fermeture, aucune
   * décision « sans intervention » n'est prise sur une absence de preuve
   * causée par une panne.
   */
  errors: string[];
  observations: EvidenceObservation[];
  /** Indice du titre / nom de fichier (dates) et dates retrouvées dans le contenu. */
  titleHint: { dates: string[]; confirmed: string[]; excerpt: string | null } | null;
  /** Titre lu du document (contexte transmis à T4 pour la pertinence, ≤ 200 caractères). */
  documentTitle?: string | null;
  /** Lot 61 : autres dates FIABLES lues dans le document (faits actifs, hors donnée visée), ≤ 20. */
  contextDates?: Array<{ key: string; iso: string; confidence: string }>;
  /** Lot 61 (écart 4) : empreinte des éléments lus (valeurs, sources, statuts, titre). */
  fingerprint?: string;
}

const court = (v: unknown, n = 120) => (v === null || v === undefined ? null : String(v).slice(0, n));
const sha = (v: unknown, n = 20) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, n);

/**
 * Normalise une valeur lue pour la donnée `key` : date → ISO avec statut ;
 * autre donnée → texte. `confidence` est plafonnée à `probable` pour une date
 * dont l'ordre jour / mois reste ambigu. Pure.
 */
export function readValue(key: string, raw: unknown, confidence: string, valueType?: 'date' | 'text'): { value: string | null; confidence: string; status: EvidenceObservation['status'] } {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null, confidence, status: 'EMPTY' };
  if ((valueType ?? (isDateKey(key) ? 'date' : 'text')) !== 'date') return { value: String(raw).trim(), confidence, status: 'TEXT' };
  const p = parseDocumentDate(raw);
  if (!p.iso) return { value: null, confidence, status: p.status };
  return { value: p.iso, confidence: p.status === 'ORDER_AMBIGUOUS' && confidence === 'certain' ? 'probable' : confidence, status: p.status };
}

/** Options de lecture (lot 61) : désignation élargie (calculs), type de valeur, indice du titre. */
export interface GatherOptions {
  /** Clés lues (insensibles à la casse) et libellés qui désignent AUSSI la donnée. */
  designation?: { keys: readonly string[]; labelMatch: (label: string) => boolean };
  /** Indice du titre (défaut : pour une date). */
  withTitleHint?: boolean;
  /** Type de valeur (défaut : celui du registre). */
  valueType?: 'date' | 'text';
}

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/**
 * Connaissance T1 PERSISTÉE relative à `key` (lecture seule) : faits actifs,
 * faits non intégrés fiables, unités « libellé : valeur », et — pour une
 * date — indice du titre / nom de fichier vérifié contre le contenu.
 * Jamais le fichier, jamais un nouvel appel T1. Lot 61 : une lecture en
 * échec est consignée dans `errors` (jamais dans `missing`).
 */
export async function gatherFieldEvidence(accountId: number, fileId: number, key: string, opts: GatherOptions = {}): Promise<FieldEvidence> {
  const sources: Record<string, number> = {};
  const missing: string[] = [];
  const errors: string[] = [];
  const facts: EvidenceFact[] = [];
  const observations: EvidenceObservation[] = [];
  const contextDates: NonNullable<FieldEvidence['contextDates']> = [];
  const registryLabel = getField(key)?.label ?? null;
  const designeCles = new Set((opts.designation?.keys ?? []).map((k) => k.toLowerCase()));
  const designe = (canonical: string | null, raw: string | null, label: string | null): boolean => {
    if (t1KeyDesignates(canonical, key) || t1KeyDesignates(raw, key)) return true;
    if (!canonical && t1LabelDesignates(label, key, registryLabel)) return true;
    if (!opts.designation) return false;
    if ((canonical && designeCles.has(canonical.toLowerCase())) || (raw && designeCles.has(raw.toLowerCase()))) return true;
    return !canonical && !!label && opts.designation.labelMatch(label);
  };
  const noter = (source: string, k: string | null, raw: unknown, confidence: string, excerpt?: string | null) => {
    sources[source] = (sources[source] ?? 0) + 1;
    const r = readValue(key, raw, confidence, opts.valueType);
    if (observations.length < 30) observations.push({ source, key: k, raw: court(raw), normalized: r.value, status: r.status });
    if (r.value !== null) facts.push({ value: r.value, confidence: r.confidence, excerpt: excerpt ?? null, source, key: k });
  };
  const fin = (titleHint: FieldEvidence['titleHint'], documentTitle: string | null, hasExtraction: boolean): FieldEvidence => ({
    hasExtraction, facts, sources, missing, errors, observations, titleHint, documentTitle, contextDates,
    fingerprint: sha([
      // Écart 4 : la CLAUSE (extrait) compte autant que la valeur — une clause modifiée invalide la décision.
      facts.map((f) => [f.source, f.value, f.confidence, f.excerpt ?? null]).sort(), observations.map((o) => [o.source, o.normalized, o.status]).sort(),
      titleHint, contextDates.map((d) => [d.key, d.iso]).sort(),
    ]),
  });

  const [ext] = (await pgClient.unsafe(
    `SELECT e.id, e.title, f.original_filename AS filename, to_jsonb(f) ->> 'retained_title' AS retained
       FROM asset_files f LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      WHERE f.id = $1 AND f.account_id = $2 ORDER BY e.id DESC NULLS LAST LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ id: number | null; title: string | null; filename: string | null; retained: string | null }>;
  if (!ext?.id) { missing.push('EXTRACTION'); return fin(null, null, false); }

  const contenu: string[] = [];
  try {
    const rows = (await pgClient.unsafe(
      `SELECT to_jsonb(f) ->> 'canonical_key' AS canonical, f.fact_key AS raw, f.label, f.normalized_value AS norm,
              f.value_text AS text, f.confidence, f.excerpt
         FROM document_facts f WHERE f.file_id = $1 AND f.account_id = $2 AND f.status = 'active'`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ canonical: string | null; raw: string; label: string | null; norm: string | null; text: string | null; confidence: string; excerpt: string | null }>;
    for (const r of rows) {
      contenu.push(r.text ?? '', r.excerpt ?? '');
      if (!designe(r.canonical, r.raw, r.label)) {
        // Lot 61 : autres dates fiables du document (situer le contrat dans le temps).
        const d = parseDocumentDate(r.norm ?? r.text);
        if (d.iso && (d.status === 'ISO' || d.status === 'NORMALIZED') && contextDates.length < 20) {
          contextDates.push({ key: r.canonical ?? r.raw, iso: d.iso, confidence: r.confidence });
        }
        continue;
      }
      // Valeur normalisée d'abord ; une valeur brute non ISO (fait générique
      // requalifié faute de normalisation) est relue ici.
      const brut = r.norm && readValue(key, r.norm, r.confidence, opts.valueType).value !== null ? r.norm : (r.text ?? r.norm);
      noter('FACTS', r.canonical ?? r.raw, brut, r.confidence, r.excerpt);
    }
  } catch (e) { errors.push(`FACTS: ${errMsg(e)}`); }

  try {
    const { sourceLayerReady } = await import('@/services/ai/source-analysis/source-units/repository');
    if (!(await sourceLayerReady())) {
      missing.push('SOURCE_UNITS', 'UNRESOLVED_FACTS');
    } else {
      const { RELIABLE_UNRESOLVED_REASONS } = await import('@/services/ai/reconciliation/document-asset/source-unit-provider');
      const nr = (await pgClient.unsafe(
        `SELECT canonical_key AS canonical, raw_key AS raw, raw_value AS value, reason
           FROM document_unresolved_facts WHERE file_id = $1 AND account_id = $2 AND status IN ('UNRESOLVED', 'RETAINED') LIMIT 500`,
        [fileId, accountId] as never[],
      )) as unknown as Array<{ canonical: string | null; raw: string | null; value: string | null; reason: string }>;
      for (const r of nr) {
        if (!r.value || !designe(r.canonical, r.raw, null)) continue;
        // Charge brute : jamais « certaine » (proposition seulement).
        noter('UNRESOLVED_FACTS', r.canonical ?? r.raw, r.value, RELIABLE_UNRESOLVED_REASONS.includes(r.reason) ? 'probable' : 'conflictual');
      }
      const units = (await pgClient.unsafe(
        `SELECT kind, label, value_text AS value, content_text AS text, coverage_status AS coverage
           FROM document_source_units
          WHERE file_id = $1 AND account_id = $2 AND coverage_status IN ('COVERED', 'UNRESOLVED', 'UNCERTAIN')
          ORDER BY ordinal LIMIT 2000`,
        [fileId, accountId] as never[],
      )) as unknown as Array<{ kind: string; label: string | null; value: string | null; text: string | null; coverage: string }>;
      for (const u of units) {
        contenu.push(u.value ?? '', u.text ?? '');
        if (!['LABEL_VALUE', 'FORM_FIELD'].includes(u.kind) || !u.label || !u.value) continue;
        if (!t1LabelDesignates(u.label, key, registryLabel) && !(opts.designation && opts.designation.labelMatch(u.label))) continue;
        // Unité lue mais non structurée en fait : proposition, jamais écriture silencieuse.
        noter('SOURCE_UNITS', u.label, u.value, u.coverage === 'UNCERTAIN' ? 'conflictual' : 'probable');
      }
    }
  } catch (e) { errors.push(`SOURCE_UNITS: ${errMsg(e)}`); }

  // ── Indice du titre / nom de fichier (dates seulement) ──────────────────
  let titleHint: FieldEvidence['titleHint'] = null;
  if ((opts.withTitleHint ?? true) && (opts.valueType ?? (isDateKey(key) ? 'date' : 'text')) === 'date') {
    const titres = [ext.title, ext.retained, ext.filename].filter((t): t is string => !!t);
    const dates = [...new Set(titres.flatMap((t) => datesMentionedIn(t).map((d) => d.iso)))];
    if (dates.length) {
      try {
        const [t] = (await pgClient.unsafe(
          `SELECT left(full_text, 200000) AS txt FROM document_extractions WHERE id = $1`, [ext.id] as never[],
        )) as unknown as Array<{ txt: string | null }>;
        contenu.push(t?.txt ?? '');
      } catch (e) { errors.push(`FULL_TEXT: ${errMsg(e)}`); }
      const dansContenu = new Set(contenu.flatMap((c) => datesMentionedIn(c).map((d) => d.iso)));
      const confirmed = dates.filter((d) => dansContenu.has(d));
      titleHint = { dates, confirmed, excerpt: court(titres[0], 200) };
      sources.TITLE_HINT = dates.length;
      for (const iso of confirmed) {
        // Date du titre RETROUVÉE dans le contenu : proposition, jamais certaine.
        if (facts.some((f) => f.value === iso)) continue;
        sources.TITLE_CONFIRMED = (sources.TITLE_CONFIRMED ?? 0) + 1;
        if (observations.length < 30) observations.push({ source: 'TITLE_CONFIRMED', key: null, raw: iso, normalized: iso, status: 'NORMALIZED' });
        facts.push({ value: iso, confidence: 'probable', excerpt: court(titres[0], 120), source: 'TITLE_CONFIRMED', key: null });
      }
      for (const iso of dates.filter((d) => !confirmed.includes(d))) {
        if (observations.length < 30) observations.push({ source: 'TITLE_ONLY', key: null, raw: iso, normalized: null, status: 'NOT_A_DATE' });
      }
    }
  }
  return fin(titleHint, court(ext.title ?? ext.retained ?? ext.filename, 200), true);
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 61 — CONSOLIDATION ENTRE DOCUMENTS D'UN MÊME CONTRAT
// ══════════════════════════════════════════════════════════════════════════

/** Clés (registre) qui identifient un contrat : même référence exacte = même contrat. */
const CONTRACT_REFERENCE_KEYS = ['contractNumber', 'insuranceContractNumber'];

/** Référence normalisée (majuscules, alphanumérique), ≥ 5 caractères, sinon null. Pure. */
export function normalizeContractReference(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 5 && /\d/.test(s) ? s : null;
}

/**
 * Valeur de la donnée `key` déjà retenue sur un AUTRE document du même compte
 * portant EXACTEMENT la même référence de contrat (n° de contrat, de police).
 * Jamais de rapprochement par ressemblance, par bien ou par fournisseur : deux
 * contrats distincts rattachés au même bien ne se mélangent pas.
 *   · une valeur de l'utilisateur, unique → fait certain (écrit, provenance) ;
 *   · sinon (valeur lue ou calculée) → proposition « probable » ;
 *   · plusieurs valeurs distinctes → propositions (arbitrage).
 */
export async function gatherRelatedDocumentValues(accountId: number, fileId: number, key: string): Promise<{ facts: EvidenceFact[]; related: Array<{ fileId: number; value: string; userValidated: boolean; kind: string | null }> }> {
  const aliases = CONTRACT_REFERENCE_KEYS.flatMap((k) => [k, ...(getField(k)?.aliases ?? [])]);
  const refs = (await pgClient.unsafe(
    `SELECT DISTINCT COALESCE(normalized_value, value_text) AS v FROM document_facts
      WHERE file_id = $1 AND account_id = $2 AND status = 'active'
        AND (to_jsonb(document_facts) ->> 'canonical_key' = ANY($3::text[]) OR fact_key = ANY($3::text[]))`,
    [fileId, accountId, aliases] as never[],
  )) as unknown as Array<{ v: string | null }>;
  const mesRefs = [...new Set(refs.map((r) => normalizeContractReference(r.v)).filter((x): x is string => !!x))];
  if (mesRefs.length === 0) return { facts: [], related: [] };
  const lignes = (await pgClient.unsafe(
    `SELECT DISTINCT v.file_id, v.value_text AS value, v.user_validated AS uv, to_jsonb(v) ->> 'value_kind' AS kind
       FROM document_facts x
       JOIN asset_files f ON f.id = x.file_id AND f.account_id = x.account_id
                         AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
       JOIN document_field_values v ON v.file_id = x.file_id AND v.account_id = x.account_id AND v.field_key = $4
      WHERE x.account_id = $1 AND x.file_id <> $2 AND x.status = 'active'
        AND (to_jsonb(x) ->> 'canonical_key' = ANY($3::text[]) OR x.fact_key = ANY($3::text[]))
        AND regexp_replace(upper(COALESCE(x.normalized_value, x.value_text, '')), '[^A-Z0-9]', '', 'g') = ANY($5::text[])
        AND v.value_text IS NOT NULL
      LIMIT 20`,
    [accountId, fileId, aliases, key, mesRefs] as never[],
  )) as unknown as Array<{ file_id: number; value: string; uv: boolean; kind: string | null }>;
  const related = lignes.map((l) => ({ fileId: Number(l.file_id), value: l.value, userValidated: l.uv === true, kind: l.kind }));
  const valeurs = new Set(related.map((r) => r.value));
  const facts: EvidenceFact[] = related
    // Une valeur CALCULÉE ailleurs n'est jamais reprise comme une donnée lue.
    .filter((r) => r.kind !== 'CALCULATED')
    .map((r) => ({
      value: r.value, source: 'RELATED_DOCUMENTS', key: `document:${r.fileId}`,
      confidence: r.userValidated && valeurs.size === 1 ? 'certain' : 'probable',
      excerpt: `Même contrat que le document ${r.fileId}`,
    }));
  return { facts, related };
}

// ══════════════════════════════════════════════════════════════════════════
// PERTINENCE — DÉCISION CENTRALE « À TRAITER » (lot 61)
// ══════════════════════════════════════════════════════════════════════════

export type Pertinence =
  /** Règle sans échéance : la question vaut par elle-même. */
  | 'NOT_EVALUATED'
  /** (58B, historique) date future ou inconnue. */
  | 'FUTURE_OR_UNDATED'
  /** Échéance passée qui exige encore une intervention identifiée. */
  | 'ACTION_REQUIRED'
  /** Échéance historique, aucune intervention attendue. */
  | 'NO_ACTION_NEEDED'
  /** L'IA s'abstient, refuse ou échoue : décision différée (jamais une carte arbitraire). */
  | 'UNDECIDED'
  /** Lot 61 : date future proche — la donnée compte maintenant. */
  | 'FUTURE_SOON'
  /** Lot 61 : date future lointaine — interpellation différée. */
  | 'FUTURE_DEFERRABLE'
  /** Lot 61 : date inconnue, document historique sans enjeu actuel. */
  | 'UNDATED_HISTORICAL'
  /** Lot 61 : date inconnue, nécessaire à un besoin réel. */
  | 'UNDATED_NEEDED'
  /** Lot 61 : date inconnue, non nécessaire. */
  | 'UNDATED_NOT_NEEDED'
  /** Lot 61 : seule une date du titre (indice, jamais une preuve). */
  | 'TITLE_HINT_ONLY'
  /** Lot 61 : valeurs FIABLES contradictoires — arbitrage justifié, quel que soit l'horizon. */
  | 'CONTRADICTION';

export type RelevanceOutcome = 'AUTO_RESOLVED' | 'NO_ACTION' | 'DEFER' | 'CREATE_ACTION';
export type RelevanceSituation = 'NOT_DEADLINE' | 'PAST_DEADLINE' | 'FUTURE_DEADLINE' | 'UNDATED' | 'TITLE_ONLY';

export type { InterventionDecision } from './intervention-check';

/** Version du contrat de décision interne (§5 du ticket « pertinence »). */
export const DECISION_CONTRACT_VERSION = 'atr-decision-v1';

/** Contrat de décision interne — structuré, jamais exposé tel quel à l'utilisateur. */
export interface DecisionContract {
  version: string;
  ruleCode: string;
  dataKey: string;
  fileId: number;
  documentType: string | null;
  /** Nature du problème. */
  problem: 'MISSING_DATA' | 'UNCERTAIN_DATA' | 'DEADLINE_INTERVENTION';
  /** Intervention précise attendue (null si aucune). */
  intervention: { kind: string | null; action: string | null; actBy: string | null } | null;
  consequence: string | null;
  /** Pourquoi la résolution automatique ne suffit pas. */
  autoResolution: string;
  temporal: { situation: RelevanceSituation; today: string; candidates: string[]; nearestFuture: string | null; reevaluateAt: string | null };
  reliability: { level: 'HIGH' | 'MEDIUM' | 'LOW'; sources: string[]; evidence: string | null };
  decision: RelevanceOutcome | null;
  motive: string;
  /** Lot 63 — seuils « À traiter » utilisés (BO › Configuration IA, défaut lot 61). */
  thresholds?: ToProcessThresholds;
}

export interface PertinenceResult {
  pertinence: Pertinence;
  reason: string;
  /** Appel IA effectué (false si décision mémorisée, déterministe ou sans objet). */
  aiCalled: boolean;
  cached: boolean;
  aiStatus: 'OK' | 'ERROR' | null;
  aiTraceId: string | null;
  signature: string | null;
  /** Lot 61 : décision proposée (null : règle sans échéance, chemin antérieur). */
  outcome: RelevanceOutcome | null;
  situation: RelevanceSituation;
  /** CREATE_ACTION : question sur la donnée, ou carte d'intervention réelle. */
  card: 'DATA_QUESTION' | 'INTERVENTION' | null;
  intervention: InterventionDecision | null;
  /** DEFER : réévaluation prévue (ISO). */
  reevaluateAt: string | null;
  /** Échec technique (IA, lecture) : aucune fermeture ne doit en découler. */
  technicalFailure: boolean;
  contract: DecisionContract | null;
}

export interface PertinenceCandidate { iso: string; source: string; excerpt?: string | null }

type DecideFn = typeof import('@/services/ai/agenda/master/classify-event').decideAgendaEvent;

/** Date du jour à Paris (AAAA-MM-JJ). */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Seuils par DÉFAUT (lot 61). Lot 63 : réglables dans le BO (`relevance-thresholds`,
 * BO › Configuration IA › Réglages › « À traiter ») ; la décision lit les
 * seuils EFFECTIFS portés par la configuration (`T4AssessmentConfig.thresholds`).
 */
export const FUTURE_HORIZON_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.futureHorizonDays;
export const HISTORICAL_YEARS = DEFAULT_TO_PROCESS_THRESHOLDS.historicalYears;
export const DEFER_UNCERTAIN_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferUncertainDays;
export const DEFER_UNDATED_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferUndatedDays;
export const DEFER_TITLE_ONLY_DAYS = DEFAULT_TO_PROCESS_THRESHOLDS.deferTitleOnlyDays;
/** Reprise après un échec technique (minutes). */
export const RETRY_AFTER_FAILURE_MIN = 60;

const plusJours = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const joursEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const aMinuit = (iso: string) => `${iso}T00:00:00.000Z`;

/**
 * Signature des éléments qui fondent la décision de pertinence (pure).
 * Lot 61 (écart 4) : + situation, empreinte des preuves, configuration IA.
 */
export function pertinenceSignature(key: string, documentType: string | null, cands: PertinenceCandidate[], extra: { situation?: string; evidence?: string | null; config?: string | null } = {}): string {
  const base = [key, documentType ?? '', ...[...new Set(cands.map((c) => `${c.iso}@${c.source}`))].sort(),
    extra.situation ?? '', extra.evidence ?? '', extra.config ?? ''].join('|');
  return createHash('sha1').update(base).digest('hex').slice(0, 20);
}

export { checkInterventionCoherence } from './intervention-check';

/** Configuration T4 effective, pour la décision et la mémoire (écart 4). */
export interface T4AssessmentConfig {
  /**
   * Référence de la configuration (version BO + contrat de sortie, ou défaut
   * du dépôt) ; lot 63 : suivie des seuils « À traiter » MODIFIÉS
   * (`|seuils:h=150`), absente aux valeurs par défaut. Écrite dans `config_ref`.
   */
  ref: string;
  /** Contrat de sortie `t4_output_v3` (ou suivant) : évaluation structurée d'une intervention possible. */
  interventionCapable: boolean;
  /** Lot 63 — référence de la seule configuration IA (sans les seuils) ; défaut : `ref`. */
  aiRef?: string;
  /** Lot 63 — seuils effectifs (BO) ; absents : valeurs par défaut du lot 61. */
  thresholds?: ToProcessThresholds;
}

/** Seuils effectifs d'une configuration (pure). */
export function thresholdsOf(config: Pick<T4AssessmentConfig, 'thresholds'> | null | undefined): ToProcessThresholds {
  return config?.thresholds ?? { ...DEFAULT_TO_PROCESS_THRESHOLDS };
}

/**
 * Part « configuration » de la signature d'une décision IA mémorisée (pure) :
 * configuration IA + délais de réévaluation MODIFIÉS (seuls seuils qui
 * changent une décision rendue par T4). Aux valeurs par défaut : `ref`,
 * comme au lot 61 (aucune décision mémorisée invalidée au déploiement).
 */
export function pertinenceConfigKey(config: T4AssessmentConfig): string {
  const ia = config.aiRef ?? config.ref;
  const d = deferThresholdsRef(config.thresholds);
  return d ? `${ia}|${d}` : ia;
}

/** Éléments documentaires de la décision (preuves déjà lues). */
export interface RelevanceInput {
  accountId: number;
  fileId: number;
  rule: ProcessingRule;
  documentType: string | null;
  candidates: PertinenceCandidate[];
  today: string;
  decide?: DecideFn;
  /** Titre lu du document : contexte de la décision (oriente, ne prouve pas). */
  documentTitle?: string | null;
  /** Autres dates fiables du document. */
  contextDates?: Array<{ key: string; iso: string; confidence?: string }>;
  /** Empreinte des preuves (mémoire de décision). */
  evidenceFingerprint?: string | null;
  config?: T4AssessmentConfig;
  /** Décision mémorisée (dernière évaluation de la règle). */
  remembered?: RememberedDecision | null;
  /** Plusieurs valeurs FIABLES (faits certains) contradictoires : arbitrage justifié. */
  contradictory?: boolean;
}

/**
 * Pertinence d'une question sur une donnée d'ÉCHÉANCE — décision centrale
 * AUTO_RESOLVED / NO_ACTION / DEFER / CREATE_ACTION (lot 61). Hybride :
 *
 *   CODE (déterministe, sans IA)
 *     · date future proche (≤ 120 j) → la donnée compte maintenant :
 *       CREATE_ACTION (question / arbitrage) ;
 *     · date future lointaine → DEFER jusqu'à l'approche (aucune carte) ;
 *     · aucune date, document dont toutes les dates fiables ont plus de
 *       5 ans → NO_ACTION (la lacune est conservée, le contrat n'est JAMAIS
 *       déclaré terminé) ;
 *     · date suggérée par le seul TITRE : jamais une preuve — au mieux DEFER
 *       (jamais NO_ACTION sur ce seul indice) ;
 *   IA (T4 CLASSIFY_EVENT, `t4_output_v3`)
 *     · échéance passée, ou date inconnue d'un document récent : T4 dit
 *       quelle intervention CONCRÈTE est attendue (preuve à l'appui, contrôlée
 *       par `checkInterventionCoherence`) : oui → carte décrivant l'action
 *       réelle (jamais une question de date) ou question de date si la date
 *       elle-même est nécessaire ; non → NO_ACTION ; incertain → DEFER ;
 *   VARIANTE PRUDENTE
 *     · échec technique → DEFER court, une carte active n'est PAS fermée ;
 *     · version T4 active antérieure (v1 / v2, sans évaluation structurée) :
 *       échéance passée « action » → DEFER (intervention non identifiée,
 *       signalée au BO) ; date inconnue d'un document récent → question
 *       maintenue (comportement antérieur), sans appel IA inutile.
 */
export async function assessDeadlinePertinence(p: RelevanceInput): Promise<PertinenceResult> {
  const vide = { aiCalled: false, cached: false, aiStatus: null, aiTraceId: null, intervention: null, technicalFailure: false } as const;
  const config: T4AssessmentConfig = p.config ?? { ref: 'unknown', interventionCapable: false };
  // Lot 63 : seuils réglables (BO), portés par la configuration effective.
  const { futureHorizonDays: FUTURE_HORIZON_DAYS, historicalYears: HISTORICAL_YEARS, deferUncertainDays: DEFER_UNCERTAIN_DAYS,
    deferUndatedDays: DEFER_UNDATED_DAYS, deferTitleOnlyDays: DEFER_TITLE_ONLY_DAYS } = thresholdsOf(config);
  const key = p.rule.fieldKey ?? '';
  const res = (r: Omit<PertinenceResult, 'contract' | keyof typeof vide> & Partial<Pick<PertinenceResult, keyof typeof vide>>): PertinenceResult => {
    const full = { ...vide, ...r } as PertinenceResult;
    return { ...full, contract: decisionContractOf(p, full) };
  };
  if (!isDeadlineRule(p.rule)) {
    return res({ pertinence: 'NOT_EVALUATED', reason: 'rule_without_deadline', signature: null, outcome: null, situation: 'NOT_DEADLINE', card: null, reevaluateAt: null });
  }

  const cands = p.candidates.filter((c) => !!c.iso);
  // Écart 7 : la date du TITRE seul est un indice, jamais une preuve.
  const preuves = cands.filter((c) => c.source !== 'TITLE_ONLY');
  const indicesTitre = cands.filter((c) => c.source === 'TITLE_ONLY');

  // ── Date(s) future(s) : déterministe, sans IA ─────────────────────────────
  const futures = preuves.filter((c) => c.iso >= p.today).map((c) => c.iso).sort();
  if (futures.length) {
    // Contradiction entre valeurs fiables : l'arbitrage est justifié maintenant
    // (aucune valeur ne peut être retenue, aucun rappel ne serait juste).
    if (p.contradictory) {
      return res({ pertinence: 'CONTRADICTION', reason: 'contradictory_reliable_values', signature: null, outcome: 'CREATE_ACTION', situation: 'FUTURE_DEADLINE', card: 'DATA_QUESTION', reevaluateAt: null });
    }
    const proche = futures[0];
    const delai = joursEntre(p.today, proche);
    if (delai <= FUTURE_HORIZON_DAYS) {
      return res({ pertinence: 'FUTURE_SOON', reason: `future_within_${FUTURE_HORIZON_DAYS}d`, signature: null, outcome: 'CREATE_ACTION', situation: 'FUTURE_DEADLINE', card: 'DATA_QUESTION', reevaluateAt: null });
    }
    return res({
      pertinence: 'FUTURE_DEFERRABLE', reason: `future_beyond_${FUTURE_HORIZON_DAYS}d`, signature: null, outcome: 'DEFER', situation: 'FUTURE_DEADLINE',
      card: null, reevaluateAt: aMinuit(plusJours(proche, -FUTURE_HORIZON_DAYS)),
    });
  }

  const situation: RelevanceSituation = preuves.length ? 'PAST_DEADLINE' : indicesTitre.length ? 'TITLE_ONLY' : 'UNDATED';

  // ── Date inconnue : document historique (déterministe) ────────────────────
  if (situation !== 'PAST_DEADLINE') {
    const datesFiables = (p.contextDates ?? []).map((d) => d.iso);
    const seuil = plusJours(p.today, -Math.round(HISTORICAL_YEARS * 365.25));
    if (datesFiables.length > 0 && datesFiables.every((d) => d < seuil)) {
      return res({
        pertinence: 'UNDATED_HISTORICAL', reason: `all_document_dates_older_than_${HISTORICAL_YEARS}y`, signature: null,
        outcome: situation === 'TITLE_ONLY' ? 'DEFER' : 'NO_ACTION', situation, card: null,
        reevaluateAt: situation === 'TITLE_ONLY' ? aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) : null,
      });
    }
    if (!config.interventionCapable) {
      // Version T4 active sans évaluation structurée : aucune décision fiable
      // possible par l'IA → comportement antérieur pour un document sans date
      // (question), mais jamais une question sur la seule foi d'un titre.
      return situation === 'TITLE_ONLY'
        ? res({ pertinence: 'TITLE_HINT_ONLY', reason: 'title_only_no_t4_assessment', signature: null, outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) })
        : res({ pertinence: 'FUTURE_OR_UNDATED', reason: 'undated_no_t4_assessment', signature: null, outcome: 'CREATE_ACTION', situation, card: 'DATA_QUESTION', reevaluateAt: null });
    }
  }

  // ── Décision mémorisée pour les mêmes éléments ────────────────────────────
  const signature = pertinenceSignature(key, p.documentType, cands, { situation, evidence: p.evidenceFingerprint ?? null, config: pertinenceConfigKey(config) });
  const m = p.remembered;
  if (m && m.signature === signature && m.outcome && m.pertinence && m.aiStatus !== 'ERROR') {
    return res({
      pertinence: m.pertinence as Pertinence, reason: 'remembered_decision', signature, cached: true, outcome: m.outcome, situation,
      card: m.card ?? (m.outcome === 'CREATE_ACTION' ? 'DATA_QUESTION' : null), intervention: m.intervention ?? null,
      reevaluateAt: m.outcome === 'DEFER' ? (m.reevaluateAt ?? aMinuit(plusJours(p.today, DEFER_UNCERTAIN_DAYS))) : null,
    });
  }

  // ── IA : T4 CLASSIFY_EVENT ────────────────────────────────────────────────
  const def = getField(key);
  const latest = [...(preuves.length ? preuves : indicesTitre)].sort((a, b) => b.iso.localeCompare(a.iso))[0] ?? null;
  const request = config.interventionCapable ? {
    contractVersion: DECISION_CONTRACT_VERSION, situation, dataKey: key, question: p.rule.question, today: p.today,
    candidates: cands.slice(0, 10).map((c) => ({ date: c.iso, source: c.source })),
    documentDates: (p.contextDates ?? []).slice(0, 10).map((d) => ({ key: d.key, date: d.iso })),
    documentTitle: p.documentTitle ?? null,
  } : null;
  const description = [
    situation === 'PAST_DEADLINE' ? `Échéance passée (date du jour : ${p.today}).`
      : situation === 'TITLE_ONLY' ? `Date suggérée uniquement par le titre ou le nom du document, non retrouvée dans son contenu (date du jour : ${p.today}).`
        : `Date inconnue (date du jour : ${p.today}).`,
    preuves.length ? `Date lue dans le document (${[...new Set(preuves.map((c) => c.source))].join(', ')}).` : '',
    `Question qui serait posée à l'utilisateur : « ${p.rule.question} »`,
    p.documentTitle ? `Document : « ${p.documentTitle} ».` : '',
  ].filter(Boolean).join(' ');
  const excerpt = (latest?.excerpt ?? p.documentTitle ?? '').slice(0, 500) || undefined;
  const decide: DecideFn = p.decide ?? (await import('@/services/ai/agenda/master/classify-event')).decideAgendaEvent;
  const d = await decide(
    {
      title: def?.label ?? key, description, originType: 'qualified_document', originFieldKey: key,
      nature: 'DEADLINE', businessType: def?.agendaEffect?.businessType ?? null,
    },
    {
      accountId: p.accountId, sourceFileId: p.fileId, date: latest?.iso ?? null, documentType: p.documentType,
      excerpt, recurrenceCandidate: null, toProcessAssessment: request,
    },
  );
  const ia = { aiCalled: true, cached: false, aiTraceId: d.traceId ?? null, signature };
  if (d.outcome === 'technical_failure') {
    // Écart 5 : une panne n'est jamais une décision. Réessai rapide, aucune fermeture.
    const at = new Date(Date.now() + RETRY_AFTER_FAILURE_MIN * 60_000).toISOString();
    return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: `t4_failure:${d.error?.code ?? 'UNKNOWN'}`, outcome: 'DEFER', situation, card: null, reevaluateAt: at, technicalFailure: true });
  }
  const motif = (s: string) => s.slice(0, 300);
  const iv = checkInterventionCoherence(d.intervention, { requested: !!request, providedText: [description, excerpt ?? '', p.documentTitle ?? ''].join(' ') });

  if (request && d.contractVersion === 3 && iv) {
    // ── Évaluation structurée (t4_output_v3), contrôlée ────────────────────
    if (iv.needed === 'yes') {
      const donnee = iv.kind === 'PROVIDE_INFORMATION';
      if (iv.timing === 'LATER') {
        const quand = iv.actBy ? plusJours(iv.actBy, -DEFER_UNCERTAIN_DAYS) : plusJours(p.today, DEFER_UNDATED_DAYS);
        return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'ACTION_REQUIRED' : 'UNDATED_NEEDED',
          reason: motif(`t4:intervention_later:${iv.justification}`), outcome: 'DEFER', situation, card: null,
          reevaluateAt: aMinuit(quand > p.today ? quand : plusJours(p.today, 1)) });
      }
      if (donnee && iv.dataNeeded === false) {
        return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDATED_NOT_NEEDED', reason: motif(`t4:data_not_needed:${iv.justification}`),
          outcome: situation === 'TITLE_ONLY' ? 'DEFER' : 'NO_ACTION', situation, card: null,
          reevaluateAt: situation === 'TITLE_ONLY' ? aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) : null });
      }
      return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'ACTION_REQUIRED' : 'UNDATED_NEEDED',
        reason: motif(`t4:intervention:${iv.kind}:${iv.justification}`), outcome: 'CREATE_ACTION', situation,
        card: donnee ? 'DATA_QUESTION' : 'INTERVENTION', reevaluateAt: null });
    }
    if (iv.needed === 'no') {
      // Écart 7 : jamais « sans intervention » sur la seule foi du titre.
      return situation === 'TITLE_ONLY'
        ? res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'TITLE_HINT_ONLY', reason: motif(`t4:no_intervention_title_only:${iv.justification}`), outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) })
        : res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: situation === 'PAST_DEADLINE' ? 'NO_ACTION_NEEDED' : 'UNDATED_NOT_NEEDED',
          reason: motif(`t4:no_intervention:${iv.justification}`), outcome: 'NO_ACTION', situation, card: null, reevaluateAt: null });
    }
    return res({ ...ia, aiStatus: 'OK', intervention: iv, pertinence: 'UNDECIDED', reason: motif(`t4:uncertain:${iv.warnings.join(',') || iv.justification}`),
      outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, situation === 'PAST_DEADLINE' ? DEFER_UNCERTAIN_DAYS : DEFER_UNDATED_DAYS)) });
  }

  if (request) {
    // Évaluation demandée mais non rendue ou rejetée (sortie hors contrat,
    // bloc vide) : sortie IA invalide — prudence : aucune carte créée, une
    // carte existante n'est PAS retirée (aucun risque supprimé en silence),
    // nouvelle tentative le lendemain.
    return res({ ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: motif(`t4:assessment_missing:${d.reason}`), outcome: 'DEFER', situation, card: null,
      reevaluateAt: aMinuit(plusJours(p.today, 1)), technicalFailure: true });
  }

  // ── Échéance passée, version T4 sans évaluation structurée (v1 / v2) ──────
  if (d.agendaDecision === 'accept' && d.classification.category === 'information') {
    return situation === 'TITLE_ONLY'
      ? res({ ...ia, aiStatus: 'OK', pertinence: 'TITLE_HINT_ONLY', reason: motif(`t4:information_title_only:${d.reason}`), outcome: 'DEFER', situation, card: null, reevaluateAt: aMinuit(plusJours(p.today, DEFER_TITLE_ONLY_DAYS)) })
      : res({ ...ia, aiStatus: 'OK', pertinence: 'NO_ACTION_NEEDED', reason: motif(`t4:information:${d.reason}`), outcome: 'NO_ACTION', situation, card: null, reevaluateAt: null });
  }
  if (d.agendaDecision === 'accept' && d.classification.category === 'action') {
    // Écart 2 : action attendue mais NON identifiée (pas de contrat v3) —
    // jamais une fausse question de date : décision différée, signalée.
    return res({ ...ia, aiStatus: 'OK', pertinence: 'ACTION_REQUIRED', reason: motif(`t4:action_not_identified:${d.reason}`), outcome: 'DEFER', situation, card: null,
      reevaluateAt: aMinuit(plusJours(p.today, DEFER_UNCERTAIN_DAYS)) });
  }
  return res({ ...ia, aiStatus: 'OK', pertinence: 'UNDECIDED', reason: motif(`t4:${d.agendaDecision}:${d.reason}`), outcome: 'DEFER', situation, card: null,
    reevaluateAt: aMinuit(plusJours(p.today, DEFER_UNCERTAIN_DAYS)) });
}

/** Contrat de décision interne (§5) — pur. */
export function decisionContractOf(p: Pick<RelevanceInput, 'rule' | 'fileId' | 'documentType' | 'today' | 'candidates'> & { config?: T4AssessmentConfig }, r: Omit<PertinenceResult, 'contract'>): DecisionContract {
  const iso = p.candidates.map((c) => c.iso).sort();
  const future = iso.filter((d) => d >= p.today)[0] ?? null;
  const sources = [...new Set(p.candidates.map((c) => c.source))];
  const fiables = p.candidates.filter((c) => c.source !== 'TITLE_ONLY' && c.source !== 'TITLE_CONFIRMED');
  return {
    version: DECISION_CONTRACT_VERSION, ruleCode: p.rule.code, dataKey: p.rule.fieldKey ?? p.rule.relationKey ?? '', fileId: p.fileId,
    documentType: p.documentType,
    problem: r.card === 'INTERVENTION' ? 'DEADLINE_INTERVENTION' : p.candidates.length ? 'UNCERTAIN_DATA' : 'MISSING_DATA',
    intervention: r.intervention && r.intervention.needed === 'yes' ? { kind: r.intervention.kind, action: r.intervention.action, actBy: r.intervention.actBy } : null,
    consequence: r.intervention?.consequence ?? null,
    autoResolution: p.candidates.length ? 'valeurs incertaines ou contradictoires : aucune n’est assez fiable pour être écrite'
      : 'aucune valeur lue, consolidée ni calculable de façon fiable',
    temporal: { situation: r.situation, today: p.today, candidates: iso.slice(0, 10), nearestFuture: future, reevaluateAt: r.reevaluateAt },
    reliability: {
      level: fiables.length && fiables.every((c) => c.source === 'FACTS') ? 'HIGH' : fiables.length ? 'MEDIUM' : 'LOW',
      sources, evidence: r.intervention?.evidence ?? null,
    },
    decision: r.outcome, motive: r.reason,
    // Lot 63 : seuils utilisés pour cette décision (traçage, diagnostic BO).
    thresholds: thresholdsOf(p.config),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CONFIGURATION IA ET RÉVISION DE LA CONNAISSANCE (écart 4)
// ══════════════════════════════════════════════════════════════════════════

let configCache: { at: number; value: T4AssessmentConfig } | null = null;

/**
 * Lot 63 — configuration complétée des seuils effectifs (pure) : `aiRef`
 * garde la référence IA, `ref` (écrite dans `config_ref`) y ajoute les seuils
 * modifiés — un réglage changé invalide les décisions NO_ACTION / DEFER
 * mémorisées (`documentsToReevaluate`).
 */
export function withThresholds(c: T4AssessmentConfig, thresholds: ToProcessThresholds): T4AssessmentConfig {
  const aiRef = c.aiRef ?? c.ref;
  return { ...c, aiRef, ref: composeConfigRef(aiRef, thresholds), thresholds };
}

/** Réservé aux tests : configuration T4 imposée (`null` : lecture réelle). */
let configOverride: T4AssessmentConfig | null = null;
export function __setT4AssessmentConfigForTests(c: T4AssessmentConfig | null): void { configOverride = c; configCache = null; }

/**
 * Configuration T4 effective (lue au plus toutes les 60 s) : version ACTIVE
 * du BO (numéro + contrat de sortie), sinon défaut du texte du dépôt. Une
 * activation dans le BO change la référence : les décisions mémorisées sont
 * réévaluées (écart 4, « changement pertinent de configuration IA »).
 */
export async function t4AssessmentConfig(): Promise<T4AssessmentConfig> {
  if (configOverride) return configOverride;
  if (configCache && Date.now() - configCache.at < 60_000) return configCache.value;
  let value: T4AssessmentConfig = { ref: 'unknown', interventionCapable: false };
  // Lot 63 : seuils « À traiter » effectifs (BO > environnement > défaut ; ne lève jamais).
  const thresholds = await loadToProcessThresholds();
  try {
    const [{ loadActiveMasterPrompts }, { getAiEnvironment }, { structuredSpecFor, normalizeExecutionConfig }] = await Promise.all([
      import('@/services/ai/master-prompts/master-prompt-runtime'), import('@/services/ai/config/environment'),
      import('@/services/ai/master-prompts/structured-context'),
    ]);
    const spec = structuredSpecFor('t4_master_v1');
    const active = (await loadActiveMasterPrompts(getAiEnvironment())).get('T4');
    const contrat = active
      ? normalizeExecutionConfig(active.execution ?? null).outputContractVersion
      : spec?.defaults.outputContractVersion ?? null;
    const n = contrat ? Number(/_v(\d+)$/.exec(contrat)?.[1] ?? 0) : 0;
    value = { ref: active ? `bo:v${active.versionNumber}:${contrat ?? 'legacy'}` : `repo:${contrat ?? 'legacy'}`, interventionCapable: n >= 3 };
  } catch (e) {
    console.warn('[to-process] configuration T4 illisible (décision prudente) :', errMsg(e));
  }
  value = withThresholds(value, thresholds);
  configCache = { at: Date.now(), value };
  return value;
}

let couches: { at: number; units: boolean } | null = null;

/**
 * Expression SQL de la RÉVISION de la connaissance d'un document (alias `f`
 * = asset_files) : type, extraction, faits actifs, faits non intégrés,
 * unités source, valeurs retenues (dont celles de l'utilisateur),
 * fournisseur. Elle change à chaque modification T1 / T3 / utilisateur,
 * même sans changement de `asset_files.updated_at` (écart 4).
 */
export async function knowledgeRevSql(alias = 'f'): Promise<string> {
  if (!couches || Date.now() - couches.at > 300_000) {
    let units = false;
    try {
      const [r] = (await pgClient.unsafe(
        `SELECT to_regclass('document_source_units') IS NOT NULL AND to_regclass('document_unresolved_facts') IS NOT NULL AS ok`,
      )) as unknown as Array<{ ok: boolean }>;
      units = r?.ok === true;
    } catch { units = false; }
    couches = { at: Date.now(), units };
  }
  const a = alias;
  return `md5(concat_ws('|', ${a}.document_type_code,
      (SELECT max(e.id)::text FROM document_extractions e WHERE e.file_id = ${a}.id),
      (SELECT count(*)::text || ':' || COALESCE(max(x.id), 0)::text FROM document_facts x WHERE x.file_id = ${a}.id AND x.status = 'active'),
      ${couches.units ? `(SELECT count(*)::text || ':' || COALESCE(max(u.id), 0)::text FROM document_unresolved_facts u WHERE u.file_id = ${a}.id),
      (SELECT count(*)::text || ':' || COALESCE(max(s.updated_at)::text, '') FROM document_source_units s WHERE s.file_id = ${a}.id),` : ''}
      (SELECT string_agg(v.field_key || '=' || COALESCE(v.value_text, '-') || ':' || v.user_validated::text, ',' ORDER BY v.field_key)
         FROM document_field_values v WHERE v.file_id = ${a}.id),
      ${a}.supplier, COALESCE(${a}.user_edited_fields::text, '')))`;
}

/** Révision actuelle de la connaissance d'un document (même expression que le balayage). */
export async function currentKnowledgeRev(accountId: number, fileId: number): Promise<string | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT ${await knowledgeRevSql('f')} AS rev FROM asset_files f WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ rev: string | null }>;
  return r?.rev ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC PAR RÈGLE (migrations 0418, 0444) — jamais bloquant
// ══════════════════════════════════════════════════════════════════════════

export type RuleTrigger = 'ANALYSIS' | 'SWEEP' | 'T3' | 'USER' | 'BACKFILL';
export type RuleDecision = 'WRITE' | 'CREATE' | 'UPDATE' | 'KEEP' | 'CLOSE' | 'NONE' | 'ERROR';
/** Lot 61 : issue centrale tracée (KEEP : carte maintenue sans nouvelle décision ; ERROR : panne). */
export type RuleOutcome = RelevanceOutcome | 'KEEP' | 'ERROR';

export interface RuleEvaluationRecord {
  accountId: number;
  fileId: number;
  ruleCode: string;
  fieldKey: string | null;
  trigger: RuleTrigger;
  runRef?: string | null;
  targetPresent: boolean | null;
  userValidated: boolean | null;
  sources?: Record<string, number>;
  missingSources?: string[];
  observations?: EvidenceObservation[];
  proposals?: Array<{ value: unknown; confidence: number }>;
  titleHint?: FieldEvidence['titleHint'];
  pertinence?: PertinenceResult | null;
  decision: RuleDecision;
  reasonCode: string;
  actionId?: number | null;
  writeVerified?: boolean | null;
  error?: string | null;
  failedStep?: string | null;
  // ── Lot 61 (0444) ─────────────────────────────────────────────────────────
  outcome?: RuleOutcome | null;
  reevaluateAt?: string | null;
  evidenceFingerprint?: string | null;
  knowledgeRev?: string | null;
  configRef?: string | null;
  derivation?: unknown;
  writeResult?: { attempted: boolean; confirmed: boolean | null; status: string; value?: unknown; valueKind?: string | null } | null;
  actionIds?: { created?: number[]; kept?: number[]; closed?: number[]; intervention?: number[] } | null;
  errorKind?: string | null;
}

let tablePresente: boolean | null = null;
let tableVerifieeA = 0;
let colonnes61: boolean | null = null;

/** Table 0418 présente ? (relue au plus toutes les 5 minutes). Lot 61 : colonnes 0444 aussi. */
export async function ruleEvaluationsReady(): Promise<boolean> {
  if (tablePresente !== null && Date.now() - tableVerifieeA < 300_000) return tablePresente;
  try {
    const [r] = (await pgClient.unsafe(
      `SELECT to_regclass('document_rule_evaluations') IS NOT NULL AS ok,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'document_rule_evaluations' AND column_name = 'outcome') AS l61`,
    )) as unknown as Array<{ ok: boolean; l61: boolean }>;
    tablePresente = r?.ok === true;
    colonnes61 = r?.l61 === true;
  } catch { tablePresente = false; colonnes61 = false; }
  tableVerifieeA = Date.now();
  return tablePresente;
}

/** Colonnes de décision du lot 61 (0444) présentes ? */
export async function relevanceColumnsReady(): Promise<boolean> {
  await ruleEvaluationsReady();
  return colonnes61 === true;
}

/** Décision mémorisée (dernière évaluation décisive d'une règle). */
export interface RememberedDecision {
  signature: string | null;
  pertinence: string | null;
  outcome?: RelevanceOutcome | null;
  card?: PertinenceResult['card'];
  intervention?: InterventionDecision | null;
  reevaluateAt?: string | null;
  aiStatus?: string | null;
}

/**
 * Dernière décision de pertinence mémorisée pour une règle d'un document.
 * Lot 61 (écart 5) : une lecture en échec est LEVÉE — jamais confondue avec
 * « aucune mémoire » (qui relancerait l'IA sans raison).
 */
export async function rememberedPertinence(accountId: number, fileId: number, ruleCode: string): Promise<RememberedDecision | null> {
  if (!(await ruleEvaluationsReady())) return null;
  const l61 = await relevanceColumnsReady();
  const [r] = (await pgClient.unsafe(
    `SELECT pertinence_signature AS signature, pertinence, ai_status AS "aiStatus"
            ${l61 ? `, outcome, decision_contract AS contract, reevaluate_at AS "reevaluateAt"` : ''}
       FROM document_rule_evaluations
      WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 AND pertinence_signature IS NOT NULL
        AND ${l61 ? `outcome IN ('NO_ACTION', 'DEFER', 'CREATE_ACTION')` : `pertinence IN ('NO_ACTION_NEEDED', 'ACTION_REQUIRED')`}
      ORDER BY id DESC LIMIT 1`,
    [accountId, fileId, ruleCode] as never[],
  )) as unknown as Array<{ signature: string | null; pertinence: string | null; aiStatus: string | null; outcome?: RelevanceOutcome | null; contract?: unknown; reevaluateAt?: Date | string | null }>;
  if (!r) return null;
  const c = (typeof r.contract === 'string' ? JSON.parse(r.contract) : r.contract) as (DecisionContract & { card?: PertinenceResult['card']; interventionDetail?: InterventionDecision | null }) | null | undefined;
  return {
    signature: r.signature, pertinence: r.pertinence, aiStatus: r.aiStatus,
    // Ligne 58B (sans issue) : NO_ACTION_NEEDED → NO_ACTION ; ACTION_REQUIRED non réutilisée (non identifiée).
    outcome: r.outcome ?? (r.pertinence === 'NO_ACTION_NEEDED' ? 'NO_ACTION' : null),
    card: c?.card ?? null, intervention: c?.interventionDetail ?? null,
    reevaluateAt: r.reevaluateAt ? new Date(r.reevaluateAt).toISOString() : null,
  };
}

/** Signature d'une évaluation (hors déclencheur, référence d'exécution et date de réévaluation). Pure. */
export function evaluationSignature(r: RuleEvaluationRecord): string {
  return createHash('sha1').update(JSON.stringify([
    r.decision, r.reasonCode, r.targetPresent, r.userValidated, r.sources ?? {}, r.missingSources ?? [],
    (r.observations ?? []).map((o) => [o.source, o.normalized, o.status]), (r.proposals ?? []).map((p) => [p.value, p.confidence]),
    r.titleHint ?? null, r.pertinence?.pertinence ?? null, r.pertinence?.signature ?? null, r.actionId ?? null, r.error ?? null,
    // Lot 61 : issue, intervention, écriture et cartes — tout changement significatif crée une ligne.
    r.outcome ?? null, r.pertinence?.intervention ? [r.pertinence.intervention.needed, r.pertinence.intervention.kind, r.pertinence.intervention.action] : null,
    r.writeResult?.status ?? null, r.actionIds ?? null, r.errorKind ?? null, r.evidenceFingerprint ?? null, r.configRef ?? null,
  ])).digest('hex').slice(0, 24);
}

/** Nombre de passages conservés sur une évaluation dédupliquée. */
const PASSAGES_MAX = 20;

/**
 * Journalise une évaluation. Une réévaluation identique (même signature que
 * la dernière ligne de la règle) ne fait que dater le constat — lot 61
 * (écart 6) : chaque passage est conservé (`passages`, ≤ 20 : déclencheur,
 * référence, date), la date de réévaluation et la révision de connaissance
 * sont mises à jour. Ne lève jamais : un diagnostic manqué ne bloque pas la
 * décision.
 */
export async function recordRuleEvaluation(r: RuleEvaluationRecord): Promise<void> {
  if (!(await ruleEvaluationsReady())) return;
  const l61 = await relevanceColumnsReady();
  const signature = evaluationSignature(r);
  const passage = JSON.stringify([{ at: new Date().toISOString(), trigger: r.trigger, runRef: r.runRef ?? null }]);
  try {
    const maj = (await pgClient.unsafe(
      `UPDATE document_rule_evaluations SET last_seen_at = now(), seen_count = seen_count + 1, trigger_code = $5, run_ref = COALESCE($6, run_ref)
              ${l61 ? `, passages = (SELECT COALESCE(jsonb_agg(z.p ORDER BY z.n), '[]'::jsonb) FROM (
                          SELECT p, n FROM jsonb_array_elements($7::jsonb || COALESCE(passages, '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
                           ORDER BY n LIMIT ${PASSAGES_MAX}) z),
                 reevaluate_at = $8::timestamptz, knowledge_rev = COALESCE($9, knowledge_rev)` : ''}
        WHERE id = (SELECT id FROM document_rule_evaluations WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 ORDER BY id DESC LIMIT 1)
          AND signature = $4
        RETURNING id`,
      (l61
        ? [r.accountId, r.fileId, r.ruleCode, signature, r.trigger, r.runRef ?? null, passage, r.reevaluateAt ?? null, r.knowledgeRev ?? null]
        : [r.accountId, r.fileId, r.ruleCode, signature, r.trigger, r.runRef ?? null]) as never[],
    )) as unknown as Array<{ id: number }>;
    if (maj.length) return;
    const j = (v: unknown) => JSON.stringify(v);
    const p = r.pertinence ?? null;
    const cols = ['account_id', 'file_id', 'rule_code', 'field_key', 'trigger_code', 'run_ref', 'engine_version',
      'target_present', 'user_validated', 'sources', 'missing_sources', 'observations', 'proposals', 'title_hint', 'pertinence', 'pertinence_reason',
      'ai_operation', 'ai_trace_id', 'ai_status', 'decision', 'reason_code', 'action_id', 'write_verified', 'error', 'failed_step', 'signature', 'pertinence_signature'];
    const vals: unknown[] = [
      r.accountId, r.fileId, r.ruleCode, r.fieldKey, r.trigger, r.runRef ?? null, DOCUMENT_RULE_ENGINE_VERSION,
      r.targetPresent, r.userValidated, j(r.sources ?? {}), j(r.missingSources ?? []), j((r.observations ?? []).slice(0, 30)),
      j((r.proposals ?? []).slice(0, 10).map((x) => ({ value: court(x.value), confidence: x.confidence }))), r.titleHint ? j(r.titleHint) : null,
      p?.pertinence ?? null, court(p?.reason, 300), p?.aiCalled ? 't4_classify_event' : null, court(p?.aiTraceId, 80), p?.aiStatus ?? null,
      r.decision, r.reasonCode, r.actionId ?? null, r.writeVerified ?? null, court(r.error, 300), r.failedStep ?? null, signature, p?.signature ?? null,
    ];
    const casts: Record<string, string> = { sources: '::jsonb', missing_sources: '::jsonb', observations: '::jsonb', proposals: '::jsonb', title_hint: '::jsonb' };
    if (l61) {
      const contrat = p?.contract ? { ...p.contract, card: p.card, interventionDetail: p.intervention } : null;
      cols.push('outcome', 'situation', 'decision_contract', 'reevaluate_at', 'evidence_fingerprint', 'knowledge_rev', 'config_ref',
        'derivation', 'write_result', 'action_ids', 'passages', 'error_kind');
      vals.push(r.outcome ?? null, p?.situation ?? null, contrat ? j(contrat) : null, r.reevaluateAt ?? null, r.evidenceFingerprint ?? null,
        r.knowledgeRev ?? null, r.configRef ?? null, r.derivation ? j(r.derivation) : null, r.writeResult ? j(r.writeResult) : null,
        r.actionIds ? j(r.actionIds) : null, passage, r.errorKind ?? null);
      Object.assign(casts, { decision_contract: '::jsonb', reevaluate_at: '::timestamptz', derivation: '::jsonb', write_result: '::jsonb', action_ids: '::jsonb', passages: '::jsonb' });
    }
    await pgClient.unsafe(
      `INSERT INTO document_rule_evaluations (${cols.join(', ')}) VALUES (${cols.map((c, i) => `$${i + 1}${casts[c] ?? ''}`).join(', ')})`,
      vals as never[],
    );
  } catch (e) {
    console.error(`[to-process] diagnostic de la règle ${r.ruleCode} du document ${r.fileId} non écrit :`, (e as Error).message);
  }
}
