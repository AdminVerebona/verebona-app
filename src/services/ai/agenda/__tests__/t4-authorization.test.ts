/**
 * CDC 15 T4-04 — autorisation de CRÉATION automatique par type documentaire
 * (DOCUMENT_CATALOG `mayCreateAgenda`) : toujours appliquée (lot 16b-2,
 * AI_T4_EFFECTS retiré — plus de mode legacy ni shadow).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { processAgendaCandidates, creationAuthorization, AUTHORIZED_CREATION_TYPES } from '../agenda-intelligence.service';

afterEach(() => vi.restoreAllMocks());

const cand = (over: Record<string, unknown> = {}) => ({
  title: 'Contrôle technique', date: '2027-05-12', confidence: 'certain' as const, excerpt: 'avant le 12/05/2027', ...over,
});
const run = (candidates: unknown[]) => processAgendaCandidates({
  accountId: 1, assetId: 3, candidates: candidates as never, existing: [], today: '2026-09-29',
});

describe('creationAuthorization', () => {
  it('catalogue : facture et certificat autorisés ; devis, annonce et inconnu refusés', () => {
    expect(creationAuthorization(cand({ documentType: 'FACTURE' }))).toMatchObject({ allowed: true });
    expect(creationAuthorization(cand({ documentType: 'CARTE_GRISE' }))).toMatchObject({ allowed: true });
    expect(creationAuthorization(cand({ documentType: 'DEVIS' }))).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });
    expect(creationAuthorization(cand({ documentType: 'ANNONCE_COMMERCIALE' }))).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });
    expect(creationAuthorization(cand({}))).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_UNKNOWN' });
    expect(creationAuthorization(cand({ documentType: 'XYZ' }))).toMatchObject({ allowed: false, reasonCode: 'SOURCE_TYPE_UNKNOWN' });
  });

  it('`mayCreateAgenda` porté par le candidat prime', () => {
    expect(creationAuthorization(cand({ documentType: 'DEVIS', mayCreateAgenda: true }))).toMatchObject({ allowed: true });
    expect(creationAuthorization(cand({ documentType: 'FACTURE', mayCreateAgenda: false }))).toMatchObject({ allowed: false });
  });

  it('AUTHORIZED_CREATION_TYPES dérivé du catalogue (lot 10 conservé)', () => {
    for (const t of ['CERTIFICAT_IMMATRICULATION', 'CARTE_GRISE', 'CONTRAT_ASSURANCE', 'AVIS_ECHEANCE', 'FACTURE', 'DPE']) {
      expect(AUTHORIZED_CREATION_TYPES.has(t), t).toBe(true);
    }
    expect(AUTHORIZED_CREATION_TYPES.has('DEVIS')).toBe(false);
  });
});

describe('processAgendaCandidates', () => {
  it('un devis ne crée pas d’échéance (proposition)', async () => {
    const [d] = await run([cand({ documentType: 'DEVIS' })]);
    expect(d).toMatchObject({ action: 'propose', reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED' });
  });

  it('source autorisée → création', async () => {
    const [d] = await run([cand({ documentType: 'FACTURE' })]);
    expect(d).toMatchObject({ action: 'create', reasonCode: 'EXPLICIT_DATE_AUTHORIZED_SOURCE' });
  });

  it('type documentaire inconnu : proposition, jamais de création', async () => {
    const [d] = await run([cand({})]);
    expect(d).toMatchObject({ action: 'propose', reasonCode: 'SOURCE_TYPE_UNKNOWN' });
  });

  it('les occurrences d’une récurrence d’une source refusée sont proposées, jamais créées', async () => {
    const decisions = await run([cand({
      title: 'Entretien chaudière', date: '2026-10-15', documentType: 'DEVIS',
      recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'yearly', interval: 1 },
    })]);
    expect(decisions.length).toBeGreaterThan(1);
    expect(decisions.some((d) => d.action === 'create')).toBe(false);
  });

  it('classification détaillée portée par la décision (T4-10)', async () => {
    const [d] = await run([cand({ documentType: 'FACTURE', originFieldKey: 'nextInspection' })]);
    expect(d.classification).toMatchObject({ category: 'action', source: 'registry', requiresQualification: false });
  });
});
