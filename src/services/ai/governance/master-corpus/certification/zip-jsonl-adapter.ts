/**
 * Lot 105B — ADAPTATEUR JSONL du ZIP #601 et RAPPROCHEMENT d'inventaire
 * (ticket P1 « IA auto-amélioration », §2). PUR, sans base, sans écriture.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÉTAT : le ZIP réel (`verebona_corpus_IA_livraison_developpeurs_2026-10-27.zip`)
 * n'est PAS disponible dans le dépôt. Cet adaptateur prépare l'interface et est
 * recetté sur un échantillon SYNTHÉTIQUE aux mêmes volumes (86 historiques +
 * 20 à revalider + 295 nouveaux = 401 ; 15 stress ; 110 paires). La table de
 * correspondance des champs (`JSONL_FIELD_MAP`) et les règles de groupe sont à
 * CONFIRMER sur le ZIP réel (docs/exploitation/promotion-automatique-ia.md,
 * « Ce qu'il faut du ZIP réel ») ; elles se changent ici, en un seul point.
 *
 *   1. `readJsonl` : une ligne = un objet ; ligne illisible SIGNALÉE (jamais
 *      ignorée en silence) ;
 *   2. `adaptJsonl` : champs du ZIP → format d'entrée DOCUMENTÉ de l'importeur
 *      (`importCaseSchema`, avec `inventoryGroup`), puis l'importeur existant
 *      fait la conversion (aucune approbation par import, aucune suppression,
 *      rapport ligne par ligne) ;
 *   3. `reconcileInventory` : rapprochement ENTRÉE PAR ENTRÉE avec le manifeste
 *      et l'inventaire attendu — historiques rattachés à une entrée HISTORIQUE_86
 *      existante (une seule fois), nouveaux sans collision, stress distincts des
 *      scénarios, paires complètes ; doublons et doubles comptages listés,
 *      jamais comptés deux fois ; écarts aux totaux attendus.
 * Aucune approbation en masse : un statut « approuvé » fourni par le ZIP est
 * REFUSÉ par l'importeur (le cas reste « à compléter »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ImportSource } from './importer';
import type { CorpusManifest } from './model';
import { inventoryCounts, type ExpectedInventory, type InventoryGroup } from './expected-inventory';

/** Correspondance des champs du JSONL du ZIP (synonymes admis, premier présent retenu) — À CONFIRMER sur le ZIP réel. */
export const JSONL_FIELD_MAP = {
  id: ['id', 'case_id', 'scenario_id', 'identifiant', 'caseId'],
  group: ['inventory_group', 'groupe', 'lot', 'category', 'categorie', 'origine', 'origin', 'statut_inventaire'],
  historical: ['historical_id', 'historicalId', 'legacy_id', 'ancien_id', 'fixture_historique', 'historical_fixture', 'source_case'],
  operation: ['operation', 'operation_code', 'operationCode'],
  treatment: ['treatment', 'traitement'],
  pairId: ['pair_id', 'paire', 'pairId'],
  pairSide: ['pair_side', 'cote', 'side', 'pairSide'],
  pairChanges: ['discriminant_changes_decision', 'discriminantChangesDecision', 'discriminant_change_decision'],
} as const;

/** Valeurs de groupe reconnues (insensibles à la casse et aux accents) — À CONFIRMER sur le ZIP réel. */
export const GROUP_SYNONYMS: Readonly<Record<string, InventoryGroup>> = {
  historique: 'HISTORIQUE', historical: 'HISTORIQUE', legacy: 'HISTORIQUE', h: 'HISTORIQUE',
  a_revalider: 'A_REVALIDER', revalider: 'A_REVALIDER', to_revalidate: 'A_REVALIDER', revalidate: 'A_REVALIDER', r: 'A_REVALIDER',
  nouveau: 'NOUVEAU', new: 'NOUVEAU', nouveaux: 'NOUVEAU', proposition: 'NOUVEAU', n: 'NOUVEAU',
  stress: 'STRESS', e2e: 'STRESS', s: 'STRESS',
};

const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const pick = (o: Record<string, unknown>, keys: readonly string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };

export interface JsonlLine { file: string; line: number; raw: Record<string, unknown> | null; error: string | null }

/** Lignes JSONL de la livraison (`*.jsonl`, `*.ndjson`) ; ligne vide ignorée, ligne illisible signalée. */
export function readJsonl(src: ImportSource): JsonlLine[] {
  const out: JsonlLine[] = [];
  for (const file of [...src.files.keys()].filter((p) => /\.(jsonl|ndjson)$/i.test(p)).sort()) {
    src.files.get(file)!.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((t, i) => {
      if (!t.trim()) return;
      try {
        const v = JSON.parse(t);
        out.push(v && typeof v === 'object' && !Array.isArray(v) ? { file, line: i + 1, raw: v as Record<string, unknown>, error: null } : { file, line: i + 1, raw: null, error: 'objet JSON attendu' });
      } catch (e) {
        out.push({ file, line: i + 1, raw: null, error: `JSON illisible (${(e as Error).message.slice(0, 120)})` });
      }
    });
  }
  return out;
}

/** Groupe d'inventaire d'une ligne : champ déclaré, sinon fichier (`stress*.jsonl`, `historique*.jsonl`…). */
export function groupOfLine(l: JsonlLine): InventoryGroup | null {
  const declared = l.raw ? GROUP_SYNONYMS[norm(pick(l.raw, JSONL_FIELD_MAP.group))] : undefined;
  if (declared) return declared;
  const f = norm(l.file.split('/').pop());
  if (f.startsWith('stress')) return 'STRESS';
  if (f.startsWith('histor')) return 'HISTORIQUE';
  if (f.includes('revalid')) return 'A_REVALIDER';
  if (f.startsWith('nouveau') || f.startsWith('new')) return 'NOUVEAU';
  return null;
}

/**
 * Convertit les lignes JSONL au format d'entrée DOCUMENTÉ de l'importeur (`cases.json`, `stress.json`) avec le
 * groupe d'inventaire ; les autres fichiers de la livraison (pièces) sont conservés tels quels.
 */
export function adaptJsonl(src: ImportSource): { source: ImportSource; errors: string[] } {
  const lines = readJsonl(src);
  const errors = lines.filter((l) => l.error).map((l) => `${l.file}:${l.line} : ${l.error}`);
  const cases: Array<Record<string, unknown>> = [];
  const stress: Array<Record<string, unknown>> = [];
  for (const l of lines.filter((x) => x.raw)) {
    const r = l.raw!;
    const g = groupOfLine(l);
    const id = pick(r, JSONL_FIELD_MAP.id);
    if (id == null) { errors.push(`${l.file}:${l.line} : identifiant absent`); continue; }
    const pairId = pick(r, JSONL_FIELD_MAP.pairId);
    const item: Record<string, unknown> = {
      ...r, id: String(id),
      ...(pick(r, JSONL_FIELD_MAP.operation) != null ? { operation: String(pick(r, JSONL_FIELD_MAP.operation)) } : {}),
      ...(pick(r, JSONL_FIELD_MAP.treatment) != null ? { treatment: String(pick(r, JSONL_FIELD_MAP.treatment)) } : {}),
      ...(pick(r, JSONL_FIELD_MAP.historical) != null ? { historicalFixture: String(pick(r, JSONL_FIELD_MAP.historical)) } : {}),
      ...(pairId != null ? { pair: { id: String(pairId), side: String(pick(r, JSONL_FIELD_MAP.pairSide) ?? '').toUpperCase(), discriminantChangesDecision: pick(r, JSONL_FIELD_MAP.pairChanges) ?? false } } : {}),
      ...(g ? { inventoryGroup: g } : {}),
    };
    for (const k of [...JSONL_FIELD_MAP.group, 'case_id', 'scenario_id', 'pair_id', 'pair_side', 'paire', 'cote']) if (k !== 'id' && k !== 'category') delete item[k];
    (g === 'STRESS' ? stress : cases).push(item);
  }
  const files = new Map([...src.files.entries()].filter(([p]) => !/\.(jsonl|ndjson)$/i.test(p)));
  files.set('cases.json', Buffer.from(JSON.stringify(cases)));
  if (stress.length) files.set('stress.json', Buffer.from(JSON.stringify(stress)));
  return { source: { name: src.name, files }, errors };
}

export type ReconcileOutcome = 'HISTORICAL_MATCHED' | 'REVALIDATE' | 'NEW' | 'STRESS' | 'DUPLICATE' | 'DOUBLE_COUNT' | 'UNMATCHED_HISTORICAL' | 'UNKNOWN_GROUP' | 'UNREADABLE';

export interface ReconcileLine { file: string; line: number; id: string | null; group: InventoryGroup | null; outcome: ReconcileOutcome; manifestId: string | null; detail: string }

export interface ReconcileReport {
  expected: ExpectedInventory['totals'];
  /** Compteurs de la LIVRAISON (chaque entrée une seule fois). */
  delivered: { historical: number; toRevalidate: number; newScenarios: number; stress: number; pairs: number; total: number };
  /** Compteurs du manifeste actuel (avant import). */
  manifest: ReturnType<typeof inventoryCounts>;
  lines: ReconcileLine[];
  /** Entrées HISTORIQUE_86 du manifeste qu'aucune ligne n'a rapprochées. */
  unmatchedHistorical: string[];
  gaps: string[];
  ok: boolean;
}

/**
 * Rapprochement entrée par entrée (pur). Une entrée n'est comptée qu'UNE fois ; un historique ne peut être
 * revendiqué qu'une fois ; un stress ne peut pas être aussi un scénario ; un « nouveau » ne peut pas réutiliser
 * l'identifiant d'un cas existant. Aucune approbation.
 */
export function reconcileInventory(p: { lines: JsonlLine[]; manifest: CorpusManifest; expected: ExpectedInventory['totals'] }): ReconcileReport {
  const out: ReconcileLine[] = [];
  const historiques = p.manifest.entries.filter((e) => e.provenance === 'HISTORIQUE_86');
  const parSource = new Map<string, string>();
  for (const e of historiques) {
    parSource.set(norm(e.sourceCaseId ?? e.id), e.id);
    parSource.set(norm(e.id), e.id);
    if (e.file) parSource.set(norm(e.file.split('/').pop()!.replace(/\.json$/i, '')), e.id);
  }
  const idsExistants = new Set(p.manifest.entries.map((e) => norm(e.id)));
  const vus = new Map<string, InventoryGroup | null>();
  const histRevendiques = new Map<string, string>();
  const paires = new Map<string, Set<string>>();
  for (const l of p.lines) {
    if (!l.raw) { out.push({ file: l.file, line: l.line, id: null, group: null, outcome: 'UNREADABLE', manifestId: null, detail: l.error ?? 'ligne illisible' }); continue; }
    const id = pick(l.raw, JSONL_FIELD_MAP.id);
    const g = groupOfLine(l);
    const k = norm(id);
    const base = { file: l.file, line: l.line, id: id == null ? null : String(id), group: g };
    if (id == null) { out.push({ ...base, outcome: 'UNREADABLE', manifestId: null, detail: 'identifiant absent' }); continue; }
    if (vus.has(k)) {
      const avant = vus.get(k);
      out.push({ ...base, outcome: avant !== g && (avant === 'STRESS' || g === 'STRESS') ? 'DOUBLE_COUNT' : 'DUPLICATE', manifestId: null, detail: avant !== g ? `identifiant déjà livré dans le groupe ${avant ?? '—'} : jamais compté deux fois` : 'identifiant déjà livré : compté une seule fois' });
      continue;
    }
    vus.set(k, g);
    if (!g) { out.push({ ...base, outcome: 'UNKNOWN_GROUP', manifestId: null, detail: 'groupe d’inventaire illisible (historique, à revalider, nouveau, stress) : à classer avant import' }); continue; }
    const pid = pick(l.raw, JSONL_FIELD_MAP.pairId);
    if (pid != null && g !== 'STRESS') paires.set(String(pid), new Set([...(paires.get(String(pid)) ?? []), String(pick(l.raw, JSONL_FIELD_MAP.pairSide) ?? '').toUpperCase()]));
    if (g === 'HISTORIQUE' || g === 'A_REVALIDER') {
      const ref = pick(l.raw, JSONL_FIELD_MAP.historical);
      const cible = parSource.get(norm(ref ?? id)) ?? null;
      if (g === 'HISTORIQUE' && !cible) { out.push({ ...base, outcome: 'UNMATCHED_HISTORICAL', manifestId: null, detail: `aucune entrée HISTORIQUE_86 ne correspond à « ${String(ref ?? id)} »` }); continue; }
      if (cible && histRevendiques.has(cible)) { out.push({ ...base, outcome: 'DOUBLE_COUNT', manifestId: cible, detail: `historique ${cible} déjà rapproché par la ligne ${histRevendiques.get(cible)} : jamais compté deux fois` }); continue; }
      if (cible) histRevendiques.set(cible, `${l.file}:${l.line}`);
      out.push({ ...base, outcome: g === 'HISTORIQUE' ? 'HISTORICAL_MATCHED' : 'REVALIDATE', manifestId: cible, detail: cible ? `rapproché de ${cible}` : 'cas à revalider sans entrée existante (sera importé à compléter)' });
      continue;
    }
    if (g === 'NOUVEAU' && (idsExistants.has(k) || parSource.has(k))) {
      out.push({ ...base, outcome: 'DOUBLE_COUNT', manifestId: parSource.get(k) ?? null, detail: 'scénario « nouveau » portant l’identifiant d’un cas existant : à rapprocher (historique / à revalider), jamais compté deux fois' });
      continue;
    }
    out.push({ ...base, outcome: g === 'STRESS' ? 'STRESS' : 'NEW', manifestId: null, detail: g === 'STRESS' ? 'stress E2E distinct des scénarios' : 'nouveau scénario (spécification à convertir puis certifier)' });
  }
  const n = (o: ReconcileOutcome) => out.filter((x) => x.outcome === o).length;
  const delivered = {
    historical: n('HISTORICAL_MATCHED'), toRevalidate: n('REVALIDATE'), newScenarios: n('NEW'), stress: n('STRESS'),
    pairs: [...paires.values()].filter((s) => s.has('A') && s.has('B')).length, total: 0,
  };
  delivered.total = delivered.historical + delivered.toRevalidate + delivered.newScenarios;
  const gaps: string[] = [];
  const labels = { historical: 'historiques', toRevalidate: 'à revalider', newScenarios: 'nouveaux', stress: 'stress', pairs: 'paires A/B complètes' } as const;
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    if (delivered[key] !== p.expected[key]) gaps.push(`${labels[key]} : ${delivered[key]} rapproché(s) pour ${p.expected[key]} attendu(s)`);
  }
  for (const o of ['DUPLICATE', 'DOUBLE_COUNT', 'UNMATCHED_HISTORICAL', 'UNKNOWN_GROUP', 'UNREADABLE'] as const) if (n(o)) gaps.push(`${n(o)} ligne(s) ${o}`);
  const unmatchedHistorical = historiques.map((e) => e.id).filter((id) => ![...histRevendiques.keys()].includes(id));
  if (p.expected.historical && unmatchedHistorical.length && delivered.historical) gaps.push(`${unmatchedHistorical.length} historique(s) du manifeste non rapproché(s)`);
  return { expected: p.expected, delivered, manifest: inventoryCounts(p.manifest.entries), lines: out, unmatchedHistorical, gaps, ok: gaps.length === 0 };
}

/** Rapport lisible du rapprochement (CI, revue, PO). */
export function reconcileReportText(r: ReconcileReport): string {
  return [
    `Rapprochement #601 : ${r.ok ? 'CONFORME' : 'ÉCARTS'} — livraison ${r.delivered.historical} historiques + ${r.delivered.toRevalidate} à revalider + ${r.delivered.newScenarios} nouveaux = ${r.delivered.total} (attendu ${r.expected.historical + r.expected.toRevalidate + r.expected.newScenarios}) ; ${r.delivered.stress} stress (attendu ${r.expected.stress}) ; ${r.delivered.pairs} paires (attendu ${r.expected.pairs})`,
    ...r.gaps.map((g) => `  écart : ${g}`),
    ...r.lines.filter((l) => !['HISTORICAL_MATCHED', 'REVALIDATE', 'NEW', 'STRESS'].includes(l.outcome)).slice(0, 100).map((l) => `  ${l.file}:${l.line} ${l.id ?? '—'} ${l.outcome} — ${l.detail}`),
  ].join('\n');
}
