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
export function assertSafeUrl(raw: string): URL {
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

/** Nettoyage HTML : retire scripts, styles et balisage, conserve le texte. */
export function extractTextFromHtml(html: string): { text: string; title: string | null } {
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
    const { text, title } = await fetchAndExtract(url);

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
    };
  }
}

async function fetchAndExtract(url: URL): Promise<{ text: string; title: string | null }> {
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
    return extractTextFromHtml(html);
  } finally {
    clearTimeout(timer);
  }
}
