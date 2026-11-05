/**
 * Lot 111B — régénération remplaçante des dossiers V12 : identité métier
 * (≠ requestHash), statut `cancelled` exposé (ni échec ni relance), lien
 * d'historique, machine d'états de l'écran (« Régénérer », texte exact,
 * paramètre explicite `regenerate`).
 */
import { describe, it, expect } from 'vitest';
import { generationIdentityKey, REGENERATION_NOTICE } from '../generation/identity';
import { requestHash } from '../generation/enqueue';
import { normalizeGenerationStatus, toGenerationDto, legacyStatus } from '../generation/status';
import {
  buildGenerateBody, initialPrepState, isRegeneration, prepReducer, type PrepState,
} from '@/lib/exports/preparation-state';
import type { PreparationDto } from '../preparation/types';

const base = { accountId: 10, assetId: 5, exportType: 'DOSSIER_COMPLET', userId: 2 };

describe('identité métier (generationIdentityKey)', () => {
  it('format stable, identifiants seulement (repris tel quel par la migration 1195)', () => {
    expect(generationIdentityKey(base)).toBe('v1:a10:b5:tDOSSIER_COMPLET:c-:v-:u2');
    expect(generationIdentityKey({ ...base, exportType: 'ASSURANCE_SINISTRE', claimOperationId: 77 })).toBe('v1:a10:b5:tASSURANCE_SINISTRE:c77:v-:u2');
  });
  it('distingue type, bien, sinistre, utilisateur (Duo), compte et variante', () => {
    const k = generationIdentityKey(base);
    expect(generationIdentityKey({ ...base, exportType: 'VENTE' })).not.toBe(k);
    expect(generationIdentityKey({ ...base, assetId: 6 })).not.toBe(k);
    expect(generationIdentityKey({ ...base, userId: 3 })).not.toBe(k);
    expect(generationIdentityKey({ ...base, accountId: 11 })).not.toBe(k);
    expect(generationIdentityKey({ ...base, claimOperationId: 1 })).not.toBe(generationIdentityKey({ ...base, claimOperationId: 2 }));
    const v = generationIdentityKey({ ...base, variant: 'a:b c' });
    expect(v).toMatch(/^v1:a10:b5:tDOSSIER_COMPLET:c-:v[0-9a-f]{12}:u2$/);
  });
  it('ne dépend PAS des options (format, sections, pièces), contrairement à requestHash', () => {
    const pdf = requestHash('DOSSIER_COMPLET', { outputFormat: 'PDF', legacyOptions: { includePhotos: true } }, null);
    const zip = requestHash('DOSSIER_COMPLET', { outputFormat: 'ZIP', legacyOptions: { includePhotos: false } }, null);
    expect(pdf).not.toBe(zip);
    // L'identité ne reçoit aucune option : la même pour les deux demandes.
    expect(generationIdentityKey(base)).toBe(generationIdentityKey({ ...base }));
  });
});

describe('statut cancelled (remplacée)', () => {
  it('motif présent → cancelled, y compris pendant l’arrêt (annulation demandée, encore generating)', () => {
    expect(normalizeGenerationStatus('cancelled', null, new Date(), { reason: 'REPLACED_BY_NEW_GENERATION' })).toBe('cancelled');
    expect(normalizeGenerationStatus('generating', null, new Date(), { reason: 'REPLACED_BY_NEW_GENERATION', requestedAt: new Date() })).toBe('cancelled');
    expect(legacyStatus('cancelled')).toBe('cancelled');
  });
  it('ancienne ligne `cancelled` sans motif : présentée en échec comme avant (aucune régression)', () => {
    expect(normalizeGenerationStatus('cancelled')).toBe('failed');
  });
  it('archives prêtes conservées : un motif sur une ligne ready n’en change pas le statut', () => {
    expect(normalizeGenerationStatus('ready', new Date(Date.now() + 86_400_000), new Date(), { reason: 'REPLACED_BY_NEW_GENERATION' })).toBe('ready');
  });
  it('DTO : libellé, lien et référence de la nouvelle génération ; ni téléchargement ni message d’erreur', () => {
    const dto = toGenerationDto({
      id: 41, publicId: 'old', exportType: 'DOSSIER_COMPLET', status: 'cancelled', userId: 2, createdAt: '2026-11-05T08:00:00Z',
      cancelReason: 'REPLACED_BY_NEW_GENERATION', cancelRequestedAt: '2026-11-05T08:01:00Z', cancelledAt: '2026-11-05T08:01:02Z', replacedByGenerationId: 42,
      outputPayload: JSON.stringify({ pdfS3Key: 'x' }),
    }, { replacement: { id: 42, publicId: 'new', exportType: 'DOSSIER_COMPLET', createdAt: '2026-11-05T08:01:00Z' } });
    expect(dto.generationStatus).toBe('cancelled');
    expect(dto.errorMessage).toBeNull();
    expect(dto.errorCode).toBeNull();
    expect(dto.downloadUrl).toBeNull();
    expect(dto.cancellation).toMatchObject({
      reason: 'REPLACED_BY_NEW_GENERATION', label: 'Annulé — Remplacé par la génération', effective: true,
      replacedBy: { publicId: 'new', reference: 'VBN-COMPLET-20261105-000042' },
    });
  });
});

const prep = (over: Partial<PreparationDto> = {}) => ({
  assetId: 5, exportType: 'DOSSIER_COMPLET', status: 'ready_pristine',
  dossier: { code: 'DOSSIER_COMPLET', label: 'Dossier complet', shortLabel: 'Complet', description: '', templateVersion: 'v1' },
  asset: { id: 5, name: 'Maison', family: 'IMMOBILIER', familyLabel: 'Immobilier', categoryLabel: null },
  eligibility: { status: 'ready', message: null }, lastGeneration: null, sections: [], photoCap: 12,
  additionalInfo: { sections: [], updatedAt: null }, cil: null,
  estimate: { blocking: [], warnings: [], zipOnlyItems: [], outputFormat: 'PDF' },
  actions: { canGeneratePdf: true, canGenerateZip: false }, messages: [], ...over,
}) as unknown as PreparationDto;

describe('écran de préparation : régénération explicite', () => {
  it('première demande : corps inchangé (aucun paramètre regenerate)', () => {
    const s = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep: prep() });
    expect(isRegeneration(s)).toBe(false);
    expect(buildGenerateBody(s, 'PDF')).not.toHaveProperty('regenerate');
  });
  it('génération active du même dossier à l’ouverture → « Régénérer », regenerate: true', () => {
    const s = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep: prep({ activeGeneration: { publicId: 'g1', status: 'generating', createdAt: '2026-11-05T08:00:00Z' } }) });
    expect(s.replacing).toEqual({ publicId: 'g1' });
    expect(buildGenerateBody(s, 'ZIP')).toMatchObject({ regenerate: true, choices: { outputFormat: 'ZIP' } });
  });
  it('« Modifier et régénérer » pendant une génération, puis la nouvelle devient la génération suivie', () => {
    let s: PrepState = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep: prep() });
    s = prepReducer(s, { type: 'GENERATE_START', format: 'PDF', now: 1 });
    s = prepReducer(s, { type: 'GENERATE_ACCEPTED', publicId: 'g1', generationStatus: 'queued' });
    s = prepReducer(s, { type: 'EDIT_AND_REGENERATE' });
    expect(s.status).toBe('ready_modified');
    expect(s.replacing).toEqual({ publicId: 'g1' });
    s = prepReducer(s, { type: 'GENERATE_START', format: 'PDF', now: 2 });
    expect(buildGenerateBody({ ...s, replacing: { publicId: 'g1' } }, 'PDF')).toHaveProperty('regenerate', true);
    s = prepReducer(s, { type: 'GENERATE_ACCEPTED', publicId: 'g2', generationStatus: 'queued' });
    expect(s.replacing).toBeNull();
  });
  it('génération suivie remplacée ailleurs → état « replaced » (pas une erreur)', () => {
    let s: PrepState = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep: prep() });
    s = prepReducer(s, { type: 'GENERATE_START', format: 'PDF', now: 1 });
    s = prepReducer(s, { type: 'GENERATE_ACCEPTED', publicId: 'g1', generationStatus: 'queued' });
    s = prepReducer(s, { type: 'GENERATION_UPDATE', dto: { generationStatus: 'cancelled' } });
    expect(s.status).toBe('replaced');
    expect(s.error).toBeNull();
  });
  it('texte UX exact', () => {
    expect(REGENERATION_NOTICE).toBe('La génération précédente sera remplacée par cette nouvelle version.');
  });
});
