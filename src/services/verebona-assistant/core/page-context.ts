/**
 * Validation du contexte de page reçu du client — CDC §27.1, §27.6, §13.3.
 *
 * Le contexte était passé tel quel à l'orchestrateur (`body.pageContext`).
 * Il ne donne JAMAIS de droit (le compte vient de la session, chaque cible est
 * revérifiée en base), mais une valeur non contrôlée finissait dans des
 * requêtes (`Number(assetId)`) et dans le choix des articles d'aide. Seules
 * les clés connues, aux formats attendus, sont conservées.
 */
import type { PageContext } from '../types/contracts';

const ENTIER = /^[1-9]\d{0,9}$/;

export function sanitizePageContext(raw: unknown): PageContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PageContext = {};
  if (typeof r.route === 'string' && /^\/(?!\/)[^\s\\]{0,200}$/.test(r.route)) out.route = r.route;
  for (const k of ['assetId', 'documentId', 'supplierId'] as const) {
    const v = r[k];
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (ENTIER.test(s)) out[k] = s;
  }
  if (typeof r.intent === 'string' && /^[A-Za-z_]{1,60}$/.test(r.intent)) out.intent = r.intent;
  if (r.platform === 'web' || r.platform === 'mobile') out.platform = r.platform;
  return Object.keys(out).length ? out : undefined;
}
