/**
 * Lot 88B — ticket P1 « Contrôle de cohérence — Détecter et réparer les
 * propriétés métier manquantes à partir de l'ensemble des preuves » :
 * parties PURES (sans base). Cycle complet sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l88b-proprietes-manquantes.e2e.ts`.
 *
 * Aucune propriété ni aucun montant n'est codé dans ces tests : la propriété
 * de référence est PRISE DANS LE REGISTRE (premier champ monétaire / date
 * soumissible de la famille), les valeurs sont neutres.
 *
 *  L88B-U-01     catalogue : registre seul, propriété renseignée / protégée jamais candidate, drapeaux déclarés
 *  L88B-U-02     décision par propriété : les 8 cas du ticket + garde-fous (confiance, circularité, ancien format, troncature)
 *  L88B-U-03     diagnostic du contrôle : constat tant que le prompt ne porte pas le contrat, réparable sinon, décidé → cohérent / ambigu
 *  L88B-U-04     contexte : ordre neutre, troncature tracée, empreinte indépendante des propriétés demandées et de l'historique
 *  L88B-U-05     contrat : six emplacements existants, version d'entrée v2, marqueur lu dans le prompt actif
 *  L88B-U-06     garde : aucune règle métier, aucun vocabulaire, aucun champ nommé dans les modules du chantier
 *  L88B-U-ORDRE  registre : contrôles ajoutés APRÈS COH-DOC-TITLES, couverture alimentée
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const contrat = await import('../contract');
const catalogue = await import('../catalog');
const ctxMod = await import('../context');
const dec = await import('../decide');
const { diagnoseMissingProperties, AMBIGUOUS_CAUSES } = await import('@/services/coherence/registry/checks/missing-properties');
const { listFields } = await import('@/services/canonical/registry');
const { defaultNormalizers } = await import('../../knowledge-query/service');
const { knowledgeContractsIn } = await import('../../knowledge-query/model');
const { DEFAULT_KNOWLEDGE_BOUNDS } = await import('../../knowledge-query/context');

type El = import('../contract').PropertyContextElement;
type Q = import('../contract').PropertyQuestion;

const SUJET = { type: 'ASSET' as const, category: 'IMMOBILIER', subtype: null };
const soumissibles = listFields('IMMOBILIER').filter((d) => !catalogue.exclusionOf(d, SUJET));
/** Propriété monétaire de référence, prise dans le registre (aucun nom codé). */
const MONTANT = catalogue.questionOf(soumissibles.find((d) => d.valueType === 'money_eur')!);
const DATE = catalogue.questionOf(soumissibles.find((d) => d.valueType === 'date')!);
const norm = await defaultNormalizers();

const el = (ref: string, text: string, p: Partial<El> = {}): El => ({
  ref, document: 'D1', fileId: 11, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text, confidence: 'certain', page: 1,
  provenance: { fileIds: [11], agendaItemIds: [] }, ...p,
});
const page = (elements: El[], index = 1, count = 1) => ({ index, count, elements });
const sortie = (outcome: 'FOUND' | 'CONSTITUENTS' | 'CONTRADICTION' | 'AMBIGUOUS' | 'NOT_FOUND', findings: unknown[] = []) =>
  ({ task: 'KNOWLEDGE_QUERY', outcome, findings, reason: 'simulé' }) as never;
const constat = (target: string, rawValue: string, refs: string[], excerpt: string, confidence = 'certain') =>
  ({ target, rawValue, evidenceRefs: refs, excerpt, confidence, meaning: 'simulé' });
const decider = (properties: Q[], answers: Array<{ page: ReturnType<typeof page>; output: never }>, complete = true) =>
  dec.decideProperties({ properties, answers, complete, norm });

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-01 — catalogue des propriétés manquantes : le registre canonique, rien d’autre', () => {
  it('toutes les propriétés vides soumissibles de la famille, dans l’ordre du registre ; drapeaux déclarés comptés', () => {
    const c = catalogue.missingPropertyCatalog({ subject: SUJET, current: () => null, protections: new Map() });
    expect(c.missing.map((m) => m.key)).toEqual(soumissibles.map((d) => d.key));
    expect(c.missing.length).toBeGreaterThan(5);
    const tous = listFields('IMMOBILIER');
    const exclus = Object.values(c.excluded).reduce((a, b) => a + b, 0);
    expect(c.missing.length + exclus).toBe(tous.length);
    // Saisie seule, texte libre, donnée sensible : jamais soumis (drapeaux du registre).
    for (const d of tous.filter((x) => x.inputOnly || x.freeText || x.sensitive)) expect(c.missing.map((m) => m.key)).not.toContain(d.key);
  });

  it('cas 6 / 7 : propriété déjà renseignée → jamais candidate ; propriété effacée ou tranchée par l’utilisateur → protégée', () => {
    const c = catalogue.missingPropertyCatalog({
      subject: SUJET, current: (k) => (k === DATE.key ? '2001-02-13' : null),
      protections: new Map([[MONTANT.key, 'USER_CLEARED' as const]]),
    });
    expect(c.missing.map((m) => m.key)).not.toContain(DATE.key);
    expect(c.missing.map((m) => m.key)).not.toContain(MONTANT.key);
    expect(c.filled).toBe(1);
    expect(c.protectedKeys).toEqual([{ key: MONTANT.key, reason: 'USER_CLEARED' }]);
  });

  it('équipement : catalogue de la cible ÉQUIPEMENT du registre', () => {
    const c = catalogue.missingPropertyCatalog({ subject: { type: 'EQUIPMENT', category: null, subtype: null }, current: () => null, protections: new Map() });
    const attendus = listFields(undefined, { targetType: 'EQUIPMENT' }).filter((d) => !catalogue.exclusionOf(d, { type: 'EQUIPMENT', category: null, subtype: null }));
    expect(c.missing.map((m) => m.key)).toEqual(attendus.map((d) => d.key));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-02 — décision par propriété (T3 simulé, validation serveur)', () => {
  const VAL = '123 456,00';
  const AUTRE = '98 765,00';

  it('cas 1 : propriété absente + une preuve forte → établie, valeur canonique du registre', () => {
    const els = [el('U-1', `Montant convenu : ${VAL} euros`)];
    const [d] = decider([MONTANT], [{ page: page(els), output: sortie('CONSTITUENTS', [constat(MONTANT.key, VAL, ['U-1'], `Montant convenu : ${VAL}`)]) }]);
    expect(d).toMatchObject({ key: MONTANT.key, decision: 'ESTABLISHED', value: 123456 });
  });

  it('cas 2 : plusieurs preuves concordantes (formats différents, documents différents) → une seule valeur établie', () => {
    const els = [el('U-1', `Somme : ${VAL} €`), el('F-2', '', { layer: 'FACT', label: 'Total', value: '123456.00', fileId: 12, document: 'D2' }),
      el('U-3', 'Montant 123 456 euros', { fileId: 13, document: 'D3' })];
    const [d] = decider([MONTANT], [{
      page: page(els), output: sortie('CONSTITUENTS', [
        constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`), constat(MONTANT.key, '123456.00', ['F-2'], '123456.00'),
        constat(MONTANT.key, '123 456', ['U-3'], 'Montant 123 456', 'probable'),
      ]),
    }]);
    expect(d).toMatchObject({ decision: 'ESTABLISHED', value: 123456 });
    expect(d.findings).toHaveLength(3);
  });

  it('cas 3 : preuves contradictoires → abstention CONTRADICTION, rien n’est proposé à l’écriture', () => {
    const els = [el('U-1', `Somme : ${VAL}`), el('U-2', `Somme : ${AUTRE}`)];
    const [d] = decider([MONTANT], [{ page: page(els), output: sortie('CONTRADICTION', [
      constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`), constat(MONTANT.key, AUTRE, ['U-2'], `Somme : ${AUTRE}`)]) }]);
    expect(d).toMatchObject({ decision: 'ABSTAINED', cause: 'CONTRADICTION' });
  });

  it('cas 4 : donnée présente uniquement dans une Opération (composante) → établie', () => {
    const comp = el('C-7', '', { layer: 'OPERATION_COMPONENT', document: 'S', fileId: 0, kind: 'REALIZED_COST', value: '123456.00 EUR',
      text: 'economicDate=2001-02-13', provenance: { fileIds: [], agendaItemIds: [], operationId: 5, componentId: 7 } });
    const [d] = decider([MONTANT], [{ page: page([comp]), output: sortie('CONSTITUENTS', [constat(MONTANT.key, '123456.00', ['C-7'], '123456.00 EUR')]) }]);
    expect(d).toMatchObject({ decision: 'ESTABLISHED', value: 123456 });
  });

  it('cas 5 : données réparties entre un document et une Opération (extrait en deux segments) → établie', () => {
    const doc = el('U-1', 'Objet : le bien désigné ci-dessus');
    const op = el('C-7', '', { layer: 'OPERATION_COMPONENT', document: 'S', fileId: 0, value: '123456.00 EUR', provenance: { fileIds: [11], agendaItemIds: [], operationId: 5 } });
    const [d] = decider([MONTANT], [{ page: page([doc, op]), output: sortie('CONSTITUENTS', [
      constat(MONTANT.key, '123456.00', ['U-1', 'C-7'], 'le bien désigné ci-dessus [...] 123456.00 EUR')]) }]);
    expect(d).toMatchObject({ decision: 'ESTABLISHED', value: 123456 });
    expect(d.findings[0].evidenceRefs).toEqual(['U-1', 'C-7']);
  });

  it('cas 8 : aucune preuve → abstention NOT_FOUND ; contexte tronqué → INCOMPLETE_CONTEXT (jamais « absente »)', () => {
    const els = [el('U-1', 'Texte sans rapport')];
    expect(decider([MONTANT], [{ page: page(els), output: sortie('NOT_FOUND') }])[0]).toMatchObject({ decision: 'ABSTAINED', cause: 'NOT_FOUND' });
    expect(decider([MONTANT], [{ page: page(els), output: sortie('NOT_FOUND') }], false)[0]).toMatchObject({ decision: 'ABSTAINED', cause: 'INCOMPLETE_CONTEXT' });
  });

  it('garde-fous : confiance probable seule, abstention déclarée, preuve hors contexte, valeur non normalisable, circularité', () => {
    const els = [el('U-1', `Somme : ${VAL}`), el('K-x', '', { layer: 'CANONICAL', document: 'S', fileId: 0, value: VAL, provenance: { fileIds: [], agendaItemIds: [], derivedFromSubject: true } })];
    const un = (findings: unknown[], outcome: 'CONSTITUENTS' | 'AMBIGUOUS' = 'CONSTITUENTS') => decider([MONTANT], [{ page: page(els), output: sortie(outcome, findings) }])[0];
    expect(un([constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`, 'probable')])).toMatchObject({ decision: 'ABSTAINED', cause: 'INSUFFICIENT_CONFIDENCE', proposed: 123456 });
    expect(un([constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`)], 'AMBIGUOUS')).toMatchObject({ decision: 'ABSTAINED', cause: 'AMBIGUOUS' });
    expect(un([constat(MONTANT.key, VAL, ['U-99'], `Somme : ${VAL}`)])).toMatchObject({ decision: 'ABSTAINED', cause: 'REJECTED_BY_VALIDATION' });
    expect(un([constat(MONTANT.key, 'Somme', ['U-1'], 'Somme')])).toMatchObject({ decision: 'ABSTAINED', cause: 'REJECTED_BY_VALIDATION' });
    expect(un([constat(MONTANT.key, VAL, ['K-x'], VAL)])).toMatchObject({ decision: 'ABSTAINED', cause: 'CIRCULAR_EVIDENCE' });
  });

  it('ancien format accepté : cible FIELD pour UNE propriété demandée ; refusée (cible inconnue) quand plusieurs sont demandées', () => {
    const els = [el('U-1', `Somme : ${VAL}`)];
    const f = [constat('FIELD', VAL, ['U-1'], `Somme : ${VAL}`)];
    expect(decider([MONTANT], [{ page: page(els), output: sortie('FOUND', f) }])[0]).toMatchObject({ decision: 'ESTABLISHED', value: 123456 });
    const deux = decider([MONTANT, DATE], [{ page: page(els), output: sortie('FOUND', f) }]);
    expect(deux.map((d) => d.decision)).toEqual(['ABSTAINED', 'ABSTAINED']);
    expect(dec.unattachedRejections([{ page: page(els), output: sortie('FOUND', f) }], [MONTANT, DATE])).toBe(1);
  });

  it('plusieurs propriétés, plusieurs pages : décision propriété par propriété ; date ambiguë JJ/MM jamais établie', () => {
    const p1 = page([el('U-1', `Somme : ${VAL}`)], 1, 2);
    const p2 = page([el('U-2', 'Fait le 03/04/2001', { fileId: 12, document: 'D2' })], 2, 2);
    const ds = decider([MONTANT, DATE], [
      { page: p1, output: sortie('CONSTITUENTS', [constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`)]) },
      { page: p2, output: sortie('CONSTITUENTS', [constat(DATE.key, '03/04/2001', ['U-2'], 'Fait le 03/04/2001')]) },
    ]);
    expect(ds[0]).toMatchObject({ key: MONTANT.key, decision: 'ESTABLISHED' });
    expect(['ESTABLISHED', 'ABSTAINED']).toContain(ds[1].decision);
    if (ds[1].decision === 'ABSTAINED') expect(['DATE_ORDER_AMBIGUOUS', 'REJECTED_BY_VALIDATION']).toContain(ds[1].cause);
    const iso = decider([DATE], [{ page: page([el('U-3', 'Date : 2001-02-13')]), output: sortie('CONSTITUENTS', [constat(DATE.key, '2001-02-13', ['U-3'], 'Date : 2001-02-13')]) }]);
    expect(iso[0]).toMatchObject({ decision: 'ESTABLISHED', value: '2001-02-13' });
  });

  it('réponse plafonnée (nombre maximal de constats) : propriétés sans constat NON décidées (redemandées), jamais « absentes »', () => {
    const els = [el('U-1', `Somme : ${VAL}`)];
    const plein = Array.from({ length: dec.MAX_FINDINGS_PER_ANSWER }, () => constat(MONTANT.key, VAL, ['U-1'], `Somme : ${VAL}`));
    const ds = decider([MONTANT, DATE], [{ page: page(els), output: sortie('CONSTITUENTS', plein) }]);
    expect(ds[1]).toMatchObject({ key: DATE.key, decision: 'UNDECIDED' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

type Etat = import('../service').ObjectRecoveryState;
function etat(p: Partial<Etat> & { missing?: Q[] } = {}): Etat {
  const missing = p.missing ?? [MONTANT];
  return {
    subject: { type: 'ASSET', id: 14, accountId: 1, assetId: 14, category: 'IMMOBILIER', subtype: null, family: 'IMMOBILIER', archived: false, fields: {}, kc: {} },
    catalog: { missing, protectedKeys: [], excluded: { NOT_APPLICABLE: 0, INPUT_ONLY: 0, FREE_TEXT: 0, SENSITIVE: 0, STRUCTURED_JSON: 0 }, filled: 0 },
    documents: [], plan: { pages: [], complete: true, elements: 3, droppedElements: 0, cutElements: 0, byLayer: {}, droppedByLayer: {} },
    collected: { collectionDropped: {}, missingLayers: [] }, complete: true, contextFingerprint: 'fp1',
    capability: { available: true, version: 'v1', reason: 'AVAILABLE', contracts: [contrat.MISSING_PROPERTIES_CONTRACT_VERSION], contractCarried: true },
    decisionPromptVersion: 'v1', memoryReady: true, decided: new Map(), pending: missing, failedRun: null, ...p,
  };
}

describe('L88B-U-03 — diagnostic du contrôle (pur, lecture seule)', () => {
  it('propriété vide non examinée : REPAIRABLE ; le jour entre dans l’empreinte (un essai par jour au plus)', () => {
    const a = diagnoseMissingProperties(etat(), '2026-01-10');
    expect(a).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'MISSING_PROPERTIES_UNEXAMINED', faultyLink: 'T3' });
    expect(diagnoseMissingProperties(etat(), '2026-01-11').inputHash).not.toBe(a.inputHash);
  });

  it('le prompt actif ne porte pas le contrat v2 : constat FINDING avec la demande IA, aucune réparation', () => {
    const cap = { available: true, version: 'v1', reason: 'AVAILABLE' as const, contracts: ['t3-knowledge-query-v1'], contractCarried: false };
    const i = diagnoseMissingProperties(etat({ capability: cap }), '2026-01-10');
    expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'MISSING_PROPERTY_ARBITRATION_PENDING' });
    expect((i.detail as { pendingContract?: string }).pendingContract).toBe(contrat.MISSING_PROPERTIES_PENDING_CONTRACT);
    // Contexte vide : abstention sans IA, réparable même sans le contrat.
    const vide = etat({ capability: cap, plan: { ...etat().plan, elements: 0 } });
    expect(diagnoseMissingProperties(vide, '2026-01-10').verdict).toBe('REPAIRABLE');
  });

  it('propriétés décidées dans ce contexte : CONSISTENT (absente, non établie) ou AMBIGUOUS (ambiguïté, contradiction)', () => {
    const d = (cause: string) => new Map([[MONTANT.key, { id: 1, runId: 1, fieldKey: MONTANT.key, questionFp: 'q', decision: 'ABSTAINED' as const, cause, valueAfter: null }]]);
    expect(diagnoseMissingProperties(etat({ pending: [], decided: d('NOT_FOUND') }), '2026-01-10').verdict).toBe('CONSISTENT');
    for (const c of AMBIGUOUS_CAUSES) {
      expect(diagnoseMissingProperties(etat({ pending: [], decided: d(c) }), '2026-01-10')).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'MISSING_PROPERTY_ABSTENTION' });
    }
    expect(diagnoseMissingProperties(etat({ missing: [], pending: [] }), '2026-01-10').verdict).toBe('CONSISTENT');
    expect(diagnoseMissingProperties(null, '2026-01-10').verdict).toBe('GONE');
  });

  it('pannes IA répétées sur le même contexte : constat, plus de réparation', () => {
    const i = diagnoseMissingProperties(etat({ failedRun: { id: 3, status: 'AI_FAILED', attempts: 3, retryAt: null } }), '2026-01-10');
    expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'MISSING_PROPERTY_ARBITRATION_FAILED' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-04 — contexte borné, ordre neutre, empreinte', () => {
  const docs = [{ ref: 'D1', fileId: 11, relation: 'LINKED' as const, title: 'Pièce', documentType: null, rubric: null, documentDate: null }];
  const base = [
    el('U-1', 'texte'), el('O-1', '', { layer: 'OPERATION', document: 'S', fileId: 0, value: 'REALIZED' }),
    el('R-k', '', { layer: 'DECISION', document: 'S', fileId: 0, value: 'keep' }), el('M-11', '', { layer: 'DOCUMENT_METADATA', label: 'Pièce' }),
  ];

  it('objet d’abord (Opérations, décisions), puis document (métadonnées avant unités) ; éléments vides ignorés', () => {
    const p = ctxMod.planPropertyContext([...base, el('U-9', '')], docs, DEFAULT_KNOWLEDGE_BOUNDS);
    expect(p.pages[0].elements.map((e) => e.ref)).toEqual(['O-1', 'R-k', 'M-11', 'U-1']);
    expect(p).toMatchObject({ complete: true, elements: 4, droppedElements: 0 });
  });

  it('troncature TRACÉE par couche au-delà des bornes ; contexte incomplet', () => {
    const beaucoup = Array.from({ length: 30 }, (_, i) => el(`U-${i + 10}`, `bloc ${i}`));
    const p = ctxMod.planPropertyContext(beaucoup, docs, { ...DEFAULT_KNOWLEDGE_BOUNDS, elementsPerPage: 10, maxPages: 2 });
    expect(p.pages).toHaveLength(2);
    expect(p).toMatchObject({ complete: false, droppedElements: 10, droppedByLayer: { SOURCE_UNIT: 10 } });
  });

  it('empreinte : stable, indépendante des propriétés demandées et de l’historique de décision ; change avec une preuve', () => {
    const fp = (els: El[]) => ctxMod.propertyContextFingerprint(docs, ctxMod.planPropertyContext(els, docs, DEFAULT_KNOWLEDGE_BOUNDS));
    const a = fp(base);
    expect(fp(base.map((e) => (e.layer === 'DECISION' ? { ...e, value: 'apply' } : e)))).toBe(a);
    expect(fp(base.filter((e) => e.layer !== 'DECISION'))).toBe(a);
    expect(fp([...base, el('U-2', 'nouvelle preuve')])).not.toBe(a);
    expect(ctxMod.propertyQuestionFingerprint(MONTANT)).not.toBe(ctxMod.propertyQuestionFingerprint(DATE));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-05 — contrat T3 réutilisé (KNOWLEDGE_QUERY), entrée v2', () => {
  it('six emplacements existants, version d’entrée v2, propriétés en CANDIDATES, état courant vide', () => {
    const v = contrat.missingPropertiesVariables({
      subject: { type: 'ASSET', category: 'IMMOBILIER', subtype: null, family: 'IMMOBILIER' }, properties: [MONTANT, DATE],
      documents: [], page: page([el('U-1', 'x')]), today: '2026-01-10', truncated: false,
    });
    expect(Object.keys(v).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(v.FIELD).toMatchObject({ contractVersion: 't3-knowledge-query-v2', mode: 'MISSING_PROPERTIES' });
    expect((v.CANDIDATES as Array<{ role: string }>).map((c) => c.role)).toEqual([MONTANT.key, DATE.key]);
    expect(v.CURRENT_STATE).toEqual({ properties: [{ key: MONTANT.key, value: null, protectedByUser: false }, { key: DATE.key, value: null, protectedByUser: false }] });
  });

  it('marqueur de contrat lu dans le texte du prompt actif (jamais présumé)', () => {
    expect(knowledgeContractsIn('BRANCHE TASK = KNOWLEDGE_QUERY\n…')).toEqual([]);
    expect(knowledgeContractsIn('… t3-knowledge-query-v1 … t3-knowledge-query-v2 … t3-knowledge-query-v2')).toEqual(['t3-knowledge-query-v1', 't3-knowledge-query-v2']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-06 — aucune règle métier codée dans les modules du chantier', () => {
  it('ni champ nommé, ni type de document, ni montant, ni vocabulaire ; le registre et T3 seuls décident', () => {
    const dir = join(process.cwd(), 'src/services/ai/reconciliation/missing-properties');
    const fichiers = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)),
      join(process.cwd(), 'src/services/coherence/registry/checks/missing-properties.ts')];
    const interdits = [/acquisitionPrice/, /acquisitionDate/, /purchase_price/, /compromis/i, /\bacte\b/i, /490\s?000/, /'ACQUISITION'/, /'PURCHASE/, /ILIKE/i, /\bachat\b/i];
    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const r of interdits) expect({ f, r: String(r), hit: r.test(src) }).toEqual({ f, r: String(r), hit: false });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('L88B-U-ORDRE — registre de cohérence et couverture', () => {
  it('COH-MISSING-PROPERTIES (biens) puis -EQUIPMENT ajoutés APRÈS COH-DOC-TITLES ; actifs ; déclaratifs complets', async () => {
    const { COHERENCE_REGISTRY, activeChecks } = await import('@/services/coherence/registry');
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    expect(ids.indexOf('COH-MISSING-PROPERTIES')).toBeGreaterThan(ids.indexOf('COH-DOC-TITLES'));
    expect(ids.indexOf('COH-MISSING-PROPERTIES-EQUIPMENT')).toBeGreaterThan(ids.indexOf('COH-MISSING-PROPERTIES'));
    expect(ids.indexOf('COH-DOC-TITLES')).toBeGreaterThan(ids.indexOf('COH-TCO-ECONOMIC-DATES'));
    const actifs = activeChecks().map((c) => c.id);
    for (const id of ['COH-MISSING-PROPERTIES', 'COH-MISSING-PROPERTIES-EQUIPMENT']) {
      expect(actifs).toContain(id);
      const c = COHERENCE_REGISTRY.find((x) => x.id === id)!;
      expect(c).toMatchObject({ status: 'ACTIVE', level: 'N3', semanticReevaluation: ['T3'] });
      expect(c.forbiddenRepairs.join(' ')).toMatch(/règle métier codée/);
      expect(c.ineligibleAccounts).toBeUndefined();
    }
  });

  it('couverture : biens, équipements et champs structurés citent les nouveaux contrôles', async () => {
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const dom = (d: string) => COVERAGE_INVENTORY.find((x) => x.domain === d)!.checks;
    expect(dom('biens')).toContain('COH-MISSING-PROPERTIES');
    expect(dom('equipements')).toContain('COH-MISSING-PROPERTIES-EQUIPMENT');
    expect(dom('champs-structures')).toEqual(expect.arrayContaining(['COH-MISSING-PROPERTIES', 'COH-MISSING-PROPERTIES-EQUIPMENT']));
  });
});
