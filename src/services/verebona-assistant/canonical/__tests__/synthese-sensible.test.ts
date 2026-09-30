/**
 * Relecture lot 15 — synthèse (CDC 15 T2-11) et données sensibles (§29.4) :
 * faits sensibles au registre écartés (clé canonique ou alias générique),
 * extrait de transcription masqué, puis politique de l'adaptateur appliquée.
 */
import { describe, it, expect } from 'vitest';
import { isSensitiveFact, maskedExcerpt, synthesisSourceContent } from '../synthesis-content';
import { applySensitiveDataPolicy } from '../../core/sensitive-data.policy';
import type { CanonicalDocumentState } from '../document-state';

const fait = (id: number, key: string, canonicalKey: string | null, label: string, value: string) =>
  ({ id, key, canonicalKey, label, value, unit: null, confidence: 'certain', excerpt: null });

const doc = (facts: CanonicalDocumentState['facts']): CanonicalDocumentState => ({
  fileId: 7, title: 'Attestation assurance', documentDate: '2025-02-01', documentTypeCode: null, documentTypeLabel: 'Attestation d’assurance',
  catalogCode: 'ATTESTATION_ASSURANCE', rubricCode: null, rubricLabel: null, amountCents: null, supplier: 'MAIF', analysisStatus: 'ANALYZED',
  assets: [{ assetId: 1, name: 'Maison', role: 'PRIMARY', origin: 'USER' }], facts,
} as CanonicalDocumentState);

describe('faits sensibles', () => {
  it('clé canonique sensible, alias générique résolu vers une clé sensible, clé non sensible', () => {
    expect(isSensitiveFact({ key: 'x', canonicalKey: 'insuranceClientNumber' })).toBe(true);
    expect(isSensitiveFact({ key: 'numeroSocietaire', canonicalKey: null })).toBe(true);
    expect(isSensitiveFact({ key: 'adresse', canonicalKey: null })).toBe(true);
    expect(isSensitiveFact({ key: 'coordonneesGps', canonicalKey: null })).toBe(true);
    expect(isSensitiveFact({ key: 'assureur', canonicalKey: null })).toBe(false);
    expect(isSensitiveFact({ key: 'insurer', canonicalKey: 'insurer' })).toBe(false);
    expect(isSensitiveFact({ key: 'faitLibre', canonicalKey: null })).toBe(false);
  });

  it('contenu de synthèse : valeurs sensibles absentes, faits utiles conservés, budget compté après exclusion', () => {
    const c = synthesisSourceContent(doc([
      fait(1, 'numeroClient', null, 'N° client', 'CLI-998877'),
      fait(2, 'insuranceClientNumber', 'insuranceClientNumber', 'N° de client assurance', 'SOC-123456'),
      fait(3, 'adresseBien', null, 'Adresse', '12 rue des Lilas'),
      fait(4, 'assureur', 'insurer', 'Assureur', 'MAIF'),
      fait(5, 'insurancePolicyNumber', 'insuranceContractNumber', 'N° de contrat', 'POL-42'),
    ]), null, 2);
    expect(c).not.toMatch(/CLI-998877|SOC-123456|Lilas/);
    expect(c).toContain('- Assureur : MAIF');
    expect(c).toContain('- N° de contrat : POL-42');
  });
});

describe('extrait de transcription — §29.4', () => {
  it('masqué avant d’entrer dans le contenu (secret, tiers, pièce d’identité)', () => {
    const brut = 'Contact : jean.dupont@example.com, tél 06 12 34 56 78. Digicode : 4589. Passeport n° 12AB34567.';
    const m = maskedExcerpt(brut)!;
    expect(m).not.toContain('jean.dupont@example.com');
    expect(m).not.toContain('06 12 34 56 78');
    expect(m).not.toContain('4589');
    expect(m).not.toContain('12AB34567');
    expect(maskedExcerpt(null)).toBeNull();
    // Un secret reste masqué même « nécessaire ».
    expect(maskedExcerpt('mot de passe : Hunter22!', { thirdParty: true })).not.toContain('Hunter22');
  });

  it('la source de synthèse repasse par la politique de l’adaptateur (exclusion des pièces d’identité)', () => {
    const d = { ...doc([]), title: 'Passeport', documentTypeLabel: 'Passeport' } as CanonicalDocumentState;
    const source = {
      id: 'doc_7', type: 'document_extraction' as const, title: d.title,
      content: synthesisSourceContent(d, maskedExcerpt('mail : a.b@example.org'), 5), relevanceScore: 0.8,
      meta: { documentTypeLabel: d.documentTypeLabel },
    };
    expect(source.content).not.toContain('a.b@example.org');
    const r = applySensitiveDataPolicy([source], 'Résume mes documents');
    expect(r.sources).toHaveLength(0);
    expect(r.excludedIds).toEqual(['doc_7']);
  });
});
