/**
 * Lot 44 — O5, refonte du Sinistre : règles PURES (CDC Opérations V1 ch. 15,
 * B14, C14, C14.1, C14.3 ; F-148 à F-160 ; décisions PO Q2, Q3, Q4, Q11).
 *
 *   O5-U01 correspondance formulaire ↔ Opération (aller-retour sans perte)
 *   O5-U02 C14.1 : statut dossier ≠ statut Opération ; seul « Clos » clôt
 *   O5-U03 C14.3 : seuil minimal de migration
 *   O5-U04 Q11 : sinistre recopié dans le miroir (le plus récent)
 *   O5-U05 Q4 : coût brut jamais diminué, net = brut − indemnité
 *   O5-U06 P09 : libellés sans terme technique
 *   O5-U07 export : choix du sinistre (payload), montants imprimés, empreinte
 *   O5-U08 export : alerte CLAIM_MISSING adaptée
 *   O5-U09 exploitation : tâche interne et bloc BO « Rattrapages »
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claimClosedFor, claimCosts, claimLabel, claimToSection, meetsClaimMigrationThreshold, pickMirrorClaim, sectionToClaimWrite,
  toClaimSummary, claimMigrationSourceKey, CLAIM_MIGRATION_VERSION, type ClaimRecord,
} from '../model';
import { CLAIM_FILE_STATUSES } from '../../model';
import { CLAIM_STATUS_OPTIONS } from '@/lib/assets/additional-infos';

function record(over: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    id: 12, accountId: 3, version: 4, status: 'REALIZED', realizedDate: '2026-03-12', closedAt: null,
    createdAt: '2026-03-13 10:00:00+00', updatedAt: '2026-03-14 10:00:00+00',
    assets: [{ assetId: 7, role: 'PRIMARY' }],
    details: {
      claimType: 'DEGAT_DES_EAUX', declaredOn: '2026-03-13', insurerClaimRef: 'SIN-88', insuranceContractOperationId: null,
      policyReferenceText: 'AU-778', status: 'EXPERTISE_PREVUE', statusDetail: 'Expert le 26/03', circumstances: 'Fuite du ballon',
      consequences: 'Plafond taché', measuresSummary: 'Eau coupée', exchangesSummary: null, estimatedDamageMinor: 420000, historyEventId: null,
    },
    lists: {
      damages: [{ itemKey: 'r1', zone: 'Cuisine', element: 'Plafond', finding: null, estimatedAmountMinor: 80000, fileIds: [5], photoIds: [9] }],
      actions: [{ itemKey: 'r2', date: '2026-03-12', endDate: null, status: 'REALISEE', title: 'Séchage', detail: null, performedBy: 'Vous', invoiceFileId: 5, childOperationId: 40 }],
      exchanges: [{ itemKey: 'r3', date: '2026-03-14', party: 'EXPERT', channel: 'COURRIER', direction: 'RECU', summary: 'Convocation', documentFileId: null }],
    },
    indemnityCents: 100000,
    costs: { grossCents: 0, indemnityCents: 100000, netCents: -100000 },
    agendaItemId: 34,
    contractLabel: null,
    origin: { form: true, migration: false, documents: 0 },
    ...over,
  };
}

describe('O5-U01 — formulaire ↔ Opération CLAIM (C14 : tableau de correspondance)', () => {
  it('sous-rubrique complète, forme du lot 43 (claimEventKey agenda, indemnité, listes avec leurs identifiants)', () => {
    const s = claimToSection(record());
    expect(s).toEqual({
      claimEventKey: 'agenda:34', claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', declaredOn: '2026-03-13', insurerClaimRef: 'SIN-88',
      policyReference: 'AU-778', status: 'EXPERTISE_PREVUE', statusDetail: 'Expert le 26/03', circumstances: 'Fuite du ballon',
      consequences: 'Plafond taché', measures: 'Eau coupée', estimatedDamageCents: 420000, compensationCents: 100000,
      damages: [{ id: 'r1', zone: 'Cuisine', element: 'Plafond', estimatedAmountCents: 80000, photoIds: [9], documentIds: [5] }],
      actions: [{ id: 'r2', date: '2026-03-12', status: 'REALISEE', title: 'Séchage', performedBy: 'Vous', invoiceDocumentId: 5 }],
      exchanges: [{ id: 'r3', date: '2026-03-14', direction: 'RECU', party: 'EXPERT', channel: 'COURRIER', summary: 'Convocation' }],
    });
  });

  it('aller-retour : la sous-rubrique redonne les mêmes détails, dates, montants et listes (F-153, F-154 : une ligne n\'est pas une Opération)', () => {
    const w = sectionToClaimWrite(claimToSection(record()));
    expect(w.occurredOn).toBe('2026-03-12');
    expect(w.compensationCents).toBe(100000);
    expect(w.claimEventKey).toBe('agenda:34');
    expect(w.details).toMatchObject({ claimType: 'DEGAT_DES_EAUX', declaredOn: '2026-03-13', insurerClaimRef: 'SIN-88', policyReferenceText: 'AU-778', status: 'EXPERTISE_PREVUE', measuresSummary: 'Eau coupée', estimatedDamageMinor: 420000 });
    expect(w.lists.damages).toEqual(record().lists.damages);
    // L'enfant (C14.2) est recalculé à l'écriture, jamais pris du formulaire.
    expect(w.lists.actions).toEqual([{ ...record().lists.actions[0], childOperationId: null }]);
    expect(w.lists.exchanges).toEqual(record().lists.exchanges);
  });

  it('événement de l\'historique (`history_event_id`) → `event:N` ; aucun lien → pas de clé', () => {
    const r = record({ agendaItemId: null, details: { ...record().details!, historyEventId: 77 } });
    expect(claimToSection(r).claimEventKey).toBe('event:77');
    expect(claimToSection(record({ agendaItemId: null })).claimEventKey).toBeUndefined();
  });

  it('valeur hors référentiel (document) : jamais rendue au formulaire ni au dossier', () => {
    const s = claimToSection(record({ details: { ...record().details!, claimType: 'TYPE_INVENTE' } }));
    expect(s.claimType).toBeUndefined();
  });
});

describe('O5-U02 — C14.1 statut du dossier vs statut de l\'Opération (F-148, F-149, F-150, INV-FINAL-022/023)', () => {
  it('8 statuts de dossier, ceux du formulaire historique', () => {
    expect([...CLAIM_FILE_STATUSES]).toEqual(CLAIM_STATUS_OPTIONS.map((o) => o.value));
  });
  it('seul « Clos » renseigne closed_at ; Refusé et Indemnisé restent ouverts', () => {
    expect(CLAIM_FILE_STATUSES.filter((s) => claimClosedFor(s))).toEqual(['CLOS']);
    expect(claimClosedFor(null)).toBe(false);
  });
  it('l\'écriture force REALIZED (jamais CANCELLED pour un sinistre arrivé)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/consolidation/claim-form.ts'), 'utf8');
    expect(src).toMatch(/if \(op\.status !== 'REALIZED'\) changes\.track\(await repo\.setStatus\(claimId, 'REALIZED'/);
    expect(src).not.toMatch(/'CANCELLED'/);
  });
});

describe('O5-U03 — C14.3 seuil minimal de création', () => {
  it.each([
    [{ claimType: 'VOL' }, true],
    [{ occurredOn: '2026-01-01' }, true],
    [{ declaredOn: '2026-01-02' }, true],
    [{ insurerClaimRef: 'S-1' }, true],
    [{ policyReference: 'AU-1' }, true],
    [{ estimatedDamageCents: 0 }, true],
    [{ compensationCents: 1000 }, true],
    [{ circumstances: 'Rayure', damages: [{ id: 'r1', zone: 'Porte' }] }, false],
    [{}, false],
  ])('%o → %s', (s, attendu) => {
    expect(meetsClaimMigrationThreshold(s as never)).toBe(attendu);
  });
  it('un événement lié daté compte comme une date', () => {
    expect(meetsClaimMigrationThreshold({ claimEventKey: 'agenda:3' }, '2026-02-02')).toBe(true);
  });
  it('clé stable de la source MIGRATION (compte × bien × champ × version, C23.1)', () => {
    expect(claimMigrationSourceKey(3, 7)).toBe(`claim_json:${CLAIM_MIGRATION_VERSION}:a3:b7`);
  });
});

describe('O5-U04 — Q11 miroir : le sinistre le plus récent du bien', () => {
  it('survenue la plus récente ; sans date, la création ; égalité → le plus récent créé', () => {
    const a = { id: 1, realizedDate: '2025-01-01', createdAt: '2026-05-01 00:00:00+00' };
    const b = { id: 2, realizedDate: '2026-02-01', createdAt: '2026-02-02 00:00:00+00' };
    const c = { id: 3, realizedDate: null, createdAt: '2026-09-01 00:00:00+00' };
    expect(pickMirrorClaim([a, b])?.id).toBe(2);
    expect(pickMirrorClaim([a, b, c])?.id).toBe(3);
    expect(pickMirrorClaim([b, { ...b, id: 5 }])?.id).toBe(5);
    expect(pickMirrorClaim([])).toBeNull();
  });
});

describe('O5-U05 — Q4 indemnité : coût brut jamais diminué, net = brut − indemnité (F-159, F-160)', () => {
  it('composantes du sinistre et de ses interventions', () => {
    expect(claimCosts([{ kind: 'REALIZED_COST', amountCents: 200000 }, { kind: 'REALIZED_COST', amountCents: 45000 }, { kind: 'INDEMNITY', amountCents: 120000 }]))
      .toMatchObject({ grossCents: 245000, indemnityCents: 120000, netCents: 125000, complete: true });
    expect(claimCosts([])).toMatchObject({ grossCents: 0, indemnityCents: 0, netCents: 0 });
  });
  it('l\'indemnité saisie est une composante INDEMNITY : attribuée au bien d\'un sinistre mono-bien, globale sinon', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/consolidation/claim-form.ts'), 'utf8');
    expect(src).toMatch(/kind: 'INDEMNITY'/);
    expect(src).toMatch(/targetAssetId: assetIds\.length === 1 \? assetIds\[0\] : null/);
  });
});

describe('O5-U06 — P09 : libellés fonctionnels, jamais « Opération »', () => {
  it('libellé de liste', () => {
    expect(claimLabel({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12' })).toBe('Dégât des eaux · 12/03/2026');
    expect(claimLabel({ claimType: 'VOL' })).toBe('Vol ou cambriolage · date à préciser');
    expect(claimLabel({ occurredOn: '2026-03-12' })).toBe('Sinistre du 12/03/2026');
    expect(claimLabel({})).toBe('Sinistre sans date');
  });
  it('résumé : autres biens concernés, provenance documentaire, clôture', () => {
    const r = record({ assets: [{ assetId: 7, role: 'PRIMARY' }, { assetId: 8, role: 'CONCERNED' }], closedAt: '2026-04-01', origin: { form: true, migration: false, documents: 2 } });
    const s = toClaimSummary(r, 7, new Map([[8, 'Garage']]));
    expect(s).toMatchObject({ id: 12, otherAssets: [{ id: 8, name: 'Garage' }], documented: true, closed: true, compensationCents: 100000 });
    expect(JSON.stringify(s)).not.toMatch(/Op[ée]ration/);
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
    const { makeSource, TODAY } = await import('@/services/exports/v12/__tests__/fixtures/sources');
    const META = { reference: 'R', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: null, templateLabel: '', zipName: null, label: '' };
    const rendu = (claim: Record<string, unknown>) => {
      const source = makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', { additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: claim as never, updatedAt: null } });
      const plan = planSelection('ASSURANCE_SINISTRE', source, buildDefaultChoices('ASSURANCE_SINISTRE', source, { today: TODAY }), TODAY);
      const data = mapDossierData('ASSURANCE_SINISTRE', { source, plan, resolved: null, meta: META, today: TODAY }) as { claim: Record<string, unknown> };
      const html = renderDossierHtml('ASSURANCE_SINISTRE', data as never, { sys: 'S/', asset: () => null, stylesheets: [], pageMap: null }).html
        .replace(/<[^>]+>/g, ' ').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
      return { data, html };
    };
    const avec = rendu({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-08-03', estimatedDamageCents: 350000, compensationCents: 120000 });
    expect(avec.data.claim).toMatchObject({ estimatedDamage: expect.stringMatching(/3\s?500/), compensation: expect.stringMatching(/1\s?200/) });
    expect(avec.html).toMatch(/Dommages estimés 3 ?500/);
    expect(avec.html).toMatch(/Indemnité reçue 1 ?200/);
    const sans = rendu({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-08-03' });
    expect(sans.data.claim).toMatchObject({ estimatedDamage: null, compensation: null });
    expect(sans.html).not.toMatch(/Indemnité reçue/);
  });
  it('snapshot de génération : sinistre retenu figé avec sa sous-rubrique', () => {
    const job = readFileSync(join(process.cwd(), 'src/services/exports/v12/generation/job.ts'), 'utf8');
    expect(job).toMatch(/claim: source\.claim \?\? null/);
    expect(job).toMatch(/claimOperationId = req\.choices\?\.claimOperationId \?\? req\.claimOperationId \?\? null/);
  });
});

describe('O5-U08 — alerte CLAIM_MISSING adaptée', () => {
  const base = {
    asset: { id: 1, category: 'IMMOBILIER', subtype: 'MAISON' }, premium: { allowed: true }, counts: { documents: 1, photos: 1 },
    cil: null, generations: [],
  };
  const hint = async (claim: Record<string, unknown>, claims?: number) => {
    const { buildExportCatalog } = await import('@/services/exports/export-catalog.service');
    const c = buildExportCatalog({ ...base, additional: { commercial: {}, rental: {}, insurance: {}, claim: claim as never }, claims });
    return c.dossiers.find((d) => d.code === 'ASSURANCE_SINISTRE')!.readiness.hints.find((h) => h.code === 'CLAIM_MISSING')?.message ?? null;
  };
  it('aucun sinistre ni ancienne saisie → invitation à l\'ajouter dans la fiche', async () => {
    expect(await hint({}, 0)).toMatch(/Aucun sinistre renseigné/);
  });
  it('sinistre sans type ou sans date → à compléter ; complet → aucune alerte', async () => {
    expect(await hint({ claimType: 'VOL' }, 1)).toMatch(/Type et date du sinistre/);
    expect(await hint({ claimType: 'VOL', occurredOn: '2026-01-01' }, 1)).toBeNull();
  });
});

describe('O5-U09 — exploitation : migration automatique, sans commande', () => {
  it('tâche interne « operations-claim-migration » toutes les heures', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(findTask('operations-claim-migration')).toMatchObject({ schedule: { kind: 'interval' } });
  });
  it('bloc BO « Rattrapages » : simulation et application, filtre compte, synthèse', async () => {
    const { backfillDefinition } = await import('@/services/admin/ops/backfill/definitions');
    expect(backfillDefinition('operations-claims')).toMatchObject({ actions: ['simulate', 'apply'], accountFilter: true, order: 7 });
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const s = summarizeBackfill('operations-claims', 'simulate', null, {
      result: { mode: 'simulate', version: CLAIM_MIGRATION_VERSION, scanned: 3, processed: 3, failed: [], more: false, changes: 9,
        outcomes: { CREATED: 1, MATCHED: 1, BELOW_THRESHOLD: 1 }, holds: [{ assetId: 4, accountId: 2, outcome: 'BELOW_THRESHOLD', reason: 'BELOW_THRESHOLD' }] },
    });
    expect(s.headline).toMatch(/Simulation : 3 bien\(s\) examiné\(s\) sur 3, 1 sinistre\(s\) à créer, 1 rapproché\(s\)/);
    expect(s.ambiguous.count).toBe(1);
  });
  it('migration 0323 dans les numéros réservés, idempotente', () => {
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0323_claim_operations.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS history_event_id/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS business_operation_claim_migration_marks/);
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });
});
