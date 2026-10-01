/**
 * Recomposition des annonces de vente (VENTE-RULE-002, relecture lot 19) :
 * seulement quand un champ de la sous-rubrique COMMERCIALE (prix,
 * argumentaire, conditions, points forts…) a été enregistré, et une seule
 * fois, `SALE_ADS_REFRESH_DELAY_MS` après la dernière saisie enregistrée —
 * pas à chaque frappe ni pour une autre sous-rubrique. Pur (minuteur
 * injectable), testé.
 */
export const SALE_ADS_REFRESH_DELAY_MS = 2500;

export interface SaleAdsRefresher {
  /** Sous-rubriques enregistrées (`AssetAdditionalInfosSection.onSectionsSaved`). */
  onSectionsSaved(sections: readonly string[]): void;
  cancel(): void;
}

export function createSaleAdsRefresher(
  reload: () => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  delayMs = SALE_ADS_REFRESH_DELAY_MS,
): SaleAdsRefresher {
  let handle: unknown = null;
  const cancel = () => { if (handle !== null) { timers.clear(handle); handle = null; } };
  return {
    onSectionsSaved(sections) {
      if (!sections.includes('commercial')) return;
      cancel();
      handle = timers.set(() => { handle = null; reload(); }, delayMs);
    },
    cancel,
  };
}
