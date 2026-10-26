/**
 * Champ Verebona — contexte de la page courante (§5) et animation de la
 * mascotte (§12bis).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPageContext, pageAreaOf } from '../page-context';
import { enrichPageContext } from '@/lib/help-center/screens';
import { sanitizePageContext } from '@/services/verebona-assistant/core/page-context';
import { mascotSrc, nextPoseMotion, poseAnimation } from '../mascot-motion';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('contexte de page transmis à l’assistant (§5)', () => {
  it('rubrique de chaque page', () => {
    expect(pageAreaOf('/accueil')).toBe('home');
    expect(pageAreaOf('/accueil/a-traiter')).toBe('to_process');
    expect(pageAreaOf('/assets')).toBe('assets');
    expect(pageAreaOf('/assets/42?tab=details')).toBe('asset');
    expect(pageAreaOf('/agenda')).toBe('agenda');
    expect(pageAreaOf('/documents/7')).toBe('document');
    expect(pageAreaOf('/admin')).toBe('other');
  });

  it('la route sans paramètres ; le bien de la fiche est extrait, le serveur revalide', () => {
    const ctx = buildPageContext('/assets/42?tab=details');
    expect(ctx).toEqual({ route: '/assets/42', area: 'asset' });
    const enrichi = enrichPageContext(ctx, 'web');
    expect(enrichi).toMatchObject({ route: '/assets/42', assetId: '42', platform: 'web' });
    // Côté serveur, seuls les champs autorisés sont retenus.
    expect(sanitizePageContext(enrichi)).toEqual({ route: '/assets/42', assetId: '42', platform: 'web' });
  });

  it('le même champ, sur toutes les pages, envoie le contexte de la page courante', () => {
    const provider = read('src/components/verebona/space/VerebonaSpaceProvider.tsx');
    expect(provider).toMatch(/const pageContext = useMemo\(\(\) => buildPageContext\(pathname\), \[pathname\]\)/);
    expect(provider).toMatch(/useVerebona\(pageContext,/);
    const layout = read('src/components/DashboardLayout.tsx');
    expect(layout).toMatch(/<VerebonaSpaceProvider/);
    expect(layout).not.toMatch(/VerebonaDrawer/);
    expect(layout).not.toMatch(/MobileSearchOverlay/);
  });
});

describe('animation de la mascotte (§12bis)', () => {
  it('rejouée uniquement quand la pose change, en alternant deux keyframes', () => {
    const a = nextPoseMotion(null, 'welcome-wave');
    expect(poseAnimation(a, false)).toMatch(/^vb-pose-a 0\.55s cubic-bezier\(\.16,1,\.3,1\) both$/);
    const same = nextPoseMotion(a, 'welcome-wave');
    expect(same).toBe(a); // même pose : rien ne bouge
    const b = nextPoseMotion(same, 'search-loupe');
    expect(poseAnimation(b, false)).toMatch(/^vb-pose-b /);
    const c = nextPoseMotion(b, 'property-house');
    expect(poseAnimation(c, false)).toMatch(/^vb-pose-a /);
  });

  it('mouvement réduit : aucune animation', () => {
    expect(poseAnimation(nextPoseMotion(null, 'x'), true)).toBe('none');
  });

  it('les poses existent dans public/mascot', () => {
    for (const pose of ['welcome-wave', 'search-loupe', 'property-house', 'info-card', 'document-analysis-pdf', 'reminder-bell', 'thumbs-up', 'dialogue-bubble', 'questioning', 'success-check', 'neutral']) {
      expect(() => readFileSync(join(process.cwd(), 'public', mascotSrc(pose)))).not.toThrow();
    }
  });

  it('le CSS global suit « prefers-reduced-motion » et déclare les deux keyframes', () => {
    const css = read('src/app/globals.css');
    expect(css).toMatch(/@keyframes vb-pose-a/);
    expect(css).toMatch(/@keyframes vb-pose-b/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-iteration-count: 1 !important/);
  });
});
