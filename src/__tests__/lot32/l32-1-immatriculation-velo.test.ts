/**
 * L32-1 — « Quel est le numéro d’immatriculation de ce bien ? — Vélo Jean
 * Fourche — RK469970GP » : « La valeur n’a pas pu être appliquée. »
 *
 * Causes racines (voir `asset-field-cards.ts`) :
 *   1. aucune carte de donnée de BIEN (pont réconciliation) n'avait
 *      d'écrivain → FIELD_NOT_RESOLVABLE pour tout bien ;
 *   2. l'immatriculation ne s'applique pas à un vélo : la carte n'aurait
 *      jamais dû être produite.
 * Ici : parties pures (registre, capacité, planification d'écriture,
 * messages). Le parcours complet, sur base réelle : `l32-a-traiter-mascotte.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assetHasRegistration, UNREGISTERED_VEHICLE_CATEGORIES } from '@/lib/asset-capabilities';
import { getField, isFieldApplicableToAsset } from '@/services/canonical/registry';
import { planCanonicalWrites } from '@/services/canonical/asset-state/write-canonical-asset-field';
import { RESOLVE_DEFAULT_ERROR, resolveErrorClosesCard, resolveErrorMessage } from '@/lib/to-process-resolve-errors';
import { getRule } from '@/services/to-process/rules-catalog';
import { isAssetFieldCard } from '@/services/to-process/asset-field-cards';

const velo = { category: 'VEHICULE', subtype: 'Vélo' };
const voiture = { category: 'VEHICULE', subtype: 'Voiture' };

describe('L32-1 — applicabilité de l’immatriculation (catégorie)', () => {
  it('L32-1 — un vélo (et VTT, trottinette) n’a pas d’immatriculation ; une voiture, une moto, si', () => {
    expect(assetHasRegistration(velo)).toBe(false);
    expect(assetHasRegistration({ category: 'VEHICULE', subtype: 'velo' })).toBe(false);
    expect(assetHasRegistration({ category: 'VEHICULE', subtype: 'VTT' })).toBe(false);
    expect(assetHasRegistration({ category: 'VEHICULE', subtype: 'Trottinette' })).toBe(false);
    expect(assetHasRegistration(voiture)).toBe(true);
    expect(assetHasRegistration({ category: 'VEHICULE', subtype: 'Moto' })).toBe(true);
    expect(assetHasRegistration({ category: 'VEHICULE', subtype: null })).toBe(true);
    expect(assetHasRegistration({ category: 'IMMOBILIER', subtype: 'Maison' })).toBe(false);
    expect(UNREGISTERED_VEHICLE_CATEGORIES).toContain('Vélo');
  });

  it('L32-1 — registre : immatriculation (clé, alias), date de 1re immatriculation et fin de validité sans objet pour un vélo', () => {
    for (const k of ['registrationNumber', 'immatriculation', 'plaque', 'firstRegistrationDate', 'registrationExpiry']) {
      expect(isFieldApplicableToAsset(k, velo)).toBe(false);
      expect(isFieldApplicableToAsset(k, voiture)).toBe(true);
    }
    // Les autres champs du vélo restent applicables ; famille toujours contrôlée.
    expect(isFieldApplicableToAsset('acquisitionPrice', velo)).toBe(true);
    expect(isFieldApplicableToAsset('make', velo)).toBe(true);
    expect(isFieldApplicableToAsset('registrationNumber', { category: 'OBJECT', subtype: null })).toBe(false);
    expect(isFieldApplicableToAsset('cleInconnue', velo)).toBe(true);
    expect(getField('registrationNumber')?.requiresCapability).toBe('registration');
  });

  it('L32-1 — écriture canonique : refusée à une origine automatique sur un vélo, libre pour la saisie humaine', () => {
    const row = { id: 1, account_id: 2, category: 'VEHICULE', subtype: 'Vélo', key_characteristics: '{}' };
    const auto = planCanonicalWrites(row, [{ key: 'registrationNumber', value: 'RK469970GP' }], { origin: 'RECONCILIATION', now: '2026-10-07T10:00:00Z' });
    expect(auto.results[0]).toMatchObject({ outcome: 'invalid', reason: 'FIELD_NOT_APPLICABLE' });
    expect(auto.changed).toBe(false);
    const humain = planCanonicalWrites(row, [{ key: 'registrationNumber', value: 'AB-123-CD' }], { origin: 'USER', now: '2026-10-07T10:00:00Z' });
    expect(humain.results[0].outcome).toBe('written');
    const auto2 = planCanonicalWrites({ ...row, subtype: 'Voiture' }, [{ key: 'registrationNumber', value: 'ab-123-cd' }], { origin: 'RECONCILIATION', now: '2026-10-07T10:00:00Z' });
    expect(auto2.results[0]).toMatchObject({ outcome: 'written', nextValue: 'AB-123-CD' });
  });
});

describe('L32-1 — résolution des cartes de donnée de bien', () => {
  it('L32-1 — DATA-REGISTRATION et DATA-ACQUISITION-PRICE ont désormais un écrivain (primitive canonique)', () => {
    for (const code of ['DATA-REGISTRATION', 'DATA-ACQUISITION-PRICE']) {
      const r = getRule(code)!;
      expect(isAssetFieldCard({ targetType: 'ASSET', ruleCode: code, fieldKey: r.fieldKey! })).toBe(true);
    }
    expect(isAssetFieldCard({ targetType: 'ASSET', ruleCode: 'MIG-REVIEW', fieldKey: 'x' })).toBe(false);
    expect(isAssetFieldCard({ targetType: 'DOCUMENT', ruleCode: 'DOC-TYP', fieldKey: 'documentTypeCode' })).toBe(false);
    const src = readFileSync(join(process.cwd(), 'src/services/to-process/resolve-action.service.ts'), 'utf8');
    expect(src).toMatch(/isAssetFieldCard\(action\)\) return resolveAssetFieldCard/);
    expect(src).toMatch(/isAssetFieldCard\(action\)\) return undoAssetFieldCard/);
  });

  it('L32-1 — un refus porte un message utile (plus jamais le seul « n’a pas pu être appliquée »)', () => {
    expect(resolveErrorMessage('FIELD_NOT_APPLICABLE')).toBe('Cette information ne s’applique pas à ce bien : la carte a été retirée.');
    expect(resolveErrorMessage('ALREADY_RESOLVED')).toBe('Cette action a déjà été traitée.');
    expect(resolveErrorMessage('INVALID_VALUE')).toMatch(/pas valide/);
    expect(resolveErrorMessage('FIELD_NOT_RESOLVABLE')).toMatch(/ouvrez l’élément/);
    expect(resolveErrorMessage(null)).toBe(RESOLVE_DEFAULT_ERROR);
    expect(resolveErrorClosesCard('FIELD_NOT_APPLICABLE')).toBe(true);
    expect(resolveErrorClosesCard('INVALID_VALUE')).toBe(false);
    const route = readFileSync(join(process.cwd(), 'src/app/api/v2/to-process/[publicId]/resolve/route.ts'), 'utf8');
    expect(route).toContain('message: resolveErrorMessage(result.error)');
    const queue = readFileSync(join(process.cwd(), 'src/components/to-process/useToProcessResolution.ts'), 'utf8');
    expect(queue).toContain('resolveErrorMessage(code)');
    expect(queue).not.toContain('La valeur n’a pas pu être appliquée.');
  });

  it('L32-1 — producteur corrigé à chaque étage : collecte des preuves, pont, balayage, migration 0270, fiche', () => {
    const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
    expect(lire('src/services/ai/reconciliation/evidence-collector.ts')).toContain('isFieldApplicableToAsset(fieldKey');
    expect(lire('src/services/to-process/reconciliation-bridge.ts')).toContain("reason: 'FIELD_NOT_APPLICABLE'");
    expect(lire('src/services/to-process/to-process-scan.job.ts')).toContain('closeInapplicableAssetFieldActions(compte.id)');
    const mig = lire('src/db/migrations/0270_to_process_registration_non_applicable.sql');
    expect(mig).toContain("'velo', 'vtt', 'trottinette'");
    expect(mig).toContain("resolution_reason = 'OBSOLETE'");
    expect(lire('src/components/assets/AssetDetailsTab.tsx')).toContain('assetHasRegistration(');
  });
});
