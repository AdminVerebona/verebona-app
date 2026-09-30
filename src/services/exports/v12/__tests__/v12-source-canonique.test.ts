/**
 * CDC 15 X-02 (lot 16, volet B) — source canonique des dossiers V12 : champs
 * du bien (CanonicalAssetView, unités du registre), chemins de rattachement
 * des pièces (N-N puis repli colonnes), agenda D-14 / 4 états, rapport
 * d'écarts shadow sans valeur. Fonctions pures, sans base.
 */
import { describe, it, expect } from 'vitest';
import {
  isConfirmedAttachment, type AttachmentLink,
  canonicalAssetScalars, canonicalCharacteristics, documentPaths, exportsSourceMode, sameExportValue, traceOf,
  type CanonicalAssetScalars, type CanonicalDocumentRow,
} from '../data/canonical-source';
import { buildCanonicalAssetState, type AssetRowJson } from '@/services/canonical/asset-state';
import { REGISTRY_VERSION } from '@/services/canonical/registry';
import { isPastEvent, isUpcoming, eventSection, isUnconfirmedPastDeadline, buildDefaultChoices, planSelection, choicesFromLegacyOptions } from '../data/choices';
import { buildPreparation } from '../preparation/prepare';
import { mapDossierData } from '../data/mappers';
import { renderDossierHtml } from '../templates';
import { diffExportSources, eventBucket } from '../data/source-diff';
import { makeSource, event, doc, TODAY } from './fixtures/sources';

const ligne = (over: Partial<AssetRowJson> & { kc?: Record<string, unknown> }): AssetRowJson => {
  const { kc, ...rest } = over;
  return { id: 5, account_id: 9, category: 'IMMOBILIER', key_characteristics: JSON.stringify(kc ?? {}), ...rest } as AssetRowJson;
};
const VIDE: CanonicalAssetScalars = {
  purchaseDate: null, purchasePriceCents: null, warrantyEndDate: null, mileageOrHours: null, registrationNumber: null,
  dimensions: null, engineInfo: null, purchaseLocation: null, address: null, postalCode: null, city: null,
  generalCondition: null, objectCategory: null, description: null,
};

describe('commutateur EXPORTS_CANONICAL_SOURCE', () => {
  it('legacy par défaut, shadow, enabled ; valeur inconnue = legacy ; trace avec version du registre', () => {
    expect(exportsSourceMode({})).toBe('legacy');
    expect(exportsSourceMode({ EXPORTS_CANONICAL_SOURCE: 'shadow' })).toBe('shadow');
    expect(exportsSourceMode({ EXPORTS_CANONICAL_SOURCE: 'enabled' })).toBe('enabled');
    expect(exportsSourceMode({ EXPORTS_CANONICAL_SOURCE: 'on' })).toBe('legacy');
    expect(traceOf('enabled', 'canonical')).toEqual({ mode: 'enabled', source: 'canonical', registryVersion: REGISTRY_VERSION });
  });
});

describe('champs du bien — CanonicalAssetView', () => {
  it('la fiche fait foi (D-10) : acquisitionDate de la fiche plutôt que la colonne divergente', () => {
    const row = ligne({ purchase_date: '2019-01-01', kc: { acquisitionDate: '2021-05-25' } });
    const s = canonicalAssetScalars(buildCanonicalAssetState(row), { ...VIDE, purchaseDate: '2019-01-01' });
    expect(s.purchaseDate).toBe('2021-05-25');
  });
  it('repli colonne quand la fiche est vide ; alias historique lu sous sa clé', () => {
    const row = ligne({ category: 'VEHICULE', registration_number: 'AB-123-CD', mileage_or_hours: 1000, kc: { kilometrage: 45000 } });
    const s = canonicalAssetScalars(buildCanonicalAssetState(row), VIDE);
    expect(s.registrationNumber).toBe('AB-123-CD');
    expect(s.mileageOrHours).toBe(45000);
  });
  it('unités : acquisitionPrice en euros au registre → centimes exacts pour purchasePriceCents', () => {
    const s = canonicalAssetScalars(buildCanonicalAssetState(ligne({ kc: { acquisitionPrice: 12500.5 } })), VIDE);
    expect(s.purchasePriceCents).toBe(1250050);
    const col = canonicalAssetScalars(buildCanonicalAssetState(ligne({ purchase_price_cents: 990000 })), VIDE);
    expect(col.purchasePriceCents).toBe(990000);
  });
  it('champ sans clé dans la famille : valeur historique conservée (état d’un véhicule, kilométrage d’un objet)', () => {
    const s = canonicalAssetScalars(buildCanonicalAssetState(ligne({ category: 'VEHICULE', kc: {} })), { ...VIDE, generalCondition: 'BON', address: 'x' });
    expect(s.generalCondition).toBe('BON');
    expect(s.address).toBe('x');
    const o = canonicalAssetScalars(buildCanonicalAssetState(ligne({ category: 'OBJET', kc: { etat: 'NEUF' } })), { ...VIDE, mileageOrHours: 12 });
    expect(o.generalCondition).toBe('NEUF');
    expect(o.mileageOrHours).toBe(12);
  });
  it('caractéristiques : clés canoniques, alias et clés techniques retirés, clés libres gardées', () => {
    const row = ligne({ address: '1 rue X', kc: {
      adresse: '2 rue Y', surfaceHabitable: 90, 'acquisitionDate__origin': 'USER', acquisitionDate: '2021-05-25', parking: 'oui',
    } });
    const c = canonicalCharacteristics(row, buildCanonicalAssetState(row));
    expect(c).toMatchObject({ acquisitionDate: '2021-05-25', parking: 'oui', address1: '2 rue Y' });
    expect(c).not.toHaveProperty('adresse');
    expect(c).not.toHaveProperty('acquisitionDate__origin');
  });
});

describe('pièces — chemins de rattachement', () => {
  const d = (over: Partial<CanonicalDocumentRow>): CanonicalDocumentRow => ({
    id: 1, s3Key: null, s3Bucket: null, originalFilename: null, documentType: 'AUTRE', documentDate: null, description: null,
    retainedTitle: null, retainedFunctionCode: null, cilRubricCodes: null, mimeType: null, size: null, isWebLink: false,
    webLinkUrl: null, webLinkTitle: null, substructureId: null, equipmentId: null,
    assetId: null, linkedAssetId: null, linkedRoomId: null, hasLinkRows: false, ...over,
  });
  const ctx = (links: Array<[number, 'PRIMARY' | 'SECONDARY']> = []) => ({
    assetId: 5, links: new Map(links), roomIds: new Set([70]), equipmentIds: new Set([80]), substructureIds: new Set([90]),
  });
  it('lien N-N (SECONDARY compris) ; colonnes historiques en repli sans ligne de lien', () => {
    expect(documentPaths(d({ id: 1, hasLinkRows: true }), ctx([[1, 'SECONDARY']]))).toEqual(['link:SECONDARY']);
    expect(documentPaths(d({ assetId: 5 }), ctx())).toEqual(['column:asset_id']);
    expect(documentPaths(d({ linkedAssetId: 5 }), ctx())).toEqual(['column:linked_asset_id']);
    expect(documentPaths(d({ linkedRoomId: 70 }), ctx())).toEqual(['column:linked_room_id']);
    expect(documentPaths(d({ equipmentId: 80 }), ctx())).toEqual(['column:equipment_id']);
    expect(documentPaths(d({ substructureId: 90, hasLinkRows: true }), ctx())).toEqual(['column:substructure_id']);
  });
  it('lien retiré ou MENTIONED seul (non demandé) : la colonne ne repêche pas le document', () => {
    expect(documentPaths(d({ assetId: 5, hasLinkRows: true }), ctx())).toEqual([]);
    expect(documentPaths(d({ linkedAssetId: 6 }), ctx())).toEqual([]);
  });
});

describe('relecture lot 16 — rattachements confirmés pour un envoi à un tiers', () => {
  const ctx = { assetId: 5, substructureIds: new Set([90]), equipmentIds: new Set([80, 81]) };
  const lien = (over: Partial<AttachmentLink>): AttachmentLink => ({ role: 'SECONDARY', origin: 'AI', roomId: null, equipmentId: null, ...over });
  const sansCol = { assetId: null, equipmentId: null, substructureId: null };
  it('confirmés : asset_id, équipement (archivé compris) ou sous-structure, PRIMARY, USER, MIGRATION', () => {
    expect(isConfirmedAttachment({ ...sansCol, assetId: 5 }, [], ctx)).toBe(true);
    expect(isConfirmedAttachment({ ...sansCol, equipmentId: 81 }, [], ctx)).toBe(true);
    expect(isConfirmedAttachment({ ...sansCol, substructureId: 90 }, [], ctx)).toBe(true);
    expect(isConfirmedAttachment(sansCol, [lien({ role: 'PRIMARY' })], ctx)).toBe(true);
    expect(isConfirmedAttachment(sansCol, [lien({ origin: 'USER' })], ctx)).toBe(true);
    expect(isConfirmedAttachment(sansCol, [lien({ origin: 'MIGRATION' })], ctx)).toBe(true);
    expect(isConfirmedAttachment(sansCol, [lien({ origin: 'LEGACY_COLUMN', equipmentId: 80 })], ctx)).toBe(true);
  });
  it('non confirmés : SECONDARY AI, linked_asset_id, linked_room_id (même PRIMARY), repli colonnes', () => {
    expect(isConfirmedAttachment(sansCol, [lien({})], ctx)).toBe(false);
    expect(isConfirmedAttachment(sansCol, [lien({ origin: 'LEGACY_COLUMN' })], ctx)).toBe(false);
    expect(isConfirmedAttachment(sansCol, [lien({ origin: 'LEGACY_COLUMN', role: 'PRIMARY', roomId: 70 })], ctx)).toBe(false);
    expect(isConfirmedAttachment(sansCol, [lien({ role: 'PRIMARY', roomId: 70 })], ctx)).toBe(false);
    expect(isConfirmedAttachment(sansCol, [], ctx)).toBe(false);
  });
  it('préparation V12 : proposé DÉCOCHÉ avec la mention, jamais pré-coché ni repris par le tiroir historique', () => {
    const s = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      documents: [doc({ id: 1, kind: 'FACTURE', title: 'Facture confirmée' }), doc({ id: 2, kind: 'FACTURE', title: 'Facture liée', unconfirmedLink: true })],
    });
    const c = buildDefaultChoices('DOSSIER_COMPLET', s, { today: TODAY });
    const sel = (id: number) => c.items.find((i) => i.sourceType === 'document' && i.sourceId === id)?.selected ?? false;
    expect(sel(1)).toBe(true);
    expect(sel(2)).toBe(false);
    const p = buildPreparation('DOSSIER_COMPLET', s, { today: TODAY, lastGeneration: null });
    const it2 = p.sections.flatMap((x) => x.items).find((i) => i.key === 'document:2')!;
    expect(it2).toMatchObject({ selected: false, recommended: false });
    expect(it2.detail).toContain('Rattachement à confirmer');
    const tiroir = choicesFromLegacyOptions('DOSSIER_COMPLET', s, { customDocIds: [1, 2] }, { outputFormat: 'PDF', today: TODAY });
    expect(tiroir.items.filter((i) => i.sourceType === 'document').map((i) => i.sourceId)).toEqual([1]);
  });
  it('libellé « échéances passées à confirmer » seulement en source canonique', () => {
    const desc = (s: ReturnType<typeof makeSource>) => buildPreparation('DOSSIER_COMPLET', s, { today: TODAY, lastGeneration: null })
      .sections.find((x) => x.id === 'deadlines')!.description;
    expect(desc(makeSource('IMMOBILIER', 'DOSSIER_COMPLET'))).not.toContain('à confirmer');
    expect(desc(makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { sourceTrace: traceOf('shadow', 'legacy') }))).not.toContain('à confirmer');
    expect(desc(makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { sourceTrace: traceOf('enabled', 'canonical') }))).toContain('échéances passées à confirmer');
  });
});

describe('agenda — nature D-14 et statut à 4 états', () => {
  const ag = (over: Parameters<typeof event>[1]) => event(1, { key: 'agenda:1', source: 'agenda', category: null, status: null, ...over });
  it('historique inchangé sans statut canonique (legacy)', () => {
    expect(isPastEvent(ag({ title: 'x', date: '2025-01-01' }), TODAY)).toBe(true);
    expect(isUpcoming(ag({ title: 'x', date: '2027-01-01' }), TODAY)).toBe(true);
  });
  it('jamais d’échéance à venir tirée d’un fait historique', () => {
    const e = ag({ title: 'Achat', date: '2027-01-01', nature: 'HISTORICAL', status4: 'unknown' });
    expect(isUpcoming(e, TODAY)).toBe(false);
    expect(eventSection('DOSSIER_COMPLET', e, TODAY)).toBeNull();
    expect(isUpcoming(ag({ title: 'CT', date: '2027-01-01', nature: 'DEADLINE', status4: 'unknown' }), TODAY)).toBe(true);
  });
  it('historique : fait passé ou échéance réalisée ; échéance passée non prouvée exclue', () => {
    expect(isPastEvent(ag({ title: 'Achat', date: '2021-01-01', nature: 'HISTORICAL', status4: 'not_proven' }), TODAY)).toBe(true);
    expect(isPastEvent(ag({ title: 'CT', date: '2025-01-01', nature: 'DEADLINE', status4: 'completed', status: 'realise' }), TODAY)).toBe(true);
    expect(isPastEvent(ag({ title: 'CT', date: '2025-01-01', nature: 'DEADLINE', status4: 'not_proven' }), TODAY)).toBe(false);
    expect(isPastEvent(ag({ title: 'CT', date: '2025-01-01', nature: 'DEADLINE', status4: 'unknown' }), TODAY)).toBe(false);
  });
});

describe('arbitrage lot 16 : échéances passées « à confirmer » (dossier complet)', () => {
  const ag = (id: number, over: Parameters<typeof event>[1]) => event(id, { key: `agenda:${id}`, source: 'agenda', category: null, status: null, ...over });
  const source = () => makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
    events: [
      ag(1, { title: 'Contrôle chaudière', date: '2025-01-10', nature: 'DEADLINE', status4: 'not_proven' }),
      ag(2, { title: 'Ramonage', date: '2027-02-01', nature: 'DEADLINE', status4: 'unknown' }),
      ag(3, { title: 'Achat', date: '2021-05-25', nature: 'HISTORICAL', status4: 'not_proven' }),
      ag(4, { title: 'Vidange', date: '2025-03-01', nature: 'DEADLINE', status4: 'completed', status: 'realise' }),
    ],
  });
  it('proposée et pré-cochée dans « deadlines », rendue sous « Échéances passées à confirmer », jamais en historique', () => {
    const s = source();
    expect(isUnconfirmedPastDeadline(s.events[0], TODAY)).toBe(true);
    expect(eventSection('DOSSIER_COMPLET', s.events[0], TODAY)).toBe('deadlines');
    expect(eventSection('VENTE', s.events[0], TODAY)).toBeNull();
    const choices = buildDefaultChoices('DOSSIER_COMPLET', s, { today: TODAY });
    const plan = planSelection('DOSSIER_COMPLET', s, choices, TODAY);
    const meta = { reference: 'VBN-T', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 't' };
    const data = mapDossierData('DOSSIER_COMPLET', { source: s, plan, resolved: null, meta, today: TODAY }) as {
      history: Array<{ id: string }>; deadlines: Array<{ id: string }>; toConfirm?: Array<{ id: string }>;
    };
    expect(data.toConfirm?.map((e) => e.id)).toEqual(['agenda:1']);
    expect(data.deadlines.map((e) => e.id)).toEqual(['agenda:2']);
    expect(data.history.map((e) => e.id)).toEqual(['agenda:4']); // « Achat » (AUTRE) proposé, non pré-coché
    const html = renderDossierHtml('DOSSIER_COMPLET', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
    expect(html).toContain('Échéances passées à confirmer');
    expect(html).toContain('À confirmer');
    expect(html).not.toContain('En retard');
  });
  it('source historique : aucune rubrique « à confirmer »', () => {
    const s = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { events: [ag(1, { title: 'CT', date: '2025-01-10' })] });
    expect(isUnconfirmedPastDeadline(s.events[0], TODAY)).toBe(false);
    expect(eventSection('DOSSIER_COMPLET', s.events[0], TODAY)).toBe('history');
  });
});

describe('rapport d’écarts shadow — sans valeur', () => {
  it('champs, pièces présentes d’un seul côté (avec chemin), événements reclassés', () => {
    const legacy = makeSource('IMMOBILIER', 'DOSSIER_COMPLET');
    legacy.asset = { ...legacy.asset, purchaseDate: '2019-01-01', address: '1 rue Secrète', characteristics: { a: 1, 'x__origin': 'USER' } };
    legacy.documents = [doc({ id: 1, kind: 'FACTURE', title: 'A' }), doc({ id: 2, kind: 'FACTURE', title: 'B' })];
    legacy.events = [event(3, { key: 'agenda:3', source: 'agenda', title: 'CT', date: '2025-01-01', status: null })];
    const canonical = {
      ...legacy,
      asset: { ...legacy.asset, purchaseDate: '2021-05-25', characteristics: { a: '1', b: 2 } },
      documents: [legacy.documents[0], doc({ id: 7, kind: 'FACTURE', title: 'C' })],
      events: [{ ...legacy.events[0], nature: 'DEADLINE' as const, status4: 'not_proven' as const }],
    };
    const r = diffExportSources(legacy, canonical, { today: TODAY, documentPaths: { 7: ['link:SECONDARY'] }, unconfirmed: [7] });
    expect(r.fields).toEqual(['asset.purchaseDate', 'characteristics.b']);
    expect(r.documents).toEqual({
      onlyLegacy: [2], onlyCanonical: [{ id: 7, paths: ['link:SECONDARY'], confirmed: false }], addedInCanonical: { confirmed: 0, unconfirmed: 1 },
    });
    expect(r.events).toEqual([{ key: 'agenda:3', legacy: 'history', canonical: null }]);
    expect(r.total).toBe(5);
    const texte = JSON.stringify(r);
    expect(texte).not.toMatch(/2021-05-25|2019-01-01|Secrète/);
  });
  it('égalité tolérante (vide, nombre texte)', () => {
    expect(sameExportValue(null, '')).toBe(true);
    expect(sameExportValue(12, '12')).toBe(true);
    expect(sameExportValue('a', 'b')).toBe(false);
    expect(eventBucket(event(1, { title: 'x', date: '2020-01-01' }), TODAY)).toBe('history');
  });
});
