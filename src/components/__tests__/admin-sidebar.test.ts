/**
 * Navigation cible du BO — CDC Back-Office V1 §3, REC-NAV-01, REC-NAV-02,
 * REC-NAV-03.
 *
 * Test statique sur le source : il vérifie la liste déclarée sans monter le
 * composant (icônes, routeur) dans l'environnement Node des tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/components/AdminSidebar.tsx'), 'utf8');
const block = src.slice(src.indexOf('export const ADMIN_NAVIGATION'), src.indexOf('] as const;'));
const entries = [...block.matchAll(/\{ name: '((?:[^'\\]|\\.)*)', href: '([^']+)'/g)].map((m) => ({
  name: m[1].replace(/\\'/g, "'"),
  href: m[2],
}));

const EXPECTED: Array<[string, string]> = [
  ['Dashboard', '/admin'],
  ['Comptes', '/admin/accounts'],
  ['Utilisateurs', '/admin/users'],
  ['Abonnements & paiements', '/admin/subscriptions'],
  ['Parrainages & promotions', '/admin/referrals'],
  ['Référentiels', '/admin/referentials'],
  ['Communications', '/admin/communications'],
  ["Modèles d'export", '/admin/export-templates'],
  ['RGPD', '/admin/gdpr'],
  ['Tableau de bord IA', '/admin/ai-dashboard'],
  ['Configuration IA', '/admin/ai-config'],
  ['File IA', '/admin/ai-queue'],
  ['Exécutions IA', '/admin/ai-executions'],
  ['Coûts IA', '/admin/ai-costs'],
  ['Fournisseur IA', '/admin/ai-provider'],
];

describe('barre latérale du back-office', () => {
  it('REC-NAV-01 : exactement les 15 entrées cibles, dans l’ordre du CDC', () => {
    expect(entries.map((e) => [e.name, e.href])).toEqual(EXPECTED);
  });

  it('REC-NAV-02 : ni « Gestion IA » ni « Suivi IA »', () => {
    expect(entries.some((e) => e.href === '/admin/document-ai' || e.href === '/admin/ai-usage')).toBe(false);
    expect(src).not.toMatch(/Gestion IA'|Suivi IA'/);
  });

  it('REC-NAV-03 : aucun badge de compteur', () => {
    expect(block).not.toMatch(/\b(badge|count)\s*:/i);
  });

  it('chaque entrée cible a une page', () => {
    for (const { href } of entries) {
      const dir = href === '/admin' ? 'src/app/admin' : `src/app${href}`;
      expect(() => readFileSync(join(process.cwd(), dir, 'page.tsx'))).not.toThrow();
    }
  });
});
