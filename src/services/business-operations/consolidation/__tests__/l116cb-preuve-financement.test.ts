/**
 * Carte Trello #806, volet B §11 (partie T3) — une « échéance » générique ne devient pas un FINANCEMENT : le type
 * n'est retenu que sur une preuve des référentiels existants (Type du document, référence de prêt, capital emprunté).
 *
 *   L116CB-F01  référentiel des pièces de financement : codes présents dans les Types V2, ancien code V1 lu par sa
 *               correspondance certaine, jamais une pièce d'assurance ni une facture
 *   L116CB-F02  preuve : chacune des trois suffit seule ; aucune : rien ; ordre stable
 *   L116CB-F03  indice de type retenu : « Financement » sans preuve → non qualifié (jamais « Autre ») ; les autres
 *               indices sont rendus tels quels
 *   L116CB-F04  identité T3 d'un candidat : type nul et trace `financingWithoutEvidence` sans preuve ; FINANCING avec
 *               chacune des trois preuves ; les autres types ne changent pas
 *   L116CB-F05  lignes documentaires du coût de possession : l'indice « Financement » sans preuve n'est pas transmis
 *               au moteur (la ligne suit la nature du document) ; avec preuve il l'est
 *   L116CB-F06  aucune règle codée en dur : ni mot du document, ni libellé, ni nom de banque dans la règle
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES } from '@/lib/referential/v2/document-types';
import { FINANCING_DOCUMENT_TYPES, isFinancingDocumentType } from '@/lib/referential/v2/financing-document-types';
import { INSURANCE_CONTRACT_DOCUMENT_TYPES } from '@/lib/referential/v2/insurance-contract-document-types';
import { REFERENCE_KINDS } from '@/services/business-operations/model';
import { qualifyDocumentLines, type EconomicDocumentInput } from '../../finance/economic-lines';
import { LOAN_PRINCIPAL_ROLE, LOAN_REFERENCE_KIND, financingEvidenceOf, provenTypeHint } from '../financing-evidence';
import { buildCandidateIdentity } from '../model';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const rien = { documentTypeCode: null, referenceKinds: [], hintRoles: [] };

describe('L116CB-F01 — référentiel des pièces de financement', () => {
  it('quatre Types V2 existants : prêt / crédit, échéancier de financement, sûreté, leasing (LOA, LLD)', () => {
    const codes = new Set(DOCUMENT_TYPES.map((t) => t.code));
    expect([...FINANCING_DOCUMENT_TYPES].sort()).toEqual(['FINANCING_CONTRACT', 'FINANCING_GUARANTEE', 'FINANCING_SCHEDULE', 'LEASING_FINANCING_CONTRACT']);
    for (const c of FINANCING_DOCUMENT_TYPES) expect(codes.has(c), c).toBe(true);
    // Tout Type V2 dont le code dit « financement » est dans la liste : un Type ajouté plus tard ne passe pas inaperçu.
    expect(DOCUMENT_TYPES.filter((t) => /FINANCING/.test(t.code)).map((t) => t.code).sort()).toEqual([...FINANCING_DOCUMENT_TYPES].sort());
  });
  it('une pièce d’assurance, une facture, un devis, un Type inconnu ou absent ne sont pas des pièces de financement', () => {
    for (const c of [...INSURANCE_CONTRACT_DOCUMENT_TYPES, 'MAINTENANCE_INVOICE', 'QUOTE', 'ACQUISITION_INVOICE', 'INCONNU', '', null, undefined]) {
      expect(isFinancingDocumentType(c), String(c)).toBe(false);
    }
    for (const c of FINANCING_DOCUMENT_TYPES) expect(isFinancingDocumentType(c), c).toBe(true);
  });
});

describe('L116CB-F02 — preuve d’un financement', () => {
  it('chacune des trois preuves suffit seule ; sans aucune : rien', () => {
    expect(financingEvidenceOf(rien)).toBeNull();
    expect(financingEvidenceOf({ ...rien, documentTypeCode: 'FINANCING_SCHEDULE' })).toBe('DOCUMENT_TYPE');
    expect(financingEvidenceOf({ ...rien, referenceKinds: ['INVOICE', 'LOAN'] })).toBe('LOAN_REFERENCE');
    expect(financingEvidenceOf({ ...rien, hintRoles: ['REALIZED_COST', 'LOAN_PRINCIPAL'] })).toBe('LOAN_PRINCIPAL');
    // Ni une référence de contrat, de police ou de facture, ni un coût, un règlement ou une prévision ne prouvent un prêt.
    expect(financingEvidenceOf({ documentTypeCode: 'INSURANCE_DUE_NOTICE', referenceKinds: ['CONTRACT', 'POLICY', 'INVOICE', 'CUSTOMER', null], hintRoles: ['REALIZED_COST', 'FORECAST_COST', 'PAYMENT', undefined] })).toBeNull();
    // Ordre stable quand plusieurs preuves coexistent.
    expect(financingEvidenceOf({ documentTypeCode: 'FINANCING_CONTRACT', referenceKinds: ['LOAN'], hintRoles: ['LOAN_PRINCIPAL'] })).toBe('DOCUMENT_TYPE');
  });
  it('les deux valeurs lues viennent des référentiels existants', () => {
    expect((REFERENCE_KINDS as readonly string[]).includes(LOAN_REFERENCE_KIND)).toBe(true);
    // Rôle de montant « capital emprunté » : celui que pose déjà la règle du lot 53D et qu'exclut le coût de possession.
    expect(lire('src/services/ai/source-analysis/operation-candidates/prepare.ts')).toContain(`h.role = '${LOAN_PRINCIPAL_ROLE}'`);
    expect(lire('src/services/business-operations/finance/economic-lines.ts')).toContain(`${LOAN_PRINCIPAL_ROLE}: 'Capital emprunté : une dette, pas une dépense'`);
  });
});

describe('L116CB-F03 — indice de type retenu', () => {
  it('« Financement » sans preuve → non qualifié ; avec preuve → conservé ; autres indices inchangés', () => {
    expect(provenTypeHint('FINANCING', rien)).toBeNull();
    expect(provenTypeHint(' financing ', rien)).toBeNull();
    expect(provenTypeHint('FINANCING', { ...rien, referenceKinds: ['LOAN'] })).toBe('FINANCING');
    for (const t of ['CONTRACT', 'INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL', 'OTHER', 'n’importe quoi', null, undefined]) expect(provenTypeHint(t, rien)).toBe(t);
  });
});

describe('L116CB-F04 — identité T3 d’un candidat', () => {
  const identite = (o: { typeHint?: string; docType?: string | null; refs?: Array<{ kind: string; value: string }>; hints?: unknown[] } = {}) => buildCandidateIdentity({
    id: 1, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain',
    typeHint: o.typeHint ?? 'FINANCING', statusHint: 'REALIZED', summary: 'Échéance',
    payload: {
      sourceRoleHint: 'INVOICE', businessReferences: o.refs ?? [{ kind: 'INVOICE', value: 'AV-1' }],
      financialHints: (o.hints ?? [{ role: 'REALIZED_COST', amountMinor: 42000, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2025-01-05', periodStart: null, periodEnd: null, factRef: 'f1' }]) as never,
    },
  }, { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map(), fileDocumentTypeCode: o.docType ?? null });

  it('échéance proposée « Financement » sans preuve : type non qualifié, tracé ; montants, références et rôle intacts', () => {
    for (const docType of [null, 'INSURANCE_DUE_NOTICE', 'MAINTENANCE_INVOICE']) {
      const i = identite({ docType });
      expect(i.type, String(docType)).toBeNull();
      expect(i.financingWithoutEvidence, String(docType)).toBe(true);
      expect(i.established).toBe(true);
      expect(i.role).toBe('INVOICE');
      expect(i.refs.map((r) => r.kind)).toEqual(['INVOICE']);
      expect(i.hints.map((h) => [h.role, h.amountMinor])).toEqual([['REALIZED_COST', 42000]]);
    }
  });
  it('chacune des trois preuves établit le financement, sans trace d’écart', () => {
    for (const o of [
      { docType: 'FINANCING_SCHEDULE' }, { docType: 'LEASING_FINANCING_CONTRACT' },
      { refs: [{ kind: 'LOAN', value: 'PR-1' }] },
      { hints: [{ role: 'LOAN_PRINCIPAL', amountMinor: 1_500_000, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }] },
    ]) {
      const i = identite(o);
      expect(i.type, JSON.stringify(o)).toBe('FINANCING');
      expect(i.financingWithoutEvidence, JSON.stringify(o)).toBeUndefined();
    }
  });
  it('les autres types ne sont pas touchés, avec ou sans pièce de financement', () => {
    for (const typeHint of ['CONTRACT', 'INTERVENTION', 'CLAIM', 'OTHER']) {
      expect(identite({ typeHint }).type).toBe(typeHint);
      expect(identite({ typeHint, docType: 'FINANCING_CONTRACT' }).type).toBe(typeHint);
      expect(identite({ typeHint }).financingWithoutEvidence).toBeUndefined();
    }
  });
});

describe('L116CB-F05 — lignes documentaires du coût de possession', () => {
  const doc = (fileId: number, typeCode: string, refs: Array<{ kind: string; value: string }>): EconomicDocumentInput => ({
    fileId, title: `Document ${fileId}`, typeCode, legacyType: null, date: '2025-01-05', supplier: 'Mutuelle', amountCents: 42000, currency: 'EUR',
    userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null, linkedAssetIds: [7], multiAsset: false, operations: [],
    candidates: [{
      id: fileId * 10, typeHint: 'FINANCING', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: 'Mutuelle', references: refs, targets: [{ type: 'ASSET', entityId: 7 }], t3Outcome: null,
      hints: [{ role: 'REALIZED_COST', amountMinor: 42000, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2025-01-05', periodStart: null, periodEnd: null }],
    }],
  });
  it('sans preuve : aucune ligne ne porte l’indice « Financement » ; avec preuve : l’indice est conservé ; le montant ne change pas', () => {
    const sans = qualifyDocumentLines([doc(1, 'INSURANCE_DUE_NOTICE', [{ kind: 'INVOICE', value: 'AV-1' }])], { today: '2026-10-12' });
    expect(sans.length).toBeGreaterThan(0);
    expect(sans.map((l) => l.typeHint)).not.toContain('FINANCING');
    expect(sans.reduce((t, l) => t + (l.kind === 'REALIZED_COST' ? l.amountMinor : 0), 0)).toBe(42000);
    for (const avec of [doc(2, 'FINANCING_SCHEDULE', [{ kind: 'INVOICE', value: 'EC-1' }]), doc(3, 'MAINTENANCE_INVOICE', [{ kind: 'LOAN', value: 'PR-1' }])]) {
      const lignes = qualifyDocumentLines([avec], { today: '2026-10-12' });
      expect(lignes.map((l) => l.typeHint), avec.typeCode ?? '').toContain('FINANCING');
      expect(lignes.reduce((t, l) => t + (l.kind === 'REALIZED_COST' ? l.amountMinor : 0), 0)).toBe(42000);
    }
  });
});

describe('L116CB-F06 — aucune règle codée en dur', () => {
  it('la règle ne lit ni un mot du document, ni un libellé, ni un fournisseur', () => {
    const code = lire('src/services/business-operations/consolidation/financing-evidence.ts').split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    expect(code).not.toMatch(/RegExp|\/[^/\n]*(pr[eê]t|cr[eé]dit|leasing|banque|[eé]ch[eé]ance)[^/\n]*\/[a-z]*/i);
    expect(code).not.toMatch(/summary|provider|title|label|includes\(['"`]/);
    const ref = lire('src/lib/referential/v2/financing-document-types.ts').split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    expect(ref).not.toMatch(/RegExp|label|title/);
    // La règle est appelée aux DEUX endroits qui reprenaient l'indice de T1 tel quel.
    expect(lire('src/services/business-operations/consolidation/model.ts')).toContain('financingEvidenceOf({');
    expect(lire('src/services/business-operations/finance/economic-lines.ts')).toContain('provenTypeHint(c.typeHint, {');
  });
});
