/**
 * CDC §4.2.9, critère d'acceptation n°13 — « les contradictions non résolues
 * alimentent la page À traiter, catégorie À arbitrer ».
 *
 * Les tests portent sur la mise en forme, pas sur la requête : c'est là que se
 * décide ce que l'utilisateur comprend. Une contradiction affichée sans ses
 * deux valeurs, ou étiquetée `livingArea` au lieu de « Surface habitable »,
 * n'est pas arbitrable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) } }));

const { listOpenReconciliationConflicts, fieldLabel } =
  await import('../to-process-conflicts');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    asset_id: 42,
    field_key: 'livingArea',
    current_value: '82',
    proposed_value: '78.4',
    source_detail: 'Autorité supérieure',
    authority_rule: 'ACTE_NOTARIE > ANNONCE_COMMERCIALE',
    current_source: 'ANNONCE_COMMERCIALE',
    current_source_id: 11,
    proposed_source: 'ACTE_NOTARIE',
    proposed_source_id: 12,
    inconsistency_type: 'conflictual',
    created_at: '2026-07-20T10:00:00.000Z',
    asset_name: 'Maison Caen',
    ...over,
  };
}

beforeEach(() => {
  unsafe.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('restitution des conflits', () => {
  it('produit un élément de la famille « À arbitrer »', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.family).toBe('arbitrate');
    expect(item.objectType).toBe('asset');
    expect(item.objectId).toBe(42);
    expect(item.id).toBe('reconciliation_conflict_7');
  });

  it('affiche les deux valeurs côte à côte — sinon rien n\'est arbitrable', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.context.conflictingValues?.map(v => v.value)).toEqual(['82', '78.4']);
    expect(item.context.conflictingField).toBe('livingArea');
  });

  it('porte la SOURCE de chaque valeur — CDC §7.1', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    // « 82 contre 78,4 » ne se décide pas ; « 82 d'après l'annonce, 78,4
    // d'après l'acte notarié » se décide en une seconde.
    expect(item.context.conflictingValues?.[0].label).toContain('Annonce commerciale');
    expect(item.context.conflictingValues?.[1].label).toContain('Acte notarié');
    expect(item.context.currentSourceLabel).toBe('Annonce commerciale');
    expect(item.context.proposedSourceLabel).toBe('Acte notarié');
  });

  it('permet d\'ouvrir le document derrière chaque valeur', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.context.currentSourceDocumentId).toBe(11);
    expect(item.context.proposedSourceDocumentId).toBe(12);
    expect(item.context.authorityRule).toContain('ACTE_NOTARIE');
  });

  it('reste lisible quand une source est inconnue', async () => {
    unsafe.mockResolvedValue([row({ current_source: null })]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.context.conflictingValues?.[0].label).toContain('Source inconnue');
  });

  it('traduit la clé technique en libellé métier', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.actionTitle).toContain('Surface habitable');
    expect(item.objectTitle).toBe('Surface habitable · Maison Caen');
  });

  it('retombe sur la clé technique plutôt que de masquer le conflit', () => {
    expect(fieldLabel('champInconnu')).toBe('champInconnu');
  });

  it('place les champs critiques en priorité haute', async () => {
    unsafe.mockResolvedValue([row({ field_key: 'postalCode' }), row({ id: 8, field_key: 'livingArea' })]);
    const items = await listOpenReconciliationConflicts(1);

    expect(items[0].priority).toBe('high');
    expect(items[1].priority).toBe('medium');
  });

  it('distingue une contradiction d\'une simple proposition', async () => {
    unsafe.mockResolvedValue([
      row({ inconsistency_type: 'conflictual' }),
      row({ id: 8, inconsistency_type: 'probable' }),
    ]);
    const items = await listOpenReconciliationConflicts(1);

    expect(items[0].badge).toBe('Valeurs contradictoires');
    expect(items[1].badge).toBe('Valeur à confirmer');
  });

  it('reste lisible quand une valeur est vide', async () => {
    unsafe.mockResolvedValue([row({ current_value: null })]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.context.conflictingValues?.[0].value).toBe('(vide)');
  });

  it('survit à la suppression du bien', async () => {
    unsafe.mockResolvedValue([row({ asset_name: null })]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.objectTitle).toContain('Bien supprimé');
  });

  it('permet d\'ouvrir les documents des deux côtés', async () => {
    unsafe.mockResolvedValue([row()]);
    const [item] = await listOpenReconciliationConflicts(1);

    expect(item.secondaryActions).toContain('view_source_document');
    expect(item.primaryAction).toBe('resolve');
  });
});

describe('robustesse', () => {
  it('rend une liste vide si la table n\'existe pas encore', async () => {
    unsafe.mockRejectedValue(Object.assign(new Error('relation inexistante'), { code: '42P01' }));
    await expect(listOpenReconciliationConflicts(1)).resolves.toEqual([]);
  });

  it('ne fait jamais tomber la page « À traiter »', async () => {
    unsafe.mockRejectedValue(new Error('base injoignable'));
    await expect(listOpenReconciliationConflicts(1)).resolves.toEqual([]);
  });

  it('rend une liste vide sans conflit ouvert', async () => {
    unsafe.mockResolvedValue([]);
    await expect(listOpenReconciliationConflicts(1)).resolves.toEqual([]);
  });
});
