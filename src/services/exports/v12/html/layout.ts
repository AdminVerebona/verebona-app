/**
 * Assemblage d'un dossier : couverture → groupes de pages → annexes intégrées →
 * « Références et limites » (CDC §7.1). Commun aux six templates.
 *
 * Portage fidèle de `maquettes/_system/layout.mjs`. Les groupes reproduisent le
 * découpage des feuilles de la maquette (chaque groupe commence une nouvelle
 * page) ; à l'intérieur d'un groupe le contenu coule et déborde sur autant de
 * pages que nécessaire. Un groupe vide est ignoré.
 *
 * Invariant exploité par le renderer (`render/render-pdf.ts`) : les pages
 * d'annexe (une page chacune) sont suivies d'une unique page « Références ».
 */

import { htmlDocument, pageSetup, IntegratedPages, isEmpty, type PlannedDoc } from './components';
import type { RenderContext, RenderedHtml } from '../types';

/** Libellé de pagination de la couverture (hors boîtes de marge) : « Page 1 / N ». */
export const coverPageLabel = (ctx: RenderContext): string => `Page 1 / ${ctx.pageMap?.total ?? '—'}`;

export function assemble({ ctx, title, headerLabel, cover, groups, annexes = [], references }: {
  ctx: RenderContext; title: string; headerLabel: string; cover: string; groups: string[]; annexes?: PlannedDoc[]; references: string;
}): RenderedHtml {
  const pages = (groups ?? []).filter((g) => !isEmpty(g?.trim?.() ?? g))
    .map((g) => `<div class="pg">\n${g}\n</div>`).join('\n');
  const body = [cover, pages, IntegratedPages(annexes), references].filter(Boolean).join('\n');
  return {
    title,
    html: htmlDocument({ title, stylesheets: ctx.stylesheets, head: pageSetup({ headerLabel }), body }),
  };
}
