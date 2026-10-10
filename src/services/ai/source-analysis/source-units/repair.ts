/**
 * Passe de réparation CIBLÉE — ticket T1, « Ajouter une passe de réparation
 * ciblée » :
 *
 *   PASS 1 → contrôle de couverture → N unités non couvertes
 *   PASS 2 → analyse de CES N unités seulement → fusion → nouveau contrôle
 *
 * Même prompt maître T1 (non modifié), même TASK ANALYZE_DOCUMENT, même
 * contrat : la source transmise n'est plus le fichier mais le TEXTE des
 * unités ciblées, en contenu préextrait délimité (`EXTRACTED_CONTENT`),
 * chaque unité précédée de son identifiant. Aucune pièce jointe : le fichier
 * n'est ni relu ni retéléchargé.
 *
 * Bornes (coût maîtrisé, aucune boucle) :
 *   · `T1_MAX_REPAIR_PASSES` (1 par défaut, 0 à 2) passes au plus ;
 *   · une unité n'est jamais soumise plus de `maxPasses` fois ;
 *   · `T1_REPAIR_MIN_UNITS` (1) unités ciblées au moins pour appeler ;
 *   · par passe, au plus `T1_REPAIR_MAX_CALLS` (3) appels de
 *     `REPAIR_MAX_UNITS` (120) unités / `REPAIR_MAX_CHARS` (24 000)
 *     caractères ; le surplus reste UNRESOLVED (contenu conservé).
 *
 * Un fait de la réparation n'est retenu que s'il est PROUVÉ par une unité
 * ciblée (extrait retrouvé) : la réparation ne peut ni inventer ni dupliquer
 * hors de sa zone.
 */
import { isExecutionCancelled } from '../../queue/execution-control';
import { isCostCapReached } from '../../gateway/errors';
import { isDefinitiveGatewayFailure } from '../failure-policy';
import { enforceT1Capabilities } from '../master/capability-guard';
import { checkFactEvidence } from '../master/fact-evidence';
import type { T1Fact } from '../master/t1-contract';
import type { AnalysisContext, SourceInput } from '../types';
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import type { AssetFamily as V2AssetFamily } from '@/lib/referential/v2';
import { SourceUnitLinker } from './coverage';
import type { CoveredSourceUnit, SourceUnit } from './types';

export const REPAIR_MAX_UNITS = 120;
export const REPAIR_MAX_CHARS = 24_000;
export const DEFAULT_MAX_REPAIR_PASSES = 1;
export const DEFAULT_REPAIR_MAX_CALLS = 3;

export function repairSettings(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, def: number, min: number, max: number) => {
    const x = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.trunc(x))) : def;
  };
  return {
    maxPasses: n(env.T1_MAX_REPAIR_PASSES, DEFAULT_MAX_REPAIR_PASSES, 0, 2),
    maxCalls: n(env.T1_REPAIR_MAX_CALLS, DEFAULT_REPAIR_MAX_CALLS, 1, 10),
    /** Nombre minimal d'unités à réparer pour déclencher un appel (réglage de coût ; 1 = toute lacune). */
    minUnits: n(env.T1_REPAIR_MIN_UNITS, 1, 1, 1_000),
  };
}

/** Lots d'unités pour la réparation (ordre de lecture). Le surplus au-delà de `maxCalls` lots est rendu à part. */
export function batchRepairUnits<U extends Pick<SourceUnit, 'text'>>(units: readonly U[], maxCalls: number): { batches: U[][]; left: U[] } {
  const batches: U[][] = [];
  let cur: U[] = [];
  let chars = 0;
  for (const u of units) {
    const len = (u.text ?? '').length + 40;
    if (cur.length > 0 && (cur.length >= REPAIR_MAX_UNITS || chars + len > REPAIR_MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(u);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return { batches: batches.slice(0, maxCalls), left: batches.slice(maxCalls).flat() };
}

/** Texte transmis : chaque unité précédée de son identifiant, séparée par une ligne vide. */
export function repairContent(units: readonly Pick<SourceUnit, 'sourceUnitId' | 'text'>[]): string {
  return units.map((u) => `[${u.sourceUnitId}]\n${u.text ?? ''}`).join('\n\n');
}

const PREFIXE = /\[(?:page|doc):[^\]]+\]\s*/g;

/** Appel ANALYZE_DOCUMENT réduit (injecté : `callAnalyzeDocument`). */
export type RepairCall = (p: {
  input: SourceInput; groupIndices: number[]; ctx: AnalysisContext;
  capabilities: AccountCapabilities; v2Families: V2AssetFamily[];
  attachments: never[]; sources: string; triggerCode: string;
}) => Promise<{ output: { facts: T1Fact[] } & Parameters<typeof enforceT1Capabilities>[0] }>;

export interface RepairPassResult {
  /** Faits prouvés par une unité ciblée (page renseignée). */
  facts: T1Fact[];
  /** Unités soumises (tentative comptée). */
  attempted: string[];
  /** Unités d'un appel en échec. */
  failed: Map<string, { reason: string; retryable: boolean }>;
  calls: number;
  /** Faits rendus mais sans preuve dans la zone ciblée (écartés). */
  outOfScope: number;
}

export async function runRepairPass(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  capabilities: AccountCapabilities;
  v2Families: V2AssetFamily[];
  units: readonly CoveredSourceUnit[];
  maxCalls: number;
  pass: number;
  call: RepairCall;
}): Promise<RepairPassResult> {
  const res: RepairPassResult = { facts: [], attempted: [], failed: new Map(), calls: 0, outOfScope: 0 };
  const { batches } = batchRepairUnits(p.units, p.maxCalls);
  const name = p.input.displayNames[p.groupIndices[0]] ?? 'document';
  for (const lot of batches) {
    res.attempted.push(...lot.map((u) => u.sourceUnitId));
    const texte = repairContent(lot);
    try {
      res.calls++;
      const r = await p.call({
        input: { ...p.input, extractedContent: texte, contentUrls: undefined },
        groupIndices: p.groupIndices,
        ctx: p.ctx,
        capabilities: p.capabilities,
        v2Families: p.v2Families,
        attachments: [],
        sources: JSON.stringify([{
          index: 0, name: `${name} — extrait ciblé (${lot.length} unité(s) non couverte(s))`, mimeType: 'text/plain',
          kind: 'extrait du document déjà lu (contenu préextrait)',
        }]),
        triggerCode: `t1_repair_pass_${p.pass}`,
      });
      const { output } = enforceT1Capabilities(r.output, p.capabilities);
      const linker = new SourceUnitLinker(lot);
      const parId = new Map(lot.map((u) => [u.sourceUnitId, u]));
      for (const f of output.facts) {
        // Lecture seule dans la zone ciblée : pas d'observation, pas de cellule.
        if (f.provenance === 'VISUAL_ANALYSIS') { res.outOfScope++; continue; }
        const check = checkFactEvidence(f);
        if (!check.ok) { res.outOfScope++; continue; }
        const excerpt = (check.fact.evidence.excerpt ?? '').replace(PREFIXE, '').trim();
        const ids = linker.link({ excerpt, provenance: 'TEXT_EXTRACTION' });
        if (ids.length === 0) { res.outOfScope++; continue; }
        const unite = parId.get(ids[0]);
        const { table: _t, ...evidence } = check.fact.evidence;
        void _t;
        res.facts.push({
          ...check.fact,
          evidence: { ...evidence, excerpt, ...(unite?.page && !evidence.page ? { page: unite.page } : {}) },
        });
      }
    } catch (e) {
      if (isExecutionCancelled(e) || isCostCapReached(e)) throw e;
      const retryable = !isDefinitiveGatewayFailure(e);
      for (const u of lot) res.failed.set(u.sourceUnitId, { reason: `repair_failed:${retryable ? 'retryable' : 'final'}`, retryable });
      console.warn(`[t1-repair] passe ${p.pass} en échec (${lot.length} unité(s)) :`, (e as Error).message);
    }
  }
  return res;
}
