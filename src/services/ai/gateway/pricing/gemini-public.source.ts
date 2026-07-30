/**
 * Source tarifaire publique Gemini, avec contrôle d'écart.
 *
 * Fournit les tarifs du catalogue relevé (`gemini-public-catalog.ts`), et
 * vérifie au passage qu'ils figurent toujours sur la page officielle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ELLE N'ÉCRIT JAMAIS UN TARIF QU'ELLE A DEVINÉ
 *
 * Le contrôle ne cherche pas à réextraire les montants — analyser un tableau
 * HTML pour en tirer un prix est précisément ce qui produit des chiffres faux
 * le jour d'un changement de mise en page. Il se contente de vérifier que les
 * montants du catalogue APPARAISSENT dans la section du modèle. Trois issues :
 *
 *   • présents        → tarif confirmé, `verified`
 *   • absents         → écart signalé, tarif du catalogue conservé
 *   • page injoignable → contrôle non concluant, tarif du catalogue conservé
 *
 * Dans les trois cas, le montant servi est celui qu'un humain a relevé. Une
 * baisse de prix chez Google se traduit par une alerte, pas par une écriture
 * silencieuse : c'est volontaire, la traçabilité prime sur l'automatisme.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { PricingSource, ModelPrice } from './pricing-source.port';
import {
  CATALOG_SOURCE_URL,
  findCatalogEntry,
  toModelPrice,
} from './gemini-public-catalog';

export type DriftStatus = 'verified' | 'drifted' | 'unverified';

export interface DriftReport {
  model: string;
  status: DriftStatus;
  detail?: string;
}

/** Extrait la portion de page consacrée à un modèle. */
export function sliceModelSection(page: string, model: string): string | null {
  // La page identifie chaque modèle par son nom entre accents graves.
  const anchor = page.indexOf('`' + model + '`');
  if (anchor === -1) return null;
  // La section court jusqu'au titre de niveau 2 suivant.
  const next = page.indexOf('\n## ', anchor);
  return page.slice(anchor, next === -1 ? page.length : next);
}

/** Relève tous les montants en dollars d'une portion de page. */
export function extractAmounts(section: string): Set<number> {
  const amounts = new Set<number>();
  for (const match of section.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)) {
    amounts.add(Number(match[1]));
  }
  return amounts;
}

/**
 * Confronte un modèle du catalogue à la page.
 *
 * Exporté pour être testable sans accès réseau.
 */
export function checkModelDrift(page: string, model: string): DriftReport {
  const entry = findCatalogEntry(model);
  if (!entry) {
    return { model, status: 'unverified', detail: 'absent du catalogue' };
  }

  const section = sliceModelSection(page, model);
  if (!section) {
    return { model, status: 'drifted', detail: 'modèle introuvable sur la page' };
  }

  const amounts = extractAmounts(section);
  const missing: string[] = [];
  if (!amounts.has(entry.inputPerMillion)) missing.push(`entrée ${entry.inputPerMillion}`);
  if (!amounts.has(entry.outputPerMillion)) missing.push(`sortie ${entry.outputPerMillion}`);

  return missing.length === 0
    ? { model, status: 'verified' }
    : { model, status: 'drifted', detail: `montant absent de la page : ${missing.join(', ')}` };
}

export class GeminiPublicPricingSource implements PricingSource {
  readonly provider = 'gemini';
  readonly name = 'google-public-pricing-page';

  private lastReports: DriftReport[] = [];

  /** Toujours disponible : le catalogue ne dépend d'aucune clé. */
  isConfigured(): boolean {
    return true;
  }

  /** Rapports du dernier relevé, pour journalisation par le lot. */
  getDriftReports(): DriftReport[] {
    return [...this.lastReports];
  }

  async fetchPrices(models: string[]): Promise<ModelPrice[]> {
    const page = await this.loadPage();
    const prices: ModelPrice[] = [];
    this.lastReports = [];

    for (const model of models) {
      const entry = findCatalogEntry(model);
      if (!entry) {
        // Modèle inconnu du catalogue : jamais inventé. Le lot le remontera
        // dans `models_missing` et il devra être saisi en administration.
        this.lastReports.push({
          model,
          status: 'unverified',
          detail: 'absent du catalogue relevé — saisie manuelle attendue',
        });
        continue;
      }

      const report = page
        ? checkModelDrift(page, model)
        : { model, status: 'unverified' as const, detail: 'page officielle injoignable' };

      this.lastReports.push(report);
      if (report.status === 'drifted') {
        console.warn(
          `[pricing] écart détecté pour ${model} : ${report.detail}. ` +
          'Le tarif du catalogue est conservé — vérifiez la page officielle ' +
          'et mettez à jour gemini-public-catalog.ts.',
        );
      }

      prices.push(toModelPrice(entry));
    }

    return prices;
  }

  /** Charge la page officielle. Un échec n'est pas bloquant. */
  private async loadPage(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(CATALOG_SOURCE_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        console.warn(`[pricing] page tarifaire : HTTP ${response.status}`);
        return null;
      }
      return await response.text();
    } catch (e) {
      console.warn(`[pricing] page tarifaire injoignable : ${(e as Error).message}`);
      return null;
    }
  }
}
