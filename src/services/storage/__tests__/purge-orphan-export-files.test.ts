/**
 * Script ponctuel `scripts/purge-orphan-export-files.ts` : identification des
 * exports supprimés par l'ancien DELETE (clés encore présentes).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/load-env', () => ({}));
vi.mock('@/db', () => ({ db: {} }));

const { legacyExportKeys } = await import('../../../../scripts/purge-orphan-export-files');

describe('legacyExportKeys', () => {
  it('ancien DELETE : clés conservées → retenues', () => {
    expect(legacyExportKeys(JSON.stringify({ pdfS3Key: 'exports/1/2/3/a.pdf', zipS3Key: 'exports/1/2/3/a.zip' })))
      .toEqual(['exports/1/2/3/a.pdf', 'exports/1/2/3/a.zip']);
  });

  it('nouveau DELETE (sans clé), payload vide ou illisible → rien', () => {
    expect(legacyExportKeys(JSON.stringify({ fileDeletedAt: '2026-09-28T00:00:00Z' }))).toEqual([]);
    expect(legacyExportKeys(null)).toEqual([]);
    expect(legacyExportKeys('{oops')).toEqual([]);
  });

  it('garde-fou : jamais une clé hors du préfixe exports/', () => {
    expect(legacyExportKeys(JSON.stringify({ pdfS3Key: 'assets/1/doc.pdf' }))).toEqual([]);
  });
});
