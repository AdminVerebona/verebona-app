/**
 * APP-PERF-39 — chemin critique de la coquille allégé, chargements
 * secondaires isolés et annulables.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scheduleIdle } from '@/lib/shell/idle';
import { countFromToProcess } from '@/hooks/useToProcessCount';
import { getWelcomeDismissedKey, isWelcomeDismissed, markWelcomeDismissed } from '@/lib/onboarding/welcome-state';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('T-02 : callbacks idle annulables', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  it('sans requestIdleCallback : l’annulation empêche l’exécution', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const cancel = scheduleIdle(cb, { fallbackDelay: 200 });
    cancel();
    vi.advanceTimersByTime(1_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('avec requestIdleCallback : poignée annulée, rappel neutralisé', () => {
    const pending: (() => void)[] = [];
    const cancelIdleCallback = vi.fn();
    (globalThis as { window?: unknown }).window = {
      requestIdleCallback: (fn: () => void) => { pending.push(fn); return 7; },
      cancelIdleCallback,
    };
    const cb = vi.fn();
    const cancel = scheduleIdle(cb);
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    pending.forEach((fn) => fn()); // même si le navigateur l'exécute quand même
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('pastille « À traiter »', () => {
  it('lit `total`, ou la longueur de `items` ; réponse inattendue → valeur conservée', () => {
    expect(countFromToProcess({ total: 4 })).toBe(4);
    expect(countFromToProcess({ items: [1, 2] })).toBe(2);
    expect(countFromToProcess(null)).toBeNull();
    expect(countFromToProcess({} as never)).toBeNull();
  });

  it('plus de repli vers l’ancienne route sur toute erreur, plus de cache de 5 min', () => {
    const hook = sansCommentaires(read('src/hooks/useToProcessCount.ts'));
    expect(hook).not.toContain('/api/dashboard/a-traiter');
    expect(hook).not.toContain('useCache');
    expect(hook).toContain('scheduleIdle(');
    expect(hook).toContain('cancelIdle()');
    expect(hook).toMatch(/\}, \[userId\]\);/);
  });
});

describe('guide de bienvenue', () => {
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  it('état mémorisé par utilisateur ; stockage indisponible → considéré non vu, sans exception', () => {
    const data = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
    };
    expect(isWelcomeDismissed(3)).toBe(false);
    markWelcomeDismissed(3);
    expect(data.get(getWelcomeDismissedKey(3))).toBe('1');
    expect(isWelcomeDismissed(3)).toBe(true);
    expect(isWelcomeDismissed(4)).toBe(false);

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    };
    expect(isWelcomeDismissed(3)).toBe(false);
    expect(() => markWelcomeDismissed(3)).not.toThrow();
  });

  it('même clé que la fenêtre (compatibilité des choix déjà enregistrés)', () => {
    expect(getWelcomeDismissedKey(12)).toBe('onboarding_dismissed_12');
    expect(read('src/components/onboarding/WelcomeOnboardingModal.tsx')).toContain("from '@/lib/onboarding/welcome-state'");
  });
});

describe('coquille', () => {
  const layout = sansCommentaires(read('src/components/DashboardLayout.tsx'));
  const shell = sansCommentaires(read('src/components/ClientShell.tsx'));

  it('CA-03 : un seul indicateur de navigation (ClientShell)', () => {
    expect(shell).toContain('<NavigationProgress />');
    expect(layout).not.toContain('NavigationProgress');
  });

  it('lectures secondaires liées à l’identité, plus à l’objet session', () => {
    expect(layout).toContain('useToProcessCount(userId)');
    expect(layout).toContain('useWelcomeOnboardingNeed(userId)');
    expect(layout).not.toMatch(/requestIdleCallback/);
    // Plus d'effet de lecture relancé par un remplacement de l'objet `user`.
    expect(layout).not.toMatch(/useEffect\(\(\) => \{\s*if \(!user\) return;/);
    expect(layout).not.toContain('fetchATraiterCount');
  });

  it('indicateur de navigation : tous les minuteurs suivis et annulés', () => {
    const src = sansCommentaires(read('src/components/NavigationProgress.tsx'));
    expect(src).toContain('timers.forEach(clearTimeout)');
    expect(src).not.toMatch(/timerRef\.current = setTimeout/);
  });
});

describe('T-03 : accueil — erreur, compte vide et revalidation distingués', () => {
  const page = sansCommentaires(read('src/app/(dashboard)/accueil/page.tsx'));

  it('erreur sans données : message et reprise, jamais un squelette permanent', () => {
    expect(page).toMatch(/status === 'error' && !summary \?/);
    expect(page).toContain('Impossible de charger vos biens et documents');
    expect(page).toContain('onClick={retry}');
  });

  it('revalidation : données conservées, échec signalé discrètement', () => {
    expect(page).toContain('aria-busy={refreshing || undefined}');
    expect(page).toContain('{refreshError && (');
  });

  it('compte vide toujours calculé sur les données reçues', () => {
    expect(page).toContain('summary.assets.total === 0 && summary.documents.total === 0');
  });
});
