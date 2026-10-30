/**
 * Lot 101A — identité produit (E, F, G, H) : fonctions PURES, sans base.
 *
 *   · propriétés distinctes du registre (série ≠ numéro de série, désignation ≠ modèle) ;
 *   · forme des valeurs (prix, offre, VIN refusés) ;
 *   · comparaison de codes : variante, valeur plus précise, modèles incompatibles ;
 *   · garde-fou T1 : page fournisseur (produit principal + recommandés), libellé générique ;
 *   · adaptateur web : produit principal (JSON-LD, titre) et zones connexes retirées ;
 *   · contrôle COH-EQUIPMENT-IDENTITY : constats, réparation fiable, valeur utilisateur protégée.
 */
import { describe, expect, it } from 'vitest';
import {
  compareProductCodes, groupProductCodes, identityValueProblem, looksLikeGenericDesignation, normalizeProductCode, productCodesIn,
} from '@/services/canonical/product-identity';
import { fieldTargetTypes, getField, normalizeValue } from '@/services/canonical/registry';
import { guardProductIdentity } from '@/services/ai/source-analysis/master/product-identity-guard';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import { extractMainProduct, prepareWebPage, stripRelatedZones } from '@/services/ai/source-analysis/adapters/web-link-source.adapter';
import { diagnoseEquipmentIdentity, equipmentIdentityCheck } from '@/services/coherence/registry/checks/equipment-identity';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';
import { EQUIPMENT_FICHE_FIELDS } from '@/lib/asset-detail-rules';

const fait = (key: string | null, value: string, o: Partial<ProjectedFact> = {}): ProjectedFact => ({
  canonicalKey: key, rawKey: null, label: key, subject: null, attribute: null, rawValue: value, value, valueType: 'string', canonicalUnit: null,
  target: { targetType: 'EQUIPMENT', targetEntityId: 8, targetEntityLabel: 'Micro-onde', targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: value }, semanticEvent: null, recurrence: null,
  periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null, ...o,
});

describe('L101A-U-E — modèle de données : propriétés distinctes du registre', () => {
  it('série, modèle, référence commerciale, désignation et numéro de série sont cinq clés distinctes (équipement et objet)', () => {
    const cles = ['brand', 'productSeries', 'modelName', 'productReference', 'productDesignation', 'serialNumber'];
    for (const k of cles) expect(fieldTargetTypes(getField(k)!), k).toEqual(['ASSET', 'EQUIPMENT']);
    expect(new Set(cles.map((k) => getField(k)!.label)).size).toBe(cles.length);
    expect(getField('productSeries')!.label).toBe('Série du produit');
    // Le tiroir d'équipement (API + UI) les expose séparément.
    for (const k of cles) expect(EQUIPMENT_FICHE_FIELDS.map((f) => f.key), k).toContain(k);
  });
  it('normalisation du registre : un prix, une offre, une date ou un VIN est refusé pour une propriété d’identité', () => {
    expect(normalizeValue('serialNumber', '29,99 EUR').ok).toBe(false);
    expect(normalizeValue('productSeries', 'Série Spéciale Livebox Lite Fibre').ok).toBe(false);
    expect(normalizeValue('productSeries', 'VF1RFB00X56123456').ok).toBe(false);
    expect(normalizeValue('modelName', '12/03/2024').ok).toBe(false);
    expect(normalizeValue('productSeries', 'MG23K3515')).toEqual({ ok: true, value: 'MG23K3515' });
    expect(normalizeValue('serialNumber', '0b8k7wam900123x')).toEqual({ ok: true, value: '0B8K7WAM900123X' });
    // Un libellé générique saisi reste accepté (constat de cohérence, jamais un refus de saisie).
    expect(normalizeValue('modelName', 'Micro-ondes gril').ok).toBe(true);
  });
  it('formes de valeurs : prix ≠ numéro de série, VIN ≠ série, libellé générique ≠ modèle', () => {
    expect(identityValueProblem('serialNumber', '29,99 EUR')).toBe('MONEY');
    expect(identityValueProblem('productSeries', 'VF1RFB00X56123456')).toBe('VIN');
    expect(identityValueProblem('productSeries', 'Série Spéciale Livebox Lite Fibre')).toBe('OFFER');
    expect(identityValueProblem('modelName', 'Micro-Ondes Gril 23L')).toBe('GENERIC_LABEL');
    expect(identityValueProblem('modelName', 'MG23K3515AK')).toBeNull();
    expect(identityValueProblem('serialNumber', 'Numéro de compteur EDF')).toBe('FREE_TEXT');
    expect(looksLikeGenericDesignation('Micro-Ondes Gril 23L')).toBe(true);
    expect(looksLikeGenericDesignation('MC32J7035AK(MC32J7035AK_EF)')).toBe(false);
  });
});

describe('L101A-U-G — conflits : variante, valeur plus précise, modèles incompatibles', () => {
  it('MG23K3515** puis MG23K3515AK : valeur générique puis modèle plus précis (même produit)', () => {
    expect(compareProductCodes('MG23K3515**', 'MG23K3515AK')).toBe('B_MORE_PRECISE');
    expect(compareProductCodes('MG23K3515AK', 'MG23K3515AK/EF')).toBe('B_MORE_PRECISE');
    expect(compareProductCodes('MG23K3515', 'MG23K3515AK')).toBe('B_MORE_PRECISE');
    expect(compareProductCodes('mg23k3515ak', 'MG23K3515AK')).toBe('SAME');
    expect(compareProductCodes('MG23K-3515AK', 'MG23K3515AK')).toBe('FORMAT_VARIANT');
  });
  it('MG23K3515AK et MC32J7035AK : deux modèles différents → incompatibles, jamais équivalents', () => {
    expect(compareProductCodes('MG23K3515AK', 'MC32J7035AK')).toBe('INCOMPATIBLE');
    expect(groupProductCodes(['MG23K3515**', 'MG23K3515AK', 'MC32J7035AK']).map((g) => g.best)).toEqual(['MG23K3515AK', 'MC32J7035AK']);
    expect(groupProductCodes(['MG23K3515**', 'MG23K3515AK', 'MG23K3515AK/EF'])).toHaveLength(1);
    expect(normalizeProductCode('MC32J7035AK(MC32J7035AK_EF)')).toBe('MC32J7035AK');
    expect(productCodesIn('Micro-ondes Gril 23L MG23K3515AK')).toEqual(['MG23K3515AK']);
  });
});

describe('L101A-U-F — extraction fournisseur : produit principal, produits recommandés', () => {
  const PAGE = `<html><head><title>Micro-ondes Gril 23L MG23K3515AK | Samsung FR</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Micro-Ondes Gril 23L","model":"MG23K3515AK","sku":"MG23K3515AK/EF","brand":{"@type":"Brand","name":"Samsung"}}</script></head>
    <body><h1>Micro-Ondes Gril 23L</h1><div class="pdp-main"><p>Modèle : MG23K3515AK</p><p>Puissance 800 W</p></div>
    <section class="product-recommendations"><div class="card"><p>MC32J7035AK(MC32J7035AK_EF)</p><p>Four micro-ondes combiné</p></div></section>
    <aside><p>MS23K3513AK</p></aside><footer>Samsung</footer></body></html>`;
  it('adaptateur : produit principal par les données structurées, zones connexes retirées du texte transmis à T1', () => {
    expect(extractMainProduct(PAGE)).toEqual({ codes: ['MG23K3515AK', 'MG23K3515AK/EF'], name: 'Micro-Ondes Gril 23L', brand: 'Samsung' });
    const { removed } = stripRelatedZones(PAGE);
    expect(removed).toHaveLength(2);
    const p = prepareWebPage(PAGE);
    expect(p.text).toContain('MG23K3515AK');
    expect(p.text).not.toContain('MC32J7035AK');
    expect(p.text).not.toContain('MS23K3513AK');
    expect(p.webPage).toMatchObject({ removedZones: 2, relatedProductCodes: ['MC32J7035AK', 'MS23K3513AK'] });
    // Sans données structurées : le titre de la page désigne le produit principal.
    expect(extractMainProduct('<title>Samsung MG23K3515AK</title><h1>x</h1>')?.codes).toEqual(['MG23K3515AK']);
  });
  it('garde-fou T1 : MG23K3515AK rattaché ; MC32J7035AK (recommandé) détaché ; « Micro-Ondes Gril 23L » jamais en modèle', () => {
    const r = guardProductIdentity([
      fait('modelName', 'MG23K3515AK'),
      fait('modelName', 'MC32J7035AK(MC32J7035AK_EF)'),
      fait('modelName', 'Micro-Ondes Gril 23L'),
      fait('brand', 'Samsung'),
    ], { mainProduct: { codes: ['MG23K3515AK', 'MG23K3515AK/EF'], name: null, brand: 'Samsung' } });
    expect(r.facts[0]).toMatchObject({ canonicalKey: 'modelName', confidence: 'certain', target: { targetType: 'EQUIPMENT', targetEntityId: 8 } });
    expect(r.facts[1]).toMatchObject({ canonicalKey: null, rawKey: 'modelName', subject: 'Produit connexe de la page', ruleCode: 'PRODUCT_SECONDARY_ON_PAGE', target: { targetType: 'GENERIC', targetEntityId: null } });
    expect(r.facts[2]).toMatchObject({ canonicalKey: 'productDesignation', rawKey: 'modelName', ruleCode: 'PRODUCT_GENERIC_LABEL_TO_DESIGNATION' });
    expect(r.facts[3]).toEqual(fait('brand', 'Samsung'));
    expect(r.counters).toEqual({ genericLabelsRekeyed: 1, incompatibleValuesRequalified: 0, secondaryProductsDetached: 1, conflictsFlagged: 0 });
    // Aucun message ne recopie une valeur.
    expect(JSON.stringify(r.warnings)).not.toMatch(/MC32J7035AK|Gril/);
  });
  it('sans produit principal établi : deux modèles incompatibles « certains » → conflit, jamais deux valeurs certaines', () => {
    const r = guardProductIdentity([fait('modelName', 'MG23K3515AK'), fait('modelName', 'MC32J7035AK')]);
    expect(r.facts.map((f) => f.confidence)).toEqual(['conflictual', 'conflictual']);
    expect(r.counters.conflictsFlagged).toBe(2);
    // Variantes d'une même référence : aucun conflit.
    const v = guardProductIdentity([fait('modelName', 'MG23K3515**'), fait('modelName', 'MG23K3515AK'), fait('productReference', 'MG23K3515AK/EF')]);
    expect(v.facts.map((f) => f.confidence)).toEqual(['certain', 'certain', 'certain']);
  });
  it('valeur d’une autre nature (prix « série ») : connaissance générique, jamais projetée sur l’équipement', () => {
    const r = guardProductIdentity([fait('serialNumber', '29,99 EUR'), fait('productSeries', 'Série Spéciale Livebox Lite Fibre')]);
    expect(r.facts.map((f) => [f.canonicalKey, f.target.targetType])).toEqual([[null, 'GENERIC'], [null, 'GENERIC']]);
  });
});

describe('L101A-U-COH-IDENTITY — contrôle de cohérence de l’identité produit', () => {
  const champ = (key: string, value: string, origin = 'DOCUMENT_EXTRACTION') => ({ key, value, origin });
  const f = (factId: number, fileId: number, key: string, value: string, o: Partial<Parameters<typeof diagnoseEquipmentIdentity>[1][number]> = {}) => ({
    factId, fileId, key, value, confidence: 'certain', sourceType: 'asset_file', ruleCode: null, linkedToThis: true, linkedToOther: false, ...o,
  });
  it('déclaré en FIN de registre, couvert (domaine équipements), jamais destructeur', () => {
    expect(COHERENCE_REGISTRY[COHERENCE_REGISTRY.length - 1].id).toBe('COH-EQUIPMENT-IDENTITY');
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'equipements')!.checks).toContain('COH-EQUIPMENT-IDENTITY');
    expect(equipmentIdentityCheck.forbiddenRepairs.join(' ')).toMatch(/utilisateur/);
  });
  it('modèles incompatibles sur un même équipement → constat (aucune valeur choisie)', () => {
    const d = diagnoseEquipmentIdentity([champ('modelName', 'MG23K3515AK')], [f(1, 10, 'modelName', 'MG23K3515AK'), f(2, 11, 'modelName', 'MC32J7035AK')]);
    expect(d.anomalies.map((a) => a.anomaly)).toEqual(['INCOMPATIBLE_MODELS', 'STRUCTURED_VS_DOCUMENT_CONFLICT']);
    expect(d.repairs).toEqual([]);
  });
  it('modèle d’un produit secondaire d’une page fournisseur → SECONDARY_PRODUCT_ON_PAGE', () => {
    const page = { sourceType: 'web_link' };
    const d = diagnoseEquipmentIdentity([champ('modelName', 'MG23K3515AK')], [f(1, 20, 'modelName', 'MG23K3515AK', page), f(2, 20, 'modelName', 'MC32J7035AK', page)]);
    expect(d.anomalies.map((a) => a.anomaly)).toEqual(['SECONDARY_PRODUCT_ON_PAGE']);
    expect(d.anomalies[0].factIds).toEqual([2]);
  });
  it('variante et valeur plus précise (MG23K3515** → MG23K3515AK) : cohérent', () => {
    expect(diagnoseEquipmentIdentity([champ('modelName', 'MG23K3515AK'), champ('productSeries', 'MG23K3515')], [f(1, 10, 'modelName', 'MG23K3515**'), f(2, 11, 'modelName', 'MG23K3515AK')]).anomalies).toEqual([]);
  });
  it('numéro de série = prix (automatique) → réparation fiable ; libellé générique en modèle → désignation ; valeur UTILISATEUR protégée', () => {
    const d = diagnoseEquipmentIdentity([champ('serialNumber', '29,99 EUR'), champ('modelName', 'Micro-Ondes Gril 23L')], []);
    expect(d.anomalies.map((a) => [a.anomaly, a.key, a.problem])).toEqual([['IDENTITY_VALUE_INCOMPATIBLE', 'serialNumber', 'MONEY'], ['IDENTITY_VALUE_INCOMPATIBLE', 'modelName', 'GENERIC_LABEL']]);
    expect(d.repairs).toEqual([
      { key: 'serialNumber', value: null, expectedCurrent: '29,99 EUR', motive: 'serialNumber:MONEY' },
      { key: 'productDesignation', value: 'Micro-Ondes Gril 23L', expectedCurrent: '', motive: 'modelName:GENERIC_LABEL' },
      { key: 'modelName', value: null, expectedCurrent: 'Micro-Ondes Gril 23L', motive: 'modelName:GENERIC_LABEL' },
    ]);
    const u = diagnoseEquipmentIdentity([champ('serialNumber', '29,99 EUR', 'USER')], []);
    expect(u.anomalies[0]).toMatchObject({ anomaly: 'IDENTITY_VALUE_INCOMPATIBLE', protectedValue: true });
    expect(u.repairs).toEqual([]);
  });
  it('série / modèle / référence incohérents ; propriété issue d’un document d’un autre objet', () => {
    const d = diagnoseEquipmentIdentity([champ('productSeries', 'MC32J'), champ('modelName', 'MG23K3515AK')], [f(3, 30, 'brand', 'Bosch', { linkedToThis: false, linkedToOther: true })]);
    expect(d.anomalies.map((a) => a.anomaly)).toEqual(['SERIES_MODEL_REFERENCE_INCONSISTENT', 'PROPERTY_FROM_OTHER_OBJECT_DOCUMENT']);
  });
});
