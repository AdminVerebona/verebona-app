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
 *     caractères ; le surplus reste UNRESOLVED (contenu conservé) et, lot
 *     49B (DEV-04), est rendu (`notAttempted`) : état PENDING, reprise
 *     programmée par `t1-completeness-retry` — jamais tenu pour non
 *     interprétable.
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
import { repairBounds, retryLimits } from './retry-policy';
import type { CoveredSourceUnit, SourceUnit } from './types';
import { unitOfCell } from './build-units';
import type { AnchoredValueDecision } from '../value-decisions/validate';

const REPAIR_MAX_UNITS = 120;
const REPAIR_MAX_CHARS = 24_000;
/**
 * Bornes de la réparation. Lot 114H (#775) : passes et appels sont lus par la règle unique des reprises
 * (`retry-policy.ts`) — une seule définition des défauts et des plages.
 */
export function repairSettings(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, def: number, min: number, max: number) => {
    const x = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.trunc(x))) : def;
  };
  return {
    ...repairBounds(env),
    /** Nombre minimal d'unités à réparer pour déclencher un appel (réglage de coût ; 1 = toute lacune). */
    minUnits: n(env.T1_REPAIR_MIN_UNITS, 1, 1, 1_000),
  };
}

/** Lot 49B : plafond de tentatives de réparation d'une unité (passes de l'analyse + reprises automatiques). */
export function repairAttemptCap(env: Record<string, string | undefined> = process.env): number {
  return retryLimits(env).unitCap;
}

/** Lots d'unités pour la réparation (ordre de lecture). Le surplus au-delà de `maxCalls` lots est rendu à part. */
function batchRepairUnits<U extends Pick<SourceUnit, 'text'>>(units: readonly U[], maxCalls: number): { batches: U[][]; left: U[] } {
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
function repairContent(units: readonly Pick<SourceUnit, 'sourceUnitId' | 'text'>[]): string {
  return units.map((u) => `[${u.sourceUnitId}]\n${u.text ?? ''}`).join('\n\n');
}

const PREFIXE = /\[(?:page|doc):[^\]]+\]\s*/g;

/** Appel ANALYZE_DOCUMENT réduit (injecté : `callAnalyzeDocument`). */
export type RepairCall = (p: {
  input: SourceInput; groupIndices: number[]; ctx: AnalysisContext;
  capabilities: AccountCapabilities; v2Families: V2AssetFamily[];
  attachments: never[]; sources: string; triggerCode: string;
}) => Promise<{
  output: { facts: T1Fact[] } & Parameters<typeof enforceT1Capabilities>[0];
  /** Lot 113AN : décisions de valeur de la réparation (contrat 91D), ancrées sur les empreintes des faits rendus. */
  valueDecisions?: AnchoredValueDecision[] | null;
  /**
   * Lot 115F (Trello #792, écart P2-10) : issue de l'appel telle que la passerelle la rend — le COÛT en
   * micro-unités de CET appel. Absent ou non numérique : coût INCONNU pour cet appel, jamais compté zéro.
   */
  res?: { costMicros?: number | null } | null;
}>;

interface RepairPassResult {
  /** Faits prouvés par une unité ciblée (page renseignée). */
  facts: T1Fact[];
  /** Unités soumises (tentative comptée). */
  attempted: string[];
  /** Unités d'un appel en échec. */
  failed: Map<string, { reason: string; retryable: boolean }>;
  calls: number;
  /** Faits rendus mais sans preuve dans la zone ciblée (écartés). */
  outOfScope: number;
  /** Lot 49B (DEV-04) : unités sélectionnées au-delà du budget d'appels de la passe — à reprendre. */
  notAttempted: string[];
  /**
   * Lot 113AN (#741) : unités CIBLÉES qui prouvent chaque fait rendu (lien local
   * à la zone transmise, jamais recalculé sur tout le document : la page citée
   * par le modèle est celle de l'extrait, pas celle du document).
   */
  links: Map<T1Fact, string[]>;
  /**
   * Lot 115F (Trello #792, écart P1-03) : faits dont l'extrait est retrouvé dans PLUSIEURS unités ciblées sans
   * que la preuve désigne laquelle (aucun identifiant d'unité cité) — association REFUSÉE : aucun lien local
   * n'est posé, le rattachement est recalculé par l'appelant et le fallback est compté, jamais silencieux.
   */
  linksAmbiguous: number;
  /** Lot 115F (#792, écart P1-03) : faits rattachés par l'IDENTIFIANT d'unité cité en tête de l'extrait transmis. */
  linksByCitedId: number;
  /**
   * Lot 113AN : décisions de valeur rendues par la réparation et rattachées à
   * une unité CIBLÉE (identifiant transmis `[page:1:field:2]`, sinon extrait
   * retrouvé) — jusqu'ici ignorées : l'unité restait `not_extracted`.
   */
  decisions: AnchoredValueDecision[];
  /**
   * Lot 114G (#760, P1-02) : décisions rendues par le modèle mais NON retenues par la passe, avec leur motif —
   * élément mal formé (`schemaInvalid`) ou unité ciblée introuvable. Jamais écartées en silence.
   */
  decisionsDropped: { schemaInvalid: number; unitNotFound: number };
  /**
   * Lot 115F (Trello #792, écart P2-10) — VENTILATION DES APPELS DE CETTE PASSE.
   *
   * `calls` compte les appels ÉMIS ; `callsFailed` ceux qui ont échoué (lot
   * d'unités marqué en échec). `costMicros` est la somme des coûts RENDUS par
   * la passerelle et `costUnknownCalls` le nombre d'appels dont le coût n'a pas
   * été rendu : un coût inconnu n'est jamais assimilé à zéro, l'appelant et le
   * BO affichent « coût partiellement inconnu ».
   */
  callsFailed: number;
  costMicros: number;
  costUnknownCalls: number;
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
  const res: RepairPassResult = {
    facts: [], attempted: [], failed: new Map(), calls: 0, outOfScope: 0, notAttempted: [], links: new Map(),
    linksAmbiguous: 0, linksByCitedId: 0, decisions: [], decisionsDropped: { schemaInvalid: 0, unitNotFound: 0 },
    callsFailed: 0, costMicros: 0, costUnknownCalls: 0,
  };
  const { batches, left } = batchRepairUnits(p.units, p.maxCalls);
  res.notAttempted = left.map((u) => u.sourceUnitId);
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
      // Lot 115F (#792, écart P2-10) : coût de CET appel tel que la passerelle le rend ; non rendu → inconnu, jamais zéro.
      const cout = r.res?.costMicros;
      if (typeof cout === 'number' && Number.isFinite(cout)) res.costMicros += cout; else res.costUnknownCalls++;
      const { output } = enforceT1Capabilities(r.output, p.capabilities);
      const linker = new SourceUnitLinker(lot);
      const parId = new Map(lot.map((u) => [u.sourceUnitId, u]));
      for (const f of output.facts) {
        // Lecture seule dans la zone ciblée : pas d'observation, pas de cellule.
        if (f.provenance === 'VISUAL_ANALYSIS') { res.outOfScope++; continue; }
        const check = checkFactEvidence(f);
        if (!check.ok) { res.outOfScope++; continue; }
        const brut = check.fact.evidence.excerpt ?? '';
        const excerpt = brut.replace(PREFIXE, '').trim();
        // ────────────────────────────────────────────────────────────────
        // Lot 115F (Trello #792, écart P1-03) — LIEN PAR IDENTIFIANT CITÉ,
        // PUIS REFUS DE L'AMBIGUÏTÉ
        //
        // Chaque unité transmise est précédée de son identifiant
        // (`repairContent`). Quand l'extrait rendu le recopie, il DÉSIGNE son
        // unité : ce lien explicite fait foi (même chemin que les décisions de
        // valeur). Sinon l'extrait est retrouvé dans la zone ciblée ; s'il
        // correspond à PLUSIEURS unités, l'association est refusée (aucun lien
        // local, fallback compté) et la page n'est jamais fabriquée à partir
        // d'une unité choisie arbitrairement.
        // ────────────────────────────────────────────────────────────────
        const cite = /\[((?:page|doc):[^\]]+)\]/.exec(brut)?.[1] ?? null;
        const parCite = cite && parId.has(unitOfCell(cite)) ? [unitOfCell(cite)] : null;
        const ids = parCite ?? linker.link({ excerpt, provenance: 'TEXT_EXTRACTION' });
        if (ids.length === 0) { res.outOfScope++; continue; }
        if (parCite) res.linksByCitedId++;
        const pages = new Set(ids.map((id) => parId.get(unitOfCell(id))?.page ?? null));
        const page = pages.size === 1 ? [...pages][0] : null;
        // ────────────────────────────────────────────────────────────────
        // Lot 115F (Trello #792, écart P1-03) — LA PAGE RENDUE PAR LE MODÈLE
        // EST ÉCARTÉE, TOUJOURS
        //
        // Règle complétée : le lot 113AN posait déjà que la page d'un fait de
        // réparation est celle de l'unité PROUVÉE, la page citée par le modèle
        // étant celle de l'extrait transmis (pseudo-document d'une page).
        // Elle n'était pourtant retirée que lorsqu'une page prouvée venait la
        // remplacer : quand l'unité restait AMBIGUË (même passage sur deux
        // pages), la page du modèle survivait et tranchait l'ambiguïté toute
        // seule, en aval, au rattachement recalculé — le rattachement arbitraire
        // que cet écart interdit. Elle est désormais retirée dans tous les cas.
        // ────────────────────────────────────────────────────────────────
        const { table: _t, page: _p, ...evidence } = check.fact.evidence;
        void _t;
        void _p;
        // Lot 113AN : la page est TOUJOURS celle de l'unité prouvée — la page citée par le modèle est
        // celle de l'extrait transmis (pseudo-document d'une page), qui rattachait le fait à une autre page.
        const repare = { ...check.fact, evidence: { ...evidence, excerpt, ...(page ? { page } : {}) } };
        res.facts.push(repare);
        if (!parCite && ids.length > 1) res.linksAmbiguous++;
        else res.links.set(repare, ids);
      }
      for (const d of r.valueDecisions ?? []) {
        if (d.schemaInvalid) { res.decisionsDropped.schemaInvalid++; continue; }
        const cite = d.sourceUnitId ? d.sourceUnitId.replace(/^\[|\]$/g, '').trim() : null;
        const excerpt = (d.evidence?.excerpt ?? '').replace(PREFIXE, '').trim();
        const id = cite && parId.has(unitOfCell(cite)) ? unitOfCell(cite)
          : excerpt ? linker.link({ excerpt, provenance: 'TEXT_EXTRACTION' })[0] ?? null : null;
        const unite = id ? parId.get(id) : undefined;
        if (!unite) { res.decisionsDropped.unitNotFound++; continue; }
        res.decisions.push({
          ...d, sourceUnitId: unite.sourceUnitId,
          evidence: { ...(d.evidence ?? {}), ...(excerpt ? { excerpt } : {}), ...(unite.page ? { page: unite.page } : {}) },
        });
      }
    } catch (e) {
      if (isExecutionCancelled(e) || isCostCapReached(e)) throw e;
      // Lot 115F (#792, écart P2-10) : appel en ÉCHEC compté à part — un appel émis sans résultat n'est ni
      // une tentative réussie ni une absence d'appel ; son coût n'est pas rendu, donc il reste inconnu.
      res.callsFailed++;
      res.costUnknownCalls++;
      const retryable = !isDefinitiveGatewayFailure(e);
      for (const u of lot) res.failed.set(u.sourceUnitId, { reason: `repair_failed:${retryable ? 'retryable' : 'final'}`, retryable });
      console.warn(`[t1-repair] passe ${p.pass} en échec (${lot.length} unité(s)) :`, (e as Error).message);
    }
  }
  return res;
}
