/**
 * Lot 100B — ORACLE structuré d'un cas du corpus et son évaluation (PUR,
 * déterministe : aucune IA ne juge la sortie d'une IA — QUAL-09, R49).
 *
 * Un oracle décrit la vérité attendue, établie sur les SOURCES (pièces du
 * cas, contexte), jamais sur la sortie du modèle testé, un enregistrement
 * historique, un consensus de modèles ou une réponse inventée : faits
 * obligatoires, faits absents, preuves, entités, décisions permises /
 * interdites, critères d'abstention, sources autorisées, équivalences
 * tolérées (`model.ts`, `oracleSchema`).
 *
 * L'évaluation lit la sortie BRUTE du modèle (après validation du schéma par
 * la passerelle) de façon SÉMANTIQUE et non textuelle : montants normalisés
 * en euros (centimes, « 749,00 € », 749 EUR…), dates normalisées
 * (AAAA-MM-JJ, JJ/MM/AAAA, « 10 mai 2026 »), textes sans casse ni accents,
 * équivalences déclarées. Une réponse correcte formulée autrement passe ; un
 * montant omis échoue même si le JSON est valide (recette bloquante n° 1).
 *
 * Elle COMPLÈTE les contrôles serveur de la branche (`evaluators.ts`), qui
 * restent appliqués avec `serverExpected` : l'oracle ne les remplace pas.
 */
import type { Defect } from '../../../qualification/defects';
import { canonicalJson, sha256 } from '../../../qualification/signature';
import type { Oracle, OracleFact } from './model';

// ══════════════════════════════════════════════════════════════════════════
// Empreinte et complétude
// ══════════════════════════════════════════════════════════════════════════

/** Empreinte de l'oracle (SHA-256 du JSON canonique) : l'approbation porte sur CETTE empreinte. */
export function oracleFingerprint(o: Oracle | null | undefined): string | null {
  return o ? sha256(canonicalJson(o)) : null;
}

/** Sources interdites pour certifier un attendu (partie 1/5). */
const SOURCES_INTERDITES = /^(recording|output|sortie|model|modele|modèle|consensus|historique-modele|reponse-modele)\b/i;

/**
 * Ce qui manque à un oracle pour être APPROUVABLE (vide : approuvable). Un
 * oracle sans assertion, un fait critique sans preuve, une preuve tirée de
 * la sortie d'un modèle ne peuvent pas être approuvés.
 */
export function oracleApprovalProblems(o: Oracle | null | undefined): string[] {
  if (!o) return ['aucun oracle : attendu à rédiger depuis les sources'];
  const p: string[] = [];
  const assertions = o.requiredFacts.length + o.absentFacts.length + o.entities.expected.length + o.entities.forbidden.length
    + o.decisions.allowed.length + o.decisions.forbidden.length + (o.abstention.expected !== 'EITHER' ? 1 : 0)
    + (o.serverExpected && Object.keys(o.serverExpected).length ? 1 : 0);
  if (!assertions) p.push('oracle vide : aucun fait, aucune décision, aucun critère d’abstention');
  for (const f of o.requiredFacts) {
    if (f.critical && !f.evidence.length) p.push(`fait critique « ${f.key} » sans preuve ni provenance`);
    for (const e of f.evidence) if (SOURCES_INTERDITES.test(e.source)) p.push(`fait « ${f.key} » : la preuve « ${e.source} » est une sortie de modèle (interdit)`);
  }
  const keys = o.requiredFacts.map((f) => f.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) p.push(`clés de faits dupliquées : ${[...new Set(dup)].join(', ')}`);
  for (const a of o.absentFacts) {
    const contradictoire = o.requiredFacts.find((f) => f.kind === a.kind && sameValue(f, a.value, a.unit ?? null));
    if (contradictoire) p.push(`contradiction : « ${a.key} » est à la fois obligatoire (${contradictoire.key}) et interdit`);
  }
  const both = o.decisions.allowed.filter((d) => o.decisions.forbidden.includes(d));
  if (both.length) p.push(`décision(s) à la fois permise(s) et interdite(s) : ${both.join(', ')}`);
  return p;
}

function sameValue(f: Pick<OracleFact, 'kind' | 'value' | 'unit'>, v: unknown, unit: string | null): boolean {
  if (f.kind === 'AMOUNT') return amountEur(f.value, f.unit ?? null) === amountEur(v, unit);
  if (f.kind === 'DATE') return toIsoDate(f.value) === toIsoDate(v);
  return norm(String(f.value)) === norm(String(v));
}

// ══════════════════════════════════════════════════════════════════════════
// Normalisation
// ══════════════════════════════════════════════════════════════════════════

/** Texte comparable : minuscules, sans accents, espaces normalisés, apostrophes unifiées. */
export function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’ʼ`]/g, "'").replace(/[\s  ]+/g, ' ').trim().toLowerCase();
}

/** Montant en euros (2 décimales) ; `unit` cents/minor : centimes. */
export function amountEur(v: unknown, unit: string | null = null): number | null {
  const centimes = unit != null && /^(cents?|centimes?|minor)$/i.test(unit);
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round((centimes ? v / 100 : v) * 100) / 100;
  if (typeof v === 'string') {
    const p = parseFrenchAmount(v);
    if (p != null) return Math.round((centimes ? p / 100 : p) * 100) / 100;
  }
  return null;
}

/** « 18 500,00 € », « 749 EUR », « 1.234,5 » → nombre ; null sinon. */
export function parseFrenchAmount(s: string): number | null {
  const t = s.replace(/[  ]/g, ' ').replace(/€|eur(os?)?/gi, '').trim();
  if (!/^-?[\d\s.,]+$/.test(t)) return null;
  let x = t.replace(/\s/g, '');
  if (/,\d{1,2}$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(\.|$)/.test(x) && !/\.\d{1,2}$/.test(x)) x = x.replace(/\./g, '');
  else x = x.replace(/,/g, '');
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const MOIS: Record<string, string> = {
  janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12',
};

/** Date normalisée AAAA-MM-JJ (ISO, JJ/MM/AAAA, « 10 mai 2026 ») ; null sinon. */
export function toIsoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = norm(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})(?:er)? ([a-z]+) (\d{4})$/.exec(s);
  if (m && MOIS[m[2]]) return `${m[3]}-${MOIS[m[2]]}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Montants (en euros) cités dans un texte libre. */
export function amountsInText(s: string): number[] {
  const out: number[] = [];
  const re = /(-?\d{1,3}(?:[   .]\d{3})+(?:,\d{1,2})?|-?\d+(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euros?\b)/gi;
  for (const m of s.matchAll(re)) {
    const n = parseFrenchAmount(m[1]);
    if (n != null) out.push(Math.round(n * 100) / 100);
  }
  return out;
}

/** Dates citées dans un texte libre (normalisées). */
export function datesInText(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g)) out.add(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  for (const m of norm(s).matchAll(/\b(\d{1,2})(?:er)? (janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre) (\d{4})\b/g)) {
    out.add(`${m[3]}-${MOIS[m[2]]}-${m[1].padStart(2, '0')}`);
  }
  return [...out];
}

// ══════════════════════════════════════════════════════════════════════════
// Observation d'une sortie (lecture sémantique, toutes opérations)
// ══════════════════════════════════════════════════════════════════════════

interface Scalar { path: string; key: string; value: string | number | boolean; parent: Record<string, unknown> | null }

export interface ObservedAmount { eur: number; path: string; hasEvidence: boolean; key: string | null; entity: string | null }

export interface Observation {
  scalars: Scalar[];
  /** Texte normalisé de toutes les chaînes de la sortie. */
  text: string;
  amounts: ObservedAmount[];
  dates: Array<{ iso: string; path: string; hasEvidence: boolean; key: string | null }>;
  decisions: string[];
  ids: string[];
  sourcesCited: string[];
  abstained: boolean;
}

/** Champs de décision (action, issue, statut, catégorie…) — jamais `task` / `mode`, qui désignent la branche. */
const DECISION_KEY = /^(decision|action|outcome|status|verdict|kind|category|homeCategory|agendaDecision|recurrenceDecision|intent|businessType|documentTypeCode|canonicalType|occurrenceMatch|representation|reasonCode)$/;
const ID_KEY = /(^id$|Id$|Ids$|_id$|_ids$|^ids$|^groups$)/;
const SOURCE_KEY = /^(sourceId|sourceIds|source_id|source_ids|evidenceId|evidenceIds|evidence_ids|sources|sourceRef|sourceRefs)$/;
const ABSTENTION = /(abst|unknown|insuffi|not_?found|no_?answer|no_?information|undetermin|unresolved|ambigu|not_?enough|no_?decision|cannot|aucune?_?reponse)/i;
const CENTS_KEY = /(cents|minor)$/i;
const AMOUNT_KEY = /(amount|price|prix|montant|cost|cout|total|value|normalizedValue)$/i;

function walk(v: unknown, path: string, key: string, parent: Record<string, unknown> | null, out: Scalar[]): void {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, key, parent, out)); return; }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const [k, x] of Object.entries(o)) walk(x, path ? `${path}.${k}` : k, k, o, out);
    return;
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push({ path, key, value: v, parent });
}

const hasExcerpt = (o: Record<string, unknown> | null): boolean => {
  if (!o) return false;
  const e = o.evidence as { excerpt?: unknown } | undefined;
  if (e && typeof e.excerpt === 'string' && e.excerpt.trim()) return true;
  return Array.isArray(o.evidenceSignals) && o.evidenceSignals.length > 0;
};

/** Entité portée par l'objet (cible T1 : `target.targetEntityId`). */
const entityOf = (o: Record<string, unknown> | null): string | null => {
  const t = o?.target as { targetType?: unknown; targetEntityId?: unknown; type?: unknown; entityId?: unknown } | undefined;
  const id = t?.targetEntityId ?? t?.entityId;
  return t && id != null ? `${String(t.targetType ?? t.type ?? '')}:${String(id)}` : null;
};

/** Lecture sémantique d'une sortie (pure). */
export function observeOutput(output: unknown): Observation {
  const scalars: Scalar[] = [];
  walk(output, '', '', null, scalars);
  const amounts: ObservedAmount[] = [];
  const dates: Observation['dates'] = [];
  const decisions = new Set<string>();
  const ids = new Set<string>();
  const sources = new Set<string>();
  const textes: string[] = [];
  for (const s of scalars) {
    const parent = s.parent;
    // Objet porteur de la preuve : la fiche (fait, champ du document, décision de valeur).
    const holder = parent && ('evidence' in parent || 'evidenceSignals' in parent) ? parent : null;
    const keyOfFact = parent && typeof parent.canonicalKey === 'string' ? parent.canonicalKey : parent && typeof parent.key === 'string' ? parent.key : null;
    if (typeof s.value === 'string') {
      textes.push(s.value);
      for (const eur of amountsInText(s.value)) amounts.push({ eur, path: s.path, hasEvidence: hasExcerpt(holder), key: keyOfFact, entity: entityOf(parent) });
      const iso = toIsoDate(s.value);
      if (iso) dates.push({ iso, path: s.path, hasEvidence: hasExcerpt(holder), key: keyOfFact });
      else for (const d of datesInText(s.value)) dates.push({ iso: d, path: s.path, hasEvidence: hasExcerpt(holder), key: keyOfFact });
      // Montant écrit sans devise mais dans un champ monétaire (« 749,00 »).
      if (AMOUNT_KEY.test(s.key) && parent && (parent.canonicalUnit === 'EUR' || parent.kind === 'AMOUNT' || parent.valueType === 'amount')) {
        const n = parseFrenchAmount(s.value);
        if (n != null && !amountsInText(s.value).length) amounts.push({ eur: Math.round(n * 100) / 100, path: s.path, hasEvidence: hasExcerpt(holder), key: keyOfFact, entity: entityOf(parent) });
      }
    }
    if (typeof s.value === 'number') {
      // `document.amountCents.value` : l'unité est portée par le champ parent.
      const parentKey = s.path.replace(/\[\d+\]/g, '').split('.').slice(-2, -1)[0] ?? '';
      const centimes = CENTS_KEY.test(s.key) || (s.key === 'value' && CENTS_KEY.test(parentKey)) || (parent?.canonicalUnit === 'cents') || (s.key === 'normalizedValue' && parent?.kind === 'AMOUNT');
      const euros = !centimes && AMOUNT_KEY.test(s.key) && (parent?.canonicalUnit === 'EUR' || parent?.valueType === 'amount' || /amount|price|prix|montant|cost|total/i.test(s.key));
      if (centimes || euros) {
        const holderMeta = parent && 'value' in parent && 'evidence' in parent ? parent : holder;
        amounts.push({ eur: Math.round((centimes ? s.value / 100 : s.value) * 100) / 100, path: s.path, hasEvidence: hasExcerpt(holderMeta), key: keyOfFact ?? (parentKey || null), entity: entityOf(parent) });
      }
    }
    if (DECISION_KEY.test(s.key) && (typeof s.value === 'string' || typeof s.value === 'boolean')) decisions.add(String(s.value));
    if (ID_KEY.test(s.key) && (typeof s.value === 'number' || typeof s.value === 'string')) ids.add(String(s.value));
    if (SOURCE_KEY.test(s.key) && (typeof s.value === 'string' || typeof s.value === 'number')) sources.add(String(s.value));
  }
  const decs = [...decisions];
  // Abstention : décision explicite d'abstention, ou réponse T2 dont le statut n'est pas « répondue ».
  const statut = scalars.find((s) => s.path === 'status')?.value;
  const abstained = decs.some((d) => ABSTENTION.test(d)) || (typeof statut === 'string' && statut !== 'answered' && /^(insufficient|no_|unknown|not_)/i.test(statut));
  return { scalars, text: norm(textes.join(' \n ')), amounts, dates, decisions: decs, ids: [...ids], sourcesCited: [...sources], abstained };
}

// ══════════════════════════════════════════════════════════════════════════
// Évaluation
// ══════════════════════════════════════════════════════════════════════════

export interface OracleEvaluation {
  defects: Defect[];
  /** Faits critiques en défaut (omission, valeur fausse, sans preuve…) : erreur CRITIQUE (A1). */
  criticalDefects: Defect[];
  abstained: boolean;
  /** Décisions lues (paires adversariales : le discriminant a-t-il changé la décision ?). */
  decisions: string[];
}

const eqValues = (o: Oracle, key: string): Array<string | number | boolean | null> => o.equivalences.filter((e) => e.key === key).flatMap((e) => e.values);

function factPresent(o: Oracle, f: OracleFact, obs: Observation): { present: boolean; withEvidence: boolean; contradiction: string | null; entityMismatch: string | null } {
  const variantes = [f.value, ...eqValues(o, f.key)];
  switch (f.kind) {
    case 'AMOUNT': {
      const cibles = variantes.map((v) => amountEur(v, v === f.value ? f.unit ?? null : null)).filter((n): n is number => n != null);
      const tol = o.amountTolerance;
      const hits = obs.amounts.filter((a) => cibles.some((c) => Math.abs(a.eur - c) <= tol + 1e-9));
      // Contradiction : même clé de fait, autre montant.
      const autres = obs.amounts.filter((a) => a.key === f.key && !cibles.some((c) => Math.abs(a.eur - c) <= tol + 1e-9));
      const ent = f.entity ? hits.filter((h) => h.entity != null) : [];
      return {
        present: hits.length > 0, withEvidence: hits.some((h) => h.hasEvidence),
        contradiction: autres.length ? `${f.key} : ${autres.map((a) => a.eur).join(' / ')} € ≠ ${cibles[0]} €` : null,
        entityMismatch: ent.length && !ent.some((h) => h.entity!.endsWith(`:${f.entity}`) || h.entity === f.entity) ? `${f.key} rattaché à ${ent.map((h) => h.entity).join(', ')} au lieu de ${f.entity}` : null,
      };
    }
    case 'DATE': {
      const cibles = variantes.map(toIsoDate).filter((d): d is string => Boolean(d));
      const hits = obs.dates.filter((d) => cibles.includes(d.iso));
      const autres = obs.dates.filter((d) => d.key === f.key && !cibles.includes(d.iso));
      return { present: hits.length > 0, withEvidence: hits.some((h) => h.hasEvidence), contradiction: autres.length ? `${f.key} : ${autres.map((a) => a.iso).join(' / ')} ≠ ${cibles[0]}` : null, entityMismatch: null };
    }
    case 'STATUS': {
      const ok = variantes.some((v) => obs.decisions.some((d) => norm(d) === norm(String(v))));
      return { present: ok, withEvidence: true, contradiction: null, entityMismatch: null };
    }
    case 'ENTITY': {
      const ok = variantes.some((v) => obs.ids.includes(String(v)));
      return { present: ok, withEvidence: true, contradiction: null, entityMismatch: null };
    }
    case 'NUMBER': {
      const ok = variantes.some((v) => obs.scalars.some((s) => typeof s.value === 'number' && s.value === Number(v)) || obs.text.includes(norm(String(v))));
      return { present: ok, withEvidence: true, contradiction: null, entityMismatch: null };
    }
    case 'BOOLEAN': {
      const ok = obs.scalars.some((s) => s.key === f.key && s.value === f.value);
      const contra = obs.scalars.some((s) => s.key === f.key && typeof s.value === 'boolean' && s.value !== f.value);
      return { present: ok, withEvidence: true, contradiction: contra ? `${f.key} : ${String(!f.value)} ≠ ${String(f.value)}` : null, entityMismatch: null };
    }
    default: {
      const ok = variantes.some((v) => v != null && obs.text.includes(norm(String(v))));
      return { present: ok, withEvidence: true, contradiction: null, entityMismatch: null };
    }
  }
}

function absentPresent(a: Oracle['absentFacts'][number], obs: Observation): boolean {
  switch (a.kind) {
    case 'AMOUNT': { const c = amountEur(a.value, a.unit ?? null); return c != null && obs.amounts.some((x) => Math.abs(x.eur - c) < 1e-9); }
    case 'DATE': { const d = toIsoDate(a.value); return d != null && obs.dates.some((x) => x.iso === d); }
    case 'STATUS': return obs.decisions.some((d) => norm(d) === norm(String(a.value)));
    case 'ENTITY': return obs.ids.includes(String(a.value));
    default: return a.value != null && obs.text.includes(norm(String(a.value)));
  }
}

/**
 * Évalue une sortie contre l'oracle (pur). Chaque écart est un DÉFAUT métier
 * (seuil 0, décision PO n° 14) ; un écart sur un fait critique est aussi
 * relevé comme CRITIQUE (verrou A1, recette 9).
 */
export function evaluateOracle(o: Oracle, output: unknown): OracleEvaluation {
  const obs = observeOutput(output);
  const defects: Defect[] = [];
  const critical: Defect[] = [];
  const add = (d: Defect, crit: boolean) => { defects.push(d); if (crit) critical.push(d); };

  for (const f of o.requiredFacts) {
    const r = factPresent(o, f, obs);
    const lib = f.kind === 'AMOUNT' ? `montant ${f.key} (${String(f.value)}${f.unit && !/^eur$/i.test(f.unit) ? ` ${f.unit}` : ' €'})` : `${f.kind === 'DATE' ? 'date' : 'fait'} ${f.key} (${String(f.value)})`;
    if (!r.present) add({ category: f.kind === 'ENTITY' ? 'ATTRIBUTION' : 'OMISSION', field: f.key, message: `${lib} omis : attendu par l’oracle, absent de la sortie` }, f.critical);
    else if (f.evidenceRequired && !r.withEvidence) add({ category: f.kind === 'DATE' ? 'DATE_WITHOUT_PROOF' : 'INVENTION', field: f.key, message: `${lib} présent sans preuve (extrait non porté)` }, f.critical);
    if (r.contradiction) add({ category: 'INCORRECT_VALUE', field: f.key, message: `contradiction : ${r.contradiction}` }, f.critical);
    if (r.entityMismatch) add({ category: 'ATTRIBUTION', field: f.key, message: `mauvais rattachement : ${r.entityMismatch}` }, f.critical);
  }
  for (const a of o.absentFacts) {
    if (absentPresent(a, obs)) add({ category: a.kind === 'ENTITY' ? 'ATTRIBUTION' : 'INVENTION', field: a.key, message: `valeur interdite présente : ${a.key} = ${String(a.value)}${a.reason ? ` (${a.reason})` : ''}` }, true);
  }
  for (const id of o.entities.forbidden) {
    if (obs.ids.includes(String(id))) add({ category: 'ATTRIBUTION', field: 'entities', message: `mauvais bien / entité : ${String(id)} est interdit pour ce cas` }, true);
  }
  for (const id of o.entities.expected) {
    if (!obs.ids.includes(String(id))) add({ category: 'OMISSION', field: 'entities', message: `entité attendue non résolue : ${String(id)}` }, true);
  }
  // Une décision déclarée équivalente à une décision permise est permise (équivalences tolérées).
  const permises = [...o.decisions.allowed, ...o.equivalences.filter((e) => e.values.some((v) => o.decisions.allowed.some((a) => norm(a) === norm(String(v))))).flatMap((e) => e.values.map(String))];
  if (o.decisions.allowed.length && !obs.decisions.some((d) => permises.some((x) => norm(x) === norm(d)))) {
    add({ category: 'INCORRECT_VALUE', field: 'decision', message: `décision ${obs.decisions.join(', ') || 'absente'} hors des décisions permises (${o.decisions.allowed.join(', ')})` }, true);
  }
  for (const d of obs.decisions.filter((x) => o.decisions.forbidden.some((y) => norm(y) === norm(x)))) {
    add({ category: 'INCORRECT_VALUE', field: 'decision', message: `décision interdite : ${d}` }, true);
  }
  if (o.abstention.expected === 'ANSWER' && obs.abstained) add({ category: 'OMISSION', field: 'abstention', message: 'abstention injustifiée : une réponse fiable existe dans les sources' }, true);
  if (o.abstention.expected === 'ABSTAIN' && !obs.abstained) add({ category: 'INVENTION', field: 'abstention', message: 'réponse affirmée sans fondement fiable : l’abstention était attendue' }, true);
  if (o.allowedSources.length) {
    for (const s of obs.sourcesCited.filter((x) => !o.allowedSources.includes(x))) add({ category: 'INVENTION', field: 'sources', message: `source inventée : ${s}` }, true);
  }
  return { defects, criticalDefects: critical, abstained: obs.abstained, decisions: obs.decisions };
}
