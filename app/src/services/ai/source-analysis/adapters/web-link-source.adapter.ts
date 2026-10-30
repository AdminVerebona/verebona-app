/**
 * Adaptateur lien web — CDC §4.1.5 et §4.1.7.
 *
 * « La route d'analyse des liens web ne doit plus contenir sa propre logique
 *   Gemini. Elle doit appeler le pipeline commun après préparation du contenu. »
 *
 * Cet adaptateur porte donc UNIQUEMENT : contrôle d'URL, téléchargement,
 * nettoyage HTML et extraction textuelle. Le contenu extrait est transmis via
 * `extractedContent`, ce qui permet au pipeline de produire exactement le même
 * `SourceAnalysisResult` que pour un fichier (critère d'acceptation n°6).
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { SourceAdapter, AdapterPrepareInput } from './source-adapter.port';
import type { SourceInput } from '../types';
import { compareProductCodes, productCodesIn } from '@/services/canonical/product-identity';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 120_000;

/** Protocoles autorisés — protège contre file://, data:, gopher://… */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Contrôle d'URL avant téléchargement. Bloque les adresses internes afin
 * d'éviter qu'un lien fourni par un utilisateur ne serve à sonder le réseau
 * interne depuis le serveur.
 */
function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL invalide');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Protocole non autorisé : ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate) throw new Error('Adresse réseau interne refusée');
  return url;
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 101A (F) — PRODUIT PRINCIPAL D'UNE PAGE FOURNISSEUR
//
// Une fiche produit montre aussi des produits recommandés, comparatifs,
// accessoires, carrousels. Leur texte n'est plus transmis à T1 (zones
// connexes retirées), et le produit PRINCIPAL est établi ici, sans modèle :
// données structurées schema.org `Product` (JSON-LD), sinon `og:title`, `h1`,
// `<title>`. Le garde-fou `guardProductIdentity` ne rattache à l'objet que
// les codes de ce produit. Fonctions pures, testées.
// ══════════════════════════════════════════════════════════════════════════

/** Marqueurs de zones connexes (classe, id, rôle, attribut de données). */
const ZONE_CONNEXE = /(related|recommend|similar|carousel|cross-?sell|up-?sell|you-?may|also-?(like|bought|viewed)|accessor|compare|comparison|suggest|reco-|product-?list|other-?products|complementary)/i;

/** Retire un élément et tout son contenu (balises de même nom équilibrées), à partir de `start`. */
function retirerElement(html: string, start: number, tag: string): { html: string; removed: string } | null {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1] === '/') depth -= 1; else if (!m[0].endsWith('/>')) depth += 1;
    if (depth === 0) {
      const end = m.index + m[0].length;
      return { html: html.slice(0, start) + ' ' + html.slice(end), removed: html.slice(start, end) };
    }
  }
  return null;
}

/**
 * Retire les zones de produits CONNEXES (pure, testée) : `<aside>`, et tout
 * élément dont la classe, l'id ou un attribut `data-*` désigne des produits
 * recommandés / similaires / un carrousel / un comparatif / des accessoires.
 */
export function stripRelatedZones(html: string): { html: string; removed: string[] } {
  let out = html;
  const removed: string[] = [];
  for (let garde = 0; garde < 200; garde += 1) {
    const ouvre = /<(aside|section|div|ul|ol|nav|article)\b([^>]*)>/gi;
    let trouve: { start: number; tag: string } | null = null;
    for (let m = ouvre.exec(out); m; m = ouvre.exec(out)) {
      const attrs = m[2] ?? '';
      if (m[1].toLowerCase() === 'aside' || /\b(class|id|data-[\w-]+|role|aria-label)\s*=\s*["'][^"']*["']/i.test(attrs) && ZONE_CONNEXE.test(attrs)) {
        trouve = { start: m.index, tag: m[1] };
        break;
      }
    }
    if (!trouve) break;
    const r = retirerElement(out, trouve.start, trouve.tag);
    if (!r) break;
    out = r.html;
    removed.push(r.removed);
  }
  return { html: out, removed };
}

/** Produit principal d'une page (pure, testée) — `null` si rien d'établi. */
export function extractMainProduct(html: string): { codes: string[]; name: string | null; brand: string | null } | null {
  const codes: string[] = [];
  const ajouter = (v: unknown) => {
    for (const c of productCodesIn(String(v ?? ''))) if (!codes.includes(c)) codes.push(c);
  };
  let name: string | null = null;
  let brand: string | null = null;
  // 1. schema.org Product (JSON-LD) : le plus fiable.
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const noeuds: unknown[] = [];
    const parcourir = (x: unknown) => {
      if (Array.isArray(x)) { x.forEach(parcourir); return; }
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const t = o['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) noeuds.push(o);
        if (o['@graph']) parcourir(o['@graph']);
      }
    };
    parcourir(data);
    const p = noeuds[0] as Record<string, unknown> | undefined;
    if (!p) continue;
    for (const k of ['model', 'sku', 'mpn', 'productID']) ajouter(typeof p[k] === 'object' ? (p[k] as Record<string, unknown>)?.name : p[k]);
    name = typeof p.name === 'string' ? decodeEntities(p.name).trim() : name;
    const b = p.brand as unknown;
    brand = typeof b === 'string' ? b : (b && typeof b === 'object' && typeof (b as Record<string, unknown>).name === 'string' ? String((b as Record<string, unknown>).name) : brand);
    if (codes.length) break;
  }
  // 2. Titre de la page : og:title, h1, <title>.
  if (!codes.length) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ' ');
    const titre = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    for (const t of [og, h1, titre]) {
      if (!t) continue;
      ajouter(decodeEntities(t));
      name ??= decodeEntities(t).replace(/\s+/g, ' ').trim();
      if (codes.length) break;
    }
  }
  return codes.length ? { codes, name, brand } : null;
}

/** Nettoyage HTML : retire scripts, styles et balisage, conserve le texte. */
function extractTextFromHtml(html: string): { text: string; title: string | null } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : null;

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return { text: normalizeWhitespace(decodeEntities(text)), title };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&apos;': "'", '&euro;': '€',
  };
  return s
    .replace(/&[a-z]+;/gi, (m) => named[m.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

export class WebLinkSourceAdapter implements SourceAdapter {
  readonly sourceType = 'web_link' as const;

  async prepare(input: AdapterPrepareInput): Promise<SourceInput> {
    const [row] = await db
      .select({
        id: assetFiles.id,
        webLinkUrl: assetFiles.webLinkUrl,
        webLinkTitle: assetFiles.webLinkTitle,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
      })
      .from(assetFiles)
      .where(and(
        inArray(assetFiles.id, input.sourceIds),
        eq(assetFiles.accountId, input.accountId),
        isNull(assetFiles.deletedAt),
      ))
      .limit(1);

    if (!row?.webLinkUrl) {
      throw new Error(`[web-link-adapter] Lien introuvable ou inaccessible pour le compte ${input.accountId}`);
    }

    const url = assertSafeUrl(row.webLinkUrl);
    const { text, title, webPage } = await fetchAndExtract(url);

    return {
      sourceType: 'web_link',
      sourceIds: [row.id],
      accountId: input.accountId,
      userId: input.userId,
      mimeTypes: ['text/html'],
      displayNames: [row.webLinkTitle ?? title ?? url.hostname],
      // Aucune URL transmise au fournisseur : seul le texte nettoyé circule (§5.6).
      extractedContent: text.slice(0, MAX_EXTRACTED_CHARS),
      linkedAssetId: input.linkedAssetId ?? row.assetId ?? row.linkedAssetId ?? null,
      webPage,
    };
  }
}

/**
 * Page HTML → texte du produit PRINCIPAL (zones connexes retirées) et
 * descripteur de page (pure, testée).
 */
export function prepareWebPage(html: string): { text: string; title: string | null; webPage: NonNullable<SourceInput['webPage']> } {
  const mainProduct = extractMainProduct(html);
  const { html: principal, removed } = stripRelatedZones(html);
  const relatedProductCodes = [...new Set(removed.flatMap((z) => productCodesIn(extractTextFromHtml(z).text)))]
    .filter((c) => !(mainProduct?.codes ?? []).some((p) => compareProductCodes(p, c) !== 'INCOMPATIBLE'))
    .slice(0, 50);
  const { text, title } = extractTextFromHtml(principal);
  return { text, title, webPage: { mainProduct, relatedProductCodes, removedZones: removed.length } };
}

async function fetchAndExtract(url: URL): Promise<{ text: string; title: string | null; webPage?: SourceInput['webPage'] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Verebona/1.0 (+https://verebona.fr)' },
    });

    if (!res.ok) throw new Error(`Page inaccessible : HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Type de contenu non exploitable : ${contentType || 'inconnu'}`);
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_CONTENT_BYTES) throw new Error('Page trop volumineuse');

    const html = new TextDecoder('utf-8').decode(buffer);
    if (contentType.includes('text/plain')) return extractTextFromHtml(html);
    return prepareWebPage(html);
  } finally {
    clearTimeout(timer);
  }
}
