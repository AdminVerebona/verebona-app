/**
 * Lot 113AB (Trello #725, §2 D et §3) — périodes métier sur les surfaces : fiche de
 * l'événement de référence, détail d'une dépense, Assistant (T2), dossiers V12.
 * Unitaires SANS base (règles pures, contrats d'interface, garde statique des écrans).
 *
 *   L113AB-U-01  faits T2 : « couverture établie du … au … », justificatif, correction, « aucune prolongation » ; rien sinon
 *   L113AB-U-02  T2 contrats : couvertures citées, justificatifs consultables ; réponse inchangée sans couverture
 *   L113AB-U-03  T2 source métier d'un contrat : faits de couverture dans l'extrait ; aucun statut, aucun « Opération »
 *   L113AB-U-04  dossiers V12 : période principale de la pièce (`detail`), jamais Notes / Description ; rien sinon
 *   L113AB-U-05  écrans : fiche de l'événement de référence (tiroir du document, ligne de dépense), période facturée
 *                corrigeable depuis la dépense par la route du MÊME fait ; jetons de couleur seulement ; jamais « Opération »
 *   L113AB-U-06  libellé utilisateur d'un événement de référence (vocabulaire TCO, jamais « Opération »)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageFactsText, documentPeriodsText, exportPeriodDetail, periodBody, REFERENCE_EVENT_TITLE, T2_NO_EXTENSION,
} from '@/lib/documents/business-period-surfaces';
import { contractsAnswer } from '@/services/verebona-assistant/canonical/structured-answers';
import { operationBusinessSource } from '@/services/verebona-assistant/canonical/business-sources';
import { toDocItem } from '@/services/exports/v12/data/mappers/common';
import { withPeriodLines, type SourceDocument } from '@/services/exports/v12/data/source';
import { referenceEventLabel } from '@/services/documents/business-period-surfaces';
import { TCO_UNDATED_TEXTS } from '@/services/business-operations/tco/undated-expenses';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const COUV = [
  { line: 'Période couverte : du 01/04/2023 au 31/03/2024', documentTitle: 'Attestation 2023-2024' },
  { line: 'Période couverte : de avril 2024 à mars 2025', documentTitle: 'Attestation 2024-2025', userCorrected: true },
];

describe('L113AB-U-01 — faits temporels pour T2', () => {
  it('phrase factuelle, chronologique, sourcée ; aucune prolongation ; rien quand rien n’est établi', () => {
    expect(periodBody('Période couverte : du 01/04/2023 au 31/03/2024')).toBe('du 01/04/2023 au 31/03/2024');
    expect(periodBody('Fin de couverture : 30/06/2026')).toBe('30/06/2026');
    const t = coverageFactsText(COUV)!;
    expect(t).toBe('Périodes de couverture établies par les justificatifs : du 01/04/2023 au 31/03/2024 (justificatif : Attestation 2023-2024) ; '
      + 'de avril 2024 à mars 2025 (justificatif : Attestation 2024-2025), corrigée par l’utilisateur — ' + T2_NO_EXTENSION);
    expect(t).not.toMatch(/expir|en cours|dernière période connue|Opération/i);
    expect(coverageFactsText([])).toBeNull();
    expect(documentPeriodsText({ principal: null, secondary: [] })).toBeNull();
    expect(documentPeriodsText({
      principal: { line: 'Période de validité : 2025', segments: [{ line: 'Période de validité : 2025' }] },
      secondary: [{ line: 'Période facturée : mars 2026', userCorrected: true }],
    })).toBe('Période de validité : 2025 · Période facturée : mars 2026 (corrigée par l’utilisateur)');
    expect(documentPeriodsText({
      principal: { line: 'Plusieurs périodes concernées', segments: [{ line: 'Période couverte : du 01/01/2024 au 31/03/2024' }, { line: 'Période couverte : du 01/07/2024 au 30/09/2024' }] },
      secondary: [],
    })).toBe('Plusieurs périodes concernées (Période couverte : du 01/01/2024 au 31/03/2024 ; Période couverte : du 01/07/2024 au 30/09/2024)');
  });
});

describe('L113AB-U-02 — T2 : réponse « contrats »', () => {
  const base = {
    operationId: 1, label: 'contrat « Assurance habitation »', provider: 'Assureur', reference: 'POL-1', from: '2023-04-01', to: null,
    status: 'REALIZED', realizedCents: null, forecastCents: null, assetIds: [20], source: { id: 'doc_5', type: 'document' as const, title: 'Attestation', content: 'x' },
  };
  const scope = { assets: [], ambiguous: false, unresolved: false, label: 'Maison' };
  it('couvertures établies citées avec leurs justificatifs ; jamais de fin ni de statut déduits', () => {
    const r = contractsAnswer([{
      ...base, coverages: COUV,
      coverageSources: [{ id: 'doc_5', type: 'document', title: 'Attestation 2023-2024', content: 'a' }, { id: 'doc_6', type: 'document', title: 'Attestation 2024-2025', content: 'b' }],
    }], scope);
    expect(r.answer).toBe(`Contrat « Assurance habitation » chez Assureur (n° POL-1), depuis le 1 avril 2023 — ${coverageFactsText(COUV)}.`);
    expect(r.sources.map((s) => s.id)).toEqual(['doc_5', 'doc_6']);
    expect(r.answer).not.toMatch(/jusqu|expir|en cours|Opération/i);
  });
  it('sans couverture : réponse inchangée (B15)', () => {
    const r = contractsAnswer([base], scope);
    expect(r.answer).toBe('Contrat « Assurance habitation » chez Assureur (n° POL-1), depuis le 1 avril 2023.');
    expect(r.sources.map((s) => s.id)).toEqual(['doc_5']);
  });
});

describe('L113AB-U-03 — T2 : source métier d’un contrat', () => {
  const op = {
    id: 9, accountId: 1, typeCode: 'CONTRACT', status: 'REALIZED', technicalLabel: 'Assurance habitation', provider: 'Assureur',
    plannedDate: null, startDate: '2023-04-01', realizedDate: null, endDate: '2026-03-31', closedAt: null, invalidatedAt: null, invalidationReason: null,
    mergedIntoOperationId: null, lastReconciledAt: null, version: 1, active: true, contractReference: 'POL-1', effectiveFrom: '2023-04-01', effectiveTo: null,
    claimStatus: null, claimType: null, insurerClaimRef: null, declaredOn: null, assetIds: [14], components: [],
    documents: [{ fileId: 5, role: 'CONTRACT_DOCUMENT', title: 'Attestation 2023-2024', date: '2023-03-20', amountCents: null, documentTypeCode: 'INSURANCE_CERTIFICATE' }],
    sourceKinds: ['DOCUMENT'],
  } as unknown as Parameters<typeof operationBusinessSource>[0];
  it('faits de couverture dans l’extrait ; aucune fin contractuelle déduite ; extrait inchangé sans couverture', () => {
    const sans = operationBusinessSource(op, 14, 'Maison');
    const avec = operationBusinessSource(op, 14, 'Maison', COUV);
    expect(avec.endDate).toBeNull();
    expect(avec.source!.content).toBe(`${sans.source!.content} · ${coverageFactsText(COUV)}`);
    expect(avec.source!.content).not.toMatch(/Opération|expir/i);
    expect(sans.source!.content).not.toContain('Périodes de couverture');
  });
});

describe('L113AB-U-04 — dossiers V12 : période de la pièce', () => {
  const doc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
    id: 7, title: 'Attestation 2025-2026', typeLabel: 'Attestation d’assurance', kind: 'AUTRE' as SourceDocument['kind'], format: 'PDF', integrable: true,
    sensitive: false, occupantData: false, date: '2025-03-20', sizeBytes: 100, fileName: 'a.pdf', mimeType: 'application/pdf', s3Key: null, s3Bucket: null,
    supplier: null, amountCents: null, cilRubricCodes: [], codes: [], equipmentId: null, ...over,
  });
  const m = { resolved: null } as unknown as Parameters<typeof toDocItem>[2];
  it('période principale telle que sur la fiche ; rien sans période ; un `detail` explicite du mappeur reste prioritaire', () => {
    const [d] = withPeriodLines([doc()], new Map([[7, 'Période couverte : du 01/04/2025 au 31/03/2026']]));
    expect(d.periodLine).toBe('Période couverte : du 01/04/2025 au 31/03/2026');
    expect(toDocItem({ doc: d, mode: 'PDF' } as never, 'docs', m).detail).toBe('Période couverte : du 01/04/2025 au 31/03/2026');
    expect(toDocItem({ doc: doc(), mode: 'PDF' } as never, 'docs', m).detail).toBeUndefined();
    expect(toDocItem({ doc: d, mode: 'PDF' } as never, 'docs', m, { detail: 'autre' }).detail).toBe('autre');
    expect(exportPeriodDetail('  ')).toBeNull();
    expect(withPeriodLines([doc()], new Map())[0]).not.toHaveProperty('periodLine');
  });
  it('la source V12 ne porte toujours aucune Notes / Description (113Z)', () => {
    const src = lire('src/services/exports/v12/data/source.ts');
    expect(src).toMatch(/periodLine\?: string \| null/);
    const iface = src.slice(src.indexOf('export interface SourceDocument'), src.indexOf('export interface SourcePhoto'));
    expect(iface).not.toMatch(/\bdescription\??:|\bnotes\??:/);
  });
});

describe('L113AB-U-05 — écrans (desktop et mobile, même composant)', () => {
  const sheet = lire('src/components/documents/ReferenceEventSheet.tsx');
  const periode = lire('src/components/assets/tco-expense-period.tsx');
  const tco = lire('src/components/assets/TcoSection.tsx');
  const drawer = lire('src/components/assets/DocumentDrawer.tsx');
  it('fiche de l’événement de référence ouverte depuis le tiroir du document (sans agenda) et la ligne de dépense', () => {
    expect(drawer).toContain('<DocumentReferenceEvents documentId={doc.id} />');
    expect(sheet).toMatch(/r\.hasAgenda/);
    expect(sheet).toContain('/api/evenements-reference/');
    expect(sheet).toContain('<CoverageHistoryList');
    expect(tco).toContain('<ReferenceEventLink operationId={l.operationId} />');
    expect(REFERENCE_EVENT_TITLE).toBe('Événement de référence');
  });
  it('période facturée de la dépense : lecture groupée, correction par la route du MÊME fait (PeriodRow)', () => {
    expect(periode).toContain('/api/documents/periodes?ids=');
    expect(periode).toContain('<PeriodRow');
    expect(lire('src/components/documents/BusinessPeriods.tsx')).toContain('apiClient.put(`/api/documents/${fileId}/periodes`');
    expect(tco).toContain('<TcoExpensePeriod fileId={l.fileId}');
    expect((tco.match(/<LigneDepense key=\{l\.id\} l=\{l\} t=\{t\} periods=\{periodesDepenses\}/g) ?? []).length).toBe(6);
  });
  it('charte : jetons seulement (aucune couleur brute) ; jamais « Opération » affiché', () => {
    for (const s of [sheet, periode]) {
      // Code seulement (les commentaires citent « #725 »).
      const visibles = s.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|import )/.test(l)).map((l) => l.replace(/\{\/\*.*?\*\/\}/g, '')).join('\n');
      expect(visibles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(?:text|bg|border)-(?:red|green|blue|gray|slate|amber|yellow|orange|emerald|zinc|neutral)-\d{2,3}\b/);
      expect(visibles).not.toMatch(/Opération/);
    }
    expect(sheet).toContain('Voir l’événement de référence');
    expect(TCO_UNDATED_TEXTS.reference).toBe('Voir l’événement de référence');
  });
});

describe('L113AB-U-06 — libellé utilisateur d’un événement de référence', () => {
  it('nature + libellé technique, sinon premier justificatif, sinon fournisseur ; jamais « Opération »', () => {
    expect(referenceEventLabel({ typeCode: 'CONTRACT', technicalLabel: 'Assurance habitation' })).toBe('Contrat — Assurance habitation');
    expect(referenceEventLabel({ typeCode: 'INTERVENTION', technicalLabel: null, firstDocumentTitle: 'Facture chaudière' })).toBe('Intervention — Facture chaudière');
    expect(referenceEventLabel({ typeCode: null, technicalLabel: '  ', provider: 'EDF' })).toBe('Dépense — EDF');
    expect(referenceEventLabel({ typeCode: 'CLAIM', technicalLabel: null })).toBe('Sinistre');
  });
});
