/**
 * VER-007, WF-26 : navigation client interceptée quand des saisies ne sont
 * pas enregistrées.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { internalHref } from '../useUnsavedNavigationGuard';

const LOC = { origin: 'https://bo.verebona.fr', href: 'https://bo.verebona.fr/admin/ai-config?v=3' };
const click = (over: Partial<MouseEvent> = {}) => ({
  button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over,
}) as MouseEvent;
const a = (href: string, target = '', download = false) => ({ href, target, hasAttribute: (n: string) => n === 'download' && download });

describe('interception des liens internes (WF-26)', () => {
  it('lien du menu admin : intercepté', () => {
    expect(internalHref(click(), a('/admin/ai-costs'), LOC)).toBe('/admin/ai-costs');
  });
  it('nouvel onglet, lien externe, téléchargement, ancre de la même page : laissés passer', () => {
    expect(internalHref(click({ metaKey: true }), a('/admin/ai-costs'), LOC)).toBeNull();
    expect(internalHref(click(), a('/admin/ai-costs', '_blank'), LOC)).toBeNull();
    expect(internalHref(click(), a('https://ai.google.dev/pricing'), LOC)).toBeNull();
    expect(internalHref(click(), a('/admin/x.json', '', true), LOC)).toBeNull();
    expect(internalHref(click(), a('/admin/ai-config?v=3#t2'), LOC)).toBeNull();
    expect(internalHref(click(), null, LOC)).toBeNull();
  });
  it('la page de configuration IA branche la garde', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/admin/ai-config/page.tsx'), 'utf8');
    expect(src).toMatch(/useUnsavedNavigationGuard\(dirty\.size > 0/);
    expect(src).toMatch(/forEach\(resetTreatment\)/);
  });
});
