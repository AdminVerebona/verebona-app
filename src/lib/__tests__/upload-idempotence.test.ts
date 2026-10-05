/**
 * APP-PERF-30 — contrat d'idempotence du dépôt (décisions pures).
 */
import { describe, it, expect } from 'vitest';
import {
  deciderConfirm, deciderPresignRejoue, empreinteConfirm, empreintePresign, estCleOperation,
} from '../upload-idempotence';

const OP = '3f0c6a5e-8a59-4c39-9d2b-0d7e5f1c2a11';

describe('clé d’opération', () => {
  it('UUID accepté ; vide, trop courte, espaces refusés', () => {
    expect(estCleOperation(OP)).toBe(true);
    expect(estCleOperation('')).toBe(false);
    expect(estCleOperation('abc')).toBe(false);
    expect(estCleOperation('a b c d e f g h i j k l')).toBe(false);
    expect(estCleOperation(42)).toBe(false);
  });
});

describe('empreintes', () => {
  it('confirm : normalisation (undefined, chaîne vide, 0 → null ; ordre des clés indifférent)', () => {
    const a = empreinteConfirm({ assetId: 0, documentType: 'FACTURE', description: '', amountCents: undefined });
    const b = empreinteConfirm({ documentType: 'FACTURE', assetId: null });
    expect(a).toBe(b);
    expect(empreinteConfirm({ assetId: '12' })).toBe(empreinteConfirm({ assetId: 12 }));
    expect(empreinteConfirm({ supplier: 'EDF' })).not.toBe(empreinteConfirm({ supplier: 'Engie' }));
  });

  it('presign : une seule différence (taille, empreinte, bien, compte) change l’empreinte', () => {
    const base = { accountId: 1, assetId: null, filename: 'a.pdf', mimeType: 'application/pdf', size: 10, sha256Hash: 'a'.repeat(64) };
    const e = empreintePresign(base);
    for (const over of [{ size: 11 }, { sha256Hash: 'b'.repeat(64) }, { assetId: 3 }, { accountId: 2 }, { filename: 'b.pdf' }]) {
      expect(empreintePresign({ ...base, ...over })).not.toBe(e);
    }
    expect(empreintePresign({ ...base })).toBe(e);
  });
});

const ligne = (over: Record<string, unknown> = {}) => ({
  uploadStatus: 'PENDING', deletedAt: null, uploadOperationId: OP, uploadRequestFingerprint: 'P', confirmFingerprint: null, ...over,
}) as Parameters<typeof deciderConfirm>[0];

describe('presign rejoué', () => {
  it('même demande, en attente : même ligne (nouvelle URL)', () => {
    expect(deciderPresignRejoue(ligne(), 'P')).toEqual({ kind: 'pending' });
  });
  it('même demande, déjà confirmé : pas de nouvel envoi', () => {
    expect(deciderPresignRejoue(ligne({ uploadStatus: 'COMPLETED' }), 'P')).toEqual({ kind: 'completed' });
  });
  it('même clé, autre demande : 409', () => {
    expect(deciderPresignRejoue(ligne(), 'AUTRE')).toMatchObject({ kind: 'refus', code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });
  it('dépôt écarté : opération close', () => {
    expect(deciderPresignRejoue(ligne({ deletedAt: new Date() }), 'P')).toMatchObject({ kind: 'refus', code: 'OPERATION_CLOSED' });
  });
});

describe('confirm', () => {
  it('PENDING : nouvelle confirmation', () => {
    expect(deciderConfirm(ligne({ uploadOperationId: null }), null, 'C')).toEqual({ kind: 'nouvelle' });
    expect(deciderConfirm(ligne(), OP, 'C')).toEqual({ kind: 'nouvelle' });
  });

  it('réponse perdue puis rejeu identique : le résultat existant est rendu (CA-01)', () => {
    expect(deciderConfirm(ligne({ uploadStatus: 'COMPLETED', confirmFingerprint: 'C' }), OP, 'C')).toEqual({ kind: 'deja_confirme' });
  });

  it('rejeu avec d’autres métadonnées : 409, rien n’est réécrit', () => {
    expect(deciderConfirm(ligne({ uploadStatus: 'COMPLETED', confirmFingerprint: 'C' }), OP, 'X'))
      .toMatchObject({ kind: 'refus', code: 'IDEMPOTENCY_PAYLOAD_MISMATCH', status: 409 });
  });

  it('clé d’une autre opération : 409', () => {
    expect(deciderConfirm(ligne(), 'ffffffff-8a59-4c39-9d2b-0d7e5f1c2a11', 'C'))
      .toMatchObject({ kind: 'refus', code: 'IDEMPOTENCY_KEY_MISMATCH' });
  });

  it('sans clé, déjà confirmé : INVALID_STATUS (contrat antérieur inchangé)', () => {
    expect(deciderConfirm(ligne({ uploadStatus: 'COMPLETED' }), null, 'C')).toMatchObject({ kind: 'refus', code: 'INVALID_STATUS', status: 400 });
  });

  it('ligne écartée : jamais reconfirmée', () => {
    expect(deciderConfirm(ligne({ deletedAt: new Date() }), OP, 'C')).toMatchObject({ kind: 'refus', code: 'FILE_DISCARDED' });
  });
});
