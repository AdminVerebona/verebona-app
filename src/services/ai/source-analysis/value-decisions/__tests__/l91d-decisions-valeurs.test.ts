/**
 * Lot 91D — traçabilité des décisions T1 sur les valeurs significatives et
 * qualification des omissions documentaires (COH-DOC-EXTRACT-CHAIN, contrat
 * `t1-value-decisions-v1`, demande 82B-t1-omissions-extract). Sans base —
 * voir le scénario e2e `l91d-decisions-t1-omissions.e2e.ts`.
 *
 *  L91D-U01  contrat de sortie T1 v6 : additif et facultatif (une v5 reste valide, ABSENT ≠ liste vide), schéma
 *            fournisseur toujours transmis ; lecture tolérante : une décision mal formée est écartée SEULE et conservée
 *            comme invalide, index de faits recalés ;
 *  L91D-U02  validation serveur : facture 120 € dont 34 € de frais (composante valide), exclusion motivée, valeur
 *            absente de l'unité, forme normalisée divergente, motif absent, rattachement manquant / inconnu,
 *            décisions contradictoires, doublons, unité citée par identifiant ;
 *  L91D-U03  contrôle : contrat NON porté → constats et empreintes d'avant ; décision valide → plus de faux constat ;
 *            absente / invalide / obsolète / rattachement disparu → toujours signalée (réexamen ciblé une fois,
 *            puis constat qualifié) ; indéterminée ou conflictuelle → FACT_DECISION_UNDETERMINED ; reprise épuisée
 *            qualifiée, sans répétition ;
 *  L91D-U04  guide du PO : le bloc T1 s'applique au prompt livré (ligne repère unique), porte le marqueur, passe les
 *            contrôles d'activation du BO ; son exemple JSON passe le schéma strict, la validation serveur réelle et
 *            le contrôle (montants 34 € et 10 000 € justifiés, aucun fait ajouté) ;
 *  L91D-U05  diagnostic global, transfert de compte, registre, rattrapage BO, Supervision : la table et le
 *            réexamen sont déclarés partout ;
 *  L91D-U06  réexamen : formes comparables d'une valeur, faits actifs retrouvés par la valeur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { T1AnalyzeDocumentOutput, T1_ANALYZE_DOCUMENT_CONTRACT_VERSION } = await import('../../master/t1-contract');
const { T1AnalyzeDocumentTolerantOutput, splitNormalisation } = await import('../../master/tolerant-output');
const { anchorOperationCandidates } = await import('../../operation-candidates/prepare');
const { buildSourceUnits } = await import('../../source-units/build-units');
const v = await import('../validate');
const { promptCarriesValueDecisions, T1_VALUE_DECISIONS_CONTRACT, T1_OMISSIONS_PENDING_CONTRACT } = await import('../contract');
const { valueForms, matchFactIds } = await import('../review');
const { providerJsonSchema } = await import('@/services/ai/gateway/output-resolution/provider-schema');
const { outputSchemaRef } = await import('@/services/ai/gateway/output-resolution/contracts');
const ec = await import('@/services/coherence/registry/checks/extract-chain');
const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');

type Prepared = import('../validate').PreparedValueDecision;
type DecisionView = import('@/services/coherence/registry/checks/extract-chain').DecisionView;
type ExtractChainInput = import('@/services/coherence/registry/checks/extract-chain').ExtractChainInput;

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const T1_LIVRE = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'source-analysis', 't1_master_v1.txt'), 'utf-8');

// ── Jeu de données : facture 120 € dont 34 € de frais (valeurs neutres) ─────
const FACTURE = [
  'Facture de maintenance',
  'Date : 12/03/2026',
  'Total TTC : 120,00 €',
  'dont frais de dossier : 34,00 €',
  '',
  'Paiement à réception. SARL au capital de 10 000 €',
].join('\n');
const UNITES = buildSourceUnits({ segments: [{ text: FACTURE, pageOffset: 0, origin: 'PASS_1' }] });
const uniteDe = (morceau: string) => {
  const u = UNITES.find((x) => (v.unitTextOf(x) ?? '').includes(morceau));
  if (!u) throw new Error(`unité introuvable : ${morceau}`);
  return u;
};

const fait = (excerpt: string, rawValue: string, normalizedValue: number) => ({
  canonicalKey: null, rawKey: 'totalTTC', label: 'Total TTC', rawValue, normalizedValue, valueType: 'money_eur', canonicalUnit: 'EUR',
  target: { type: 'DOCUMENT', entityId: null, confidence: 'certain' }, provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 },
});
const decision = (o: Record<string, unknown>) => ({
  value: '34,00 €', kind: 'AMOUNT', normalizedValue: '3400', decision: 'COMPONENT_OR_CONTEXT',
  reason: 'Frais de dossier déjà inclus dans le total TTC de 120,00 €.', sourceUnitId: null,
  evidence: { excerpt: 'dont frais de dossier : 34,00 €', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain', ...o,
});
/** Sortie T1 brute → lecture tolérante → empreintes → décisions ancrées (chemin de production). */
const recevoir = (brut: Record<string, unknown>) => {
  const { output, report } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(brut));
  anchorOperationCandidates(output, 'PASS_1');
  return { output, report, anchored: v.anchorValueDecisions(output, 'PASS_1', report?.invalidValueDecisions ?? []) };
};
const sortie = (decisions?: unknown[]) => ({
  task: 'ANALYZE_DOCUMENT', document: {}, facts: [fait('Total TTC : 120,00 €', '120,00 €', 120)],
  ...(decisions ? { valueDecisions: decisions } : {}),
});
const valider = (decisions: unknown[], over: Partial<import('../validate').ValidationContext> = {}) => {
  const r = recevoir(sortie(decisions));
  const refs = new Set((r.output.facts as Array<{ t1FactRef?: string }>).map((f) => f.t1FactRef!).filter(Boolean));
  return v.validateValueDecisions(r.anchored!, { units: UNITES, keptFactRefs: refs, candidateKeys: new Set(['op1']), ...over });
};

// ── Contrôle : entrée pure construite comme `inspect` ─────────────────────
const k = (o: { amounts?: number[]; dates?: string[] } = {}) => ({ amounts: new Set(o.amounts ?? []), dates: new Set(o.dates ?? []), identifiers: new Set<string>() });
const extractUnits = (status = 'COVERED') => UNITES.filter((u) => ['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW'].includes(u.kind)).map((u) => ({
  unitId: u.sourceUnitId, kind: u.kind, ordinal: u.ordinal, text: v.unitTextOf(u), status, reason: 'fact', salient: true,
  repairAttempts: 0, repairState: null, retryable: null, updatedAt: '2026-10-26T08:00:00.000000',
}));
const entree = (o: Partial<ExtractChainInput> = {}): ExtractChainInput => ({
  fileId: 91, extractionId: 910, coverage: { retryAttempts: 0, nextRetryAt: null, pagesMissing: [] }, units: extractUnits(),
  // T1 a structuré le total (120 €) et la date du document.
  t1: k({ amounts: [12000, 120], dates: ['2026-03-12'] }), t1Unstructured: k(),
  projection: null, repairableUnitIds: new Set(), maxRetries: 2, pendingHashes: new Set(), triedHashes: new Set(), ...o,
});
/** Décisions persistées telles que les lit le contrôle (rattachement actif si un fait ou un candidat est cité). */
const vues = (ps: Prepared[], linkActive = true): Map<string, DecisionView> => new Map(ps.filter((p) => p.sourceUnitId && p.kind && p.normalizedValue).map((p, i) => [
  v.valueKey(p.sourceUnitId!, p.kind!, p.normalizedValue!),
  { id: i + 1, decision: p.decision, validity: p.validity, invalidReason: p.invalidReason, confidence: p.confidence, unitFingerprint: p.unitFingerprint,
    linkActive: linkActive && (p.relatedFactRefs.length > 0 || p.relatedCandidateKeys.length > 0) },
]));
const valeursSignalees = (i: { observed?: unknown }) => ((i.observed ?? []) as Array<{ values: Array<{ value: string }> }>).flatMap((o) => o.values.map((x) => x.value));

describe('L91D-U01 — contrat de sortie T1 v6 (additif, facultatif, compatible avec le schéma strict)', () => {
  it('une sortie v5 reste valide ; le tableau ABSENT n’est pas une liste vide ; version et schéma fournisseur', () => {
    expect(T1_ANALYZE_DOCUMENT_CONTRACT_VERSION).toBe(7);
    expect(outputSchemaRef('T1AnalyzeDocumentOutput', T1AnalyzeDocumentOutput, 't1_analyze_document').version).toBe('t1_analyze_document@v7');
    expect(T1AnalyzeDocumentOutput.parse(sortie()).valueDecisions).toBeUndefined();
    expect(T1AnalyzeDocumentOutput.parse(sortie([])).valueDecisions).toEqual([]);
    expect(recevoir(sortie()).anchored).toBeNull();
    expect(recevoir(sortie([])).anchored).toEqual([]);
    const ps = providerJsonSchema(T1AnalyzeDocumentOutput);
    expect(ps.omitted).toBeNull();
    const props = (ps.schema as { properties: Record<string, unknown>; required?: string[] });
    expect(props.properties.valueDecisions).toBeDefined();
    expect(props.required ?? []).not.toContain('valueDecisions');
  });

  it('lecture tolérante : décision mal formée écartée SEULE (conservée invalide), vocabulaire et index recalés', () => {
    const r = recevoir({
      ...sortie([
        decision({ decision: 'component_or_context', confidence: 'uncertain', sourceUnitId: '[page:1:field:3]' }),
        decision({ decision: 'PEUT-ÊTRE' }),
        decision({ value: 'x'.repeat(300) }),
      ]),
      // Un fait invalide AVANT le total : l'index 1 de la sortie devient 0.
      facts: [{ canonicalKey: null, normalizedValue: 'trop'.repeat(600), target: { type: 'DOCUMENT' }, confidence: 'certain' }, fait('Total TTC : 120,00 €', '120,00 €', 120)],
    });
    expect(r.output.facts).toHaveLength(1);
    expect(r.output.valueDecisions).toHaveLength(1);
    expect(r.output.valueDecisions![0]).toMatchObject({ decision: 'COMPONENT_OR_CONTEXT', confidence: 'probable', sourceUnitId: 'page:1:field:3' });
    expect(r.report?.invalidValueDecisions).toHaveLength(2);
    expect(r.anchored!.filter((a) => a.schemaInvalid)).toHaveLength(2);
    // Le document entier reste valide (faits, autres décisions).
    expect(T1AnalyzeDocumentOutput.safeParse(r.output).success).toBe(true);
  });
});

describe('L91D-U02 — validation serveur (forme et provenance, jamais la pertinence)', () => {
  it('facture 120 € dont 34 € de frais : la composante rattachée au total est VALIDE, sur la bonne unité', () => {
    const [d] = valider([decision({ relatedFactIndexes: [0] })]);
    expect(d).toMatchObject({
      validity: 'VALID', invalidReason: null, decision: 'COMPONENT_OR_CONTEXT', kind: 'AMOUNT', normalizedValue: '3400',
      sourceUnitId: uniteDe('34,00').sourceUnitId, unitFingerprint: v.unitFingerprint(v.unitTextOf(uniteDe('34,00'))),
    });
    expect(d.relatedFactRefs).toHaveLength(1);
  });

  it('exclusion motivée valide ; valeur citée par identifiant d’unité ; forme normalisée nulle recalculée', () => {
    const u = uniteDe('10 000');
    const ps = valider([
      decision({ value: '10 000 €', normalizedValue: null, decision: 'NOT_RETAINED', reason: 'Capital social du prestataire, mention légale.', relatedFactIndexes: [], evidence: {}, sourceUnitId: u.sourceUnitId }),
    ]);
    expect(ps).toEqual([expect.objectContaining({ validity: 'VALID', normalizedValue: '1000000', sourceUnitId: u.sourceUnitId })]);
  });

  it('rejets motivés : valeur absente de l’unité, forme divergente, motif absent ou générique, rattachement manquant ou inconnu', () => {
    const rejet = (o: Record<string, unknown>, over = {}) => valider([decision(o)], over)[0].invalidReason;
    expect(rejet({ value: '35,00 €', normalizedValue: '3500' })).toBe('VALUE_NOT_IN_UNIT');
    expect(rejet({ normalizedValue: '34' })).toBe('NORMALIZED_MISMATCH');
    expect(rejet({ reason: 'ok' })).toBe('REASON_MISSING');
    expect(rejet({ reason: '34,00 €' })).toBe('REASON_MISSING');
    expect(rejet({ relatedFactIndexes: [] })).toBe('LINK_MISSING');
    expect(rejet({ decision: 'STRUCTURED', relatedFactIndexes: [] })).toBe('LINK_MISSING');
    // Fait cité mais écarté par l'analyse (preuve, capacités) : le rattachement n'existe pas.
    expect(rejet({}, { keptFactRefs: new Set<string>() })).toBe('LINK_UNKNOWN');
    // Candidat retenu par la barrière serveur : rattachement accepté sans fait.
    expect(rejet({ relatedFactIndexes: [], relatedCandidateKeys: ['op1'] })).toBeNull();
    expect(rejet({ relatedFactIndexes: [], relatedCandidateKeys: ['op9'] })).toBe('LINK_UNKNOWN');
    expect(rejet({ evidence: { excerpt: 'texte absent du document', page: 1 } })).toBe('UNIT_NOT_FOUND');
    // Décision indéterminée : valide (motif présent), jamais une justification (voir L91D-U03).
    expect(rejet({ decision: 'UNDETERMINED', relatedFactIndexes: [] })).toBeNull();
  });

  it('une valeur, une décision : doublons exacts retirés, décisions contradictoires toutes invalides', () => {
    expect(valider([decision({}), decision({})])).toHaveLength(1);
    const contra = valider([decision({}), decision({ decision: 'NOT_RETAINED', relatedFactIndexes: [], reason: 'Frais affichés pour information seulement.' })]);
    expect(contra.map((p) => p.invalidReason)).toEqual(['CONFLICTING_DECISIONS', 'CONFLICTING_DECISIONS']);
  });
});

describe('L91D-U03 — COH-DOC-EXTRACT-CHAIN exploite les décisions (et seulement si le contrat est porté)', () => {
  const frais = uniteDe('34,00');

  it('contrat NON porté : constat d’avant, mêmes empreintes, aucune décision simulée, aucun réexamen', () => {
    const avant = ec.diagnoseExtractChain(entree());
    const aujourdHui = ec.diagnoseExtractChain(entree({ decisionContract: 'MARKER_MISSING' }));
    expect(aujourdHui).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT', inputHash: avant.inputHash,
      detail: expect.objectContaining({ pendingContract: T1_OMISSIONS_PENDING_CONTRACT, t1Relaunch: false, repair: null, valueDecisions: { contract: 'MARKER_MISSING' } }) });
    expect(valeursSignalees(aujourdHui).sort()).toEqual(['1000000', '3400']);
  });

  it('montant inclus dans un total + exclusion justifiée : décisions valides → COHÉRENT, motif de résolution tracé', () => {
    const ps = valider([
      decision({}),
      decision({ value: '10 000 €', normalizedValue: '1000000', decision: 'NOT_RETAINED', reason: 'Capital social du prestataire, mention légale.', relatedFactIndexes: [], evidence: { excerpt: 'SARL au capital de 10 000 €', page: 1 } }),
    ]);
    const i = ec.diagnoseExtractChain(entree({ decisions: vues(ps), decisionContract: 'CARRIED' }));
    expect(i.verdict).toBe('CONSISTENT');
    expect(i.detail).toMatchObject({ valueDecisions: { contract: 'CARRIED', justified: 2, absent: 0, undetermined: 0 } });
    expect((i.detail as { valueDecisions: { justifiedSample: unknown[] } }).valueDecisions.justifiedSample).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: frais.sourceUnitId, kind: 'AMOUNT', value: '3400', decision: 'COMPONENT_OR_CONTEXT' }),
    ]));
  });

  it('véritable omission : sans décision → réexamen ciblé UNE fois, puis constat qualifié (jamais justifié par le code)', () => {
    const justif = valider([decision({ value: '10 000 €', normalizedValue: '1000000', decision: 'NOT_RETAINED', reason: 'Capital social, mention légale.', relatedFactIndexes: [], evidence: { excerpt: 'SARL au capital de 10 000 €', page: 1 } })]);
    const i = ec.diagnoseExtractChain(entree({ decisions: vues(justif), decisionContract: 'CARRIED' }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({ repair: 'DECISION_REVIEW', qualification: 'UNJUSTIFIED_OMISSION', decisionReview: 'DUE' }) });
    expect(i.observed).toEqual([{ unit: frais.sourceUnitId, status: 'COVERED', values: [{ kind: 'AMOUNT', value: '3400', decision: { state: 'ABSENT' } }] }]);
    const apres = ec.diagnoseExtractChain(entree({ decisions: vues(justif), decisionContract: 'CARRIED', triedHashes: new Set([i.inputHash!]) }));
    expect(apres).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT',
      detail: expect.objectContaining({ qualification: 'UNJUSTIFIED_OMISSION', motive: 'NO_VALID_DECISION_AFTER_REVIEW', decisionReview: 'TRIED', repair: null }) });
    expect((apres.detail as Record<string, unknown>).pendingContract).toBeUndefined();
  });

  it('décision invalide, obsolète (unité réécrite) ou rattachement disparu : toujours signalée', () => {
    const tried = (i: { inputHash?: string }) => new Set([i.inputHash!]);
    const invalide = valider([decision({ reason: 'ok' })]);
    const i1 = ec.diagnoseExtractChain(entree({ decisions: vues(invalide), decisionContract: 'CARRIED' }));
    const f1 = ec.diagnoseExtractChain(entree({ decisions: vues(invalide), decisionContract: 'CARRIED', triedHashes: tried(i1) }));
    expect(f1.anomaly).toBe('FACT_OMITTED_COVERED_UNIT');
    expect(JSON.stringify(f1.observed)).toContain('"state":"INVALID"');
    expect(JSON.stringify(f1.observed)).toContain('REASON_MISSING');
    const valide = valider([decision({})]);
    const obsolete = new Map([...vues(valide)].map(([cle, d]) => [cle, { ...d, unitFingerprint: 'autre-texte' }]));
    expect(JSON.stringify(ec.diagnoseExtractChain(entree({ decisions: obsolete, decisionContract: 'CARRIED' })).observed)).toContain('"state":"STALE"');
    expect(JSON.stringify(ec.diagnoseExtractChain(entree({ decisions: vues(valide, false), decisionContract: 'CARRIED' })).observed)).toContain('"state":"LINK_GONE"');
  });

  it('décision incertaine (UNDETERMINED ou conflictuelle) : jamais une conformité → FACT_DECISION_UNDETERMINED', () => {
    for (const o of [{ decision: 'UNDETERMINED', relatedFactIndexes: [] }, { confidence: 'conflictual' }]) {
      const ps = valider([decision(o), decision({ value: '10 000 €', normalizedValue: '1000000', decision: 'NOT_RETAINED', reason: 'Capital social, mention légale.', relatedFactIndexes: [], evidence: { excerpt: 'SARL au capital de 10 000 €', page: 1 } })]);
      const i = ec.diagnoseExtractChain(entree({ decisions: vues(ps), decisionContract: 'CARRIED' }));
      expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_DECISION_UNDETERMINED', faultyLink: 'T1',
        detail: expect.objectContaining({ qualification: 'UNDETERMINED_DECISION', motive: 'T1_UNDETERMINED', valueDecisions: expect.objectContaining({ undetermined: 1, justified: 1 }) }) });
      expect(valeursSignalees(i)).toEqual(['3400']);
    }
  });

  it('reprise épuisée : réexamen une fois, puis FACT_OMITTED_REPAIR_EXHAUSTED qualifié technique, sans répétition', () => {
    const units = extractUnits('UNRESOLVED');
    const i = ec.diagnoseExtractChain(entree({ units, decisions: new Map(), decisionContract: 'CARRIED' }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', detail: expect.objectContaining({ repair: 'DECISION_REVIEW', qualification: 'REPAIR_TECHNICAL' }) });
    const f = ec.diagnoseExtractChain(entree({ units, decisions: new Map(), decisionContract: 'CARRIED', triedHashes: new Set([i.inputHash!]) }));
    expect(f).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', detail: expect.objectContaining({ qualification: 'REPAIR_TECHNICAL', decisionReview: 'TRIED' }) });
    // Le réexamen ne change pas son empreinte avec l'état des décisions : jamais de boucle.
    const invalides = new Map([...vues(valider([decision({ reason: 'ok' })]))]);
    expect(ec.diagnoseExtractChain(entree({ units, decisions: invalides, decisionContract: 'CARRIED', triedHashes: new Set([i.inputHash!]) })).verdict).toBe('FINDING');
    // Sans contrat : le diagnostic historique.
    expect(ec.diagnoseExtractChain(entree({ units }))).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', detail: expect.objectContaining({ motive: 'REPAIR_EXHAUSTED' }) });
  });
});

/** Applique le bloc balisé du guide comme le PO (même lecture que l89c-guide-prompts). */
const blocT1 = (() => {
  const m = /<!-- l89c:bloc ([^>]*?id="t1-value-decisions-v1"[^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/.exec(GUIDE);
  if (!m) throw new Error('bloc T1 absent du guide');
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  return { attrs, text: m[2] };
})();
const T1_ETAPE4 = (() => {
  expect(T1_LIVRE.split(blocT1.attrs.anchor).length - 1).toBe(1);
  return T1_LIVRE.replace(blocT1.attrs.anchor, `${blocT1.text}\n\n${blocT1.attrs.anchor}`);
})();
/** PREMIER exemple JSON du bloc (lot 97A : le bloc T1 unique porte aussi l'exemple de période facturée). */
const exempleJson = (): Record<string, unknown> => {
  const i = blocT1.text.indexOf('\n{\n');
  const fin = blocT1.text.indexOf('\n}\n', i);
  return JSON.parse(blocT1.text.slice(i + 1, fin + 2));
};

describe('L91D-U04 — guide du PO : bloc T1 prêt à coller, vérifié contre le code réel', () => {
  it('bloc applicable au prompt livré, marqueur lu (absent du texte livré), aucun emplacement ni section de branche ajouté', () => {
    expect(blocT1.attrs).toMatchObject({ prompt: 't1', action: 'insert-before' });
    expect(promptCarriesValueDecisions(T1_LIVRE)).toBe(false);
    expect(promptCarriesValueDecisions(T1_ETAPE4)).toBe(true);
    expect(blocT1.text).toContain(T1_VALUE_DECISIONS_CONTRACT);
    expect(inspectMasterTemplate(blocT1.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(T1_ETAPE4).branches).toEqual(inspectMasterTemplate(T1_LIVRE).branches);
  });

  it('contrôles d’activation du BO : aucun bloquant, aucun avertissement nouveau', () => {
    const avant = checkMasterPromptContent('T1', T1_LIVRE);
    const apres = checkMasterPromptContent('T1', T1_ETAPE4);
    expect(apres.blocking).toEqual([]);
    expect(apres.warnings.map((w) => w.code)).toEqual(avant.warnings.map((w) => w.code));
  });

  it('exemple JSON : schéma strict v6, validation serveur réelle, contrôle → montants justifiés, aucun fait ajouté', () => {
    const ex = exempleJson();
    expect(T1AnalyzeDocumentOutput.safeParse(ex).success).toBe(true);
    const r = recevoir(ex);
    expect(r.output.facts).toHaveLength(1);
    const refs = new Set((r.output.facts as Array<{ t1FactRef?: string }>).map((f) => f.t1FactRef!));
    const ps = v.validateValueDecisions(r.anchored!, { units: UNITES, keptFactRefs: refs, candidateKeys: new Set() });
    expect(ps.map((p) => [p.decision, p.validity, p.normalizedValue])).toEqual([
      ['COMPONENT_OR_CONTEXT', 'VALID', '3400'], ['NOT_RETAINED', 'VALID', '1000000'],
    ]);
    const i = ec.diagnoseExtractChain(entree({ decisions: vues(ps), decisionContract: 'CARRIED' }));
    expect(i.verdict).toBe('CONSISTENT');
  });

  it('le guide cite le marqueur, la demande d’origine, la table et le rattrapage BO', () => {
    for (const m of [T1_VALUE_DECISIONS_CONTRACT, T1_OMISSIONS_PENDING_CONTRACT, 'document_value_decisions', 'FACT_DECISION_UNDETERMINED', 'T1_VALUE_DECISIONS_ENABLED']) expect(GUIDE, m).toContain(m);
    // La demande n'est plus listée parmi celles qui ne se règlent pas dans le BO.
    const nonReglables = GUIDE.slice(GUIDE.indexOf('NE se règlent PAS dans le BO\n'), GUIDE.indexOf('Ce qui est déjà présent dans les prompts livrés'));
    expect(nonReglables.length).toBeGreaterThan(100);
    expect(nonReglables).not.toContain('82B-t1-omissions-extract');
  });
});

describe('L91D-U05 — déclarations transversales (diagnostic global, transfert, registre, rattrapage, Supervision)', async () => {
  const cov = await import('@/services/admin/diagnostics-export/coverage');
  const { RECETTE_TABLE_CATALOG } = await import('@/services/admin/diagnostics-export/recette-catalog') as unknown as { RECETTE_TABLE_CATALOG?: Record<string, unknown> };
  const catalogue = readFileSync(join(RACINE, 'src', 'services', 'admin', 'diagnostics-export', 'recette-catalog.ts'), 'utf-8');
  const { FILE_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
  const { backfillDefinition, validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
  const { QUALIFICATION_LABELS } = await import('@/services/coherence/supervision');

  it('table couverte par « Ensemble de l’application », références logiques, traitement T1, catalogue de recette, transfert', () => {
    expect(cov.DIAG_TABLE_COVERAGE.document_value_decisions).toMatchObject({ section: 'extractions-ia' });
    const refs = cov.DIAG_LOGICAL_REFERENCES.filter((r) => r.from === 'document_value_decisions').map((r) => [r.column, r.to]);
    expect(refs).toEqual(expect.arrayContaining([['extraction_id', 'document_extractions'], ['related_fact_ids', 'document_facts']]));
    expect(cov.DIAG_AI_OPERATION_COVERAGE.t1_analyze_document.tables).toContain('document_value_decisions');
    expect(RECETTE_TABLE_CATALOG?.document_value_decisions ?? catalogue.includes('document_value_decisions:')).toBeTruthy();
    expect(FILE_SCOPED_TABLES).toContainEqual(['document_value_decisions', 'file_id']);
  });

  it('contrôle : anomalie, sources, réexamen et rattrapage déclarés ; version de règles inchangée (aucune relance massive)', () => {
    expect(ec.extractChainCheck.version).toBe(1);
    expect(ec.extractChainCheck.anomalies).toContain('FACT_DECISION_UNDETERMINED');
    expect(ec.extractChainCheck.sources).toContain('document_value_decisions');
    expect(ec.extractChainCheck.catchupCandidates).toBeTypeOf('function');
    expect(ec.extractChainCheck.forbiddenRepairs.join(' ')).toMatch(/justifier une valeur à la place de T1/);
  });

  it('rattrapage BO 18 et libellés de Supervision', () => {
    expect(backfillDefinition('extract-chain-decision-review')).toMatchObject({ order: 18, actions: ['simulate', 'apply'], accountFilter: true });
    expect(validateBackfillRequest({ script: 'extract-chain-decision-review', action: 'apply', reason: '' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(QUALIFICATION_LABELS).toMatchObject({ UNJUSTIFIED_OMISSION: expect.any(String), UNDETERMINED_DECISION: expect.any(String), REPAIR_TECHNICAL: expect.any(String) });
  });
});

describe('L91D-U06 — réexamen : faits retrouvés par leur valeur', () => {
  it('formes comparables et rattachement aux faits actifs', () => {
    expect([...valueForms('120,00 €')]).toContain('AMOUNT:12000');
    expect([...valueForms(120)]).toEqual(expect.arrayContaining(['AMOUNT:12000', 'AMOUNT:120']));
    expect([...valueForms('2026-03-12')]).toContain('DATE:2026-03-12');
    const m = matchFactIds(
      [{ t1FactRef: 'r1', normalizedValue: 120, rawValue: '120,00 €' }, { t1FactRef: 'r2', normalizedValue: 99, rawValue: '99,00 €' }] as never,
      [{ id: 5, values: ['120,00 €', null, null, 120] }, { id: 6, values: ['autre', null, null, null] }],
    );
    expect([...m.entries()]).toEqual([['r1', [5]]]);
  });
});
