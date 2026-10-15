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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import { getField, resolveAlias } from '@/services/canonical/registry';
import { documentBridgeRules, type ProcessingRule } from './rules-catalog';

/** Version du traitement (diagnostic, BO). */
export const DOCUMENT_RULE_ENGINE_VERSION = 'l58b-1';

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
  missing: string[];
  observations: EvidenceObservation[];
  /** Indice du titre / nom de fichier (dates) et dates retrouvées dans le contenu. */
  titleHint: { dates: string[]; confirmed: string[]; excerpt: string | null } | null;
  /** Titre lu du document (contexte transmis à T4 pour la pertinence, ≤ 200 caractères). */
  documentTitle?: string | null;
}

const court = (v: unknown, n = 120) => (v === null || v === undefined ? null : String(v).slice(0, n));

/**
 * Normalise une valeur lue pour la donnée `key` : date → ISO avec statut ;
 * autre donnée → texte. `confidence` est plafonnée à `probable` pour une date
 * dont l'ordre jour / mois reste ambigu. Pure.
 */
export function readValue(key: string, raw: unknown, confidence: string): { value: string | null; confidence: string; status: EvidenceObservation['status'] } {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { value: null, confidence, status: 'EMPTY' };
  if (!isDateKey(key)) return { value: String(raw).trim(), confidence, status: 'TEXT' };
  const p = parseDocumentDate(raw);
  if (!p.iso) return { value: null, confidence, status: p.status };
  return { value: p.iso, confidence: p.status === 'ORDER_AMBIGUOUS' && confidence === 'certain' ? 'probable' : confidence, status: p.status };
}

/**
 * Connaissance T1 PERSISTÉE relative à `key` (lecture seule) : faits actifs,
 * faits non intégrés fiables, unités « libellé : valeur », et — pour une
 * date — indice du titre / nom de fichier vérifié contre le contenu.
 * Jamais le fichier, jamais un nouvel appel T1.
 */
export async function gatherFieldEvidence(accountId: number, fileId: number, key: string): Promise<FieldEvidence> {
  const sources: Record<string, number> = {};
  const missing: string[] = [];
  const facts: EvidenceFact[] = [];
  const observations: EvidenceObservation[] = [];
  const registryLabel = getField(key)?.label ?? null;
  const noter = (source: string, k: string | null, raw: unknown, confidence: string, excerpt?: string | null) => {
    sources[source] = (sources[source] ?? 0) + 1;
    const r = readValue(key, raw, confidence);
    if (observations.length < 30) observations.push({ source, key: k, raw: court(raw), normalized: r.value, status: r.status });
    if (r.value !== null) facts.push({ value: r.value, confidence: r.confidence, excerpt: excerpt ?? null, source });
  };

  const [ext] = (await pgClient.unsafe(
    `SELECT e.id, e.title, f.original_filename AS filename, to_jsonb(f) ->> 'retained_title' AS retained
       FROM asset_files f LEFT JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
      WHERE f.id = $1 AND f.account_id = $2 ORDER BY e.id DESC NULLS LAST LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ id: number | null; title: string | null; filename: string | null; retained: string | null }>;
  if (!ext?.id) return { hasExtraction: false, facts, sources, missing: ['EXTRACTION'], observations, titleHint: null };

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
      if (!t1KeyDesignates(r.canonical, key) && !t1KeyDesignates(r.raw, key) && !(!r.canonical && t1LabelDesignates(r.label, key, registryLabel))) continue;
      // Valeur normalisée d'abord ; une valeur brute non ISO (fait générique
      // requalifié faute de normalisation) est relue ici.
      const brut = r.norm && readValue(key, r.norm, r.confidence).value !== null ? r.norm : (r.text ?? r.norm);
      noter('FACTS', r.canonical ?? r.raw, brut, r.confidence, r.excerpt);
    }
  } catch { missing.push('FACTS'); }

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
        if (!r.value || (!t1KeyDesignates(r.canonical, key) && !t1KeyDesignates(r.raw, key))) continue;
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
        if (!t1LabelDesignates(u.label, key, registryLabel)) continue;
        // Unité lue mais non structurée en fait : proposition, jamais écriture silencieuse.
        noter('SOURCE_UNITS', u.label, u.value, u.coverage === 'UNCERTAIN' ? 'conflictual' : 'probable');
      }
    }
  } catch { missing.push('SOURCE_UNITS'); }

  // ── Indice du titre / nom de fichier (dates seulement) ──────────────────
  let titleHint: FieldEvidence['titleHint'] = null;
  if (isDateKey(key)) {
    const titres = [ext.title, ext.retained, ext.filename].filter((t): t is string => !!t);
    const dates = [...new Set(titres.flatMap((t) => datesMentionedIn(t).map((d) => d.iso)))];
    if (dates.length) {
      try {
        const [t] = (await pgClient.unsafe(
          `SELECT left(full_text, 200000) AS txt FROM document_extractions WHERE id = $1`, [ext.id] as never[],
        )) as unknown as Array<{ txt: string | null }>;
        contenu.push(t?.txt ?? '');
      } catch { missing.push('FULL_TEXT'); }
      const dansContenu = new Set(contenu.flatMap((c) => datesMentionedIn(c).map((d) => d.iso)));
      const confirmed = dates.filter((d) => dansContenu.has(d));
      titleHint = { dates, confirmed, excerpt: court(titres[0], 200) };
      sources.TITLE_HINT = dates.length;
      for (const iso of confirmed) {
        // Date du titre RETROUVÉE dans le contenu : proposition, jamais certaine.
        if (facts.some((f) => f.value === iso)) continue;
        sources.TITLE_CONFIRMED = (sources.TITLE_CONFIRMED ?? 0) + 1;
        if (observations.length < 30) observations.push({ source: 'TITLE_CONFIRMED', key: null, raw: iso, normalized: iso, status: 'NORMALIZED' });
        facts.push({ value: iso, confidence: 'probable', excerpt: court(titres[0], 120), source: 'TITLE_CONFIRMED' });
      }
      for (const iso of dates.filter((d) => !confirmed.includes(d))) {
        if (observations.length < 30) observations.push({ source: 'TITLE_ONLY', key: null, raw: iso, normalized: null, status: 'NOT_A_DATE' });
      }
    }
  }
  return { hasExtraction: true, facts, sources, missing, observations, titleHint, documentTitle: court(ext.title ?? ext.retained ?? ext.filename, 200) };
}

// ══════════════════════════════════════════════════════════════════════════
// PERTINENCE MÉTIER D'UNE ÉCHÉANCE — décision T4 CLASSIFY_EVENT (existante)
// ══════════════════════════════════════════════════════════════════════════

export type Pertinence =
  /** Règle sans échéance : la question vaut par elle-même. */
  | 'NOT_EVALUATED'
  /** Date future, ou aucune date candidate : contrat en cours possible — question utile. */
  | 'FUTURE_OR_UNDATED'
  /** Échéance passée qui exige encore une action (reconduction, obligation…). */
  | 'ACTION_REQUIRED'
  /** Échéance historique, aucune intervention attendue. */
  | 'NO_ACTION_NEEDED'
  /** L'IA s'abstient, refuse la date ou échoue : variante prudente (question maintenue). */
  | 'UNDECIDED';

export interface PertinenceResult {
  pertinence: Pertinence;
  reason: string;
  /** Appel IA effectué (false si décision mémorisée ou sans objet). */
  aiCalled: boolean;
  cached: boolean;
  aiStatus: 'OK' | 'ERROR' | null;
  aiTraceId: string | null;
  signature: string | null;
}

export interface PertinenceCandidate { iso: string; source: string; excerpt?: string | null }

type DecideFn = typeof import('@/services/ai/agenda/master/classify-event').decideAgendaEvent;

/** Date du jour à Paris (AAAA-MM-JJ). */
export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Signature des éléments qui fondent la décision de pertinence (pure). */
export function pertinenceSignature(key: string, documentType: string | null, cands: PertinenceCandidate[]): string {
  const base = [key, documentType ?? '', ...[...new Set(cands.map((c) => `${c.iso}@${c.source}`))].sort()].join('|');
  return createHash('sha1').update(base).digest('hex').slice(0, 20);
}

/**
 * Pertinence d'une question sur une donnée d'ÉCHÉANCE. Pure sur la partie
 * temporelle ; l'IA (T4 CLASSIFY_EVENT, branche existante) ne tranche que
 * le cas d'une échéance entièrement PASSÉE.
 */
export async function assessDeadlinePertinence(p: {
  accountId: number; fileId: number; rule: ProcessingRule; documentType: string | null;
  candidates: PertinenceCandidate[]; today: string; decide?: DecideFn;
  /** Titre lu du document : contexte de la décision (oriente, ne prouve pas). */
  documentTitle?: string | null;
  /** Décision mémorisée pour la même signature (dernière évaluation). */
  remembered?: { signature: string | null; pertinence: string | null } | null;
}): Promise<PertinenceResult> {
  const vide = { aiCalled: false, cached: false, aiStatus: null, aiTraceId: null } as const;
  if (!isDeadlineRule(p.rule)) return { ...vide, pertinence: 'NOT_EVALUATED', reason: 'rule_without_deadline', signature: null };
  const cands = p.candidates.filter((c) => !!c.iso);
  if (cands.length === 0) return { ...vide, pertinence: 'FUTURE_OR_UNDATED', reason: 'no_candidate_date', signature: null };
  if (cands.some((c) => c.iso >= p.today)) return { ...vide, pertinence: 'FUTURE_OR_UNDATED', reason: 'candidate_date_not_past', signature: null };

  const signature = pertinenceSignature(p.rule.fieldKey!, p.documentType, cands);
  if (p.remembered?.signature === signature && (p.remembered.pertinence === 'NO_ACTION_NEEDED' || p.remembered.pertinence === 'ACTION_REQUIRED')) {
    return { ...vide, cached: true, pertinence: p.remembered.pertinence, reason: 'remembered_decision', signature };
  }

  const key = p.rule.fieldKey!;
  const def = getField(key);
  const latest = [...cands].sort((a, b) => b.iso.localeCompare(a.iso))[0];
  const titleOnly = cands.every((c) => c.source === 'TITLE_ONLY');
  const description = [
    `Échéance passée (date du jour : ${p.today}).`,
    titleOnly ? 'Date suggérée uniquement par le titre ou le nom du document, non retrouvée dans son contenu.' : `Date lue dans le document (${[...new Set(cands.map((c) => c.source))].join(', ')}).`,
    `Question qui serait posée à l'utilisateur : « ${p.rule.question} »`,
    p.documentTitle ? `Document : « ${p.documentTitle} ».` : '',
  ].filter(Boolean).join(' ');
  const decide: DecideFn = p.decide ?? (await import('@/services/ai/agenda/master/classify-event')).decideAgendaEvent;
  const d = await decide(
    {
      title: def?.label ?? key, description, originType: 'qualified_document', originFieldKey: key,
      nature: 'DEADLINE', businessType: def?.agendaEffect?.businessType ?? null,
    },
    {
      accountId: p.accountId, sourceFileId: p.fileId, date: latest.iso, documentType: p.documentType,
      excerpt: (latest.excerpt ?? p.documentTitle ?? '').slice(0, 500) || undefined, recurrenceCandidate: null,
    },
  );
  const ia = { aiCalled: true, cached: false, aiTraceId: d.traceId ?? null, signature };
  if (d.outcome === 'technical_failure') {
    return { ...ia, aiStatus: 'ERROR', pertinence: 'UNDECIDED', reason: `t4_failure:${d.error?.code ?? 'UNKNOWN'}` };
  }
  if (d.agendaDecision === 'accept' && d.classification.category === 'information') {
    return { ...ia, aiStatus: 'OK', pertinence: 'NO_ACTION_NEEDED', reason: `t4:information:${d.reason}`.slice(0, 300) };
  }
  if (d.agendaDecision === 'accept' && d.classification.category === 'action') {
    return { ...ia, aiStatus: 'OK', pertinence: 'ACTION_REQUIRED', reason: `t4:action:${d.reason}`.slice(0, 300) };
  }
  return { ...ia, aiStatus: 'OK', pertinence: 'UNDECIDED', reason: `t4:${d.agendaDecision}:${d.reason}`.slice(0, 300) };
}

// ══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC PAR RÈGLE (migration 0418) — jamais bloquant
// ══════════════════════════════════════════════════════════════════════════

export type RuleTrigger = 'ANALYSIS' | 'SWEEP' | 'T3' | 'USER';
export type RuleDecision = 'WRITE' | 'CREATE' | 'UPDATE' | 'KEEP' | 'CLOSE' | 'NONE' | 'ERROR';

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
}

let tablePresente: boolean | null = null;
let tableVerifieeA = 0;

/** Table 0418 présente ? (relue au plus toutes les 5 minutes). */
export async function ruleEvaluationsReady(): Promise<boolean> {
  if (tablePresente !== null && Date.now() - tableVerifieeA < 300_000) return tablePresente;
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('document_rule_evaluations') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    tablePresente = r?.ok === true;
  } catch { tablePresente = false; }
  tableVerifieeA = Date.now();
  return tablePresente;
}

/** Dernière décision de pertinence mémorisée pour une règle d'un document. */
export async function rememberedPertinence(accountId: number, fileId: number, ruleCode: string): Promise<{ signature: string | null; pertinence: string | null } | null> {
  if (!(await ruleEvaluationsReady())) return null;
  try {
    const [r] = (await pgClient.unsafe(
      `SELECT pertinence_signature AS signature, pertinence FROM document_rule_evaluations
        WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 AND pertinence_signature IS NOT NULL
          AND pertinence IN ('NO_ACTION_NEEDED', 'ACTION_REQUIRED')
        ORDER BY id DESC LIMIT 1`,
      [accountId, fileId, ruleCode] as never[],
    )) as unknown as Array<{ signature: string | null; pertinence: string | null }>;
    return r ?? null;
  } catch { return null; }
}

/** Signature d'une évaluation (hors déclencheur et référence d'exécution). Pure. */
export function evaluationSignature(r: RuleEvaluationRecord): string {
  return createHash('sha1').update(JSON.stringify([
    r.decision, r.reasonCode, r.targetPresent, r.userValidated, r.sources ?? {}, r.missingSources ?? [],
    (r.observations ?? []).map((o) => [o.source, o.normalized, o.status]), (r.proposals ?? []).map((p) => [p.value, p.confidence]),
    r.titleHint ?? null, r.pertinence?.pertinence ?? null, r.pertinence?.signature ?? null, r.actionId ?? null, r.error ?? null,
  ])).digest('hex').slice(0, 24);
}

/**
 * Journalise une évaluation. Une réévaluation identique (même signature que
 * la dernière ligne de la règle) ne fait que dater le constat. Ne lève
 * jamais : un diagnostic manqué ne bloque pas la décision.
 */
export async function recordRuleEvaluation(r: RuleEvaluationRecord): Promise<void> {
  if (!(await ruleEvaluationsReady())) return;
  const signature = evaluationSignature(r);
  try {
    const maj = (await pgClient.unsafe(
      `UPDATE document_rule_evaluations SET last_seen_at = now(), seen_count = seen_count + 1, trigger_code = $5, run_ref = COALESCE($6, run_ref)
        WHERE id = (SELECT id FROM document_rule_evaluations WHERE account_id = $1 AND file_id = $2 AND rule_code = $3 ORDER BY id DESC LIMIT 1)
          AND signature = $4
        RETURNING id`,
      [r.accountId, r.fileId, r.ruleCode, signature, r.trigger, r.runRef ?? null] as never[],
    )) as unknown as Array<{ id: number }>;
    if (maj.length) return;
    const j = (v: unknown) => JSON.stringify(v);
    const p = r.pertinence ?? null;
    await pgClient.unsafe(
      `INSERT INTO document_rule_evaluations (account_id, file_id, rule_code, field_key, trigger_code, run_ref, engine_version,
          target_present, user_validated, sources, missing_sources, observations, proposals, title_hint, pertinence, pertinence_reason,
          ai_operation, ai_trace_id, ai_status, decision, reason_code, action_id, write_verified, error, failed_step, signature, pertinence_signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
      [
        r.accountId, r.fileId, r.ruleCode, r.fieldKey, r.trigger, r.runRef ?? null, DOCUMENT_RULE_ENGINE_VERSION,
        r.targetPresent, r.userValidated, j(r.sources ?? {}), j(r.missingSources ?? []), j((r.observations ?? []).slice(0, 30)),
        j((r.proposals ?? []).slice(0, 10).map((x) => ({ value: court(x.value), confidence: x.confidence }))), r.titleHint ? j(r.titleHint) : null,
        p?.pertinence ?? null, court(p?.reason, 300), p?.aiCalled ? 't4_classify_event' : null, court(p?.aiTraceId, 80), p?.aiStatus ?? null,
        r.decision, r.reasonCode, r.actionId ?? null, r.writeVerified ?? null, court(r.error, 300), r.failedStep ?? null, signature, p?.signature ?? null,
      ] as never[],
    );
  } catch (e) {
    console.error(`[to-process] diagnostic de la règle ${r.ruleCode} du document ${r.fileId} non écrit :`, (e as Error).message);
  }
}
