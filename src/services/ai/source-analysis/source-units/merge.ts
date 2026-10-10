/**
 * Fusion IDEMPOTENTE des lots d'une analyse T1 (fonctions pures) : lot de
 * débordement d'une même sortie, lots de pages (découpage d'un long
 * document), passes de réparation ciblée.
 *
 * Idempotente : fusionner deux fois le même lot ne change rien (faits,
 * tableaux et observations identiques reconnus par une empreinte de contenu).
 * C'est ce qui permet le recouvrement d'une page entre deux lots et la
 * reprise d'une réparation sans dupliquer la connaissance.
 */
import type { T1AnalyzeDocumentOutput, T1Fact } from '../master/t1-contract';
import type { T1NormalisationReport } from '../master/tolerant-output';
import { plat } from './text';

type Out = T1AnalyzeDocumentOutput;
type RawTable = Out['tables'][number];
type RawObservation = NonNullable<Out['visual']>['observations'][number];

/** Empreinte de contenu d'un fait (clé, valeur, cible, extrait, cellule). */
export function factFingerprint(f: Pick<T1Fact, 'canonicalKey' | 'rawKey' | 'label' | 'normalizedValue' | 'rawValue' | 'target' | 'evidence' | 'visualEvidence' | 'provenance'>): string {
  const cle = plat(String(f.canonicalKey ?? f.rawKey ?? f.label ?? ''));
  const valeur = plat(String(f.normalizedValue ?? f.rawValue ?? ''));
  const cible = `${f.target?.type ?? ''}:${f.target?.entityId ?? plat(String(f.target?.rawLabel ?? ''))}`;
  const preuve = f.provenance === 'VISUAL_ANALYSIS'
    ? `v:${plat(f.visualEvidence?.description ?? '').slice(0, 120)}`
    : `t:${plat(f.evidence?.excerpt ?? '').slice(0, 200)}`;
  return [cle, valeur, cible, preuve].join('|');
}

/** Ajoute les faits nouveaux (empreinte inconnue) ; rend ceux réellement ajoutés. */
export function mergeFacts(base: T1Fact[], incoming: readonly T1Fact[]): T1Fact[] {
  const vus = new Set(base.map(factFingerprint));
  const ajoutes: T1Fact[] = [];
  for (const f of incoming) {
    const k = factFingerprint(f);
    if (vus.has(k)) continue;
    vus.add(k);
    base.push(f);
    ajoutes.push(f);
  }
  return ajoutes;
}

const tableFingerprint = (t: RawTable) =>
  [plat(t.title ?? ''), t.pageStart ?? '', t.columns.map((c) => plat(c.header)).join(','),
    t.rows.slice(0, 3).map((r) => r.cells.map((c) => plat(String(c.value ?? ''))).join(',')).join(';'), t.rows.length].join('|');
const observationFingerprint = (o: RawObservation) => `${o.page ?? ''}|${plat(o.description)}`;

/**
 * Réintègre le lot de débordement d'une sortie (au-delà des bornes du
 * contrat) : faits, tableaux, observations (descriptions complètes),
 * entités, suite de la transcription. Rend une NOUVELLE sortie ; l'ordre est
 * celui du modèle (les références de cellule restent valides).
 */
export function applyOverflow(out: Out, report: T1NormalisationReport | null): { output: Out; batches: number } {
  const o = report?.overflow;
  if (!o) return { output: out, batches: 0 };
  let batches = 0;
  const visual = out.visual
    ? {
        ...out.visual,
        observations: [
          ...out.visual.observations.map((x, i) => (o.fullDescriptions?.[i] ? { ...x, description: o.fullDescriptions[i] } : x)),
          ...(o.observations ?? []),
        ],
      }
    : out.visual;
  if ((o.observations?.length ?? 0) > 0) batches++;
  if ((o.facts?.length ?? 0) > 0) batches++;
  if (o.tables) batches++;
  if (o.transcriptionTail) batches++;
  const ent = o.entities ?? { assets: [], rooms: [], equipments: [], suppliers: [] };
  if (Object.values(ent).some((l) => l.length > 0)) batches++;
  return {
    output: {
      ...out,
      transcription: o.transcriptionTail ? `${out.transcription ?? ''}${o.transcriptionTail}` : out.transcription,
      visual,
      tables: o.tables ?? out.tables,
      facts: [...out.facts, ...(o.facts ?? [])],
      entities: {
        ...out.entities,
        assets: [...out.entities.assets, ...ent.assets],
        rooms: [...out.entities.rooms, ...ent.rooms],
        equipments: [...out.entities.equipments, ...ent.equipments],
        suppliers: [...out.entities.suppliers, ...ent.suppliers],
      },
    },
    batches,
  };
}

/** Décale les pages d'une sortie de lot (pages 1…k du lot → pages réelles). */
export function offsetPages(out: Out, offset: number): Out {
  if (offset === 0) return out;
  const p = (n: number | undefined) => (typeof n === 'number' ? n + offset : n);
  const ev = <E extends { page?: number }>(e: E | undefined): E | undefined => (e ? { ...e, ...(e.page ? { page: p(e.page) } : {}) } : e);
  return {
    ...out,
    tables: out.tables.map((t) => ({
      ...t, pageStart: p(t.pageStart), pageEnd: p(t.pageEnd),
      rows: t.rows.map((r) => ({ ...r, ...(r.page ? { page: p(r.page) } : {}) })),
    })),
    visual: out.visual ? { ...out.visual, observations: out.visual.observations.map((x) => ({ ...x, ...(x.page ? { page: p(x.page) } : {}) })) } : out.visual,
    facts: out.facts.map((f) => ({
      ...f,
      evidence: ev(f.evidence) ?? {},
      ...(f.visualEvidence ? { visualEvidence: ev(f.visualEvidence) } : {}),
    })) as T1Fact[],
  };
}

/**
 * Fusionne un lot de pages dans la sortie principale : faits (dédoublonnés),
 * tableaux (dédoublonnés, références de cellule recalées), observations,
 * entités, métadonnées manquantes. Le texte du lot est porté à part (segment).
 */
export function mergeChunkOutput(base: Out, chunk: Out): { output: Out; addedFacts: number } {
  const tables = [...base.tables];
  const vusT = new Map(tables.map((t, i) => [tableFingerprint(t), i]));
  const indexMap = new Map<number, number>();
  chunk.tables.forEach((t, i) => {
    const k = tableFingerprint(t);
    const existant = vusT.get(k);
    if (existant !== undefined) { indexMap.set(i, existant); return; }
    vusT.set(k, tables.length);
    indexMap.set(i, tables.length);
    tables.push(t);
  });
  const recale = chunk.facts.map((f) => {
    const t = f.evidence?.table;
    if (!t) return f;
    const idx = indexMap.get(t.index);
    if (idx === undefined) {
      const { table: _t, ...e } = f.evidence;
      void _t;
      return { ...f, evidence: e };
    }
    return { ...f, evidence: { ...f.evidence, table: { ...t, index: idx } } };
  });
  const facts = [...base.facts];
  const ajoutes = mergeFacts(facts, recale);

  const obs = [...(base.visual?.observations ?? [])];
  const vusO = new Set(obs.map(observationFingerprint));
  for (const o of chunk.visual?.observations ?? []) {
    const k = observationFingerprint(o);
    if (!vusO.has(k)) { vusO.add(k); obs.push(o); }
  }
  const entites = <K extends 'assets' | 'rooms' | 'equipments' | 'suppliers'>(k: K) => {
    const l = [...base.entities[k]];
    const id = (c: (typeof l)[number]) => (c.entityId !== null ? `#${c.entityId}` : plat(c.rawLabel ?? ''));
    const vus = new Set(l.map(id));
    for (const c of chunk.entities[k]) if (!vus.has(id(c))) { vus.add(id(c)); l.push(c); }
    return l;
  };
  const d = base.document;
  const c = chunk.document;
  return {
    output: {
      ...base,
      document: {
        ...d,
        ...(d.title ? {} : c.title ? { title: c.title } : {}),
        ...(d.description ? {} : c.description ? { description: c.description } : {}),
        ...(d.documentDate ? {} : c.documentDate ? { documentDate: c.documentDate } : {}),
        ...(d.supplier ? {} : c.supplier ? { supplier: c.supplier } : {}),
        ...(d.amountCents ? {} : c.amountCents ? { amountCents: c.amountCents } : {}),
        ...(d.classification ? {} : c.classification ? { classification: c.classification } : {}),
      },
      entities: {
        ...base.entities,
        assets: entites('assets'), rooms: entites('rooms'), equipments: entites('equipments'), suppliers: entites('suppliers'),
        multiAsset: base.entities.multiAsset || chunk.entities.multiAsset,
      },
      visual: obs.length > 0 || base.visual || chunk.visual
        ? { ...(base.visual ?? {}), summary: base.visual?.summary ?? chunk.visual?.summary, observations: obs }
        : base.visual,
      tables,
      facts,
      hasExploitableContent: base.hasExploitableContent || chunk.hasExploitableContent,
    },
    addedFacts: ajoutes.length,
  };
}

/** Dernière page citée par une sortie (faits, tableaux, observations, marques de page). */
export function lastPageSeen(out: Out, pageFromText: number): number {
  let max = pageFromText;
  for (const f of out.facts) max = Math.max(max, f.evidence?.page ?? 0, f.visualEvidence?.page ?? 0);
  for (const t of out.tables) max = Math.max(max, t.pageEnd ?? 0, t.pageStart ?? 0);
  for (const o of out.visual?.observations ?? []) max = Math.max(max, o.page ?? 0);
  return max;
}
