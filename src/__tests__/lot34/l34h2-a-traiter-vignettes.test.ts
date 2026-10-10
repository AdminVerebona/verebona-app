/**
 * Lot 34 (34H2), point 11 — « À traiter », vue Cartes : visuel à droite de
 * chaque carte.
 *
 *   L34-11-1 document : miniature signée fournie par la réponse de la file
 *            (mêmes vignettes que l'accueil), chargement paresseux ;
 *   L34-11-2 échéance → icône agenda ; bien / équipement / pièce → leur
 *            icône ; sinon icône générique ; document sans miniature → icône ;
 *   L34-11-3 performance : vignettes lues dans la requête d'hydratation
 *            (jointure, pas de N+1), signature mémorisée (pas par rendu),
 *            décision commune avec l'accueil ;
 *   L34-11-4 mobile : vignette plus petite (classes `sm:`), sans casser la
 *            mise en page (colonne de texte `min-w-0 flex-1`) ;
 *   L34-11-5 vue Liste inchangée (aucun visuel) ; dialogue de la mascotte
 *            inchangé.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
(globalThis as { React?: typeof React }).React = React;

const { ActionCard, ActionRow } = await import('@/components/to-process/ActionCard');
const { documentPreviews } = await import('@/services/documents/thumbnails/document-previews');
const { toPreviewRow } = await import('@/services/to-process/to-process-query.service');
const { documentThumbnailKey } = await import('@/services/documents/thumbnails/thumbnail-spec');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const noop = () => {};

type View = Parameters<typeof ActionCard>[0]['action'];
const action = (over: Partial<View> = {}, target: Partial<View['target']> = {}): View => ({
  publicId: 'a1b2c3d4-0000', targetType: 'DOCUMENT', targetId: 42, fieldKey: 'endDate', relationKey: null,
  actionKind: 'COMPLETE', priority: 'DO_NEXT', ruleCode: 'R', question: 'Quelle est la date de fin de ce contrat ?',
  proposals: [], ...over, target: { label: 'Contrat LLD', ...target },
});
const carte = (a: View, visual = true) => renderToStaticMarkup(h(ActionCard, { action: a, onChoose: noop, onOpenTarget: noop, visual }));

describe('L34-11 — visuel des cartes', () => {
  it('L34-11-1 — document avec miniature : image servie par l’URL de la file, paresseuse, à droite du contenu', () => {
    const html = carte(action({}, { thumbnailUrl: 'https://s3.example/derivatives/thumbnails/a_1/f_42/list-x.webp?X-Amz-Signature=1' }));
    expect(html).toContain('data-card-visual="thumbnail"');
    expect(html).toMatch(/<img[^>]+src="https:\/\/s3\.example\/derivatives\/thumbnails\/[^"]+"/);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    // Le visuel suit la colonne de contenu (à droite).
    expect(html.indexOf('min-w-0 flex-1')).toBeLessThan(html.indexOf('data-card-visual'));
  });

  it('L34-11-2 — sans miniature : icône de la cible (agenda, bien, équipement, pièce, document) ou générique', () => {
    const icone = (a: View) => {
      const html = carte(a);
      expect(html).toContain('data-card-visual="icon"');
      expect(html).not.toContain('<img');
      return html.slice(html.indexOf('data-card-visual'));
    };
    expect(icone(action({ targetType: 'AGENDA_ITEM' }))).toContain('lucide-calendar');
    expect(icone(action({ targetType: 'ASSET' }))).toContain('lucide-house');
    expect(icone(action({ targetType: 'EQUIPMENT' }))).toContain('lucide-wrench');
    expect(icone(action({ targetType: 'ROOM' }))).toContain('lucide-layout-grid');
    expect(icone(action({ targetType: 'SUPPLIER' }))).toContain('lucide-package');
    expect(icone(action({}, { thumbnailUrl: null }))).toContain('lucide-file-text');
    expect(icone(action({}, { thumbnailUrl: null, mimeType: 'image/jpeg' }))).toMatch(/lucide-image/);
  });

  it('L34-11-4 — mobile : vignette réduite (h-14 w-11), taille pleine à partir de `sm`', () => {
    const html = carte(action({}, { thumbnailUrl: 'https://x/t.webp' }));
    expect(html).toMatch(/class="[^"]*h-14 w-11[^"]*sm:h-\[88px\] sm:w-\[68px\]/);
    expect(html).toMatch(/class="[^"]*flex items-start gap-3 sm:gap-4/);
    const ic = carte(action({ targetType: 'AGENDA_ITEM' }));
    expect(ic).toMatch(/class="[^"]*h-11 w-11[^"]*sm:h-14 sm:w-14/);
  });

  it('L34-11-5 — vue Liste et dialogue de la mascotte inchangés (aucun visuel)', () => {
    const ligne = renderToStaticMarkup(h(ActionRow, { action: action({}, { thumbnailUrl: 'https://x/t.webp' }), onChoose: noop, onOpenTarget: noop }));
    expect(ligne).not.toContain('data-card-visual');
    expect(carte(action({}, { thumbnailUrl: 'https://x/t.webp' }), false)).not.toContain('data-card-visual');
    const file = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(file).toMatch(/<ActionCard[\s\S]*?visual\s*\/>/);
    expect(lire('src/components/home/TodoChoicesDialog.tsx')).not.toMatch(/\bvisual\b/);
  });
});

describe('L34-11-3 — performance : une requête, signatures mémorisées', () => {
  const pret = (id: number) => {
    const s3Key = `e2e/1/doc-${id}.png`;
    return {
      id, s3Key, mimeType: 'image/png', fileExtension: 'png', originalFilename: `doc-${id}.png`, isWebLink: false,
      thumbStatus: 'READY', thumbSourceKey: s3Key, thumbS3Key: documentThumbnailKey(1, id, s3Key),
      thumbAttempts: 0, thumbLeaseUntil: null, thumbUpdatedAt: new Date(),
    };
  };

  it('L34-11-3 — prête → URL signée ; absente → génération demandée ; doublon → une seule décision ; échec → icône', async () => {
    const signes: string[] = [];
    const enFile: number[] = [];
    const deps = { enabled: () => true, sign: async (k: string) => { signes.push(k); return `https://s/${k}`; }, enqueue: (id: number) => { enFile.push(id); } };
    const sansMiniature = { ...pret(2), thumbStatus: null, thumbSourceKey: null, thumbS3Key: null, thumbUpdatedAt: null };
    const out = await documentPreviews([pret(1), pret(1), sansMiniature], deps);
    expect(out.get(1)).toMatch(/^https:\/\/s\/derivatives\/thumbnails\//);
    expect(out.has(2)).toBe(false);
    expect(signes).toHaveLength(1);
    expect(enFile).toEqual([2]);
    expect((await documentPreviews([pret(1)], { ...deps, enabled: () => false })).size).toBe(0);
    expect((await documentPreviews([pret(1)], { ...deps, sign: async () => { throw new Error('config'); } })).size).toBe(0);
    expect((await documentPreviews([pret(1)], Promise.reject(new Error('import')))).size).toBe(0);
  });

  it('L34-11-3 — `toPreviewRow` : ligne d’hydratation → entrée commune (nom de fichier pour l’extension)', () => {
    const row = toPreviewRow({ ...pret(5), filename: 'scan.png' });
    expect(row.originalFilename).toBe('scan.png');
    expect(row.thumbS3Key).toContain('f_5');
  });

  it('L34-11-3 — hydratation : jointure miniature dans la requête des documents, signature par `thumbnail-url` (accueil commun)', () => {
    const q = lire('src/services/to-process/to-process-query.service.ts');
    const hydr = q.slice(q.indexOf('const documentIds = byType.get'));
    expect(hydr.slice(0, hydr.indexOf('for (const doc of docs)'))).toMatch(/\.leftJoin\(assetFileThumbnails, and\(/);
    expect(q).toContain("documentPreviews(docs.map((d) => toPreviewRow(d)), undefined, 'à traiter')");
    expect(lire('src/services/documents/thumbnails/document-previews.ts')).toContain("import('./thumbnail-url')");
    expect(lire('src/services/home/HomeSummaryService.ts')).toContain("documentPreviews(rows, depsP ?? defaultDocumentPreviewDeps(), 'accueil')");
    // La page « À traiter » seule demande les vignettes.
    expect(lire('src/app/api/v2/to-process/route.ts')).toContain('withThumbnails: true');
    expect(lire('src/services/home/mascot/collector.ts')).not.toContain('withThumbnails');
    // Aucune requête par carte côté client.
    expect(lire('src/components/to-process/ActionCard.tsx')).not.toMatch(/apiClient|fetch\(|useThumbnailUrl/);
  });
});
