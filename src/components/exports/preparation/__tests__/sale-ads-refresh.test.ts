/**
 * Annonces de vente : recomposition seulement après une saisie COMMERCIALE
 * enregistrée, une fois, 2,5 s après la dernière (relecture lot 19).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSaleAdsRefresher, SALE_ADS_REFRESH_DELAY_MS } from '../sale-ads-refresh';

afterEach(() => vi.useRealTimers());

describe('createSaleAdsRefresher', () => {
  it('délai entre 2 et 3 s', () => {
    expect(SALE_ADS_REFRESH_DELAY_MS).toBeGreaterThanOrEqual(2000);
    expect(SALE_ADS_REFRESH_DELAY_MS).toBeLessThanOrEqual(3000);
  });

  it('autre sous-rubrique : rien ; saisies commerciales rapprochées : un seul rechargement après la dernière', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const r = createSaleAdsRefresher(reload);
    r.onSectionsSaved(['rental']);
    vi.advanceTimersByTime(10_000);
    expect(reload).not.toHaveBeenCalled();
    r.onSectionsSaved(['commercial']);
    vi.advanceTimersByTime(2000);
    r.onSectionsSaved(['commercial', 'insurance']);
    vi.advanceTimersByTime(SALE_ADS_REFRESH_DELAY_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('annulation (écran fermé) : aucun rechargement', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const r = createSaleAdsRefresher(reload);
    r.onSectionsSaved(['commercial']);
    r.cancel();
    vi.advanceTimersByTime(10_000);
    expect(reload).not.toHaveBeenCalled();
  });
});
