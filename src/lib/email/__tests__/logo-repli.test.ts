/**
 * APP-PERF-38 T-02 — logo d'en-tête des emails : absent ou SVG → ressource
 * maîtrisée servie par l'application, plus jamais un stockage Supabase hérité.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {} }));
vi.mock('@/lib/notifications/channel-activation', () => ({ isTransactionalEmailActive: async () => true }));

const { EMAIL_LOGO_FALLBACK_PATH, resolveEmailLogoUrl, emailService } = await import('../email-service');

const REPLI = 'https://app.exemple.fr/brand/verebona-logo-email.png';
type Wrap = { wrapInHTML(b: string, s: unknown, l: { type: string; content: string }): Promise<string> };

describe('logo des emails — repli maîtrisé', () => {
  it('candidate absente, vide ou SVG (y compris avec paramètres) : repli', () => {
    for (const c of [null, undefined, '', '  ', 'https://cdn.exemple.fr/logo.svg', 'https://cdn.exemple.fr/logo.SVG?v=2', 'data:image/svg+xml;base64,AAA']) {
      expect(resolveEmailLogoUrl(c, REPLI), String(c)).toBe(REPLI);
    }
    expect(resolveEmailLogoUrl('https://cdn.exemple.fr/logo.png', REPLI)).toBe('https://cdn.exemple.fr/logo.png');
  });

  it('la ressource de repli existe dans public/ et est un PNG', () => {
    const f = join(process.cwd(), 'public', EMAIL_LOGO_FALLBACK_PATH);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f).subarray(1, 4).toString()).toBe('PNG');
  });

  it('rendu : logo SVG ou absent → URL absolue de l’application, aucun domaine Supabase', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.exemple.fr';
    const w = emailService as unknown as Wrap;
    for (const content of ['', '/brand/verebona-logo.svg']) {
      const html = await w.wrapInHTML('Bonjour', { logoUrl: null }, { type: 'url', content });
      expect(html).toContain(`src="${REPLI}"`);
      expect(html).not.toMatch(/supabase/i);
    }
  });
});
