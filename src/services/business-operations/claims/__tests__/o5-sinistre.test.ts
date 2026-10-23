/**
 * Lot 44 — O5, Sinistre = Opération CLAIM : règles PURES encore en vigueur
 * après la refonte du lot 83D (CDC v5 §15–§18 ; arbitrages V-Q1, V-Q2, V-Q8).
 *
 * Lot 83D : O5-U01 (correspondance formulaire ↔ Opération), O5-U02 (statut
 * écrit par le formulaire), O5-U03 (seuil de migration), O5-U04 (miroir
 * `claim_json`) et O5-U09 (tâche de migration) sont RETIRÉS avec le
 * formulaire, la migration et le miroir — leur absence est prouvée par
 * `l83d-sinistres-v5.test.ts` (L83D-U01…). Restent :
 *
 *   O5-U02 C14.1 : statuts du dossier (libellés) ≠ statut de l'Opération
 *   O5-U05 Q4 : coût brut jamais diminué, net = brut − indemnité
 *   O5-U06 P09 : libellés sans terme technique
 *   O5-U07 export : choix du sinistre (payload), montants imprimés, empreinte
 *   O5-U08 export : alerte CLAIM_MISSING (lot 83D : établie par les documents)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimCosts, claimLabel, claimRecordLabel } from '../model';
import { CLAIM_FILE_STATUSES } from '../../model';
import { CLAIM_STATUS_OPTIONS } from '@/lib/assets/additional-infos';

describe('O5-U02 — C14.1 statut du dossier vs statut de l\'Opération (F-148, F-149, F-150, INV-FINAL-022/023)', () => {
  it('8 statuts de dossier, mêmes libellés pour le dossier d’assurance', () => {
    expect([...CLAIM_FILE_STATUSES]).toEqual(CLAIM_STATUS_OPTIONS.map((o) => o.value));
  });
});

describe('O5-U05 — Q4 indemnité : coût brut jamais diminué, net = brut − indemnité (F-159, F-160)', () => {
  it('composantes du sinistre (lot 83D, AC39 : la réparation reste DANS l’Opération CLAIM)', () => {
    expect(claimCosts([{ kind: 'REALIZED_COST', amountCents: 200000 }, { kind: 'REALIZED_COST', amountCents: 45000 }, { kind: 'INDEMNITY', amountCents: 120000 }]))
      .toMatchObject({ grossCents: 245000, indemnityCents: 120000, netCents: 125000, complete: true });
    expect(claimCosts([])).toMatchObject({ grossCents: 0, indemnityCents: 0, netCents: 0 });
  });
  it('lecture : plus de composantes d’intervention ENFANT additionnées (parent_operation_id plus lu)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/claims/read.ts'), 'utf8');
    expect(src).not.toMatch(/parent_operation_id/);
  });
});

describe('O5-U06 — P09 : libellés fonctionnels, jamais « Opération »', () => {
  it('libellé de liste', () => {
    expect(claimLabel({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12' })).toBe('Dégât des eaux · 12/03/2026');
    expect(claimLabel({ claimType: 'VOL' })).toBe('Vol ou cambriolage · date à préciser');
    expect(claimLabel({ occurredOn: '2026-03-12' })).toBe('Sinistre du 12/03/2026');
    expect(claimLabel({})).toBe('Sinistre sans date');
    expect(claimRecordLabel({ realizedDate: '2026-03-12', details: { claimType: 'INCENDIE' } as never })).toBe('Incendie · 12/03/2026');
  });
});

describe('O5-U07 — export Assurance-sinistre lu depuis le Sinistre', () => {
  it('choix du sinistre dans le payload (§17.2) : accepté pour le dossier sinistre seulement', async () => {
    const { parseChoicesPayload } = await import('@/services/exports/v12/data/choices');
    const ok = parseChoicesPayload('ASSURANCE_SINISTRE', { claimOperationId: 12 });
    expect(ok.ok && ok.choices.claimOperationId).toBe(12);
    expect(parseChoicesPayload('VENTE', { claimOperationId: 12 }).ok).toBe(false);
    expect(parseChoicesPayload('ASSURANCE_SINISTRE', { claimOperationId: -1 }).ok).toBe(false);
    const sans = parseChoicesPayload('ASSURANCE_SINISTRE', {});
    expect(sans.ok && 'claimOperationId' in sans.choices).toBe(false);
  });
  it('deux sinistres différents → deux générations (empreinte de la demande)', async () => {
    const { requestHash } = await import('@/services/exports/v12/generation/enqueue');
    const base = { outputFormat: 'PDF' as const };
    expect(requestHash('ASSURANCE_SINISTRE', { ...base, claimOperationId: 1 }, null)).not.toBe(requestHash('ASSURANCE_SINISTRE', { ...base, claimOperationId: 2 }, null));
    expect(requestHash('ASSURANCE_SINISTRE', base, null)).toBe(requestHash('ASSURANCE_SINISTRE', { ...base, claimOperationId: null }, null));
  });
  it('montant estimé et indemnité imprimés s\'ils sont présents, absents sinon', async () => {
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { renderDossierHtml } = await import('@/services/exports/v12/templates');
    const { claimFileOf, claimSourceOf, TODAY } = await import('@/services/exports/v12/__tests__/fixtures/sources');
    const META = { reference: 'R', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: null, templateLabel: '', zipName: null, label: '' };
    const rendu = (over: Parameters<typeof claimFileOf>[0]) => {
      const source = claimSourceOf(claimFileOf({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-08-03', ...over }));
      const plan = planSelection('ASSURANCE_SINISTRE', source, buildDefaultChoices('ASSURANCE_SINISTRE', source, { today: TODAY }), TODAY);
      const data = mapDossierData('ASSURANCE_SINISTRE', { source, plan, resolved: null, meta: META, today: TODAY }) as { claim: Record<string, unknown> };
      const html = renderDossierHtml('ASSURANCE_SINISTRE', data as never, { sys: 'S/', asset: () => null, stylesheets: [], pageMap: null }).html
        .replace(/<[^>]+>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
      return { data, html };
    };
    const avec = rendu({ estimatedDamageCents: 350000, compensationCents: 120000 });
    expect(avec.data.claim).toMatchObject({ estimatedDamage: expect.stringMatching(/3\s?500/), compensation: expect.stringMatching(/1\s?200/) });
    expect(avec.html).toMatch(/Dommages estimés 3 ?500/);
    expect(avec.html).toMatch(/Indemnité reçue 1 ?200/);
    const sans = rendu({});
    expect(sans.data.claim).toMatchObject({ estimatedDamage: null, compensation: null });
    expect(sans.html).not.toMatch(/Indemnité reçue/);
  });
  it('snapshot de génération : sinistre retenu figé', () => {
    const job = readFileSync(join(process.cwd(), 'src/services/exports/v12/generation/job.ts'), 'utf8');
    expect(job).toMatch(/claim: source\.claim \?\? null/);
    expect(job).toMatch(/claimOperationId = req\.choices\?\.claimOperationId \?\? req\.claimOperationId \?\? null/);
  });
});

describe('O5-U08 — alerte CLAIM_MISSING (lot 83D : le sinistre est établi par les documents)', () => {
  const base = {
    asset: { id: 1, category: 'IMMOBILIER', subtype: 'MAISON' }, premium: { allowed: true }, counts: { documents: 1, photos: 1 },
    cil: null, generations: [], additional: { commercial: {}, rental: {}, insurance: {} },
  };
  const hint = async (latestClaim: { claimType: string | null; occurredOn: string | null } | null, claims?: number) => {
    const { buildExportCatalog } = await import('@/services/exports/export-catalog.service');
    const c = buildExportCatalog({ ...base, claims, latestClaim });
    return c.dossiers.find((d) => d.code === 'ASSURANCE_SINISTRE')!.readiness.hints.find((h) => h.code === 'CLAIM_MISSING') ?? null;
  };
  it('aucun sinistre → invitation à ajouter ses documents (plus de rubrique « Sinistres »)', async () => {
    const h = await hint(null, 0);
    expect(h).toMatchObject({ target: 'documents', message: expect.stringMatching(/Aucun sinistre connu/) });
    expect(h!.message).not.toMatch(/rubrique/);
  });
  it('sinistre sans type ou sans date → signalé (non établi par les documents) ; complet → aucune alerte', async () => {
    // Lot 69 : seul le champ réellement absent est signalé (DIAG-S02).
    expect((await hint({ claimType: 'VOL', occurredOn: null }, 1))?.message).toBe('Date du sinistre non établie par vos documents pour une synthèse complète.');
    expect(await hint({ claimType: 'VOL', occurredOn: '2026-01-01' }, 1)).toBeNull();
  });
});
