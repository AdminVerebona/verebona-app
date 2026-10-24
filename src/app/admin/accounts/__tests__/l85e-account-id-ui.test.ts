/**
 * Lot 85E — BO › Comptes : identifiant du compte visible et copiable (ticket
 * PO du 23/10/2026 « Dans le BO comptes, faire apparaître l'ID compte »).
 *
 *   L85E-UI-01  composant : « ID 42 », chiffres à chasse fixe, bouton de copie
 *               libellé, zone tactile mobile (32 px) / desktop (24 px), aucun
 *               retour à la ligne ;
 *   L85E-UI-02  liste : sous le nom (première colonne, visible sans défilement
 *               horizontal sur mobile), clic de copie qui n'ouvre pas la fiche ;
 *   L85E-UI-03  fiche détail : sous l'en-tête (même composant desktop et mobile) ;
 *   L85E-UI-04  recherche par ID (« 42 », « #42 », « ID 42 ») ; aucune donnée
 *               sensible ajoutée (ni Stripe, ni nouvelle colonne renvoyée).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountIdFromQuery } from '@/services/admin/account-list.service';

(globalThis as { React?: typeof React }).React = React;
const { AccountIdBadge, accountIdText } = await import('@/components/admin/AccountIdBadge');
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L85E-UI-01 composant AccountIdBadge (desktop et mobile)', () => {
  const html = renderToStaticMarkup(h(AccountIdBadge, { id: 4217 }));
  it('affiche « ID 4217 » en chasse fixe, sans retour à la ligne, sélectionnable', () => {
    expect(html).toContain('data-testid="bo-account-id"');
    expect(html).toMatch(/<span>ID<\/span>/);
    expect(html).toMatch(/data-testid="bo-account-id-value"[^>]*>4217<\/span>/);
    expect(html).toContain('font-mono');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('select-all');
    expect(accountIdText(4217)).toBe('4217');
  });
  it('bouton de copie libellé ; zone tactile 32 px sur mobile, 24 px dès sm', () => {
    expect(html).toContain('aria-label="Copier l’ID du compte 4217"');
    expect(html).toContain('type="button"');
    expect(html).toContain('h-8 w-8 sm:h-6 sm:w-6');
  });
  it('copie : presse-papiers avec repli, clic non propagé (la ligne ouvre la fiche)', () => {
    const src = lire('src/components/admin/AccountIdBadge.tsx');
    expect(src).toContain("import { copyText } from '@/app/admin/ai-executions/_components/CopyJson';");
    expect(src).toMatch(/e\.stopPropagation\(\);/);
    expect(src).toMatch(/copyText\(accountIdText\(id\)\)/);
    expect(src).not.toMatch(/from '@\/db'/);
  });
});

describe('L85E-UI-02 / UI-03 intégration : liste et fiche', () => {
  it('liste : badge sous le nom, dans la première colonne (visible sans défilement sur mobile)', () => {
    const page = lire('src/app/admin/accounts/page.tsx');
    expect(page).toContain("import { AccountIdBadge } from '@/components/admin/AccountIdBadge';");
    const premiereCellule = page.slice(page.indexOf('<TableCell>'), page.indexOf('</TableCell>'));
    expect(premiereCellule).toContain('{account.name}');
    expect(premiereCellule).toContain('<AccountIdBadge id={account.id}');
    expect(page).toContain('Rechercher par ID ou nom de compte');
  });
  it('fiche détail : badge sous le titre (même composant desktop et mobile)', () => {
    const fiche = lire('src/app/admin/accounts/[id]/page.tsx');
    expect(fiche).toContain("import { AccountIdBadge } from '@/components/admin/AccountIdBadge';");
    const entete = fiche.slice(fiche.indexOf('{/* Header */}'), fiche.indexOf('<PlanBadge plan={account.planType} />'));
    expect(entete).toContain('{account.name}');
    expect(entete).toContain('<AccountIdBadge id={account.id}');
  });
});

describe('L85E-UI-04 recherche par ID, aucune donnée sensible ajoutée', () => {
  it('« 42 », « #42 », « ID 42 », « id:42 » → 42 ; texte, 0, négatif ou trop long → null', () => {
    for (const q of ['42', ' #42 ', 'ID 42', 'id:42', 'Id#42']) expect(accountIdFromQuery(q), q).toBe(42);
    for (const q of ['', 'dupont', '42a', '0', '-3', '4 2', '1234567890', null, undefined]) expect(accountIdFromQuery(q as string), String(q)).toBeNull();
  });
  it('route : égalité stricte sur accounts.id en plus de la recherche texte ; aucun champ nouveau renvoyé', () => {
    const route = lire('src/app/api/admin/accounts/route.ts');
    expect(route).toMatch(/const id = accountIdFromQuery\(q\);[\s\S]*\.\.\.\(id !== null \? \[eq\(accounts\.id, id\)\] : \[\]\)/);
    expect(route).not.toMatch(/stripeCustomerId:\s*accounts\.stripeCustomerId|stripeSubscriptionId/);
  });
});
