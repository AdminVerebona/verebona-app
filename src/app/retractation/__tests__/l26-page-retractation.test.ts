/**
 * Lot 26 — point 4 : page « Renoncer au contrat » (/retractation).
 *
 *  · AC4a : un bouton retour (Mon compte si connecté, sinon page précédente,
 *    sinon connexion) ;
 *  · AC4b : plus d'erreur « Jeton manquant. » à l'arrivée sans jeton.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWithdrawalBackTarget } from '@/lib/withdrawal-back-target';

const page = readFileSync(join(process.cwd(), 'src/app/retractation/page.tsx'), 'utf8');

describe('lot 26 — AC4a : cible du bouton retour', () => {
  it('connecté : Mon compte', () => {
    expect(resolveWithdrawalBackTarget({ authenticated: true, referrer: '', historyLength: 1 }))
      .toEqual({ kind: 'link', href: '/mon-compte', label: 'Retour à mon compte' });
    expect(resolveWithdrawalBackTarget({ authenticated: true, referrer: 'https://verebona.fr/', historyLength: 3 }).kind)
      .toBe('link');
  });

  it('non connecté, arrivé d’une autre page : retour navigateur', () => {
    expect(resolveWithdrawalBackTarget({ authenticated: false, referrer: 'https://verebona.fr/cgu', historyLength: 2 }))
      .toEqual({ kind: 'history', label: 'Retour' });
    expect(resolveWithdrawalBackTarget({ authenticated: null, referrer: 'https://app.verebona.fr/login', historyLength: 2 }).kind)
      .toBe('history');
  });

  it('non connecté, onglet neuf ou lien de courriel : connexion', () => {
    expect(resolveWithdrawalBackTarget({ authenticated: false, referrer: '', historyLength: 1 }))
      .toEqual({ kind: 'link', href: '/login', label: 'Retour à la connexion' });
    expect(resolveWithdrawalBackTarget({ authenticated: false, referrer: 'https://x/', historyLength: 1 }).kind).toBe('link');
  });

  it('la page affiche le retour au-dessus de la carte, avec les composants existants', () => {
    // Lot 32 : plus de retour une fois le compte supprimé (étape « done »).
    expect(page).toContain("<Shell back={step === 'done' ? undefined : <BackLink authenticated={authenticated} />}>");
    expect(page).toMatch(/<Button variant="ghost" size="sm"/);
    expect(page).toContain('<ArrowLeft');
    expect(page).toContain('resolveWithdrawalBackTarget({ authenticated, ...nav })');
  });
});

describe('lot 26 — AC4b : pas d’erreur « Jeton manquant. » avant toute action', () => {
  const load = page.slice(page.indexOf('const loadContext = useCallback'), page.indexOf('useEffect(() => { loadContext(); }, [loadContext]);'));

  it('la vérification publique n’est appelée QU’AVEC un jeton, et le transmet', () => {
    expect(load).toContain('if (token) {');
    expect(load).toContain('/api/withdrawal/public/verify?token=${encodeURIComponent(token)}');
    // L'ancienne régression : un appel sans `?token=` dans un bloc nu.
    expect(load).not.toMatch(/fetch\(`\/api\/withdrawal\/public\/verify`/);
    expect(load.indexOf('if (token) {')).toBeLessThan(load.indexOf('/api/withdrawal/public/verify'));
  });

  it('sans jeton : la session est tentée (connecté → récapitulatif), sinon présentation sans erreur', () => {
    const sansJeton = load.slice(load.indexOf('// Sans jeton'));
    expect(sansJeton).toContain("fetch('/api/withdrawal/prepare'");
    expect(sansJeton).toContain('setAuthenticated(r.ok);');
    expect(sansJeton).not.toContain('setError(');
  });
});
