/**
 * Lot 48 (O10) — bouton « Reconsolider ce compte » (BO › Opérations du
 * compte et fiche compte), desktop ET mobile (même composant), sans
 * outil d'édition d'Opération (décision PO Q9).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RECONSOLIDATION_LABELS, RECONSOLIDATION_REASON_MAX, RECONSOLIDATION_REASON_MIN, normalizeReconsolidationReason, reconsolidationHref,
} from '@/services/business-operations/admin-reconsolidation.model';

(globalThis as { React?: typeof React }).React = React;
const { ReconsolidateAccountButton } = await import('../_components/ReconsolidateAccountButton');
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('O10-UI-01 composant (desktop et mobile)', () => {
  const html = renderToStaticMarkup(h(ReconsolidateAccountButton, { accountId: 42 }));
  it('un bouton libellé, pleine largeur sur mobile, largeur naturelle sur desktop ; aucune fenêtre ouverte par défaut', () => {
    expect(html).toContain('Reconsolider ce compte');
    expect(html).toContain('w-full sm:w-auto');
    expect(html).toContain('data-testid="reconsolidate-account"');
    expect(html).not.toContain(RECONSOLIDATION_LABELS.title);
  });
  it('confirmation + motif obligatoire, POST vers la route du compte, aucune valeur métier envoyée', () => {
    const src = lire('src/app/admin/operations/_components/ReconsolidateAccountButton.tsx');
    expect(src).toContain('AlertDialog');
    expect(src).toContain('<Textarea');
    expect(src).toMatch(/disabled=\{busy \|\| !valid\}/);
    expect(src).toMatch(/apiClient\.post<[^>]*>\(reconsolidationHref\(accountId\), \{ reason: reason\.trim\(\) \}\)/);
    expect(src).not.toMatch(/from '@\/db'|business-operations\/(write|repository)/);
    expect(reconsolidationHref(42)).toBe('/api/admin/accounts/42/operations-reconsolidation');
  });
  it('motif : 5 à 500 caractères (mêmes règles côté écran et route)', () => {
    expect(RECONSOLIDATION_REASON_MIN).toBe(5);
    expect(RECONSOLIDATION_REASON_MAX).toBe(500);
    expect(normalizeReconsolidationReason('  abcd ')).toBeNull();
    expect(normalizeReconsolidationReason('  Correctif ')).toBe('Correctif');
    expect(normalizeReconsolidationReason('x'.repeat(501))).toBeNull();
    expect(normalizeReconsolidationReason(12)).toBeNull();
  });
  it('libellés : ce n’est pas une modification d’Opération (Q9), un compte cohérent reste inchangé', () => {
    expect(RECONSOLIDATION_LABELS.description).toContain('ce n’est pas une modification d’Opération');
    expect(RECONSOLIDATION_LABELS.description).toContain('Un compte déjà cohérent reste inchangé');
  });
});

describe('O10-UI-02 intégration : BO › Opérations du compte et fiche compte', () => {
  it('page Opérations filtrée sur un compte : bouton à côté des liens du compte ; page toujours sans écriture directe (GET seulement)', () => {
    const page = lire('src/app/admin/operations/page.tsx');
    expect(page).toContain("import { ReconsolidateAccountButton } from './_components/ReconsolidateAccountButton';");
    expect(page).toMatch(/\{accountId && \([\s\S]*<ReconsolidateAccountButton accountId=\{Number\(accountId\)\}/);
    expect(page).toContain('flex flex-col sm:flex-row sm:flex-wrap sm:items-center');
    expect(page).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'|apiClient\.(post|put|patch|delete)/);
  });
  it('fiche compte, section « Opérations du compte » : bouton, boutons empilés sur mobile', () => {
    const compte = lire('src/app/admin/accounts/[id]/page.tsx');
    expect(compte).toContain('<ReconsolidateAccountButton accountId={account.id} />');
    expect(compte).toContain('<div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">');
  });
  it('les vues de diagnostic restent pures et sans action (INV-032) : le bouton n’est pas dans views.tsx', () => {
    expect(lire('src/app/admin/operations/_components/views.tsx')).not.toContain('Reconsolid');
  });
});
