/**
 * Lot 32 — L32-6 (compteur « À traiter » du menu), L32-10 (pastilles
 * « action à faire » des biens retirées), PO20 (formulation naturelle des
 * sujets MASC-BLOCKED et MASC-EXT-ACTION).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  usePathname: () => '/assets',
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
(globalThis as { React?: typeof React }).React = React;

import { TO_PROCESS_COUNT_EVENT, TO_PROCESS_REFRESH_EVENTS } from '@/hooks/useToProcessCount';
import { AssetCard } from '@/components/dashboard/AssetCard';
import { HomeAssets } from '@/components/home/HomeBlocks';
import { deadlineBlockedText, deadlineExtActionText } from '@/services/home/mascot/deadline-label';
import { buildCandidates, type MascotAgendaRow, type MascotRawData } from '@/services/home/mascot/signals';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L32-6 — compteur « À traiter » du menu', () => {
  it('L32-6 — relu après toute écriture et chaque événement métier (résolution, création, analyse, échéance)', () => {
    for (const e of ['refresh-a-traiter', 'verebona:data-mutated', 'document-analysis-complete', 'agenda-mutated', 'document-added', 'document-deleted']) {
      expect(TO_PROCESS_REFRESH_EVENTS).toContain(e);
    }
    const hook = lire('src/hooks/useToProcessCount.ts');
    expect(hook).toContain("document.addEventListener('visibilitychange', onVisible)");
    // Aucun cache client : la route du compteur reste sans cache navigateur.
    expect(lire('src/app/api/to-process/route.ts')).toContain("'Cache-Control': 'private, no-cache'");
  });

  it('L32-6 — la page publie son total à la pastille (desktop + barre mobile) à chaque lecture : même nombre, même instant', () => {
    const file = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(file).toContain('new CustomEvent(TO_PROCESS_COUNT_EVENT, { detail: data.total })');
    expect(TO_PROCESS_COUNT_EVENT).toBe('update-a-traiter-count');
    // Une seule source de la pastille pour la coquille : desktop et mobile reçoivent la même valeur.
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout).toContain('useToProcessCount(userId)');
  });

  it('L32-6 — toute résolution (file ou mascotte) émet la synchronisation sans rechargement', () => {
    const res = lire('src/components/to-process/useToProcessResolution.ts');
    expect(res.match(/notifyToProcessChanged\(\)/g)!.length).toBeGreaterThanOrEqual(4);
    expect(res).not.toContain('location.reload');
  });
});

describe('L32-10 — pastilles « action à faire » des biens', () => {
  it('L32-10 — carte de bien (AssetCard) : plus de pastille, même avec des actions', () => {
    const html = renderToStaticMarkup(h(AssetCard, { id: 1, name: 'Vélo Jean Fourche', category: 'VEHICULE', subtype: 'Vélo', todoCount: 3, documentCount: 2 }));
    expect(html).toContain('Vélo Jean Fourche');
    expect(html).not.toMatch(/actions? à faire/);
  });

  it('L32-10 — tuiles « Mes biens » de l’accueil : plus de pastille', () => {
    const html = renderToStaticMarkup(h(HomeAssets, {
      onAddAsset: () => {},
      assets: [{ id: 1, name: 'Ferrari', category: 'VEHICULE', subtype: 'Voiture', status: 'EN_SERVICE', thumbnailUrl: null, signedThumbnailUrl: null, documentCount: 4, documentLabels: [], todoCount: 5 }],
    }));
    expect(html).toContain('Ferrari');
    expect(html).not.toMatch(/actions? à faire/);
  });

  it('L32-10 — nulle part ailleurs (liste Mes biens, fiche)', () => {
    for (const f of ['src/app/(dashboard)/assets/page.tsx', 'src/components/home/HomeBlocks.tsx', 'src/components/dashboard/AssetCard.tsx']) {
      expect(lire(f)).not.toMatch(/'1 action à faire'|actions à faire`/);
    }
  });
});

describe('PO20 — formulation naturelle (MASC-BLOCKED, MASC-EXT-ACTION)', () => {
  const cupra = { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture' };

  it('PO20 — MASC-BLOCKED : libellé naturel, jamais le titre technique entre guillemets', () => {
    expect(deadlineBlockedText(cupra, '18 avril 2028'))
      .toBe('Une échéance doit être précisée avant de pouvoir être suivie : le contrôle technique de la Cupra, le 18 avril 2028.');
    expect(deadlineBlockedText({ title: 'Audit énergétique', assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison' }, '2 mai 2026'))
      .toBe('Une échéance doit être précisée avant de pouvoir être suivie : Audit énergétique de la maison, le 2 mai 2026.');
  });

  it('PO20 — MASC-EXT-ACTION : passée / du jour, accord du genre, repli neutre sans article deviné', () => {
    expect(deadlineExtActionText(cupra, '18 avril 2028', true))
      .toBe('Le contrôle technique de la Cupra était prévu le 18 avril 2028. Si c’est fait, vous pouvez l’indiquer.');
    expect(deadlineExtActionText({ title: 'Vidange Clio', assetName: 'Clio', assetCategory: 'VEHICULE', assetSubtype: 'Voiture' }, '7 octobre 2026', false))
      .toBe('La vidange de la Clio est prévue aujourd’hui, le 7 octobre 2026. Une fois que c’est fait, vous pouvez l’indiquer.');
    expect(deadlineExtActionText({ title: 'Audit énergétique', assetName: 'Polo' }, '1er octobre 2026', true))
      .toBe('Votre échéance du 1er octobre 2026 concerne Polo : Audit énergétique. Si c’est fait, vous pouvez l’indiquer.');
    expect(deadlineExtActionText({ title: 'Audit', assetName: null }, '1er octobre 2026', true))
      .toBe('Votre échéance du 1er octobre 2026 : Audit. Si c’est fait, vous pouvez l’indiquer.');
  });

  it('PO20 — dans le moteur : aucun texte ni libellé secondaire ne cite le titre brut entre guillemets', () => {
    const agenda = (o: Partial<MascotAgendaRow>): MascotAgendaRow => ({
      id: 1, title: cupra.title, date: '2026-10-01', forecast: false, requiresQualification: false,
      assetId: 2, assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture', ...o,
    });
    const raw: MascotRawData = {
      accountId: 7, today: '2026-10-07', processing: { uploads: [], analyses: [], exports: [] },
      onboarding: { activeAssets: [{ id: 2, name: 'Cupra' }], activeAssetCount: 1, documentCount: 3 },
      toProcess: [], agenda: [agenda({ id: 1 }), agenda({ id: 2, requiresQualification: true })], acknowledgments: [],
    };
    const c = buildCandidates(raw).candidates.filter((s) => s.sourceCode === 'MASC-EXT-ACTION' || s.sourceCode === 'MASC-BLOCKED');
    expect(c.map((s) => s.sourceCode).sort()).toEqual(['MASC-BLOCKED', 'MASC-EXT-ACTION']);
    for (const s of c) {
      expect(s.fallbackText).not.toContain('CUPRA LEON');
      expect(s.fallbackText).not.toContain('«');
      expect(s.secondaryLabel).not.toContain('CUPRA LEON');
      expect(s.fallbackText).toContain(s.allowedHighlight!);
    }
    expect(c.find((s) => s.sourceCode === 'MASC-EXT-ACTION')!.secondaryLabel).toBe('Contrôle technique : c’est fait ?');
    expect(c.find((s) => s.sourceCode === 'MASC-BLOCKED')!.secondaryLabel).toBe('Préciser « Contrôle technique »');
  });
});
