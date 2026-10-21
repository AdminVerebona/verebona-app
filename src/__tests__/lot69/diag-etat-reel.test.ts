/**
 * Lot 69 — « Supprimer les diagnostics et exemples codés en dur qui se
 * substituent à l'état réel » (tests DIAG-xx).
 *
 * Chaque test part d'un ÉTAT STRUCTURÉ (blocs CIL, champs du sinistre,
 * équipements, composants d'adresse, erreur PostgreSQL…) et vérifie que le
 * message produit correspond exactement à cet état — jamais une chaîne fixe
 * unique (l'ancien test figeait « (B1, B3, B8) »).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const { isBlockBlocking, evaluateCilB6 } = await import('@/services/exports/cil-preparation.service');
const { cilBlockingMessage, cilActionRequiredMessage, CIL_BLOCKING_BLOCK_IDS } = await import('@/lib/exports/cil-blocking');
const { buildPreparation } = await import('@/services/exports/v12/preparation/prepare');
const { blockedReason } = await import('@/components/exports/preparation/PreparationSummary');
const { initialPrepState } = await import('@/lib/exports/preparation-state');
const { buildExportCatalog } = await import('@/services/exports/export-catalog.service');
const { claimMissingKeyFields, claimMissingKeyFieldsMessage } = await import('@/services/business-operations/claims/model');
const { classifyCilEnergyEquipment } = await import('@/lib/cil/energy-equipment');
const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
const { renderDossierHtml } = await import('@/services/exports/v12/templates');
const { listMissingPreviewData, missingAddressMessage } = await import('@/services/admin/export-preview.service');
const { diagnoseDatabaseError, extractUndefinedObject } = await import('@/lib/database-diagnostic');
const { expenseCompletionHint } = await import('@/services/verebona-assistant/canonical/structured-answers');
const { tenureSituationHint } = await import('@/lib/assets/tenure-end');
const { schemaNotReadyMessage } = await import('@/lib/schema-readiness-log');
const { makeSource, TODAY } = await import('@/services/exports/v12/__tests__/fixtures/sources');

import type { CilBlock, CilReadiness, CilEquipmentRow } from '@/services/exports/cil-preparation.service';
import type { ExportSource, SourceEquipment } from '@/services/exports/v12/data/source';
import type { CilData } from '@/services/exports/v12/types';

// ── Fabrique d'état CIL (mêmes statuts que `evaluateCilReadiness`) ────────

const LABELS: Record<string, string> = {
  B1: 'Identification du logement', B3: 'Plans et coupes', B4: 'Réseaux', B5: 'Matériaux à incidence énergétique',
  B6: 'Équipements à incidence énergétique', B7: 'Travaux de rénovation énergétique', B8: 'Documents de performance énergétique', B9: 'Documents annexes',
};

/** `missing` : blocs de la règle (B1, B3, B8) réellement à compléter ; les autres sont complets. */
function readinessFor(missing: string[], extra: Partial<CilReadiness> = {}): CilReadiness {
  const blocks: CilBlock[] = ['B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map((id) => {
    const manque = missing.includes(id);
    return {
      id, label: LABELS[id], status: manque ? 'missing' : 'complete',
      blocking: id === 'B1' || id === 'B8' ? true : id === 'B3' ? manque : false,
      missingItems: [],
    };
  });
  const blockingBlocks = blocks.filter(isBlockBlocking);
  return {
    globalStatus: blockingBlocks.length ? 'action_required' : 'ready',
    completion: { resolvedBlocks: 8 - blockingBlocks.length, applicableBlocks: 8, totalBlocks: 8, percentage: 50 },
    blocks, blockingBlocks, ...extra,
  };
}

function cilSource(readiness: CilReadiness, over: Partial<ExportSource> = {}): ExportSource {
  return makeSource('IMMOBILIER', 'CIL', {
    cil: { readiness, profile: null, materials: [], works: [], resolutions: [] },
    ...over,
  });
}

const CATALOG_BASE = {
  asset: { id: 1, category: 'IMMOBILIER', subtype: 'MAISON' }, premium: { allowed: true }, counts: { documents: 1, photos: 1 },
  additional: { commercial: {}, rental: {}, insurance: {}, claim: {} }, generations: [],
};

/** Les trois surfaces qui affichent le blocage : préparation (desktop et mobile : même `blockedReason`), catalogue, refus API. */
function cilMessages(missing: string[]) {
  const readiness = readinessFor(missing);
  const prep = buildPreparation('CIL', cilSource(readiness), { today: TODAY, lastGeneration: null });
  const reason = blockedReason({ ...initialPrepState, status: 'ready_pristine' as never, prep });
  const catalog = buildExportCatalog({
    ...CATALOG_BASE,
    cil: { globalStatus: readiness.globalStatus, percentage: 50, blockingBlocks: readiness.blockingBlocks.map((b) => ({ id: b.id, label: b.label })) },
  } as never);
  const hint = catalog.dossiers.find((d) => d.code === 'CIL')!.readiness.hints.find((h) => h.code === 'CIL_ACTION_REQUIRED')?.message ?? null;
  return { prep, reason, hint, api: readiness.blockingBlocks.length ? cilActionRequiredMessage(readiness.blockingBlocks) : null };
}

describe('DIAG-C — CIL : message construit sur les blocs réellement bloquants', () => {
  it('règle métier inchangée : B1, B3, B8 sont les blocs POUVANT bloquer', () => {
    expect([...CIL_BLOCKING_BLOCK_IDS]).toEqual(['B1', 'B3', 'B8']);
  });

  it('DIAG-C01 — B1 seul manquant', () => {
    const m = cilMessages(['B1']);
    expect(m.prep.cil!.blockingBlocks).toEqual([{ id: 'B1', label: 'Identification du logement' }]);
    expect(m.reason).toBe('Identification du logement à compléter avant de générer le CIL.');
    expect(m.hint).toBe(m.reason);
    expect(m.api).toBe('Le CIL ne peut pas encore être généré : le bloc « Identification du logement » est à compléter.');
    expect(m.prep.eligibility.message).toBe(m.api);
  });

  it('DIAG-C02 — B3 seul manquant', () => {
    const m = cilMessages(['B3']);
    expect(m.prep.cil!.blockingBlocks.map((b) => b.id)).toEqual(['B3']);
    expect(m.reason).toBe('Plans et coupes à compléter avant de générer le CIL.');
    expect(m.hint).toBe(m.reason);
    expect(m.api).not.toMatch(/Identification|performance/);
  });

  it('DIAG-C03 — B8 seul manquant', () => {
    const m = cilMessages(['B8']);
    expect(m.reason).toBe('Documents de performance énergétique à compléter avant de générer le CIL.');
    expect(m.api).toBe('Le CIL ne peut pas encore être généré : le bloc « Documents de performance énergétique » est à compléter.');
  });

  it('DIAG-C04 — B1 + B3', () => {
    const m = cilMessages(['B1', 'B3']);
    expect(m.reason).toBe('Identification du logement et Plans et coupes sont à compléter avant de générer le CIL.');
    expect(m.hint).toBe(m.reason);
    expect(m.api).toBe('Le CIL ne peut pas encore être généré : les blocs « Identification du logement » et « Plans et coupes » sont à compléter.');
    expect(m.reason).not.toMatch(/performance/);
  });

  it('DIAG-C05 — B3 + B8', () => {
    const m = cilMessages(['B3', 'B8']);
    expect(m.reason).toBe('Plans et coupes et Documents de performance énergétique sont à compléter avant de générer le CIL.');
    expect(m.reason).not.toMatch(/Identification/);
  });

  it('DIAG-C06 — aucun bloc manquant : aucun message de blocage', () => {
    const m = cilMessages([]);
    expect(m.prep.cil!.globalStatus).toBe('ready');
    expect(m.prep.cil!.blockingBlocks).toEqual([]);
    expect(m.reason).toBeNull();
    expect(m.hint).toBeNull();
    expect(m.prep.eligibility).toEqual({ status: 'ready', message: null });
    expect(cilBlockingMessage([])).toBeNull();
  });

  it('DIAG-C07 — les trois blocs : liste réelle complète (et jamais la chaîne « (B1, B3, B8) »)', () => {
    const m = cilMessages(['B1', 'B3', 'B8']);
    expect(m.reason).toBe('Identification du logement, Plans et coupes et Documents de performance énergétique sont à compléter avant de générer le CIL.');
    for (const s of [m.reason, m.hint, m.api]) expect(s).not.toContain('B1, B3, B8');
  });

  it('DIAG-C08 — B3 non applicable : jamais cité, même s’il fait partie de la règle', () => {
    const r = readinessFor(['B1']);
    const b3 = r.blocks.find((b) => b.id === 'B3')!;
    b3.status = 'not_applicable'; b3.blocking = false;
    r.blockingBlocks = r.blocks.filter(isBlockBlocking);
    expect(cilBlockingMessage(r.blockingBlocks)).toBe('Identification du logement à compléter avant de générer le CIL.');
  });

  it('DIAG-C09 — DTO sans `blockingBlocks` (réponse antérieure) : repli sur les blocs qui bloquent réellement', () => {
    const prep = buildPreparation('CIL', cilSource(readinessFor(['B8'])), { today: TODAY, lastGeneration: null });
    const ancien = { ...prep, cil: { ...prep.cil!, blockingBlocks: undefined as never } };
    expect(blockedReason({ ...initialPrepState, status: 'ready_pristine' as never, prep: ancien })).toBe('Documents de performance énergétique à compléter avant de générer le CIL.');
  });
});

// ── Sinistre ─────────────────────────────────────────────────────────────

describe('DIAG-S — sinistre : champs réellement absents', () => {
  const hint = (claim: Record<string, unknown>) => {
    const c = buildExportCatalog({ ...CATALOG_BASE, cil: null, claims: 1, additional: { ...CATALOG_BASE.additional, claim } } as never);
    return c.dossiers.find((d) => d.code === 'ASSURANCE_SINISTRE')!.readiness.hints.find((h) => h.code === 'CLAIM_MISSING')?.message ?? null;
  };
  it('DIAG-S01 — type absent, date connue → seul le type est demandé', () => {
    expect(claimMissingKeyFields({ occurredOn: '2026-03-12' })).toEqual(['claimType']);
    expect(hint({ occurredOn: '2026-03-12' })).toBe('Type du sinistre à renseigner pour une synthèse complète.');
  });
  it('DIAG-S02 — type connu, date absente → seule la date est demandée', () => {
    expect(claimMissingKeyFields({ claimType: 'DEGAT_DES_EAUX' })).toEqual(['occurredOn']);
    expect(hint({ claimType: 'DEGAT_DES_EAUX' })).toBe('Date du sinistre à renseigner pour une synthèse complète.');
  });
  it('DIAG-S03 — type et date absents → les deux', () => {
    expect(hint({ declaredOn: '2026-03-14' })).toBe('Type et date du sinistre à renseigner pour une synthèse complète.');
    expect(claimMissingKeyFieldsMessage(['claimType', 'occurredOn'])).toBe('Type et date du sinistre à renseigner.');
  });
  it('DIAG-S04 — les deux présents → aucun avertissement correspondant', () => {
    expect(claimMissingKeyFields({ claimType: 'VOL', occurredOn: '2026-01-01' })).toEqual([]);
    expect(hint({ claimType: 'VOL', occurredOn: '2026-01-01' })).toBeNull();
    expect(claimMissingKeyFieldsMessage([])).toBeNull();
  });
});

// ── B6 : règle partagée, préparation = rendu ────────────────────────────

const equip = (id: number, over: Partial<SourceEquipment>): SourceEquipment => ({
  id, name: `Équipement ${id}`, type: null, category: null, brand: null, model: null, energyType: null, ...over,
});

/**
 * Préparation (évaluation B6 réelle, `evaluateCilB6`) puis rendu (mappeur +
 * template). Retourne les deux pour comparer.
 */
function b6Chain(list: SourceEquipment[], opts: { withIds?: boolean } = { withIds: true }) {
  const rows: CilEquipmentRow[] = list.map((e) => ({ id: e.id, type: e.type, category: e.category, energyType: e.energyType }));
  const prep = evaluateCilB6(rows, undefined);
  const base = readinessFor([]);
  base.blocks = base.blocks.map((b) => (b.id === 'B6' ? prep.block : b));
  if (opts.withIds) base.energyEquipmentIds = prep.energyEquipmentIds;
  const source = cilSource(base, { equipments: list });
  const plan = planSelection('CIL', source, buildDefaultChoices('CIL', source, { today: TODAY }), TODAY);
  const meta = { reference: 'VBN-TEST-69', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: null, templateLabel: 't', zipName: null, label: 'T' };
  const data = mapDossierData('CIL', { source, plan, resolved: null, meta, today: TODAY }) as CilData;
  const html = renderDossierHtml('CIL', data as never, { sys: 'SYS/', asset: () => null, stylesheets: [], pageMap: null }).html;
  const b6Block = data.cil.blocks.find((b) => b.code === 'B6')!;
  const rendered = (data.cil.equipments ?? []).map((r) => r.equipment);
  // Préparation (DTO) : même statut B6.
  const dto = buildPreparation('CIL', source, { today: TODAY, lastGeneration: null }).cil!.blocks.find((b) => b.id === 'B6')!;
  return { prep, b6Block, rendered, html, dto };
}

const namesOf = (list: SourceEquipment[], ids: number[]) => list.filter((e) => ids.includes(e.id)).map((e) => e.name);

describe('DIAG-B6 — équipements à incidence énergétique (données structurées, aucun repli)', () => {
  it('DIAG-B6-01 — chauffage structuré → B6 renseigné, préparation = rendu', () => {
    const list = [equip(1, { name: 'Chaudière', category: 'CHAUFFAGE' })];
    const c = b6Chain(list);
    expect(c.prep.block.status).toBe('complete');
    expect(c.b6Block.status).toBe('complete');
    expect(c.dto.status).toBe('complete');
    expect(c.rendered).toEqual(namesOf(list, c.prep.energyEquipmentIds));
    expect(c.b6Block.source).toBe('1 équipement');
  });

  it('DIAG-B6-02 — VMC structurée (type du référentiel) → B6 renseigné', () => {
    const list = [equip(2, { name: 'Ventilo cuisine', type: 'VMC double flux' })];
    const c = b6Chain(list);
    expect(classifyCilEnergyEquipment(list[0])).toEqual({ usage: 'ventilation', basis: 'type' });
    expect(c.prep.block.status).toBe('complete');
    expect(c.rendered).toEqual(['Ventilo cuisine']);
  });

  it('DIAG-B6-03 — équipement non énergétique uniquement → B6 non renseigné, rien au PDF', () => {
    const list = [equip(3, { name: 'TV salon', type: 'Téléviseur' })];
    const c = b6Chain(list);
    expect(c.prep.block.status).toBe('unknown');
    expect(c.prep.block.missingItems.map((i) => i.id)).toEqual(['equipments_unclassified']);
    expect(c.b6Block.status).toBe('unknown');
    expect(c.dto.status).toBe('unknown');
    expect(c.rendered).toEqual([]);
    expect(c.b6Block.source).toBeNull();
    expect(c.html).not.toContain('TV salon');
  });

  it('DIAG-B6-04 — plusieurs équipements dont un énergétique → seul le périmètre pertinent alimente B6', () => {
    const list = [
      equip(4, { name: 'Portail motorisé', type: 'Portail' }),
      equip(5, { name: 'Chaudière gaz', type: 'Chaudière gaz à condensation', energyType: 'GAZ' }),
      equip(6, { name: 'Lave-linge', type: 'Électroménager' }),
    ];
    const c = b6Chain(list);
    expect(c.prep.energyEquipmentIds).toEqual([5]);
    expect(c.rendered).toEqual(['Chaudière gaz']);
    expect(c.b6Block.source).toBe('1 équipement');
    expect(c.html).not.toContain('Portail motorisé');
    expect(c.html).not.toContain('Lave-linge');
  });

  it('DIAG-B6-05 — nom ambigu mais correctement catégorisé : seules les données structurées comptent', () => {
    const list = [
      equip(7, { name: 'Bidule du grenier', category: 'EQUIPEMENT_VENTILATION' }),
      // Nom « énergétique » mais type structuré non énergétique : exclu (le nom n'est pas lu).
      equip(8, { name: 'Radiateur décoratif (sculpture)', type: 'Décoration' }),
    ];
    const c = b6Chain(list);
    expect(c.prep.energyEquipmentIds).toEqual([7]);
    expect(c.rendered).toEqual(['Bidule du grenier']);
  });

  it('DIAG-B6-06 — aucun équipement classifiable → aucun repli vers tous les équipements', () => {
    const list = [
      equip(9, { name: 'Chauffage d’appoint' }), // nom seul, aucune donnée structurée : jamais suffisant
      equip(10, { name: 'Alarme', type: 'Sécurité' }),
    ];
    const c = b6Chain(list);
    expect(c.prep.energyEquipmentIds).toEqual([]);
    expect(c.prep.block.status).toBe('unknown');
    expect(c.rendered).toEqual([]);
    // Même résultat quand le mappeur réapplique la règle (état sans liste d'identifiants).
    expect(b6Chain(list, { withIds: false }).rendered).toEqual([]);
  });

  it('DIAG-B6-07 — état sans liste d’identifiants : le mappeur réapplique LA MÊME règle', () => {
    const list = [equip(11, { name: 'PAC', type: 'Pompe à chaleur air/eau' }), equip(12, { name: 'Box', type: 'Box internet' })];
    expect(b6Chain(list, { withIds: false }).rendered).toEqual(b6Chain(list).rendered);
    expect(b6Chain(list).rendered).toEqual(['PAC']);
  });

  it('DIAG-B6-08 — caractéristique CIL propre aux équipements énergétiques (énergie utilisée) suffit ; marque seule non', () => {
    expect(classifyCilEnergyEquipment({ energyType: 'BOIS' })).toEqual({ usage: null, basis: 'cil_specs' });
    expect(classifyCilEnergyEquipment({ heatNetworkDeliveryStation: 'SST-12' })).toEqual({ usage: 'chauffage', basis: 'cil_specs' });
    expect(classifyCilEnergyEquipment({ type: null, category: null })).toBeNull();
    expect(classifyCilEnergyEquipment({ type: 'Pacman arcade' })).toBeNull(); // « pac » en tête d'un autre mot : non
  });

  it('DIAG-B6-09 — B6 déclaré non applicable : statut conservé, aucun équipement inventé', () => {
    const r = evaluateCilB6([{ id: 1, type: 'Téléviseur' }], 'not_applicable');
    expect(r.block.status).toBe('not_applicable');
    expect(r.energyEquipmentIds).toEqual([]);
  });

  it('DIAG-B6-10 — aucun équipement du tout : invitation à en ajouter (pas « caractériser »)', () => {
    const r = evaluateCilB6([], undefined);
    expect(r.block.status).toBe('unknown');
    expect(r.block.missingItems.map((i) => i.id)).toEqual(['equipments']);
  });
});

// ── Prévisualisation BO : adresse par composant ─────────────────────────

describe('DIAG-A — prévisualisation BO : composants d’adresse réellement absents', () => {
  const manifest = { sections: [], includedDocuments: [{}], unqualifiedDocCount: 0, missingRubricCount: 0, exportType: 'DOSSIER_COMPLET' } as never;
  const snap = (over: Record<string, unknown>) => ({
    category: 'IMMOBILIER', address: '12 rue des Lilas', postalCode: '69003', city: 'Lyon', purchaseDate: '2020-01-01',
    purchasePriceCents: 1, estimatedValueCents: null, photos: [{}], events: [], documents: [{ isWebLink: false }], ...over,
  }) as never;
  const adresse = (over: Record<string, unknown>) => listMissingPreviewData(manifest, snap(over)).filter((m) => /du bien non renseign/.test(m));

  it('DIAG-A01 — adresse absente', () => { expect(adresse({ address: null })).toEqual(['Adresse du bien non renseignée.']); });
  it('DIAG-A02 — code postal absent', () => { expect(adresse({ postalCode: '' })).toEqual(['Code postal du bien non renseigné.']); });
  it('DIAG-A03 — ville absente', () => { expect(adresse({ city: null })).toEqual(['Ville du bien non renseignée.']); });
  it('DIAG-A04 — deux composants absents', () => {
    expect(adresse({ address: null, postalCode: null })).toEqual(['Adresse et code postal du bien non renseignés.']);
    expect(missingAddressMessage({ address: 'x', postalCode: null, city: ' ' })).toBe('Code postal et ville du bien non renseignés.');
    expect(missingAddressMessage({ address: null, postalCode: '1', city: null })).toBe('Adresse et ville du bien non renseignées.');
  });
  it('DIAG-A05 — trois composants absents ; adresse complète → rien', () => {
    expect(adresse({ address: null, postalCode: null, city: null })).toEqual(['Adresse, code postal et ville du bien non renseignés.']);
    expect(adresse({})).toEqual([]);
    expect(listMissingPreviewData(manifest, snap({}))).not.toContain('Adresse complète du bien (adresse, code postal, ville).');
  });
});

// ── PostgreSQL 42883 ─────────────────────────────────────────────────────

describe('DIAG-P — diagnostic PostgreSQL 42883 générique', () => {
  const pgErr = (message: string) => Object.assign(new Error('Failed query'), { cause: Object.assign(new Error(message), { code: '42883' }) });

  it('DIAG-P01 — sans fonction identifiable : explication générique, aucun nom supposé', () => {
    const d = diagnoseDatabaseError(pgErr('something unexpected happened'));
    expect(d).toMatchObject({ pgCode: '42883', schemaHint: 'MISSING_FUNCTION' });
    expect(d.explanation).toBe('Une fonction ou un opérateur PostgreSQL requis est introuvable ou incompatible avec les arguments transmis.');
    expect(d.undefinedObject).toBeUndefined();
  });

  it('DIAG-P02 — fonction identifiable dans le message : citée telle quelle', () => {
    const d = diagnoseDatabaseError(pgErr('function similarity(text, text) does not exist'));
    expect(d.undefinedObject).toEqual({ kind: 'function', signature: 'similarity(text, text)' });
    expect(d.explanation).toContain('similarity(text, text)');
    expect(extractUndefinedObject("la fonction public.unaccent(text) n'existe pas")).toEqual({ kind: 'function', signature: 'public.unaccent(text)' });
    expect(extractUndefinedObject('operator does not exist: integer = text')).toEqual({ kind: 'operator', signature: 'integer = text' });
  });

  it('DIAG-P03 — gen_random_uuid() jamais mentionné s’il n’est pas concerné ; cité s’il l’est', () => {
    for (const m of ['operator does not exist: integer = text', 'function similarity(text, text) does not exist', 'boom']) {
      expect(JSON.stringify(diagnoseDatabaseError(pgErr(m)))).not.toContain('gen_random_uuid');
    }
    expect(diagnoseDatabaseError(pgErr('function gen_random_uuid() does not exist')).explanation).toContain('gen_random_uuid()');
  });
});

// ── Audit transversal : cas corrigés ─────────────────────────────────────

describe('DIAG-AU — audit transversal (cas corrigés)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('DIAG-AU01 — assistant (dépenses non isolables) : ne demande que ce qui manque', () => {
    expect(expenseCompletionHint(2, 0)).toBe('Précisez leur type pour obtenir un total fiable.');
    expect(expenseCompletionHint(0, 1)).toBe('Précisez leur date pour obtenir un total fiable.');
    expect(expenseCompletionHint(1, 1)).toBe('Précisez leur type et leur date pour obtenir un total fiable.');
  });

  it('DIAG-AU02 — assistant (fin de contrat non applicable) : champ de la famille, « à compléter » seulement s’il est vide', () => {
    expect(tenureSituationHint('IMMOBILIER', {})).toBe('statut d’occupation à compléter sur la fiche');
    expect(tenureSituationHint('IMMOBILIER', { occupancyStatus: 'PROPRIETAIRE_OCCUPANT' })).toBe('d’après le statut d’occupation renseigné sur la fiche');
    expect(tenureSituationHint('VEHICULE', { vehicleOwnershipStatus: '' })).toBe('statut de détention à compléter sur la fiche');
    expect(tenureSituationHint('VEHICULE', { vehicleOwnershipStatus: 'ACHAT' })).toBe('d’après le statut de détention renseigné sur la fiche');
    expect(tenureSituationHint('OBJET', {})).toBe('mode d’acquisition à compléter sur la fiche');
    for (const f of ['IMMOBILIER', 'VEHICULE', 'OBJET']) expect(tenureSituationHint(f, {})).not.toMatch(/détention ou d.occupation/);
  });

  it('DIAG-AU03 — journaux de schéma : n’affirment que ce qui est constaté (adapté lot 75A : jamais « migration non appliquée »)', () => {
    const base = { scope: '[x]', migration: '0223', expected: ['a', 'b', 'c'], consequence: 'Effet.' };
    expect(schemaNotReadyMessage({ ...base, found: 2 })).toContain('Schéma incomplet');
    expect(schemaNotReadyMessage({ ...base, found: 2 })).toContain('2/3');
    expect(schemaNotReadyMessage({ ...base, found: 0 })).toContain('Aucun élément attendu trouvé (migration de référence 0223) parmi a, b, c');
    expect(schemaNotReadyMessage({ ...base, missing: ['b'] })).toContain('Schéma incomplet (migration de référence 0223) : b absent (2/3 présents).');
    const err = schemaNotReadyMessage({ ...base, found: null, error: new Error('connection refused') });
    expect(err).toContain('Vérification du schéma (migration 0223) impossible : connection refused');
    expect(schemaNotReadyMessage({ ...base })).toContain('État du schéma indéterminé');
    expect(schemaNotReadyMessage({ ...base })).not.toContain('absent');
    for (const p of [{ ...base, found: 2 }, { ...base, found: 0 }, { ...base, missing: ['b'] }, { ...base, error: new Error('x') }, { ...base }]) {
      expect(schemaNotReadyMessage(p)).not.toMatch(/NON APPLIQU/i);
    }
  });

  it('DIAG-AU04 — agenda 0223 : 2 colonnes sur 3 → « 2/3 », pas « clé fonctionnelle et nature absentes »', async () => {
    const { pgClient } = await import('@/db');
    (pgClient.unsafe as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ n: 2 }]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { agendaFunctionalColumnsReady, __resetAgendaColumnsForTests } = await import('@/services/agenda/agenda-columns');
    __resetAgendaColumnsForTests();
    expect(await agendaFunctionalColumnsReady()).toBe(false);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain('2/3');
    expect(msg).not.toContain('clé fonctionnelle et nature absentes');
  });

  it('DIAG-AU05 — fiche canonique 0227/0229 : seules les colonnes absentes sont citées', async () => {
    const { pgClient } = await import('@/db');
    (pgClient.unsafe as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { t: 'equipments', c: 'key_characteristics' }, { t: 'substructures', c: 'key_characteristics' },
      { t: 'canonical_field_writes', c: 'target_type' }, { t: 'canonical_field_writes', c: 'target_id' },
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { entityCanonicalColumnsReady, __resetEntityColumnsForTests } = await import('@/services/canonical/entity-state/entity-schema');
    __resetEntityColumnsForTests();
    expect(await entityCanonicalColumnsReady()).toBe(false);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain('substructures.area absent (');
    expect(msg).not.toContain('equipments.key_characteristics');
  });

  it('DIAG-AU06 — requête de contrôle en échec : « vérification impossible », jamais « migration non appliquée »', async () => {
    const { pgClient } = await import('@/db');
    (pgClient.unsafe as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('permission denied for schema'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { timelineColumnReady } = await import('@/services/verebona-assistant/core/timeline-persistence');
    expect(await timelineColumnReady()).toBe(false);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain('impossible : permission denied for schema');
    expect(msg).not.toContain('NON APPLIQUÉE');
  });
});
