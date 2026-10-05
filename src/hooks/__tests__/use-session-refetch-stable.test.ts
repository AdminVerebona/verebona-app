/**
 * Lot 24 (revue) — `useSession().refetch` est une référence STABLE et le
 * retour de Stripe sur « Offres » ne synchronise qu'une fois.
 *
 * Défaut : `refetch: () => store.refetch()` était recréé à chaque rendu ; placé
 * dans les dépendances de l'effet « retour Stripe », il le rejouait à chaque
 * rendu (sync-subscription et refreshToken lancés plusieurs fois, et le rejeu
 * annulait la fin du précédent). Le harnais (node, sans DOM) ne rerend pas un
 * composant : contrat vérifié sur le source, comme `session-shell.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('refetch stable', () => {
  it('useSession mémorise refetch sur le magasin', () => {
    const src = read('src/hooks/useSession.ts');
    expect(src).toMatch(/const refetch = useCallback\(\(\) => store\.refetch\(\), \[store\]\)/);
    expect(src).not.toMatch(/refetch:\s*\(\)\s*=>\s*store/);
  });

  it('Offres : retour Stripe traité une seule fois, jamais annulé par un rejeu', () => {
    const src = read('src/app/(dashboard)/mon-compte/offres/page.tsx');
    expect(src).toMatch(/retourStripeTraite\.current\) return;\s*retourStripeTraite\.current = true;/);
    expect(src.match(/sync-subscription/g)).toHaveLength(1);
    expect(src).not.toMatch(/cancelled = true/);
  });

  it('les autres consommateurs n’en font pas une dépendance instable', () => {
    for (const f of ['src/components/DashboardLayout.tsx', 'src/app/(dashboard)/mon-compte/informations/InformationsTab.tsx']) {
      expect(read(f)).not.toMatch(/\[[^\]]*\brefetch\w*\b[^\]]*\]\s*\)/);
    }
  });
});
