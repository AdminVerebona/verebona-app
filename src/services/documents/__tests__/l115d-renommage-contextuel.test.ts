/**
 * Lot 115D (Trello #783) — RENOMMAGE IA CONTEXTUEL : la garantie n'entre plus dans le titre d'une
 * facture d'achat, et le fournisseur du titre est fiabilisé. Unitaires SANS base (règles pures +
 * garde statique du service de nommage et du guide des prompts).
 *
 *   L115D-783-U-01  nature d'une période : seule la garantie est exclue d'un titre (référentiel)
 *   L115D-783-U-02  périodes de faits éligibles : clé du fait, sinon bornes qualifiées (113W)
 *   L115D-783-U-03  titre composé : la facture d'achat de la capture perd la plage de garantie,
 *                   les documents périodiques gardent leur période discriminante
 *   L115D-783-U-04  fournisseur : enseigne prouvée, sinon raison sociale ; jamais l'établissement ;
 *                   rubrique absente, hésitante ou sans preuve → comportement d'aujourd'hui
 *   L115D-783-U-05  reprise du stock : version des règles de titre et contrôle COH-DOC-TITLES
 *   L115D-783-U-06  service de nommage : la nature des périodes est lue, jamais devinée
 *   L115D-783-U-07  guide des prompts : étape 52 présente, contrat et garde-fous
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERIOD_FACT_KEYS, periodKindOfFactKey } from '@/lib/documents/business-periods';
import {
  periodKindIdentifiesDocument, titleEligibleFactPeriods, TITLE_EXCLUDED_PERIOD_KINDS,
} from '@/lib/documents/document-title-period';
import {
  presentSupplier, supplierIdentityFromAnalysis, supplierTitleName, T1_SUPPLIER_IDENTITY_CONTRACT,
} from '@/lib/documents/document-title-convention';
import { DOCUMENT_TITLE_RULE_VERSION, titleCarriesStalePeriod, titlePeriodMarkers } from '@/lib/documents/document-title-rules';
import { planBusinessTitle, titleInputsFromAnalysis, type BillingBasis } from '@/services/ai/source-analysis/document-title';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/** Bornes de la garantie de la capture (facture Conforama du 14/11/2026). */
const GARANTIE = { s: '2026-11-14', e: '2028-11-14' };

describe('L115D-783-U-01 — nature d’une période et titre', () => {
  it('seule la garantie est écartée ; les autres natures du référentiel restent admises', () => {
    expect([...TITLE_EXCLUDED_PERIOD_KINDS]).toEqual(['WARRANTY']);
    expect(periodKindIdentifiesDocument('WARRANTY')).toBe(false);
    for (const k of ['COVERAGE', 'BILLING', 'VALIDITY', 'SERVICE', 'CONTRACT', 'REALIZATION'] as const) {
      expect(periodKindIdentifiesDocument(k), k).toBe(true);
    }
    // Nature inconnue (fait générique) : traitée comme avant la carte.
    expect(periodKindIdentifiesDocument(null)).toBe(true);
  });
  it('clé de fait T1 → nature (un seul référentiel, réexporté par le modèle des périodes)', async () => {
    expect(periodKindOfFactKey('period.warranty')).toBe('WARRANTY');
    expect(periodKindOfFactKey('Period.Warranty')).toBe('WARRANTY');
    expect(periodKindOfFactKey('period.billing')).toBe('BILLING');
    expect(periodKindOfFactKey('warrantyEndDate')).toBeNull();
    expect(periodKindOfFactKey(null)).toBeNull();
    const m = await import('@/services/documents/business-periods/model');
    expect(m.PERIOD_FACT_KEYS).toBe(PERIOD_FACT_KEYS);
    expect(m.PERIOD_FACT_PREFIX).toBe('period.');
  });
});

describe('L115D-783-U-02 — périodes de faits éligibles au titre', () => {
  it('écartée par la clé du fait (garantie), conservée pour toute autre nature', () => {
    const faits = [{ ...GARANTIE, key: 'period.warranty' }, { s: '2026-11-01', e: '2026-11-30', key: 'period.billing' }];
    expect(titleEligibleFactPeriods(faits)).toEqual([{ s: '2026-11-01', e: '2026-11-30', key: 'period.billing' }]);
  });
  it('fait sans clé exploitable : écartée si ses bornes sont celles d’une garantie QUALIFIÉE et d’aucune autre nature', () => {
    const faits = [{ ...GARANTIE, key: 'warrantyEndDate' }];
    const qualifiees = [{ kind: 'WARRANTY' as const, start: GARANTIE.s, end: GARANTIE.e }];
    expect(titleEligibleFactPeriods(faits, qualifiees)).toEqual([]);
    // Mêmes bornes aussi portées par une période facturée : la période reste admise (jamais supprimée en bloc).
    expect(titleEligibleFactPeriods(faits, [...qualifiees, { kind: 'BILLING' as const, start: GARANTIE.s, end: GARANTIE.e }]))
      .toEqual(faits);
    // Aucune nature connue (migration 1560 absente, lecture en échec) : comportement d'avant la carte.
    expect(titleEligibleFactPeriods(faits, [])).toEqual(faits);
  });
  it('une couverture et une validité qualifiées ne sont jamais écartées', () => {
    const faits = [{ s: '2025-04-01', e: '2026-03-31', key: null }];
    expect(titleEligibleFactPeriods(faits, [{ kind: 'COVERAGE', start: '2025-04-01', end: '2026-03-31' }])).toEqual(faits);
    expect(titleEligibleFactPeriods(faits, [{ kind: 'VALIDITY', start: '2025-04-01', end: '2026-03-31' }])).toEqual(faits);
  });
});

describe('L115D-783-U-03 — titre composé : avant / après', () => {
  const billing = (b: BillingBasis['billedPeriod']): BillingBasis =>
    ({ billedPeriod: b, principalMonth: null, invoiceReferences: [], issueDate: '2026-11-14' });
  it('AVANT (bornes de garantie prises pour une période facturée) : le titre portait la plage', () => {
    // Reproduction du titre observé : la période de garantie arrivait au nommage comme période facturée.
    const plan = planBusinessTitle('Facture', {
      typeCode: 'FACTURE', supplier: 'Conforama France SA Chasse S/R', documentDate: '2026-11-14',
      billing: billing({ start: GARANTIE.s, end: GARANTIE.e, source: 'T1_FACT' }),
    });
    expect(plan.title).toBe('Facture Conforama France SA Chasse S/R — 14 novembre 2026 au 14 novembre 2028');
  });
  it('APRÈS : la garantie n’atteint plus le nommage → nature + objet + fournisseur + date du document', () => {
    // `titleEligibleFactPeriods` l'a écartée : plus aucune période facturée pour ce document.
    const plan = planBusinessTitle('Facture', {
      typeCode: 'FACTURE', supplier: 'Conforama', documentDate: '2026-11-14',
      subjects: ['Table de cuisson FAR CI606025BK'],
      billing: billing(null),
    });
    expect(plan.title).toBe('Facture Table de cuisson FAR CI606025BK Conforama — 14 novembre 2026');
    expect(plan.title).not.toMatch(/14 novembre 2028|2028/);
    expect(plan.convention).toBeNull();
  });
  it('les documents périodiques gardent leur période discriminante (rien n’est supprimé en bloc)', () => {
    const abonnement = planBusinessTitle('Facture', {
      typeCode: 'FACTURE', supplier: 'Homiris', documentDate: '2026-02-06',
      billing: billing({ start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' }),
    });
    expect(abonnement.title).toBe('Facture Homiris — Février 2026');
    const attestation = planBusinessTitle('Attestation', {
      typeCode: 'ATTESTATION', supplier: 'Assureur Habitation', documentDate: '2025-04-01',
      period: { start: '2025-04-01', end: '2026-03-31' },
    });
    expect(attestation.title).toBe('Attestation Assureur Habitation — Avril 2025 à mars 2026');
  });
});

describe('L115D-783-U-04 — fournisseur du titre (bloc PO 52, facultatif)', () => {
  const resultat = (identity: unknown) => ({ document: { supplier: { value: { name: 'CONFORAMA FRANCE SA CHASSE S/R', identity } } } });
  it('rubrique absente : le nom lu aujourd’hui, inchangé (tolérance au bloc non collé)', () => {
    expect(supplierIdentityFromAnalysis(resultat(undefined))).toBeNull();
    expect(supplierIdentityFromAnalysis(null)).toBeNull();
    expect(titleInputsFromAnalysis(resultat(undefined) as never).ctx.supplier).toBe('CONFORAMA FRANCE SA CHASSE S/R');
    // La casse est seule normalisée (règle 87D inchangée) : aucune troncature, aucun mot retiré.
    expect(presentSupplier('CONFORAMA FRANCE SA CHASSE S/R')).toBe('Conforama France SA Chasse S/R');
  });
  it('rubrique prouvée : l’enseigne, jamais l’établissement ni l’adresse', () => {
    const id = {
      legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R',
      confidence: 'certain', evidence: { quote: 'CONFORAMA FRANCE SA — Magasin de Chasse S/R' },
    };
    expect(supplierIdentityFromAnalysis(resultat(id))).toEqual({
      legalName: 'Conforama France SA', tradeName: 'Conforama', establishment: 'Chasse S/R',
      quote: 'CONFORAMA FRANCE SA — Magasin de Chasse S/R',
    });
    expect(titleInputsFromAnalysis(resultat(id) as never).ctx.supplier).toBe('Conforama');
    // Sans enseigne : la raison sociale (aucune troncature inventée).
    expect(titleInputsFromAnalysis(resultat({ ...id, tradeName: null }) as never).ctx.supplier).toBe('Conforama France SA');
    // L'établissement seul ne nomme jamais : rubrique inexploitable → nom d'aujourd'hui.
    expect(titleInputsFromAnalysis(resultat({ ...id, legalName: null, tradeName: null }) as never).ctx.supplier)
      .toBe('CONFORAMA FRANCE SA CHASSE S/R');
  });
  it('rubrique hésitante, sans preuve, ou coupée par la variable d’environnement : aucun effet', () => {
    const base = { legalName: 'Conforama France SA', tradeName: 'Conforama', evidence: { quote: 'CONFORAMA' } };
    expect(supplierIdentityFromAnalysis(resultat({ ...base, confidence: 'probable' }))).toBeNull();
    expect(supplierIdentityFromAnalysis(resultat({ ...base, confidence: 'certain', evidence: {} }))).toBeNull();
    expect(supplierIdentityFromAnalysis(resultat({ ...base, confidence: 'certain' }), { T1_SUPPLIER_IDENTITY_ENABLED: '0' })).toBeNull();
    expect(supplierTitleName(null, 'Orange')).toBe('Orange');
    expect(supplierTitleName(null, '  ')).toBeNull();
  });
});

describe('L115D-783-U-05 — reprise du stock des titres automatiques', () => {
  it('repères temporels d’un titre : un titre en place qui porte une plage périmée est recomposé', () => {
    const ancien = 'Facture Conforama France SA Chasse S/R — 14 novembre 2026 au 14 novembre 2028';
    const nouveau = 'Facture Table de cuisson FAR CI606025BK Conforama France SA Chasse S/R — 14 novembre 2026';
    expect(titlePeriodMarkers(ancien)).toEqual(['novembre 2026', 'novembre 2028']);
    expect(titleCarriesStalePeriod(ancien, nouveau)).toBe(true);
    // Un titre périodique inchangé, ou enrichi, n’est jamais recomposé par cette règle.
    expect(titleCarriesStalePeriod('Facture Homiris — Février 2026', 'Facture Homiris — Février 2026 (n° 94741361)')).toBe(false);
    expect(titleCarriesStalePeriod('Facture Homiris', 'Facture Homiris — Février 2026')).toBe(false);
    // La règle ne sert QUE lorsqu'une période a été écartée par sa nature (garde du service).
    const svc = lire('src/services/documents/document-title.service.ts');
    expect(svc).toContain("if (!decision.replace && excludedPeriods > 0 && titleCarriesStalePeriod(row.retained_title, candidat)) {");
    expect(svc).toContain("decision = { replace: true, reason: 'EXCLUDED_PERIOD_REMOVED' };");
  });
  it('version des règles relevée : le contrôle COH-DOC-TITLES reprend les titres SYSTÈME antérieurs', async () => {
    // Règle remplacée (carte #783) : version 3 (lot 87D) → 4.
    expect(DOCUMENT_TITLE_RULE_VERSION).toBe(4);
    const check = lire('src/services/coherence/registry/checks/document-titles.ts');
    expect(check).toContain("if (s.ruleVersion !== DOCUMENT_TITLE_RULE_VERSION) return { verdict: 'REPAIRABLE', anomaly: 'TITLE_RULES_OUTDATED' };");
    // Aucun titre utilisateur n'est proposé ni réécrit par la reprise.
    expect(check).toMatch(/titleSource !== 'SYSTEM'|titleSource === 'SYSTEM'/);
    const { diagnoseDocumentTitle } = await import('@/services/coherence/registry/checks/document-titles');
    expect(diagnoseDocumentTitle({
      fileId: 1, title: 'Ma facture', titleSource: 'USER', titleValid: true, ruleVersion: 1, contextFingerprint: null,
      persisted: { basis: null, convention: null, key: null }, expected: null, harmonized: false,
      searchLabel: 'Ma facture', sheetLabel: 'Ma facture',
    })).toEqual({ verdict: 'CONSISTENT' });
  });
});

describe('L115D-783-U-06 — service de nommage : la nature des périodes est LUE', () => {
  const svc = lire('src/services/documents/document-title.service.ts');
  it('les périodes de faits passent par le filtre pur, avec leur clé et les natures qualifiées', () => {
    expect(svc).toContain('titleEligibleFactPeriods(faits, qualifiees)');
    expect(svc).toContain("COALESCE(raw_key, fact_key) AS key");
    expect(svc).toContain('FROM document_business_periods');
    // Les deux lectures du nommage (contexte du compte et données de facturation) passent par le filtre.
    expect((svc.match(/loadTitleFactPeriods\(sql, fileId, accountId/g) ?? []).length).toBe(2);
    expect(svc).not.toMatch(/period_start IS NOT NULL AND period_end IS NOT NULL\s*\n\s*LIMIT/);
    // La lecture des natures ne lève jamais (table absente : comportement d'avant).
    expect(svc).toContain('.catch(() => [])) as unknown as Array<{ kind: string; start: string | null; end: string | null }>');
  });
  it('aucune règle ne dépend d’un fournisseur, d’une marque ou d’un modèle particulier', () => {
    for (const f of ['src/services/documents/document-title.service.ts', 'src/lib/documents/document-title-period.ts', 'src/services/ai/source-analysis/document-title.ts']) {
      const code = lire(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/Conforama|CI606025BK/i);
    }
  });
});

describe('L115D-783-U-07 — guide des prompts : étape 52', () => {
  const guide = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
  it('bloc 52 présent, facultatif, avec son contrat et ses garde-fous', () => {
    expect(guide).toContain('## 16. Étape 52 — T1 : identité de l’émetteur');
    expect(guide).toContain(`contrat ${T1_SUPPLIER_IDENTITY_CONTRACT}`);
    expect(guide).toContain("IDENTITÉ DE L'ÉMETTEUR — contrat t1-supplier-identity-v1");
    for (const clef of ['legalName', 'tradeName', 'establishment', 'confidence', 'evidence.quote']) expect(guide).toContain(clef);
    expect(guide).toContain('FACULTATIVE');
    expect(guide).toContain('T1_SUPPLIER_IDENTITY_ENABLED=0');
    // Le code ne cite que des NOMS de variables d'environnement, et le texte du prompt n'est QUE dans le guide.
    expect(lire('src/lib/documents/document-title-convention.ts')).not.toContain("IDENTITÉ DE L'ÉMETTEUR —");
  });
});
