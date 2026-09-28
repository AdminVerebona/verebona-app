/**
 * Annexe dont l'apposition échoue malgré l'inspection stricte : la pièce est
 * marquée « corrupted » et le dossier est RE-RENDU sans elle — elle disparaît
 * de l'index et de la pagination (jamais de page d'annexe vide), la
 * génération devient partielle.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeSource, doc, TODAY } from './fixtures/sources';

vi.mock('../render/media', () => ({
  fileSize: async () => 1000,
  resolveFiles: async ({ documents }: { documents: Array<{ doc: { id: number } }> }) => ({
    documents: new Map(documents.map(({ doc: d }) => [d.id, {
      id: d.id, status: 'ok', pages: 1, localPath: `/tmp/doc-${d.id}.pdf`, boxes: [{ width: 595, height: 842, rotation: 0 }],
    }])),
    photos: new Map(),
  }),
}));
const printCalls: Array<{ annexes: Array<{ annexRef: string }>; html: string }> = [];
vi.mock('../render/render-pdf', () => ({
  printDossier: async (p: { annexes: Array<{ annexRef: string; pageCount: number }>; build: (m: unknown) => { html: string } }) => {
    const total = 8 + p.annexes.length;
    const annexStart = Object.fromEntries(p.annexes.map((a, i) => [a.annexRef, total - p.annexes.length + i]));
    const pageMap = { total, annexStart };
    printCalls.push({ annexes: p.annexes, html: p.build(pageMap).html });
    return { pdf: Buffer.from('%PDF'), pageCount: total, pageMap, frames: [], pageSizes: [], passes: 2 };
  },
}));
let overlayCall = 0;
const failedPaths: string[] = [];
vi.mock('../render/annexes', () => ({
  applyAnnexOverlays: async (p: { annexes: Array<{ annexRef: string; pdfPath?: string }> }) => {
    overlayCall++;
    if (overlayCall === 1) {
      failedPaths.push(p.annexes[0].pdfPath!);
      return { pdf: Buffer.from('%PDF'), failed: [p.annexes[0].annexRef] };
    }
    return { pdf: Buffer.from('%PDF-final'), failed: [] };
  },
}));

describe('renderDossier — apposition en échec', () => {
  it('re-rend le dossier sans la pièce : index, pagination et traçabilité justes', async () => {
    const { renderDossier } = await import('../render/render-dossier');
    const { parseChoicesPayload } = await import('../data/choices');
    const source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      documents: [
        doc({ id: 1, kind: 'DPE', title: 'Diagnostic énergétique' }),
        doc({ id: 2, kind: 'FACTURE', title: 'Facture chaudière' }),
      ],
    });
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', {
      outputFormat: 'PDF', items: [1, 2].map((id) => ({ sourceType: 'document', sourceId: id, selected: true, mode: 'PDF' })),
    });
    if (!parsed.ok) throw new Error('payload');
    const r = await renderDossier({
      code: 'DOSSIER_COMPLET', source, choices: parsed.choices, today: TODAY, workDir: '/tmp/none',
      meta: { reference: 'VBN-X', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire' },
    });
    expect(printCalls).toHaveLength(2);
    expect(printCalls[0].annexes).toHaveLength(2);
    expect(printCalls[1].annexes).toHaveLength(1);
    const failedId = Number(/doc-(\d+)\.pdf/.exec(failedPaths[0])![1]);
    const failedTitle = failedId === 1 ? 'Diagnostic énergétique' : 'Facture chaudière';
    const keptTitle = failedId === 1 ? 'Facture chaudière' : 'Diagnostic énergétique';
    expect(printCalls[1].html).not.toContain(failedTitle);
    expect(printCalls[1].html).toContain(keptTitle);
    expect(r.pdf.toString()).toBe('%PDF-final');
    expect(r.partial).toBe(true);
    expect(r.counts.integratedPdf).toBe(1);
    expect(r.items.find((i) => i.sourceType === 'document' && i.sourceId === failedId)).toMatchObject({ status: 'excluded', reason: 'corrupted' });
  });
});
