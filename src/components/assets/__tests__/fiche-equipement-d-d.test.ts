/**
 * CDC 15, lot 20 — fiche de l'équipement (D-D) et règles de saisie des dates
 * (D-E) : module pur partagé par le tiroir, la route PUT et la route GET.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EQUIPMENT_FICHE_FIELDS, changedDetailFields, equipmentFicheChanges, parseEquipmentFiche, validateDetailChanges } from '@/lib/asset-detail-rules';
import { getField } from '@/services/canonical/registry';

const ROOT = resolve(__dirname, '../../../..');
const src = (...p: string[]) => readFileSync(resolve(ROOT, 'src', ...p), 'utf8').replace(/\r\n?/g, '\n');

describe('fiche équipement : champs saisissables', () => {
  it('puissance, COP, fluide frigorigène, compteur horaire : clés canoniques ciblant l’équipement', () => {
    expect(EQUIPMENT_FICHE_FIELDS.map((f) => f.key)).toEqual(['powerKw', 'cop', 'refrigerant', 'hourMeter']);
    for (const f of EQUIPMENT_FICHE_FIELDS) {
      const def = getField(f.key);
      expect(def?.key, f.key).toBe(f.key);
      expect(def!.targetTypes, f.key).toContain('EQUIPMENT');
      expect(def!.valueType, f.key).toBe(f.type === 'number' ? 'number' : 'string');
    }
  });

  it('validation : nombres ≥ 0 (virgule acceptée), COP ≤ 20, vide = effacement, clés inconnues ignorées', () => {
    expect(parseEquipmentFiche({ powerKw: '12,5', cop: 4.2, refrigerant: ' R32 ', hourMeter: '', inconnu: 'x' }))
      .toEqual({ values: { powerKw: 12.5, cop: 4.2, refrigerant: 'R32', hourMeter: null }, errors: [] });
    expect(parseEquipmentFiche(undefined)).toEqual({ values: {}, errors: [] });
    expect(parseEquipmentFiche({ cop: 25 }).errors.map((e) => e.field)).toEqual(['cop']);
    expect(parseEquipmentFiche({ powerKw: -1, hourMeter: 'abc' }).errors.map((e) => e.field)).toEqual(['powerKw', 'hourMeter']);
    expect(parseEquipmentFiche('x').errors).toHaveLength(1);
  });

  it('route PUT : fiche validée puis écrite par recordManualEntityEdit (origine USER), comme les montants', () => {
    const put = src('app', 'api', 'assets', '[id]', 'equipments', '[equipId]', 'route.ts');
    expect(put).toContain('parseEquipmentFiche(body.fiche)');
    expect(put).toMatch(/const after: Record<string, unknown> = \{ \.\.\.fiche\.values \};/);
    expect(put).toContain('recordManualEntityEdit');
    const get = src('app', 'api', 'equipments', '[id]', 'route.ts');
    expect(get).toContain("getCanonicalEntityState({ type: 'EQUIPMENT', id: equipmentId }, accountId)");
  });
});

describe('règles de saisie : dates D-E contrôlées', () => {
  it.each(['dpeExpiryDate', 'maintenanceDueDate', 'lastInspectionDate', 'registrationExpiry', 'contractStartDate', 'warrantyStartDate'])('%s : date invalide refusée, date valide acceptée', (k) => {
    expect(validateDetailChanges({ [k]: '2026-02-30' }, {}, '2026-10-02')).toEqual([{ field: k, message: 'Date invalide.' }]);
    expect(validateDetailChanges({ [k]: '2020-01-15' }, {}, '2026-10-02')).toEqual([]);
  });
});

describe('relecture lot 20 — aucune valeur effacée par un formulaire non chargé ou non touché', () => {
  const chargee = { powerKw: 12.5, cop: 4.2, refrigerant: 'R32', hourMeter: 1250 };
  const formDe = (f: Record<string, unknown>) => Object.fromEntries(EQUIPMENT_FICHE_FIELDS.map((x) => [x.key, f[x.key] == null ? '' : String(f[x.key])]));

  it('GET en échec / enregistrement avant la réponse : fiche non chargée → rien envoyé', () => {
    const vide = formDe({});
    expect(equipmentFicheChanges(null, vide)).toBeUndefined();
    expect(equipmentFicheChanges(undefined, { ...vide, cop: '5' })).toBeUndefined();
  });

  it('fiche chargée, rien touché → rien envoyé ; seule la clé modifiée est envoyée', () => {
    expect(equipmentFicheChanges(chargee, formDe(chargee))).toBeUndefined();
    expect(equipmentFicheChanges(chargee, { ...formDe(chargee), powerKw: '12,5' })).toBeUndefined();
    expect(equipmentFicheChanges(chargee, { ...formDe(chargee), cop: '4.5' })).toEqual({ cop: '4.5' });
    expect(equipmentFicheChanges(chargee, { ...formDe(chargee), refrigerant: '' })).toEqual({ refrigerant: null });
    expect(equipmentFicheChanges({ powerKw: null, cop: null, refrigerant: null, hourMeter: null }, formDe({}))).toBeUndefined();
  });

  it('serveur : clé absente ou undefined ignorée (jamais transformée en null)', () => {
    expect(parseEquipmentFiche({ cop: undefined, refrigerant: 'R410A' })).toEqual({ values: { refrigerant: 'R410A' }, errors: [] });
    expect(parseEquipmentFiche({})).toEqual({ values: {}, errors: [] });
  });

  it('tiroir : fiche omise tant qu’elle n’est pas chargée, saisie proposée seulement une fois chargée', () => {
    const tiroir = src('components', 'assets', 'EquipmentDrawer.tsx');
    expect(tiroir).toContain('const ficheModifiee = equipmentFicheChanges(fiche, ficheForm);');
    expect(tiroir).toContain('if (!isCreateMode && ficheModifiee) payload.fiche = ficheModifiee;');
    expect(tiroir).toMatch(/\.catch\(\(\) => \{ setFiche\(null\); \}\)/);
    expect(tiroir).toContain('{!isCreateMode && fiche && EQUIPMENT_FICHE_FIELDS.map(');
    expect(tiroir).not.toMatch(/fiche: Object\.fromEntries\(EQUIPMENT_FICHE_FIELDS/);
    // GET : fiche `null` quand la fiche canonique est illisible.
    expect(src('app', 'api', 'equipments', '[id]', 'route.ts')).toContain('let fiche: Record<string, unknown> | null = null;');
  });

  it('fiche bien : la section n’envoie que les champs modifiés', () => {
    const base = { carrezArea: 61.2, parking: null, listedArea: 65, networks: ['Eau'], name: 'Appartement' };
    expect(changedDetailFields(base, { ...base })).toEqual({});
    expect(changedDetailFields(base, { ...base, parking: '' })).toEqual({});
    expect(changedDetailFields(base, { ...base, carrezArea: 62 })).toEqual({ carrezArea: 62 });
    expect(changedDetailFields(base, { ...base, listedArea: null })).toEqual({ listedArea: null });
    expect(changedDetailFields(base, { ...base, networks: ['Eau', 'Gaz'] })).toEqual({ networks: ['Eau', 'Gaz'] });
    expect(src('components', 'assets', 'AssetDetailSection.tsx')).toContain('const fields = changedDetailFields(data, form);');
  });
});
