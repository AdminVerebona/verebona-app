/**
 * Registre des templates V12 (MIG-04) : un template versionné par dossier.
 *
 * `version` est la version technique figée dans le snapshot et les métriques
 * (IC-GEN-010, §16.3, `renderer.template_version`) ; `label` est le libellé
 * « cil · v1.0 » imprimé sur la page Références. Toute modification visible du
 * rendu d'un template doit en incrémenter la version.
 */

import type { DossierCode } from '@/services/exports/catalog';
import type { DossierDataMap, RenderContext, RenderedHtml } from '../types';
import { selected } from '../html/selection';
import * as cil from './cil';
import * as dossierComplet from './dossier-complet';
import * as vente from './vente';
import * as location from './location';
import * as souscription from './assurance-souscription';
import * as sinistre from './assurance-sinistre';

interface TemplateEntry<C extends DossierCode> {
  code: C;
  version: string;
  label: string;
  render: (data: DossierDataMap[C], ctx: RenderContext) => RenderedHtml;
}

export const TEMPLATES: { [C in DossierCode]: TemplateEntry<C> } = {
  CIL: { code: 'CIL', version: cil.TEMPLATE_VERSION, label: cil.TEMPLATE_LABEL, render: cil.render },
  DOSSIER_COMPLET: { code: 'DOSSIER_COMPLET', version: dossierComplet.TEMPLATE_VERSION, label: dossierComplet.TEMPLATE_LABEL, render: dossierComplet.render },
  VENTE: { code: 'VENTE', version: vente.TEMPLATE_VERSION, label: vente.TEMPLATE_LABEL, render: vente.render },
  LOCATION: { code: 'LOCATION', version: location.TEMPLATE_VERSION, label: location.TEMPLATE_LABEL, render: location.render },
  ASSURANCE_SOUSCRIPTION: { code: 'ASSURANCE_SOUSCRIPTION', version: souscription.TEMPLATE_VERSION, label: souscription.TEMPLATE_LABEL, render: souscription.render },
  ASSURANCE_SINISTRE: { code: 'ASSURANCE_SINISTRE', version: sinistre.TEMPLATE_VERSION, label: sinistre.TEMPLATE_LABEL, render: sinistre.render },
};

/** Rendu HTML d'un dossier (typage conservé par code). */
export function renderDossierHtml<C extends DossierCode>(code: C, data: DossierDataMap[C], ctx: RenderContext): RenderedHtml {
  // Carte #767 (E03) : « Notes / Description » des pièces retenues — vide (donc rendu inchangé)
  // tant que l'inclusion n'a pas été cochée ; même section pour les six modèles (`assemble`).
  const documentNotes = documentNotesOf(data.documents);
  return (TEMPLATES[code] as TemplateEntry<C>).render(data, documentNotes.length ? { ...ctx, documentNotes } : ctx);
}

/**
 * Carte #767 (E03) — textes « Notes / Description » à imprimer : pièces RETENUES seulement (ni
 * décochées, ni fichier inutilisable, ni données d'occupant), dans l'ordre du dossier. Pure.
 */
export function documentNotesOf(documents: DossierDataMap[DossierCode]['documents']): Array<{ title: string; text: string }> {
  return selected(documents)
    .filter((d) => typeof d.note === 'string' && d.note.trim().length > 0)
    .map((d) => ({ title: d.title, text: String(d.note).trim() }));
}

export function templateVersion(code: DossierCode): string {
  return TEMPLATES[code].version;
}

export function templateLabel(code: DossierCode): string {
  return TEMPLATES[code].label;
}
