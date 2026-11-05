/**
 * Lot 111M (ticket « budgets IA », §6) — MESURE AVANT / APRÈS par opération
 * sur le corpus de qualification LOCAL (cas master du dépôt, sorties
 * enregistrées SYNTHÉTIQUES, aucun appel modèle, aucune base) :
 *
 *   npx tsx scripts/ai-budget-measure.ts            # tableau Markdown
 *   npx tsx scripts/ai-budget-measure.ts --json     # données brutes
 *
 * Pour chaque opération : cas, jetons d'entrée estimés (prompt maître du dépôt
 * + variables du cas), jetons de sortie estimés (sortie enregistrée), plafond
 * de sortie AVANT (lot 110 : borne T2 à 500, plancher T1, valeurs du code) et
 * APRÈS (résolution commune 111M, sans version BO), saturations (sortie
 * estimée > plafond : la passerelle aurait refusé la sortie tronquée et
 * rejoué un repli), appels simulés et coût simulé.
 *
 * LIMITES (écrites dans la recette) : estimation 3,5 caractères par jeton ;
 * sorties synthétiques (pas de raisonnement) ; tarif HYPOTHÉTIQUE de
 * simulation (`SIM_PRICE_IN_PER_M` / `SIM_PRICE_OUT_PER_M`, défaut 0,10 / 0,40
 * USD par million de jetons) — le rapport préprod utilise les coûts RÉELS des
 * traces. KNOWLEDGE_QUERY : éléments coupés avant / segments transmis après.
 */
import { loadEnvQuietly } from './lib/quiet-env';

async function main() {
  loadEnvQuietly();
  const json = process.argv.includes('--json');
  const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
  const { AI_OPERATIONS, ASSISTANT_MAX_OUTPUT_TOKENS } = await import('@/services/ai/registry/operations');
  const { estimateTokens, resolveBudget } = await import('@/services/ai/gateway/budget-resolution');
  const { planKnowledgePages, DEFAULT_KNOWLEDGE_BOUNDS } = await import('@/services/ai/reconciliation/knowledge-query/context');

  const prixIn = Number(process.env.SIM_PRICE_IN_PER_M ?? 0.1);
  const prixOut = Number(process.env.SIM_PRICE_OUT_PER_M ?? 0.4);
  const cout = (i: number, o: number) => (i * prixIn + o * prixOut) / 1e6;
  const cases = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.output !== undefined);
  const masters = new Map<string, number>();
  const T2 = new Set(['t2_understand', 't2_answer', 't2_revalidate']);

  /** Plafond AVANT (lot 110) : borne cachée T2 à 500, plancher T1, valeur du code sinon défaut du modèle. */
  const avant = (code: string): number | null => {
    const op = AI_OPERATIONS[code];
    const base = op.minOutputTokens ? Math.max(op.defaultMaxOutputTokens ?? 0, op.minOutputTokens) : op.defaultMaxOutputTokens ?? null;
    return T2.has(code) ? Math.min(base ?? ASSISTANT_MAX_OUTPUT_TOKENS, ASSISTANT_MAX_OUTPUT_TOKENS) : base;
  };
  const apres = (code: string): number | null => {
    const op = AI_OPERATIONS[code];
    return resolveBudget({ operationCode: code, op, config: { primaryModel: op.primaryModel, fallbackModels: op.fallbackModels, maxOutputTokens: op.defaultMaxOutputTokens ?? null, configVersionId: null } }).output.sent;
  };

  interface Row { op: string; cases: number; inMax: number; inSum: number; outMax: number; outSum: number; capBefore: number | null; capAfter: number | null;
    satBefore: number; satAfter: number; callsBefore: number; callsAfter: number; costBefore: number; costAfter: number; kqCutBefore?: number; kqSegmentsAfter?: number }
  const rows = new Map<string, Row>();
  for (const c of cases) {
    if (!masters.has(c.masterPromptCode)) masters.set(c.masterPromptCode, estimateTokens(readMasterFileFromRepo(c.masterPromptCode)));
    const entree = masters.get(c.masterPromptCode)! + estimateTokens(c.context);
    const sortie = estimateTokens(c.output);
    const r = rows.get(c.operationCode) ?? { op: c.operationCode, cases: 0, inMax: 0, inSum: 0, outMax: 0, outSum: 0, capBefore: avant(c.operationCode), capAfter: apres(c.operationCode),
      satBefore: 0, satAfter: 0, callsBefore: 0, callsAfter: 0, costBefore: 0, costAfter: 0 };
    r.cases += 1; r.inSum += entree; r.outSum += sortie; r.inMax = Math.max(r.inMax, entree); r.outMax = Math.max(r.outMax, sortie);
    const satB = r.capBefore != null && sortie > r.capBefore;
    const satA = r.capAfter != null && sortie > r.capAfter;
    // Sortie tronquée : jamais acceptée (décision PO 08) — un repli est rejoué (1 appel de plus, sortie perdue facturée).
    r.satBefore += satB ? 1 : 0; r.satAfter += satA ? 1 : 0;
    r.callsBefore += satB ? 2 : 1; r.callsAfter += satA ? 2 : 1;
    r.costBefore += cout(entree, Math.min(sortie, r.capBefore ?? sortie)) + (satB ? cout(entree, sortie) : 0);
    r.costAfter += cout(entree, Math.min(sortie, r.capAfter ?? sortie)) + (satA ? cout(entree, sortie) : 0);
    if (c.operationCode === 't3_knowledge_query') {
      const ev = (c.context as { EVIDENCES?: Array<Record<string, unknown>> }).EVIDENCES ?? [];
      const els = ev.map((e, i) => ({ ref: String(e.ref ?? `E${i}`), document: String(e.document ?? 'D0'), fileId: 1, layer: (e.layer ?? 'SOURCE_UNIT') as 'SOURCE_UNIT',
        kind: String(e.kind ?? 'TEXT_BLOCK'), label: (e.label as string) ?? null, value: (e.value as string) ?? null, text: (e.text as string) ?? null, confidence: 'certain' as const, page: null }));
      const coupesAvant = els.filter((e) => (e.label?.length ?? 0) + (e.value?.length ?? 0) + (e.text?.length ?? 0) > DEFAULT_KNOWLEDGE_BOUNDS.charsPerElement).length;
      const p = planKnowledgePages(els, [{ ref: 'D0', fileId: 1, role: 'TARGET', relation: null, title: null, documentType: null }], DEFAULT_KNOWLEDGE_BOUNDS);
      r.kqCutBefore = (r.kqCutBefore ?? 0) + coupesAvant;
      r.kqSegmentsAfter = (r.kqSegmentsAfter ?? 0) + p.pages.flatMap((x) => x.elements).length + p.continuationPages.flatMap((x) => x.elements).length;
    }
    rows.set(c.operationCode, r);
  }
  const liste = [...rows.values()].sort((a, b) => a.op.localeCompare(b.op));
  if (json) { console.log(JSON.stringify({ priceInPerM: prixIn, priceOutPerM: prixOut, rows: liste }, null, 2)); return; }
  const f = (n: number | null) => (n == null ? 'défaut modèle' : n.toLocaleString('fr-FR'));
  console.log(`Corpus local : ${cases.length} cas rejouables · tarif hypothétique ${prixIn} / ${prixOut} USD par M jetons (entrée / sortie)\n`);
  console.log('| Opération | Cas | Entrée moy. / max | Sortie moy. / max | Plafond avant → après | Saturations avant → après | Appels avant → après | Coût simulé avant → après (USD) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of liste) {
    console.log(`| ${r.op} | ${r.cases} | ${Math.round(r.inSum / r.cases)} / ${r.inMax} | ${Math.round(r.outSum / r.cases)} / ${r.outMax} | ${f(r.capBefore)} → ${f(r.capAfter)} | ${r.satBefore} → ${r.satAfter} | ${r.callsBefore} → ${r.callsAfter} | ${r.costBefore.toFixed(5)} → ${r.costAfter.toFixed(5)} |`);
  }
  const kq = rows.get('t3_knowledge_query');
  if (kq) console.log(`\nKNOWLEDGE_QUERY : éléments coupés avant (texte > ${DEFAULT_KNOWLEDGE_BOUNDS.charsPerElement} car.) : ${kq.kqCutBefore ?? 0} ; segments transmis après : ${kq.kqSegmentsAfter ?? 0}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
