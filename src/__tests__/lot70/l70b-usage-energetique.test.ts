/**
 * Lot 70B — décision PO 19/10 n° 1 : champ « Usage énergétique » du tiroir
 * équipement, lu EN PRIORITÉ par la règle unique B6
 * (`classifyCilEnergyEquipment`). Tests purs + relecture des sources
 * (tiroir desktop/mobile, routes, migration). Le parcours complet sur
 * PostgreSQL 16 est dans `src/test/e2e/scenarios/l70b-usage-energetique.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EQUIPMENT_ENERGY_USAGE_OPTIONS, ENERGY_USAGE_NONE, classifyCilEnergyEquipment, cilEnergyEquipments,
  equipmentEnergyUsageLabel, normalizeEquipmentEnergyUsage, parseEquipmentCategory, parseEquipmentEnergyUsage,
  suggestEnergyUsageFromType, type CilEnergyUsage,
} from '@/lib/cil/energy-equipment';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const USAGES: CilEnergyUsage[] = ['chauffage', 'refroidissement', 'ecs', 'ventilation', 'enr'];

describe('L70-ENER-01 — chaque valeur du champ', () => {
  it.each(USAGES)('usage déclaré « %s » : équipement retenu, fondé sur l’usage déclaré', (u) => {
    expect(classifyCilEnergyEquipment({ energyUsage: u, type: null })).toEqual({ usage: u, basis: 'energy_usage' });
  });

  it('« Aucun usage énergétique » : exclu', () => {
    expect(classifyCilEnergyEquipment({ energyUsage: 'aucun' })).toBeNull();
  });

  it('« Non renseigné » (null, vide, absent) : le type décide', () => {
    for (const energyUsage of [null, undefined, '']) {
      expect(classifyCilEnergyEquipment({ energyUsage, type: 'Chaudière gaz à condensation' })).toEqual({ usage: 'chauffage', basis: 'type' });
      expect(classifyCilEnergyEquipment({ energyUsage, type: 'Téléviseur' })).toBeNull();
    }
  });

  it('libellés fermés (ordre d’affichage) et « Non renseigné »', () => {
    expect(EQUIPMENT_ENERGY_USAGE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['chauffage', 'Chauffage'],
      ['ecs', 'Eau chaude sanitaire'],
      ['ventilation', 'Ventilation'],
      ['refroidissement', 'Climatisation / rafraîchissement'],
      ['enr', 'Production d’énergie (solaire…)'],
      ['aucun', 'Aucun usage énergétique'],
    ]);
    expect(equipmentEnergyUsageLabel(null)).toBe('Non renseigné');
    expect(equipmentEnergyUsageLabel('inconnu')).toBe('Non renseigné');
    expect(equipmentEnergyUsageLabel('ecs')).toBe('Eau chaude sanitaire');
  });
});

describe('L70-ENER-02 — priorité sur le type, la catégorie et les caractéristiques CIL', () => {
  it('« Aucun » exclut même si type, catégorie et caractéristiques CIL le suggèrent', () => {
    expect(classifyCilEnergyEquipment({ energyUsage: ENERGY_USAGE_NONE, type: 'Chaudière gaz', category: 'CHAUFFAGE', energyType: 'GAZ', evacuationMode: 'VENTOUSE', heatNetworkDeliveryStation: 'SST-1' })).toBeNull();
  });

  it('un usage déclaré l’emporte sur l’usage déduit du type', () => {
    expect(classifyCilEnergyEquipment({ energyUsage: 'chauffage', type: 'VMC double flux' })).toEqual({ usage: 'chauffage', basis: 'energy_usage' });
    expect(classifyCilEnergyEquipment({ energyUsage: 'ecs', category: 'CHAUFFAGE' })).toEqual({ usage: 'ecs', basis: 'energy_usage' });
  });

  it('un usage déclaré inclut un équipement que le type ne classe pas', () => {
    expect(classifyCilEnergyEquipment({ energyUsage: 'enr', type: 'Onduleur' })).toEqual({ usage: 'enr', basis: 'energy_usage' });
  });

  it('valeur persistée inconnue (jamais écrite : contrainte CHECK) : ignorée, le type décide', () => {
    expect(classifyCilEnergyEquipment({ energyUsage: 'CHAUFFAGE', type: 'Téléviseur' })).toBeNull();
    expect(normalizeEquipmentEnergyUsage('CHAUFFAGE')).toBeNull();
  });

  it('liste B6 : filtre appliqué dans l’ordre reçu', () => {
    const list = [
      { id: 1, energyUsage: 'aucun', type: 'Chaudière' },
      { id: 2, energyUsage: null, type: 'Pompe à chaleur air/eau' },
      { id: 3, energyUsage: 'ventilation', type: 'Boîtier' },
      { id: 4, energyUsage: null, type: 'Portail motorisé' },
    ];
    expect(cilEnergyEquipments(list).map((e) => e.id)).toEqual([2, 3]);
  });
});

describe('L70-ENER-03 — suggestion depuis le type (sûre seulement)', () => {
  it('référentiel reconnu en tête du type', () => {
    expect(suggestEnergyUsageFromType('Chaudière gaz à condensation')).toBe('chauffage');
    expect(suggestEnergyUsageFromType('Chauffe-eau thermodynamique')).toBe('ecs');
    expect(suggestEnergyUsageFromType('VMC simple flux')).toBe('ventilation');
    expect(suggestEnergyUsageFromType('Climatiseur réversible')).toBe('refroidissement');
    expect(suggestEnergyUsageFromType('Panneaux photovoltaïques')).toBe('enr');
  });
  it('aucune suggestion hors référentiel ou au milieu d’un texte', () => {
    expect(suggestEnergyUsageFromType('Téléviseur')).toBeNull();
    expect(suggestEnergyUsageFromType('Ancien radiateur')).toBeNull();
    expect(suggestEnergyUsageFromType('')).toBeNull();
    expect(suggestEnergyUsageFromType(null)).toBeNull();
  });
});

describe('L70-ENER-04 — lecture des corps de requête', () => {
  it('energyUsage : absent / non renseigné / code / invalide', () => {
    expect(parseEquipmentEnergyUsage(undefined)).toBeUndefined();
    expect(parseEquipmentEnergyUsage(null)).toBeNull();
    expect(parseEquipmentEnergyUsage('')).toBeNull();
    for (const o of EQUIPMENT_ENERGY_USAGE_OPTIONS) expect(parseEquipmentEnergyUsage(o.value)).toBe(o.value);
    expect(parseEquipmentEnergyUsage('Chauffage')).toBe('INVALID');
    expect(parseEquipmentEnergyUsage('non_renseigne')).toBe('INVALID');
    expect(parseEquipmentEnergyUsage(3)).toBe('INVALID');
  });
  it('category : absente / effacée / rognée / invalide', () => {
    expect(parseEquipmentCategory(undefined)).toBeUndefined();
    expect(parseEquipmentCategory(null)).toBeNull();
    expect(parseEquipmentCategory('   ')).toBeNull();
    expect(parseEquipmentCategory(' MOBILIER ')).toBe('MOBILIER');
    expect(parseEquipmentCategory(12)).toBe('INVALID');
    expect(parseEquipmentCategory('x'.repeat(101))).toBe('INVALID');
  });
});

describe('L70-ENER-05 — valeurs alignées sur le référentiel CIL (aucun référentiel parallèle)', () => {
  it('les usages du champ sont ceux de energy_works.category, plus « aucun »', () => {
    const schema = read('src/db/schema.ts');
    const works = /energy_works_category_check',\s*sql`\$\{table\.category\} IN \(([^)]*)\)`/.exec(schema)![1];
    for (const u of USAGES) expect(works).toContain(`'${u}'`);
    expect(EQUIPMENT_ENERGY_USAGE_OPTIONS.map((o) => o.value).sort()).toEqual([...USAGES, 'aucun'].sort());
  });
  it('migration 0486 et schéma Drizzle : même contrainte, colonne NULL sans défaut, idempotente', () => {
    const mig = read('src/db/migrations/0486_l70b_equipment_energy_usage.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS energy_usage text;');
    expect(mig).toContain("energy_usage IN ('chauffage', 'refroidissement', 'ecs', 'ventilation', 'enr', 'aucun')");
    expect(mig).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'equipments_energy_usage_check'\)/);
    expect(mig).toContain('NOT VALID');
    const schema = read('src/db/schema.ts');
    expect(schema).toContain("energyUsage: text('energy_usage'),");
    expect(schema).toContain("'equipments_energy_usage_check'");
  });
});

describe('L70-ENER-06 — tiroir équipement (même composant desktop et mobile)', () => {
  const src = read('src/components/assets/EquipmentDrawer.tsx');
  it('champ « Usage énergétique » éditable en création et en modification, choix fermés + « Non renseigné »', () => {
    expect(src).toContain('<Label htmlFor="equipment-energy-usage">Usage énergétique</Label>');
    expect(src).toContain('EQUIPMENT_ENERGY_USAGE_OPTIONS.map');
    expect(src).toContain('{ENERGY_USAGE_UNSET_LABEL}');
    expect(src).toMatch(/if \(isCreateMode \|\| knownEnergyUsage !== undefined\) \{\s*payload\.energyUsage =/);
  });
  it('suggestion depuis le type, confirmée par l’utilisateur (jamais enregistrée seule)', () => {
    expect(src).toContain('suggestEnergyUsageFromType(type)');
    expect(src).toContain('onClick={() => setEnergyUsage(energyUsageSuggestion)}');
    expect(src).toContain('Confirmer');
  });
  it('consultation : usage affiché ; jetons de la charte uniquement (aucune couleur en dur)', () => {
    expect(src).toContain('<span className="text-muted-foreground">Usage énergétique</span>');
    const bloc = src.slice(src.indexOf('data-testid="equipment-energy-usage"'), src.indexOf('{/* Fiche (équipement existant'));
    expect(bloc).not.toMatch(/#[0-9a-f]{3,6}\b|bg-(blue|green|red|yellow|gray)-/i);
    expect(bloc).toContain('var(--accent-soft)');
  });
  it('relu depuis GET /api/equipments/:id (écrans appelants qui ne le transmettent pas)', () => {
    expect(src).toContain('d.equipment.energyUsage');
    expect(read('src/app/api/equipments/[id]/route.ts')).toContain('e.energy_usage AS "energyUsage"');
  });
});

describe('L70-ENER-07 — routes : la route PUT écrit ce qu’elle lit', () => {
  it('PUT écrit category et energy_usage, POST aussi ; valeurs invalides refusées', () => {
    const put = read('src/app/api/assets/[id]/equipments/[equipId]/route.ts');
    expect(put).toContain('sets.push(`category = $${p++}`)');
    expect(put).toContain('sets.push(`energy_usage = $${p++}`)');
    expect(put).toContain("'Invalid energy usage'");
    const post = read('src/app/api/assets/[id]/equipments/route.ts');
    expect(post).toMatch(/INSERT INTO equipments \(asset_id, substructure_id, name, type, category, energy_usage, status/);
  });
  it('préparation CIL et source d’export lisent l’usage déclaré (même entrée de règle)', () => {
    expect(read('src/services/exports/cil-preparation.service.ts')).toContain('energyUsage: equipments.energyUsage');
    expect(read('src/services/exports/v12/data/source.ts')).toContain('energyUsage: equipments.energyUsage');
  });
  it('B8 inchangé : « Documents de performance énergétique » (décision PO)', () => {
    expect(read('src/lib/exports/cil-blocking.ts')).toContain('Documents de performance énergétique');
  });
});
