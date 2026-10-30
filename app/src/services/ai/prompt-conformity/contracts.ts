/**
 * Lot 99B — REGISTRE UNIQUE des contrats exigés par opération IA (T1, T2,
 * T3, T4, T6) et de leur mise en conformité.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ALIMENTÉ PAR LE CODE EXISTANT — AUCUNE LISTE RECOPIÉE
 *
 *   · marqueurs : constantes des modules qui exploitent le contrat
 *     (`MISSING_PROPERTIES_CONTRACT_VERSION`, `T6_SUGGESTION_CONTRACT`…) ;
 *   · détection : fonctions de capacité de production (`knowledgeContractsIn`,
 *     `promptCarriesIdentity`, `representationCapabilityOf`,
 *     `assessT4Compatibility`, `checkMasterPromptContent`…) — la même règle
 *     que l'exécution, jamais une copie ;
 *   · opérations, tâche, schémas de sortie : registre `AI_OPERATIONS` ;
 *   · blocs de texte : blocs OFFICIELS balisés du guide du PO (étapes 1 à 8,
 *     rejoués contre les validateurs réels par l89c / l91d / l97a / l98a) ;
 *   · configuration d'exécution attendue (T4) : `T4_EXECUTION_SPEC`,
 *     `conformingT4Execution` (diagnostic T4 du lot 98A).
 * Seuls le rang (ordre conseillé du guide), les libellés en français simple
 * et les dépendances sont écrits ici.
 *
 * Un contrat « socle » (un par prompt) = contrôles techniques bloquants du
 * BO : il est surveillé, jamais corrigé automatiquement (aucun bloc officiel).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import type { QualificationCase } from '../qualification/cases';
import { guideBlock, type GuideBlock } from './guide-blocks';

export type ContractState = 'SATISFIED' | 'ABSENT' | 'OBSOLETE' | 'INCOMPLETE' | 'INCOMPATIBLE';

export interface ContractCheck {
  state: ContractState;
  /** Cause en clair (vide si satisfait). */
  cause: string;
  /** Éléments manquants (marqueurs, sections, configuration). */
  missing: string[];
}

export interface PromptUnderCheck {
  text: string;
  execution: MasterExecutionConfig;
  /** Texte livré avec l'application (fichier du dépôt). */
  referenceText: string | null;
}

/** Modification élémentaire d'une correction. */
export type CorrectionStep =
  | { kind: 'block'; block: GuideBlock; optional?: boolean }
  | { kind: 'execution'; target: MasterExecutionConfig };

export type CorrectionPlan =
  | { ok: true; steps: CorrectionStep[] }
  | { ok: false; code: 'NO_OFFICIAL_BLOCK' | 'BLOCK_UNAVAILABLE' | 'TEXT_TOO_DIVERGENT'; message: string };

export interface PromptContract {
  id: string;
  treatment: Treatment;
  masterPromptCode: string;
  /** Ordre conseillé du guide (1 = d'abord) ; 0 : socle, jamais corrigé. */
  rank: number;
  label: string;
  lot: string;
  guideStep: number | null;
  /** Version du contrat (identifiant du marqueur ou du contrat d'exécution). */
  version: string;
  task: string | null;
  operations: string[];
  inputs: string[];
  outputs: string[];
  capabilities: string[];
  markers: string[];
  validations: string[];
  /** Contrats à satisfaire d'abord. */
  requires: string[];
  /** Blocs officiels du guide utilisés par la correction. */
  blockIds: string[];
  /** Configuration d'exécution attendue (en clair) ; null : sans objet. */
  expectedExecution: string | null;
  /** Coupure d'urgence existante de la fonction (variable Scalingo). */
  killSwitch: string | null;
  impact: string;
  /** Constat de cohérence lié (rattrapage après activation). */
  anomaly: { checkIds: string[]; anomaly: string } | null;
  /**
   * Couverture exigée de la NOUVELLE branche : au moins un cas obligatoire
   * vérifiable qui exerce le contrat (sinon : couverture insuffisante).
   */
  coverage: { operation: string; label: string; matches(c: Pick<QualificationCase, 'variables' | 'operationCode'>): boolean } | null;
  check(p: PromptUnderCheck): Promise<ContractCheck>;
  plan(p: PromptUnderCheck): Promise<CorrectionPlan>;
}

const ok = (): ContractCheck => ({ state: 'SATISFIED', cause: '', missing: [] });
const manque = (state: ContractState, cause: string, missing: string[]): ContractCheck => ({ state, cause, missing });

/** Plan fait des blocs officiels du guide (refus si un bloc manque au guide). */
function blocks(ids: Array<string | { id: string; optional: true }>): CorrectionPlan {
  const steps: CorrectionStep[] = [];
  for (const x of ids) {
    const id = typeof x === 'string' ? x : x.id;
    const b = guideBlock(id);
    if (!b) return { ok: false, code: 'BLOCK_UNAVAILABLE', message: `Bloc officiel « ${id} » introuvable dans le guide du PO (docs/exploitation/prompts-a-appliquer-par-le-po.md) : défaut du code livré, aucune correction automatique.` };
    steps.push({ kind: 'block', block: b, ...(typeof x === 'string' ? {} : { optional: true }) });
  }
  return { ok: true, steps };
}

const noBlock = (label: string): CorrectionPlan => ({
  ok: false, code: 'NO_OFFICIAL_BLOCK',
  message: `${label} : aucun bloc officiel dans le guide du PO — le texte livré le porte déjà ; la correction sûre consiste à repartir du texte livré (BO › Prompts maîtres), jamais une réécriture automatique.`,
});

async function operationsOf(masterPromptCode: string, task?: string | null): Promise<Array<{ operationCode: string; task: string | null; outputSchema: string }>> {
  const { AI_OPERATIONS } = await import('../registry/operations');
  return Object.values(AI_OPERATIONS)
    .filter((o) => o.active && o.provider !== 'none' && o.masterPromptCode === masterPromptCode && (task === undefined || task === null || o.task === task))
    .map((o) => ({ operationCode: o.operationCode, task: o.task ?? null, outputSchema: o.outputSchema }));
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * EXTENSION : CONTRAT « À MARQUEUR » = UNE LIGNE
 *
 * Tout nouveau contrat livré sous la forme « marqueur dans le prompt + bloc
 * officiel du guide » s'ajoute ici, en UNE entrée, sans autre code : la
 * détection appelle la fonction de capacité du module qui l'exploite, la
 * correction insère le bloc officiel balisé du guide (`blockId`), les
 * opérations et schémas sont lus dans le registre IA (`task`). Exemple à
 * l'intégration du lot 99C (étape 9 du guide, déclaration exportée par
 * `reconciliation/document-naming/model.ts`) :
 *
 *   { id: 't3-naming-period-v1', treatment: 'T3', rank: 10, guideStep: 9, lot: '99C', task: 'DOCUMENT_NAMING',
 *     blockId: 't3-naming-period-v1', killSwitch: 'T3_NAMING_PERIOD_ENABLED', label: 'T3 : période dans le nommage des documents',
 *     impact: '…', detect: async (t) => (await import('../reconciliation/document-naming/model')).promptCarriesNamingPeriod(t) },
 *
 * `rank` : position dans l'ordre conseillé du guide (après les contrats
 * existants : 10, 11…). `requires` facultatif (défaut : le socle du prompt).
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface MarkerContractDeclaration {
  id: string;
  treatment: Treatment;
  rank: number;
  guideStep: number | null;
  lot: string;
  /** Branche (TASK) exploitée ; null : tout le prompt. */
  task: string | null;
  /** Bloc officiel balisé du guide (`<!-- l89c:bloc id="…" -->`). */
  blockId: string;
  killSwitch: string | null;
  label: string;
  impact: string;
  requires?: string[];
  /** Détection de production (même règle que l'exécution) : le texte porte-t-il le contrat ? */
  detect(text: string): boolean | Promise<boolean>;
}

export const MARKER_CONTRACT_DECLARATIONS: readonly MarkerContractDeclaration[] = [
  // Lot 99C : représentation de la période dans le titre (étape 9 du guide).
  { id: 't3-naming-period-v1', treatment: 'T3', rank: 10, guideStep: 9, lot: '99C', task: 'DOCUMENT_NAMING',
    blockId: 't3-naming-period-v1', killSwitch: 'T3_NAMING_PERIOD_ENABLED', label: 'T3 : période dans le nommage des documents',
    impact: 'Titre prudent (mois seulement s\'il est écrit sur le document, sinon période exacte, sinon rien) tant que le contrat manque.',
    detect: async (t) => (await import('../reconciliation/document-naming/model')).promptCarriesNamingPeriod(t) },
  // Lot 101A : identité du produit et produit principal d'une page fournisseur (étape 10 du guide).
  { id: 't1-product-identity-v1', treatment: 'T1', rank: 11, guideStep: 10, lot: '101A', task: 'ANALYZE_DOCUMENT',
    blockId: 't1-product-identity-v1', killSwitch: null, label: 'T1 : série, modèle, référence et numéro de série distincts ; produit principal d’une page fournisseur',
    impact: 'Le garde-fou serveur s’applique déjà (libellé générique ≠ modèle, produit connexe jamais rattaché, modèles incompatibles en conflit) ; sans le contrat, T1 range plus souvent ces valeurs en connaissance générique.',
    detect: async (t) => (await import('../source-analysis/master/product-identity-contract')).promptCarriesProductIdentity(t) },
  // Lot 101A : continuité conversationnelle et propriété exacte (étape 11 du guide).
  { id: 't2-property-continuity-v1', treatment: 'T2', rank: 12, guideStep: 11, lot: '101A', task: 'UNDERSTAND',
    blockId: 't2-property-continuity-v1', killSwitch: null, label: 'T2 : ellipses sur l’objet du tour précédent, propriété exacte (série ≠ numéro de série)',
    impact: 'L’objet actif est déjà résolu par le serveur et le retrieval borné ; sans le contrat, une ellipse sans formulation reconnue (« Et son prix ? ») est moins souvent comprise par UNDERSTAND.',
    detect: async (t) => (await import('@/services/verebona-assistant/core/property-continuity-contract')).promptCarriesPropertyContinuity(t) },
];

let registryCache: Promise<PromptContract[]> | null = null;

/** Registre (mémorisé : il ne dépend que du code livré et du guide). */
export function promptContracts(): Promise<PromptContract[]> {
  registryCache ??= buildRegistry().catch((e) => { registryCache = null; throw e; });
  return registryCache;
}

/** Tests seulement : reconstruit le registre (guide substitué). */
export function __resetPromptContractsForTests(): void { registryCache = null; }

async function buildRegistry(): Promise<PromptContract[]> {
  const [
    { masterPromptForTreatment }, { inspectMasterTemplate }, { checkMasterPromptContent },
    kq, mp, vd, bp, idc, rep, repc, t6s, t4c, { T4_EXECUTION_SPEC }, sc,
  ] = await Promise.all([
    import('../config/prompt-architecture'), import('../prompts/prompt-loader'), import('../master-prompts/master-prompt-checks'),
    import('../reconciliation/knowledge-query/contract'), import('../reconciliation/missing-properties/contract'),
    import('../source-analysis/value-decisions/contract'), import('../source-analysis/billing-period/contract'),
    import('@/services/business-operations/semantic/identity-contract'), import('@/services/business-operations/semantic/decider'), import('@/services/business-operations/semantic/contract'),
    import('@/services/home/mascot/t6-suggestions'), import('../agenda/master/t4-compatibility'), import('../agenda/master/t4-execution-contract'),
    import('../master-prompts/structured-context'),
  ]);
  const { knowledgeContractsIn } = await import('../reconciliation/knowledge-query/model');
  const code = (t: Treatment) => masterPromptForTreatment(t)!.masterPromptCode;
  const branches = (text: string) => inspectMasterTemplate(text).branches;
  const outputsOf = async (mpc: string, task?: string | null) => [...new Set((await operationsOf(mpc, task)).map((o) => o.outputSchema))];
  const opsOf = async (mpc: string, task?: string | null) => (await operationsOf(mpc, task)).map((o) => o.operationCode);
  const out: PromptContract[] = [];

  // ── Socles : contrôles techniques bloquants du BO (un par prompt) ────────
  for (const t of ['T1', 'T2', 'T3', 'T4', 'T6'] as Treatment[]) {
    const mpc = code(t);
    out.push({
      id: `${t.toLowerCase()}-socle`, treatment: t, masterPromptCode: mpc, rank: 0,
      label: `${t} : contrat technique du prompt (emplacements, branches, configuration d’exécution)`, lot: '27 / 34D', guideStep: null,
      version: mpc, task: null, operations: await opsOf(mpc), inputs: [], outputs: await outputsOf(mpc),
      capabilities: ['exécution de toutes les branches'], markers: [], validations: ['checkMasterPromptContent (contrôles bloquants du BO)'],
      requires: [], blockIds: [], expectedExecution: null, killSwitch: null,
      impact: 'Les appels de la branche concernée échoueraient : la version ne peut pas être activée.',
      anomaly: null, coverage: null,
      async check(p) {
        const r = checkMasterPromptContent(t, p.text, p.execution);
        return r.ok ? ok() : manque('INCOMPATIBLE', r.blocking.map((i) => i.message).join(' '), r.blocking.map((i) => i.code));
      },
      async plan() { return noBlock(`Socle ${t}`); },
    });
  }

  // ── T2 : arbitrage et informations apportées (lot 59) ─────────────────────
  {
    const mpc = code('T2');
    out.push({
      id: 't2-arbitrage', treatment: 'T2', masterPromptCode: mpc, rank: 0,
      label: 'T2 : règles A7 à A9, interactionMode, suppliedFacts, {{BUSINESS_CANDIDATES}}', lot: '59 / 75J', guideStep: null,
      version: 't2-capabilities', task: null, operations: await opsOf(mpc), inputs: ['{{BUSINESS_CANDIDATES}}'], outputs: await outputsOf(mpc),
      capabilities: ['arbitrage entre candidats', 'informations apportées par l’utilisateur'], markers: ['A7 —', 'A8 —', 'A9 —', 'interactionMode', 'suppliedFacts'],
      validations: ['t2PromptCapabilities'], requires: [], blockIds: [], expectedExecution: null, killSwitch: null,
      impact: 'L’assistant ne peut pas arbitrer entre candidats ni comprendre une information apportée.', anomaly: null, coverage: null,
      async check(p) {
        const { t2PromptCapabilities } = await import('../assistant/master/t2-prompt-capabilities');
        const c = t2PromptCapabilities(p.text);
        return c.message ? manque('INCOMPLETE', c.message, c.checks.filter((x) => !x.present).map((x) => x.label)) : ok();
      },
      async plan() { return noBlock('T2 arbitrage'); },
    });
  }

  // ── T3 ────────────────────────────────────────────────────────────────────
  const t3 = code('T3');
  const kqOps = await opsOf(t3, kq.KNOWLEDGE_QUERY_TASK);
  const kqOut = await outputsOf(t3, kq.KNOWLEDGE_QUERY_TASK);
  out.push({
    id: kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, treatment: 'T3', masterPromptCode: t3, rank: 1,
    label: 'T3 : branche KNOWLEDGE_QUERY (lecture de la connaissance T1 d’un document)', lot: '85F', guideStep: 1,
    version: kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, task: kq.KNOWLEDGE_QUERY_TASK, operations: kqOps, inputs: [kq.KNOWLEDGE_QUERY_CONTRACT_VERSION], outputs: kqOut,
    capabilities: ['knowledgeQueryCapability'], markers: [`BRANCHE TASK = ${kq.KNOWLEDGE_QUERY_TASK}`, kq.KNOWLEDGE_QUERY_CONTRACT_VERSION],
    validations: ['T3KnowledgeQueryOutput', 'validateFinding'], requires: [`t3-socle`], blockIds: ['t3-valeurs', 't3-knowledge-query-v1'],
    expectedExecution: null, killSwitch: 'T3_KNOWLEDGE_QUERY_ENABLED',
    impact: 'Les données écrites dans le texte des documents restent « interprétation en attente » : cartes « À traiter » ouvertes (constat INTERPRETATION_PENDING).',
    anomaly: null, coverage: null,
    async check(p) {
      const b = branches(p.text).includes(kq.KNOWLEDGE_QUERY_TASK);
      const v = knowledgeContractsIn(p.text).includes(kq.KNOWLEDGE_QUERY_CONTRACT_VERSION);
      if (b && v) return ok();
      if (!b && !v) return manque('ABSENT', `La section « BRANCHE TASK = ${kq.KNOWLEDGE_QUERY_TASK} » est absente du prompt T3 actif.`, [`BRANCHE TASK = ${kq.KNOWLEDGE_QUERY_TASK}`, kq.KNOWLEDGE_QUERY_CONTRACT_VERSION]);
      return manque('INCOMPLETE', b ? `La branche ${kq.KNOWLEDGE_QUERY_TASK} existe sans le contrat ${kq.KNOWLEDGE_QUERY_CONTRACT_VERSION} : texte propre au PO, à revoir.` : `Le marqueur ${kq.KNOWLEDGE_QUERY_CONTRACT_VERSION} est présent sans la section de branche.`,
        b ? [kq.KNOWLEDGE_QUERY_CONTRACT_VERSION] : [`BRANCHE TASK = ${kq.KNOWLEDGE_QUERY_TASK}`]);
    },
    async plan() { return blocks([{ id: 't3-valeurs', optional: true }, 't3-knowledge-query-v1']); },
  });
  const COMPLETS = 'kq-constituants-complets-v1';
  out.push({
    id: COMPLETS, treatment: 'T3', masterPromptCode: t3, rank: 2,
    label: 'T3 : KNOWLEDGE_QUERY rend tous les constituants utiles (durée ET remboursement…)', lot: '98A', guideStep: 7,
    version: COMPLETS, task: kq.KNOWLEDGE_QUERY_TASK, operations: kqOps, inputs: [kq.KNOWLEDGE_QUERY_CONTRACT_VERSION], outputs: kqOut,
    capabilities: ['knowledgeCompleteness (évaluateur 98A)'], markers: [COMPLETS], validations: ['T3KnowledgeQueryOutput', 'validateFinding', 'knowledgeCompleteness'],
    requires: [kq.KNOWLEDGE_QUERY_CONTRACT_VERSION], blockIds: ['t3-knowledge-query-constituants', 't3-knowledge-query-exemple-complet'],
    expectedExecution: null, killSwitch: null,
    impact: 'T3 ne rend que la durée : une carte « Quelle est la date de fin de ce contrat ? » inutile reste ouverte sur un prêt.',
    anomaly: null, coverage: null,
    async check(p) {
      return p.text.includes(COMPLETS) ? ok() : manque('INCOMPLETE', `La règle K6 (repère ${COMPLETS}) est absente de la branche KNOWLEDGE_QUERY : réponses incomplètes (constituant repayment manquant).`, [COMPLETS]);
    },
    async plan() { return blocks(['t3-knowledge-query-constituants', 't3-knowledge-query-exemple-complet']); },
  });
  out.push({
    id: mp.MISSING_PROPERTIES_CONTRACT_VERSION, treatment: 'T3', masterPromptCode: t3, rank: 4,
    label: 'T3 : reprise des propriétés manquantes d’un bien ou d’un équipement', lot: '88B', guideStep: 2,
    version: mp.MISSING_PROPERTIES_CONTRACT_VERSION, task: kq.KNOWLEDGE_QUERY_TASK, operations: kqOps, inputs: [mp.MISSING_PROPERTIES_CONTRACT_VERSION], outputs: kqOut,
    capabilities: ['missingPropertiesState (contractCarried)'], markers: [mp.MISSING_PROPERTIES_CONTRACT_VERSION],
    validations: ['T3KnowledgeQueryOutput', 'decideProperties'], requires: [kq.KNOWLEDGE_QUERY_CONTRACT_VERSION], blockIds: ['t3-knowledge-query-v2'],
    expectedExecution: null, killSwitch: 'T3_KNOWLEDGE_QUERY_ENABLED',
    impact: 'Aucune propriété vide n’est reprise : traitements bloqués, constat MISSING_PROPERTY_ARBITRATION_PENDING répété.',
    anomaly: { checkIds: [mp.MISSING_PROPERTIES_CHECK_ID, mp.MISSING_PROPERTIES_EQUIPMENT_CHECK_ID], anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING' },
    coverage: {
      operation: kq.KNOWLEDGE_QUERY_OPERATION, label: `cas de référence au contrat d’entrée ${mp.MISSING_PROPERTIES_CONTRACT_VERSION}`,
      matches: (c) => c.operationCode === kq.KNOWLEDGE_QUERY_OPERATION && JSON.stringify(c.variables?.FIELD ?? null).includes(mp.MISSING_PROPERTIES_CONTRACT_VERSION),
    },
    async check(p) {
      if (knowledgeContractsIn(p.text).includes(mp.MISSING_PROPERTIES_CONTRACT_VERSION)) return ok();
      return manque('ABSENT', `Le contrat ${mp.MISSING_PROPERTIES_CONTRACT_VERSION} est absent du prompt T3 actif (demande ${mp.MISSING_PROPERTIES_PENDING_CONTRACT}).`, [mp.MISSING_PROPERTIES_CONTRACT_VERSION]);
    },
    async plan() { return blocks(['t3-knowledge-query-v2']); },
  });
  out.push({
    id: idc.IDENTITY_CONTRACT_VERSION, treatment: 'T3', masterPromptCode: t3, rank: 8,
    label: 'T3 : identité d’un événement de référence à plusieurs documents', lot: '97A', guideStep: 5,
    version: idc.IDENTITY_CONTRACT_VERSION, task: idc.IDENTITY_TASK, operations: await opsOf(t3, idc.IDENTITY_TASK), inputs: [idc.IDENTITY_CONTRACT_VERSION],
    outputs: await outputsOf(t3, idc.IDENTITY_TASK), capabilities: ['identity capability (promptCarriesIdentity)'],
    markers: [`BRANCHE TASK = ${idc.IDENTITY_TASK}`, idc.IDENTITY_CONTRACT_VERSION], validations: ['T3OperationIdentityOutput', 'validateIdentity', 'planIdentity'],
    requires: ['t3-socle'], blockIds: [idc.IDENTITY_CONTRACT_VERSION], expectedExecution: null, killSwitch: 'T3_OPERATION_IDENTITY_ENABLED',
    impact: 'Un événement de référence qui regroupe à tort plusieurs documents n’est jamais réexaminé (constat IDENTITY_REEVALUATION_UNAVAILABLE).',
    anomaly: null, coverage: null,
    async check(p) {
      if (idc.promptCarriesIdentity(p.text, branches(p.text))) return ok();
      const b = branches(p.text).includes(idc.IDENTITY_TASK);
      const m = p.text.includes(idc.IDENTITY_CONTRACT_VERSION);
      return manque(b || m ? 'INCOMPLETE' : 'ABSENT', `Branche ${idc.IDENTITY_TASK} ${b ? 'présente' : 'absente'}, marqueur ${idc.IDENTITY_CONTRACT_VERSION} ${m ? 'présent' : 'absent'}.`,
        [...(b ? [] : [`BRANCHE TASK = ${idc.IDENTITY_TASK}`]), ...(m ? [] : [idc.IDENTITY_CONTRACT_VERSION])]);
    },
    async plan() { return blocks([idc.IDENTITY_CONTRACT_VERSION]); },
  });

  // ── T1 ────────────────────────────────────────────────────────────────────
  const t1 = code('T1');
  const t1Ops = await opsOf(t1, 'ANALYZE_DOCUMENT');
  out.push({
    id: vd.T1_VALUE_DECISIONS_CONTRACT, treatment: 'T1', masterPromptCode: t1, rank: 6,
    label: 'T1 : décisions motivées sur les valeurs significatives non reprises', lot: '91D', guideStep: 4,
    version: vd.T1_VALUE_DECISIONS_CONTRACT, task: 'ANALYZE_DOCUMENT', operations: t1Ops, inputs: [], outputs: await outputsOf(t1, 'ANALYZE_DOCUMENT'),
    capabilities: ['valueDecisionsCapability'], markers: [vd.T1_VALUE_DECISIONS_CONTRACT], validations: ['T1AnalyzeDocumentOutput', 'validateValueDecisions'],
    requires: ['t1-socle'], blockIds: [vd.T1_VALUE_DECISIONS_CONTRACT], expectedExecution: null, killSwitch: 'T1_VALUE_DECISIONS_ENABLED',
    impact: `Constats FACT_OMITTED_* maintenus (demande ${vd.T1_OMISSIONS_PENDING_CONTRACT}), aucun réexamen ciblé.`, anomaly: null, coverage: null,
    async check(p) {
      return vd.promptCarriesValueDecisions(p.text) ? ok() : manque('ABSENT', `Le contrat ${vd.T1_VALUE_DECISIONS_CONTRACT} est absent du prompt T1 actif.`, [vd.T1_VALUE_DECISIONS_CONTRACT]);
    },
    async plan() { return blocks([vd.T1_VALUE_DECISIONS_CONTRACT]); },
  });
  out.push({
    id: bp.T1_BILLING_PERIOD_CONTRACT, treatment: 'T1', masterPromptCode: t1, rank: 7,
    label: 'T1 : période facturée et mois principal d’une facture périodique', lot: '97A', guideStep: 4,
    version: bp.T1_BILLING_PERIOD_CONTRACT, task: 'ANALYZE_DOCUMENT', operations: t1Ops, inputs: [], outputs: await outputsOf(t1, 'ANALYZE_DOCUMENT'),
    capabilities: ['billingPeriodCapability'], markers: [bp.T1_BILLING_PERIOD_CONTRACT], validations: ['T1AnalyzeDocumentOutput v7 (billingPeriod)'],
    requires: [vd.T1_VALUE_DECISIONS_CONTRACT], blockIds: [vd.T1_VALUE_DECISIONS_CONTRACT], expectedExecution: null, killSwitch: 'T1_BILLING_PERIOD_ENABLED',
    impact: `Titre « Facture … — <mois> » sans mois principal décidé par l’IA (demande ${bp.T1_BILLING_PERIOD_PENDING_CONTRACT}).`, anomaly: null, coverage: null,
    async check(p) {
      if (bp.promptCarriesBillingPeriod(p.text)) return ok();
      return manque(vd.promptCarriesValueDecisions(p.text) ? 'OBSOLETE' : 'ABSENT',
        vd.promptCarriesValueDecisions(p.text) ? `Bloc T1 de la version précédente du guide (lot 91D) : la partie ${bp.T1_BILLING_PERIOD_CONTRACT} manque.` : `Le contrat ${bp.T1_BILLING_PERIOD_CONTRACT} est absent du prompt T1 actif.`,
        [bp.T1_BILLING_PERIOD_CONTRACT]);
    },
    async plan() {
      // Guide, étape 4 : bloc 91D déjà actif → seulement la fin du bloc, à partir de son titre (résultat identique, vérifié par le test du guide).
      const b = guideBlock(vd.T1_VALUE_DECISIONS_CONTRACT);
      const titre = `PÉRIODE FACTURÉE ET MOIS PRINCIPAL (contrat ${bp.T1_BILLING_PERIOD_CONTRACT})`;
      const i = b ? b.text.indexOf(titre) : -1;
      if (!b || i < 0) return { ok: false, code: 'BLOCK_UNAVAILABLE', message: `Partie « ${titre} » introuvable dans le bloc officiel ${vd.T1_VALUE_DECISIONS_CONTRACT} du guide : aucune correction automatique.` };
      const text = b.text.slice(i);
      const { createHash } = await import('node:crypto');
      return { ok: true, steps: [{ kind: 'block', block: { ...b, id: `${b.id}#periode-facturee`, text, sha256: createHash('sha256').update(text).digest('hex') } }] };
    },
  });

  // ── T4 ────────────────────────────────────────────────────────────────────
  const t4 = code('T4');
  out.push({
    id: t4c.T4_INTERVENTION_OUTPUT_CONTRACT, treatment: 'T4', masterPromptCode: t4, rank: 3,
    label: 'T4 : version active en contexte structuré, contrat de sortie t4_output_v3 (évaluation d’une intervention « À traiter »)', lot: '98A', guideStep: 8,
    version: t4c.T4_INTERVENTION_OUTPUT_CONTRACT, task: 'CLASSIFY_EVENT', operations: await opsOf(t4, 'CLASSIFY_EVENT'), inputs: [String(T4_EXECUTION_SPEC.defaults.inputContractVersion)],
    outputs: [t4c.T4_INTERVENTION_OUTPUT_CONTRACT], capabilities: ['t4AssessmentConfig (interventionCapable)'], markers: ['toProcessAssessment', 'intervention'],
    validations: ['assessT4Compatibility', 'checkExecutionConfig'], requires: ['t4-socle'], blockIds: [],
    expectedExecution: `Contexte structuré · ${String(T4_EXECUTION_SPEC.defaults.inputContractVersion)} / ${String(T4_EXECUTION_SPEC.defaults.outputContractVersion)} ou suivants · TASK CLASSIFY_EVENT`,
    killSwitch: null, impact: 'Décisions T4_INCOMPATIBLE : cartes « À traiter » conservées faute d’évaluation de l’intervention.', anomaly: null, coverage: null,
    async check(p) {
      const a = t4c.assessT4Compatibility({ spec: T4_EXECUTION_SPEC, execution: p.execution, content: p.text, referenceText: p.referenceText });
      if (a.compatible && a.textReady) return ok();
      return manque(a.issues.some((i) => i.code === 'LEGACY_TEMPLATE' || i.code === 'OUTPUT_CONTRACT_TOO_OLD') ? 'OBSOLETE' : 'INCOMPATIBLE', a.issues.map((i) => i.message).join(' '), a.issues.map((i) => i.code));
    },
    async plan(p) {
      const a = t4c.assessT4Compatibility({ spec: T4_EXECUTION_SPEC, execution: p.execution, content: p.text, referenceText: p.referenceText });
      if (a.remedy === 'RESTART_FROM_REFERENCE') {
        return { ok: false, code: 'TEXT_TOO_DIVERGENT', message: 'Le texte T4 actif ne décrit pas l’évaluation d’une intervention : seule une reprise du texte livré (guide, étape 8, procédure B) corrigerait — trop divergent pour une correction automatique minimale.' };
      }
      return { ok: true, steps: [{ kind: 'execution', target: a.target }] };
    },
  });
  const REP_TASK = 'AGENDA_REPRESENTATION';
  /** Contrats d'entrée / sortie les plus récents qui décrivent la TASK (déclarés par la spécification). */
  const numero = (v: string) => Number(/_v(\d+)$/.exec(v)?.[1] ?? 0);
  const plusRecent = (l: string[]) => l.sort((a, b) => numero(b) - numero(a))[0] ?? null;
  const repInput = plusRecent(Object.entries(T4_EXECUTION_SPEC.inputContracts).filter(([, c]) => c.tasks[REP_TASK]).map(([v]) => v));
  const repOutput = plusRecent(Object.entries(T4_EXECUTION_SPEC.outputContracts).filter(([, c]) => c.byTask[REP_TASK]).map(([v]) => v));
  out.push({
    id: repc.REPRESENTATION_CONTRACT_VERSION, treatment: 'T4', masterPromptCode: t4, rank: 9,
    label: 'T4 : représentation Agenda d’un événement de référence à plusieurs éléments', lot: '97A', guideStep: 6,
    version: repc.REPRESENTATION_CONTRACT_VERSION, task: REP_TASK, operations: await opsOf(t4, REP_TASK), inputs: [String(repInput)], outputs: [String(repOutput)],
    capabilities: ['representationCapabilityOf'], markers: [repc.REPRESENTATION_CONTRACT_VERSION], validations: ['T4AgendaRepresentationOutput', 'validateRepresentation', 'planRepresentation'],
    requires: [t4c.T4_INTERVENTION_OUTPUT_CONTRACT], blockIds: [repc.REPRESENTATION_CONTRACT_VERSION],
    expectedExecution: `Contexte structuré · ${String(repInput)} / ${String(repOutput)} · TASK ${REP_TASK} cochée`, killSwitch: 'T4_AGENDA_REPRESENTATION_ENABLED',
    impact: 'Doublons d’Agenda non fusionnés, étapes non séparées (CONTRACT_PENDING, constat REPRESENTATION_DECISION_UNAVAILABLE).', anomaly: null, coverage: null,
    async check(p) {
      const c = rep.representationCapabilityOf({ text: p.text, version: '', execution: p.execution });
      if (c.available) return ok();
      const st = (c as { contractState?: string }).contractState ?? 'MARKER_MISSING';
      return manque(st === 'MARKER_MISSING' ? 'ABSENT' : 'INCOMPATIBLE', `Représentation Agenda indisponible (${st}).`, [st]);
    },
    async plan(p) {
      if (!repInput || !repOutput) return { ok: false, code: 'BLOCK_UNAVAILABLE', message: `Aucun contrat d’exécution T4 ne décrit ${REP_TASK} : défaut du code.` };
      const base = p.execution.mode === 'STRUCTURED_CONTEXT' ? p.execution : null;
      if (!base) return { ok: false, code: 'TEXT_TOO_DIVERGENT', message: 'Version T4 active en mode historique à emplacements : l’étape 8 (contexte structuré) doit être faite d’abord.' };
      const taches = sc.allowedTasksOf(T4_EXECUTION_SPEC, base);
      const target: MasterExecutionConfig = {
        mode: 'STRUCTURED_CONTEXT',
        inputContractVersion: numero(base.inputContractVersion ?? '') >= numero(repInput) ? base.inputContractVersion : repInput,
        outputContractVersion: numero(base.outputContractVersion ?? '') >= numero(repOutput) ? base.outputContractVersion : repOutput,
        allowedTasks: taches.includes(REP_TASK) ? taches : [...taches, REP_TASK],
      };
      const steps: CorrectionStep[] = [];
      if (!rep.promptCarriesRepresentation(p.text)) {
        const b = blocks([repc.REPRESENTATION_CONTRACT_VERSION]);
        if (!b.ok) return b;
        steps.push(...b.steps);
      }
      steps.push({ kind: 'execution', target });
      return { ok: true, steps };
    },
  });

  // ── T6 ────────────────────────────────────────────────────────────────────
  const t6 = code('T6');
  out.push({
    id: t6s.T6_SUGGESTION_CONTRACT, treatment: 'T6', masterPromptCode: t6, rank: 5,
    label: 'T6 : questions suggérées fondées sur l’accueil', lot: '87C', guideStep: 3,
    version: t6s.T6_SUGGESTION_CONTRACT, task: 'FORMULATE', operations: await opsOf(t6, 'FORMULATE'), inputs: ['{{SUGGESTION_CONTEXT}}', t6s.T6_SUGGESTION_CONTRACT],
    outputs: await outputsOf(t6, 'FORMULATE'), capabilities: ['promptSupportsSuggestionGrounds'], markers: ['{{SUGGESTION_CONTEXT}}', t6s.T6_SUGGESTION_CONTRACT, '"groundRefs"'],
    validations: ['T6FormulateOutput', 'validateT6SuggestionsDetailed'], requires: ['t6-socle'], blockIds: [t6s.T6_SUGGESTION_CONTRACT], expectedExecution: null, killSwitch: null,
    impact: 'Aucune question « Ou demandez-moi » sur l’accueil (PROMPT_UNSUPPORTED).', anomaly: null, coverage: null,
    async check(p) {
      if (t6s.promptSupportsSuggestionGrounds(p.text)) return ok();
      const manquants = ['{{SUGGESTION_CONTEXT}}', t6s.T6_SUGGESTION_CONTRACT, '"groundRefs"'].filter((m) => !p.text.includes(m));
      return manque(p.text.includes('t6-suggestions-v') ? 'OBSOLETE' : 'ABSENT', `Contrat ${t6s.T6_SUGGESTION_CONTRACT} incomplet : ${manquants.join(', ')} absent(s).`, manquants);
    },
    async plan() { return blocks([t6s.T6_SUGGESTION_CONTRACT]); },
  });
  // ── Contrats déclarés en une ligne (marqueur + bloc officiel) ─────────────
  for (const d of MARKER_CONTRACT_DECLARATIONS) {
    const mpc = code(d.treatment);
    out.push({
      id: d.id, treatment: d.treatment, masterPromptCode: mpc, rank: d.rank, label: d.label, lot: d.lot, guideStep: d.guideStep,
      version: d.id, task: d.task, operations: await opsOf(mpc, d.task), inputs: [], outputs: await outputsOf(mpc, d.task),
      capabilities: [`détection du marqueur ${d.id}`], markers: [d.id], validations: ['checkMasterPromptContent', 'schéma de sortie de la branche'],
      requires: d.requires ?? [`${d.treatment.toLowerCase()}-socle`], blockIds: [d.blockId], expectedExecution: null, killSwitch: d.killSwitch,
      impact: d.impact, anomaly: null, coverage: null,
      async check(p) {
        return (await d.detect(p.text)) ? ok() : manque(p.text.includes(d.id) ? 'INCOMPLETE' : 'ABSENT', `Le contrat ${d.id} est absent du prompt ${d.treatment} actif.`, [d.id]);
      },
      async plan() { return blocks([d.blockId]); },
    });
  }
  return out.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}
