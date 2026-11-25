/**
 * Carte Trello #839 — pipeline fournisseur et nommage des périodes, titres et reprises (suite du #783).
 * Unitaires SANS base (règles pures, contrat, projection, garde-fous T3). Le trajet complet sur
 * PostgreSQL réel avec IA simulée est couvert par `src/test/e2e/scenarios/c839-nommage-fournisseur-periodes.e2e.ts`.
 *
 *   C839-U-01  E1 — contrat maître : `document.supplier.identity` accepté (Zod strict et lecture tolérante),
 *              `evidence.quote` (ancien bloc 52) rangé dans `evidence.excerpt`, rubrique mal formée retirée SEULE
 *   C839-U-02  E1 — schéma FOURNISSEUR projeté (inline et factorisé $defs/$ref) : `identity` transmis, sans perte
 *   C839-U-03  E1 — contrôle de la preuve (`verifiedSupplierIdentity`) : prouvée / faible / sans citation /
 *              citation introuvable / nom hors citation / ambiguïté / contrat non porté
 *   C839-U-04  E1 — projection `toSourceAnalysisResult` : entrée maître → `supplier.value.identity`, nom inchangé
 *   C839-U-05  E2 — point de décision temporel COMMUN (`titlePeriodDecision`) et replis du nommage
 *   C839-U-06  E3 — titres longs : aucune coupe, réduction ordonnée, abstention sûre
 *   C839-U-07  E3 — `EXCLUDED_PERIOD_REMOVED` seulement pour des bornes de garantie, jamais une date légitime
 *   C839-U-08  E2 — T3 : une proposition reprenant la garantie est refusée ; la retirer n'est pas une perte
 *   C839-U-09  aucune valeur du cas contractuel codée en dur dans le code de production
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T1AnalyzeDocumentOutput } from '@/services/ai/source-analysis/master/t1-contract';
import { T1AnalyzeDocumentTolerantOutput, splitNormalisation } from '@/services/ai/source-analysis/master/tolerant-output';
import { providerJsonSchema, resolveSchemaRefs } from '@/services/ai/gateway/output-resolution/provider-schema';
import { verifiedSupplierIdentity } from '@/services/ai/source-analysis/supplier-identity/verify';
import { identityContractFor, promptCarriesSupplierIdentity } from '@/services/ai/source-analysis/supplier-identity/contract';
import { toSourceAnalysisResult } from '@/services/ai/source-analysis/master/to-source-analysis-result';
import { emptyTrace } from '@/services/ai/source-analysis/trace';
import { supplierIdentityFromAnalysis, T1_SUPPLIER_IDENTITY_CONTRACT } from '@/lib/documents/document-title-convention';
import {
  excludedOnlyBoundDays, titleEligibleFactPeriods, titlePeriodDecision, titlePeriodEvidence,
} from '@/lib/documents/document-title-period';
import { DOCUMENT_TITLE_MAX_LENGTH, titleRemovesOnlyExcludedBounds } from '@/lib/documents/document-title-rules';
import { planBusinessTitle, titleInputsFromAnalysis, TITLE_REDUCTION_ORDER } from '@/services/ai/source-analysis/document-title';
import { billingBasisFrom } from '@/services/documents/document-title.service';
import { judgeProposal, NAMING_MAX_LENGTH, RENAME_REFUSAL_LABEL, type NamingSnapshotDoc } from '@/services/ai/reconciliation/document-naming/guards';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Cas contractuel SYNTHÉTIQUE de la carte (valeurs de test uniquement). */
const CAS = {
  nom: 'CONFORAMA FRANCE SA CHASSE S/R',
  ligne: 'CONFORAMA FRANCE SA - Magasin de Chasse S/R',
  objet: 'Table FAR CI606025BK',
  emission: '2026-11-14',
  garantie: { s: '2026-11-14', e: '2028-11-14' },
};
const TRANSCRIPTION = `FACTURE n° F-2026-1114\n${CAS.ligne}\nDate : 14/11/2026\n${CAS.objet} 1 x 469,99 €\nGarantie 2 ans du 14/11/2026 au 14/11/2028`;
const IDENTITE = {
  legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R',
  confidence: 'certain' as const, evidence: { excerpt: CAS.ligne, page: 1 },
};
const sortie = (identity?: unknown) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Facture', confidence: 'certain', evidence: { excerpt: 'FACTURE' } },
    supplier: { name: CAS.nom, confidence: 'certain', evidence: { excerpt: CAS.ligne }, ...(identity !== undefined ? { identity } : {}) },
  },
  transcription: TRANSCRIPTION,
  facts: [],
});
const PORTE = { carried: true, reason: 'CARRIED' };

describe('C839-U-01 — contrat maître : `document.supplier.identity`', () => {
  it('accepté par le contrat strict, facultatif (sortie v7 antérieure inchangée)', () => {
    expect(T1AnalyzeDocumentOutput.parse(sortie()).document.supplier?.identity).toBeUndefined();
    const p = T1AnalyzeDocumentOutput.parse(sortie(IDENTITE));
    expect(p.document.supplier?.identity).toEqual({ ...IDENTITE });
    // Clé non déclarée d'avant la carte : `identity` était silencieusement RETIRÉE par Zod (cause de E1).
    expect(Object.keys(T1AnalyzeDocumentOutput.shape.document.removeDefault().shape.supplier.unwrap().shape)).toContain('identity');
  });
  it('lecture tolérante : `evidence.quote` (bloc 52 d’origine) → `evidence.excerpt` ; chaînes vides → null ; confiance normalisée', () => {
    const r = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(sortie({
      legalName: ' Conforama France SA ', tradeName: 'Conforama', establishment: '', confidence: 'Certain', evidence: { quote: CAS.ligne },
    })));
    expect(r.output.document.supplier?.identity).toEqual({
      legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: null, confidence: 'certain', evidence: { excerpt: CAS.ligne },
    });
  });
  it('rubrique mal formée : retirée SEULE (original conservé), le document et le fournisseur restent valides', () => {
    for (const faux of [{ legalName: 42, confidence: 'certain' }, 'Conforama', { tradeName: 'x'.repeat(300), confidence: 'certain' }, { tradeName: 'Conforama' }]) {
      const r = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse(sortie(faux)));
      expect(r.output.document.supplier?.name, JSON.stringify(faux).slice(0, 40)).toBe(CAS.nom);
      expect(r.output.document.supplier?.identity).toBeUndefined();
      expect(JSON.stringify(r.report?.originals ?? [])).toContain('document.supplier.identity');
    }
  });
});

describe('C839-U-02 — schéma fournisseur projeté depuis le contrat', () => {
  for (const shape of ['inline', 'factorise'] as const) {
    it(`forme ${shape} : \`identity\` transmis sous document.supplier, aucune branche perdue`, () => {
      const ps = providerJsonSchema(T1AnalyzeDocumentOutput, { shape });
      expect(ps.schema).not.toBeNull();
      expect(ps.omitted).toBeNull();
      expect(ps.lostBranches ?? []).toEqual([]);
      const resolu = resolveSchemaRefs(ps.schema as Record<string, unknown>) as any;
      const branche = resolu.anyOf ? resolu.anyOf.find((b: any) => b.properties?.document) : resolu;
      const sup = branche.properties.document.properties.supplier;
      const id = sup.properties.identity;
      expect(Object.keys(id.properties).sort()).toEqual(['confidence', 'establishment', 'evidence', 'legalName', 'tradeName']);
      expect(id.properties.evidence.properties.excerpt).toBeDefined();
      // Facultatif : jamais exigé (une sortie sans identité reste conforme).
      expect(sup.required ?? []).not.toContain('identity');
    });
  }
});

describe('C839-U-03 — contrôle serveur de la preuve d’identité', () => {
  const verifier = (id: Partial<typeof IDENTITE> & Record<string, unknown>, o: { contract?: typeof PORTE; transcription?: string | null; sourceText?: string | null; name?: string } = {}) =>
    verifiedSupplierIdentity({ ...IDENTITE, ...id } as never, {
      supplierName: o.name ?? CAS.nom, transcription: o.transcription === undefined ? TRANSCRIPTION : o.transcription, sourceText: o.sourceText ?? null, contract: o.contract ?? PORTE,
    });
  it('identité prouvée : citation retrouvée dans la transcription, enseigne et raison sociale prouvées', () => {
    const r = verifier({});
    expect(r.verification).toMatchObject({ status: 'VERIFIED', textOrigin: 'T1_TRANSCRIPTION', proven: { tradeName: true, legalName: true }, checks: [] });
    expect(r.evidence).toEqual({ quote: CAS.ligne, page: 1 });
    // Contenu préextrait de la source (lien web) : il est préféré à la transcription.
    expect(verifier({}, { sourceText: TRANSCRIPTION, transcription: null }).verification.textOrigin).toBe('SOURCE_TEXT');
  });
  it('confiance faible, citation absente, citation introuvable, aucun texte : non vérifiée', () => {
    expect(verifier({ confidence: 'probable' as never }).verification).toMatchObject({ status: 'UNVERIFIED', checks: ['LOW_CONFIDENCE'] });
    expect(verifier({ evidence: {} as never }).verification.checks).toContain('NO_QUOTE');
    expect(verifier({ evidence: { excerpt: 'CONFORAMA FRANCE SA - Magasin de Lyon' } as never }).verification.checks).toContain('QUOTE_NOT_IN_SOURCE');
    expect(verifier({}, { transcription: null }).verification.checks).toContain('NO_SOURCE_TEXT');
  });
  it('une citation non vide ne prouve pas une enseigne qu’elle ne contient pas : seule la raison sociale reste', () => {
    const r = verifier({ tradeName: 'Confo Maison' });
    expect(r.verification).toMatchObject({ status: 'VERIFIED', proven: { tradeName: false, legalName: true } });
    expect(r.verification.checks).toEqual(['TRADE_NAME_NOT_IN_QUOTE']);
    expect(verifier({ tradeName: 'Autre', legalName: 'Autre SA' }).verification.status).toBe('UNVERIFIED');
  });
  it('ambiguïté (nom prouvé sans rapport avec le fournisseur lu : client, autre société) → non retenue', () => {
    const r = verifier({ tradeName: 'Magasin', legalName: null as never }, { name: 'Dupont Meubles' });
    expect(r.verification.status).toBe('UNVERIFIED');
    expect(verifier({}, { name: 'Dupont Meubles' }).verification.checks).toContain('INCONSISTENT_WITH_SUPPLIER_NAME');
  });
  it('prompt T1 effectif sans le contrat (ou autre version) : conservée, jamais exploitée', () => {
    expect(verifier({}, { contract: { carried: false, reason: 'MARKER_MISSING' } }).verification).toMatchObject({ status: 'UNVERIFIED', checks: ['CONTRACT_NOT_CARRIED'] });
    expect(identityContractFor({ carried: true, version: 'pv2', reason: 'CARRIED' }, 'pv1')).toEqual({ carried: false, reason: 'OTHER_PROMPT_VERSION' });
    expect(identityContractFor({ carried: true, version: 'pv2', reason: 'CARRIED' }, 'pv2')).toEqual({ carried: true, reason: 'CARRIED' });
    expect(identityContractFor({ carried: false, version: null, reason: 'DISABLED' }, 'pv2')).toEqual({ carried: false, reason: 'DISABLED' });
    expect(promptCarriesSupplierIdentity(`IDENTITÉ DE L'ÉMETTEUR — contrat ${T1_SUPPLIER_IDENTITY_CONTRACT}`)).toBe(true);
    expect(promptCarriesSupplierIdentity('prompt sans le bloc')).toBe(false);
  });
});

describe('C839-U-04 — projection maître → résultat persisté', () => {
  const projeter = (identity?: unknown, contrat?: typeof PORTE) => toSourceAnalysisResult({
    input: { sourceType: 'file', sourceIds: [7], accountId: 1, userId: 1, mimeTypes: [], displayNames: [] },
    groupIndices: [0], analysis: T1AnalyzeDocumentOutput.parse(sortie(identity)), tables: [], facts: [], projectionWarnings: [],
    multiAsset: false, documentAssetId: null, assetCandidates: [], roomCandidates: [], equipmentCandidates: [], warnings: [], trace: emptyTrace(),
    ...(contrat ? { supplierIdentity: { contract: contrat, transcription: TRANSCRIPTION } } : {}),
  });
  it('mapping EXPLICITE `document.supplier.identity` → `document.supplier.value.identity`, nom fournisseur inchangé', () => {
    const r = projeter(IDENTITE, PORTE);
    expect(r.document.supplier?.value.name).toBe(CAS.nom);
    expect(r.document.supplier?.value.identity).toMatchObject({
      legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R', evidence: { quote: CAS.ligne },
      verification: { status: 'VERIFIED', contract: { id: T1_SUPPLIER_IDENTITY_CONTRACT, carried: true } },
    });
    // Sérialisé tel quel dans `raw_response_json`, relu par le nommage : enseigne prouvée.
    const relu = JSON.parse(JSON.stringify(r));
    expect(titleInputsFromAnalysis(relu).ctx.supplier).toBe('Conforama');
    expect(supplierIdentityFromAnalysis(relu, { T1_SUPPLIER_IDENTITY_ENABLED: '0' })).toBeNull();
  });
  it('rubrique absente : aucune identité ; contexte non évalué : conservée mais non exploitée', () => {
    expect(projeter().document.supplier?.value.identity).toBeUndefined();
    const r = projeter(IDENTITE);
    expect(r.document.supplier?.value.identity?.verification.checks).toContain('CONTRACT_NOT_CARRIED');
    expect(titleInputsFromAnalysis(JSON.parse(JSON.stringify(r))).ctx.supplier).toBe(CAS.nom);
  });
});

describe('C839-U-05 — éligibilité temporelle : un seul point de décision', () => {
  const qualifGarantie = [{ kind: 'WARRANTY' as const, start: CAS.garantie.s, end: CAS.garantie.e }];
  const faitGarantie = [{ s: CAS.garantie.s, e: CAS.garantie.e, key: 'period.warranty' }];
  it('nature, provenance, bornes : la garantie ne passe par AUCUNE voie ; une vraie période facturée de mêmes bornes reste', () => {
    const ev = titlePeriodEvidence(faitGarantie, [], true);
    for (const provenance of ['FACT', 'T1_BILLING_PERIOD', 'FINANCIAL_HINT', 'T3_PROPOSAL'] as const) {
      expect(titlePeriodDecision({ start: CAS.garantie.s, end: CAS.garantie.e, provenance }, ev), provenance)
        .toEqual({ eligible: false, reason: 'MATCHES_EXCLUDED_BOUNDS' });
    }
    expect(titlePeriodDecision({ start: CAS.garantie.s, end: CAS.garantie.e, provenance: 'FACT', key: 'period.warranty' }, ev).reason).toBe('EXCLUDED_KIND');
    const avecFacture = titlePeriodEvidence(faitGarantie, [{ kind: 'BILLING', start: CAS.garantie.s, end: CAS.garantie.e }], true);
    expect(titlePeriodDecision({ start: CAS.garantie.s, end: CAS.garantie.e, provenance: 'T1_BILLING_PERIOD' }, avecFacture).eligible).toBe(true);
  });
  it('qualification ILLISIBLE : abstention pour une période sans nature établie (le fait n’est pas supprimé)', () => {
    const faits = [{ s: '2026-02-01', e: '2026-02-28', key: null }];
    expect(titleEligibleFactPeriods(faits, [], { qualificationAvailable: false })).toEqual([]);
    expect(titleEligibleFactPeriods(faits, [], { qualificationAvailable: true })).toEqual(faits);
    // Nature portée par la clé du fait : décidée sans la qualification.
    expect(titleEligibleFactPeriods([{ s: '2026-02-01', e: '2026-02-28', key: 'period.billing' }], [], { qualificationAvailable: false })).toHaveLength(1);
  });
  it('replis du nommage : `document.billingPeriod` et `financialHints` de garantie écartés ; abonnement inchangé', () => {
    const garantieT1 = { document: { billingPeriod: { start: CAS.garantie.s, end: CAS.garantie.e, principalMonth: '2026-11', principalMonthBasis: 'STATED_ON_DOCUMENT', confidence: 'certain', evidence: { quote: 'garantie', page: 1 } } } };
    const ev = titlePeriodEvidence([], qualifGarantie, true);
    // AVANT (sans le point de décision) : la garantie devenait la période facturée.
    expect(billingBasisFrom({ candidatePayloads: [], factPeriods: [], analysisResult: garantieT1, issueDate: CAS.emission }).billedPeriod)
      .toMatchObject({ source: 'T1_BILLING_PERIOD', start: CAS.garantie.s });
    // APRÈS : écartée, mois principal de cette période aussi.
    const b = billingBasisFrom({ candidatePayloads: [], factPeriods: [], analysisResult: garantieT1, issueDate: CAS.emission, periodEvidence: ev });
    expect(b.billedPeriod).toBeNull();
    expect(b.principalMonth).toBeNull();
    const hint = { financialHints: [{ role: 'REALIZED_COST', periodStart: CAS.garantie.s, periodEnd: CAS.garantie.e }] };
    expect(billingBasisFrom({ candidatePayloads: [hint], factPeriods: [], analysisResult: null, issueDate: CAS.emission, periodEvidence: ev }).billedPeriod).toBeNull();
    const abonnement = { financialHints: [{ role: 'REALIZED_COST', amountScope: 'INSTALLMENT', periodStart: '2026-02-01', periodEnd: '2026-02-28' }] };
    expect(billingBasisFrom({ candidatePayloads: [abonnement], factPeriods: [], analysisResult: null, issueDate: '2026-02-06', periodEvidence: ev }).billedPeriod)
      .toEqual({ start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' });
    // Qualification illisible : un repli sans nature établie s'abstient.
    expect(billingBasisFrom({ candidatePayloads: [abonnement], factPeriods: [], analysisResult: null, issueDate: '2026-02-06', periodEvidence: titlePeriodEvidence([], [], false) }).billedPeriod).toBeNull();
  });
  it('bornes exclues SEULEMENT : la date du document et les périodes retenues ne le sont jamais', () => {
    const ev = titlePeriodEvidence(faitGarantie, [], true);
    expect(excludedOnlyBoundDays(ev, [CAS.emission])).toEqual([CAS.garantie.e]);
    expect(excludedOnlyBoundDays(ev, [])).toEqual([CAS.garantie.s, CAS.garantie.e]);
  });
});

describe('C839-U-06 — titres longs : aucune coupe destructrice', () => {
  const MODELE = 'Réfrigérateur combiné Samsung RF65DG960ESG Bespoke AI Family Hub+ inox 645 litres';
  it('identifiant central intact, informations accessoires retirées dans l’ordre documenté', () => {
    expect([...TITLE_REDUCTION_ORDER]).toEqual(['supplier', 'target', 'period', 'reference']);
    const p = planBusinessTitle('Facture', { typeCode: 'FACTURE', subjects: [MODELE], supplier: 'Grand Magasin Électroménager Lyon Part-Dieu', documentDate: CAS.emission });
    expect(p.title!.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
    expect(p.title).toContain(MODELE);
    expect(p.reduced).toEqual(['supplier']);
    expect(p.title).toBe(`Facture ${MODELE} — 14 novembre 2026`);
    expect(p.supplier).toBeNull();
  });
  it('tout tient : rien n’est retiré (fournisseur et date gardés)', () => {
    const p = planBusinessTitle('Facture', { typeCode: 'FACTURE', subjects: [CAS.objet], supplier: 'Conforama', documentDate: CAS.emission });
    expect(p.title).toBe(`Facture ${CAS.objet} Conforama — 14 novembre 2026`);
    expect(p.reduced).toBeUndefined();
  });
  it('identifiant central plus long que la limite : aucun titre proposé (jamais coupé)', () => {
    const p = planBusinessTitle('Facture', { typeCode: 'FACTURE', subjects: [`${MODELE} ${MODELE}`], supplier: 'Conforama', documentDate: CAS.emission });
    expect(p.title).toBeNull();
    expect(p.tooLong).toBe(true);
  });
  it('titre périodique démesuré : non proposé ; titre périodique ordinaire inchangé', () => {
    const billing = { billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' as const }, principalMonth: null, invoiceReferences: [], issueDate: '2026-02-06' };
    expect(planBusinessTitle('Facture', { typeCode: 'FACTURE', supplier: 'Homiris', billing }).title).toBe('Facture Homiris — Février 2026');
    const long = planBusinessTitle('Facture', { typeCode: 'FACTURE', supplier: 'Société '.repeat(20), billing });
    expect(long.title).toBeNull();
    expect(long.tooLong).toBe(true);
  });
  it('même limite que l’harmonisation T3', () => {
    expect(NAMING_MAX_LENGTH).toBe(DOCUMENT_TITLE_MAX_LENGTH);
    const code = lire('src/services/ai/source-analysis/document-title.ts');
    expect(code).not.toMatch(/slice\(0, MAX_(TITLE|BASE)\)/);
    expect(code).not.toContain('MAX_BASE');
  });
});

describe('C839-U-07 — `EXCLUDED_PERIOD_REMOVED` prouvé', () => {
  const ancien = 'Facture Conforama France SA Chasse S/R — 14 novembre 2026 au 14 novembre 2028';
  const nouveau = `Facture ${CAS.objet} Conforama — 14 novembre 2026`;
  it('repères retirés = bornes de la garantie, jamais la date du document', () => {
    expect(titleRemovesOnlyExcludedBounds(ancien, nouveau, [CAS.garantie.e], [CAS.emission])).toBe(true);
    // Aucune période exclue connue : la règle ne s'applique pas.
    expect(titleRemovesOnlyExcludedBounds(ancien, nouveau, [], [CAS.emission])).toBe(false);
  });
  it('un repère retiré qui n’est PAS une borne de garantie (autre période légitime) : refus', () => {
    const avecFacturee = 'Facture Conforama — Novembre 2026 — 14 novembre 2028';
    expect(titleRemovesOnlyExcludedBounds(avecFacturee, 'Facture Conforama — 14 novembre 2028', [CAS.garantie.e], ['2026-11-01', '2026-11-30'])).toBe(false);
    // Borne de garantie qui est AUSSI une date légitime : jamais retirée par cette règle.
    expect(titleRemovesOnlyExcludedBounds(ancien, 'Facture Conforama', [CAS.garantie.s, CAS.garantie.e], [CAS.garantie.s])).toBe(false);
  });
});

describe('C839-U-08 — T3 : une proposition qui reprend la garantie est refusée', () => {
  const doc: NamingSnapshotDoc = { id: 5, name: `Facture ${CAS.objet} Conforama — 14 novembre 2026`, origin: 'T1', fingerprint: 'f' };
  const known = {
    dates: [CAS.emission], periods: [], amountsCents: [46999], texts: [`${CAS.garantie.s}/${CAS.garantie.e}`, CAS.nom, CAS.objet], excludedDays: [CAS.garantie.e],
  };
  const juger = (proposed: string, d: NamingSnapshotDoc = doc) => judgeProposal({
    document_id: d.id, expected_current_name: d.name, proposed_name: proposed, reason: 'harmonisation', confidence: 'certain',
  }, { docs: new Map([[d.id, d]]), seen: new Set(), known, now: new Date('2026-11-25'), cooldownDays: 30 });
  it('plage de garantie proposée : EXCLUDED_PERIOD_PROPOSED (même si le fait la justifie dans les textes)', () => {
    expect(juger(`Facture ${CAS.objet} Conforama — 14 novembre 2026 au 14 novembre 2028`)).toMatchObject({ accept: false, code: 'EXCLUDED_PERIOD_PROPOSED' });
    expect(RENAME_REFUSAL_LABEL.EXCLUDED_PERIOD_PROPOSED).toMatch(/garantie/);
  });
  it('proposition légitime acceptée ; retirer la borne de garantie d’un ancien titre n’est pas une perte', () => {
    expect(juger(`Facture ${CAS.objet} Conforama — Chasse S/R — 14 novembre 2026`)).toMatchObject({ accept: true });
    const ancien: NamingSnapshotDoc = { ...doc, name: 'Facture Conforama France SA Chasse S/R — 14 novembre 2026 au 14 novembre 2028' };
    expect(juger(`Facture ${CAS.objet} Conforama France SA Chasse S/R — 14 novembre 2026`, ancien)).toMatchObject({ accept: true });
  });
});

describe('C839-U-09 — aucune valeur du cas contractuel dans le code de production', () => {
  it('ni enseigne, ni raison sociale, ni modèle codés en dur', () => {
    for (const f of [
      'src/services/ai/source-analysis/supplier-identity/verify.ts', 'src/services/ai/source-analysis/supplier-identity/contract.ts',
      'src/services/ai/source-analysis/master/to-source-analysis-result.ts', 'src/services/ai/source-analysis/master/tolerant-output.ts',
      'src/lib/documents/document-title-convention.ts', 'src/lib/documents/document-title-period.ts', 'src/lib/documents/document-title-rules.ts',
      'src/services/documents/document-title.service.ts', 'src/services/ai/source-analysis/document-title.ts',
      'src/services/ai/reconciliation/document-naming/guards.ts', 'src/services/ai/reconciliation/document-naming/repository.ts',
    ]) {
      const code = lire(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/Conforama|CI606025BK|Chasse S\/R/i);
    }
  });
});
