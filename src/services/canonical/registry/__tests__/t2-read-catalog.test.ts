/**
 * Lot 30 — §M / §N : FIELD_CATALOG T2 = projection OFFICIELLE du registre
 * (`catalogForT2Read`), vocabulaire T2 dérivé du registre.
 *
 * AC19 : toute évolution d'un champ lisible par T2 est reflétée
 *        automatiquement dans son FIELD_CATALOG (présence, absence,
 *        familles / cibles, type / unité / enum).
 * AC20 : chaque formulation déclarée (`assistantPhrases`) est reconnue par le
 *        matcher déterministe ET exposée à UNDERSTAND ; aucun alias technique
 *        n'est pris pour une formulation ; aucune seconde liste dans T2.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_FIELDS, catalogForPrompts, catalogForT2Read, fieldAssistantVocabulary, fieldTargetTypes,
  type CanonicalFieldDef,
} from '..';
import { describeFieldCatalog, toT2Understanding } from '@/services/ai/assistant/master/t2-understand';
import { findReadableFields, deterministicRequestedFacts } from '@/services/verebona-assistant/canonical/field-vocabulary';

const ROOT = resolve(__dirname, '../../../../..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** Ajout temporaire d'un champ au registre (le registre est un tableau ; retiré après chaque test). */
const ajoutes: CanonicalFieldDef[] = [];
function ajouter(def: CanonicalFieldDef): void {
  (CANONICAL_FIELDS as CanonicalFieldDef[]).push(def);
  ajoutes.push(def);
}
afterEach(() => {
  for (const d of ajoutes.splice(0)) {
    const i = CANONICAL_FIELDS.indexOf(d);
    if (i >= 0) (CANONICAL_FIELDS as CanonicalFieldDef[]).splice(i, 1);
  }
});

const ligneDe = (key: string) => describeFieldCatalog().split('\n').find((l) => l.startsWith(`- ${key} :`));

describe('AC19 — FIELD_CATALOG T2, projection officielle de CANONICAL_FIELDS', () => {
  it('AC19 : champ assistantReadable présent, champ non lisible absent — sans toucher à describeFieldCatalog', () => {
    ajouter({
      key: 'zzTestLisible', label: 'Numéro de badge parking', families: ['IMMOBILIER'], valueType: 'enum',
      enumValues: ['A', 'B'], enumLabels: { A: 'Badge A', B: 'Badge B' }, unit: 'u', aliases: ['badge_parking_num'],
      assistantPhrases: ['badge du parking', 'numero de badge'], assistantReadable: true, assistantWritable: false,
      targetTypes: ['ASSET', 'EQUIPMENT'], sensitive: true,
    });
    ajouter({
      key: 'zzTestCache', label: 'Champ interne de test', families: ['OBJECT'], valueType: 'string', aliases: [],
      assistantReadable: false, assistantWritable: false,
    });
    const f = catalogForT2Read().fields.find((x) => x.key === 'zzTestLisible');
    expect(f).toEqual({
      key: 'zzTestLisible', label: 'Numéro de badge parking', families: ['IMMOBILIER'], targets: ['ASSET', 'EQUIPMENT'],
      valueType: 'enum', unit: 'u', enumValues: ['A', 'B'], enumLabels: { A: 'Badge A', B: 'Badge B' }, sensitive: true,
      phrases: ['numero de badge parking', 'badge du parking', 'numero de badge'],
    });
    expect(catalogForT2Read().fields.some((x) => x.key === 'zzTestCache')).toBe(false);
    // UNDERSTAND voit le champ, avec type, unité, valeurs, famille, cibles et formulations.
    expect(ligneDe('zzTestLisible')).toBe(
      '- zzTestLisible : Numéro de badge parking (enum, unité u, valeurs A=Badge A|B=Badge B ; familles IMMOBILIER ; cibles ASSET/EQUIPMENT)'
      + ' — formulations : badge du parking, numero de badge',
    );
    expect(ligneDe('zzTestCache')).toBeUndefined();
    // Le serveur accepte la clé demandée par le modèle, refuse la clé non lisible.
    const u = toT2Understanding({
      mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', entityHints: [], requestedTopics: [],
      requestedFacts: ['zzTestLisible', 'zzTestCache'], reason: 'test',
      filters: { documentType: null, periodStart: null, periodEnd: null, unlinked: null, status: null, supplier: null, upcoming: null },
    } as never);
    expect(u.requestedFacts).toEqual(['zzTestLisible']);
    expect(u.requestedTopics).toContain('zzTestCache');
    // Le matcher déterministe le reconnaît aussi (même projection).
    expect(deterministicRequestedFacts('quel est le badge du parking de la maison ?')).toEqual(['zzTestLisible']);
  });

  it('AC19 : familles, cibles, type, unité et enum issus du registre pour chaque champ lisible', () => {
    const lisibles = CANONICAL_FIELDS.filter((d) => d.assistantReadable);
    const projection = catalogForT2Read().fields;
    expect(projection.map((f) => f.key)).toEqual([...new Set(lisibles.map((d) => d.key))]);
    for (const f of projection) {
      const d = lisibles.find((x) => x.key === f.key)!;
      expect(f.families).toEqual(d.families);
      expect(f.targets).toEqual(fieldTargetTypes(d));
      expect(f.valueType).toBe(d.valueType);
      expect(f.unit).toBe(d.unit);
      expect(f.enumValues).toEqual(d.enumValues ? [...d.enumValues] : undefined);
      expect(f.enumLabels).toEqual(d.enumLabels ? { ...d.enumLabels } : undefined);
      expect(f.sensitive).toBe(d.sensitive === true);
      expect(ligneDe(f.key)?.startsWith(`- ${f.key} : ${f.label} (${f.valueType}`), f.key).toBe(true);
    }
    expect(describeFieldCatalog().split('\n')).toHaveLength(projection.length);
  });

  it('AC19 : règles de LECTURE — inputOnly et sensitive restent lisibles (≠ catalogForPrompts, inférence T1)', () => {
    const inputOnly = CANONICAL_FIELDS.filter((d) => d.inputOnly && d.assistantReadable).map((d) => d.key);
    expect(inputOnly.length).toBeGreaterThan(0);
    const t2 = new Set(catalogForT2Read().fields.map((f) => f.key));
    const t1 = new Set(catalogForPrompts().fields.map((f) => f.key));
    for (const k of inputOnly) {
      expect(t2.has(k), k).toBe(true);
      expect(t1.has(k), k).toBe(false);
    }
    for (const d of CANONICAL_FIELDS.filter((x) => x.sensitive && x.assistantReadable)) expect(t2.has(d.key), d.key).toBe(true);
  });

  it('AC19 : T2 ne garde aucune seconde projection du registre', () => {
    const understand = lire('src/services/ai/assistant/master/t2-understand.ts');
    expect(understand).not.toMatch(/\bCANONICAL_FIELDS\b/);
    expect(understand).toMatch(/catalogForT2Read\(\)/);
    const vocab = lire('src/services/verebona-assistant/canonical/field-vocabulary.ts');
    expect(vocab).not.toMatch(/\bCANONICAL_FIELDS\b/);
    expect(vocab).toMatch(/catalogForT2Read\(\)/);
  });
});

describe('AC20 — vocabulaire T2 dérivé du registre canonique', () => {
  it('AC20 : chaque assistantPhrase est reconnue par le matcher ET exposée à UNDERSTAND', () => {
    for (const f of catalogForT2Read().fields) {
      const d = CANONICAL_FIELDS.find((x) => x.key === f.key)!;
      const ligne = ligneDe(f.key)!;
      for (const p of d.assistantPhrases ?? []) {
        const n = plain(p).replace(/\s+/g, ' ').trim();
        expect(f.phrases, `${f.key} : « ${p} »`).toContain(n);
        // Matcher déterministe (formulations de 4 caractères et plus).
        if (n.length >= 4) expect(findReadableFields(p)[0]?.def.key, `${f.key} : « ${p} »`).toBe(f.key);
        // UNDERSTAND : la formulation figure sur la ligne du champ (ou c'est son libellé).
        expect(ligne.includes(n) || plain(f.label) === n, `${f.key} : « ${p} »`).toBe(true);
      }
    }
  });

  it('AC20 : insuranceClientNumber — une formulation déclarée suffit, sans dictionnaire T2', () => {
    const d = CANONICAL_FIELDS.find((x) => x.key === 'insuranceClientNumber');
    expect(d).toBeDefined();
    for (const p of [d!.label, ...(d!.assistantPhrases ?? [])]) {
      expect(findReadableFields(`quel est mon ${p} ?`)[0]?.def.key, p).toBe('insuranceClientNumber');
    }
    // Ajouter une formulation dans le registre suffit (matcher et UNDERSTAND).
    const avant = d!.assistantPhrases;
    (d as { assistantPhrases?: string[] }).assistantPhrases = [...(avant ?? []), 'identifiant chez mon assureur'];
    try {
      expect(findReadableFields('quel est mon identifiant chez mon assureur ?')[0]?.def.key).toBe('insuranceClientNumber');
      expect(ligneDe('insuranceClientNumber')).toContain('identifiant chez mon assureur');
    } finally {
      (d as { assistantPhrases?: string[] }).assistantPhrases = avant;
    }
  });

  it('AC20 : un alias purement technique n’est jamais interprété comme une formulation utilisateur', () => {
    let verifies = 0;
    for (const f of catalogForT2Read().fields) {
      const d = CANONICAL_FIELDS.find((x) => x.key === f.key)!;
      for (const a of d.aliases) {
        // Alias technique : clé camelCase, snake_case ou en un mot collé (pas une phrase).
        if (!/[A-Z_]/.test(a) || /\s/.test(a)) continue;
        verifies++;
        expect(fieldAssistantVocabulary(d), `${f.key} ← ${a}`).not.toContain(plain(a));
        expect(findReadableFields(`quel est le ${a} ?`).map((m) => m.def.key), `${f.key} ← ${a}`).not.toContain(f.key);
        expect(ligneDe(f.key)!.split(' — formulations : ')[1] ?? '', `${f.key} ← ${a}`).not.toContain(a);
      }
    }
    expect(verifies).toBeGreaterThan(20);
    // Un alias ajouté au registre ne devient pas une formulation.
    ajouter({
      key: 'zzAliasTest', label: 'Champ alias de test', families: ['OBJECT'], valueType: 'string',
      aliases: ['zz_alias_technique', 'zzAliasTechnique'], assistantReadable: true, assistantWritable: false,
    });
    expect(findReadableFields('le zz_alias_technique')).toEqual([]);
    expect(catalogForT2Read().fields.find((x) => x.key === 'zzAliasTest')?.phrases).toEqual(['champ alias de test']);
  });
});
