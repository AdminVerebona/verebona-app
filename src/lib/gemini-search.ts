/**
 * gemini-search.ts
 * Semantic search powered by Gemini Flash for paid accounts.
 * Strategy: lightweight RAG — load all account data, send as context to Gemini,
 * get back a PRECISE ranked list of matching entity IDs.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/db';

const GEMINI_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 30_000;
const MAX_ASSETS = 300;
const MAX_DOCS = 300;
const MAX_AGENDA = 200;
const MAX_SUPPLIERS = 200;

// Human-readable document type labels for better AI matching
const DOC_TYPE_LABELS: Record<string, string> = {
  FACTURE: 'facture',
  GARANTIE: 'garantie',
  MANUEL: 'manuel / notice',
  CONTRAT: 'contrat',
  CERTIFICAT: 'certificat',
  PHOTO: 'photo',
  AUTRE: 'autre',
};

export interface GeminiSearchResult {
  id: string;
  category: 'Bien' | 'Document' | 'Agenda' | 'Fournisseur';
  label: string;
  sublabel?: string;
  href: string;
  docId?: number;
  supplierId?: number;
  mimeType?: string;
  aiPowered: true;
}

/* ── Load raw account data ──────────────────────────────────────────────── */

async function loadAccountData(accountId: number) {
  const [assets, docs, agenda, suppliersList] = await Promise.all([
    db.$client.unsafe(
      `SELECT id, name, category, subtype, city, notes, address,
              postal_code, status, general_condition, registration_number,
              purchase_date, purchase_location, dimensions, engine_info,
              equipment_list, key_characteristics, object_details
       FROM assets
       WHERE account_id = $1 AND deleted_at IS NULL
       ORDER BY name
       LIMIT ${MAX_ASSETS}`,
      [accountId]
    ),
    db.$client.unsafe(
      `SELECT af.id, af.original_filename, af.document_type,
              af.description, af.supplier, af.notes, af.document_date,
              af.retained_title, af.web_link_title, af.mime_type,
              af.extracted_text, af.retained_function_code,
              af.web_link_url, af.is_web_link, af.amount_cents,
              a.name AS asset_name
       FROM asset_files af
       LEFT JOIN assets a ON a.id = af.asset_id
       WHERE af.account_id = $1
         AND af.deleted_at IS NULL
         AND af.upload_status = 'COMPLETED'
         AND af.is_draft = false
       ORDER BY af.created_at DESC
       LIMIT ${MAX_DOCS}`,
      [accountId]
    ),
    db.$client.unsafe(
      `SELECT ai.id, ai.title, ai.description, ai.start_date,
              ai.manual_status, ai.origin_field_key,
              STRING_AGG(DISTINCT a.name, ', ') AS linked_asset_names
       FROM agenda_items ai
       LEFT JOIN agenda_asset_links aal ON aal.agenda_item_id = ai.id
       LEFT JOIN assets a ON a.id = aal.asset_id
       WHERE ai.account_id = $1
       GROUP BY ai.id
       ORDER BY ai.start_date DESC NULLS LAST
       LIMIT ${MAX_AGENDA}`,
      [accountId]
    ),
    db.$client.unsafe(
      `SELECT id, name, email, phone, city, siret, vat_number, contact_status
       FROM suppliers
       WHERE account_id = $1 AND status = 'active'
       ORDER BY name
       LIMIT ${MAX_SUPPLIERS}`,
      [accountId]
    ),
  ]);

  return { assets, docs, agenda, suppliers: suppliersList };
}

/* ── Serialize data compactly for the prompt ────────────────────────────── */

function serializeForPrompt(data: { assets: any[]; docs: any[]; agenda: any[]; suppliers: any[] }): string {
  const assetLines = data.assets.map((a: any) =>
    `BIEN id=${a.id} nom="${a.name}" categorie=${a.category} sous_type=${a.subtype ?? ''} ville=${a.city ?? ''} code_postal=${a.postal_code ?? ''} statut=${a.status ?? ''} etat="${a.general_condition ?? ''}" immatriculation=${a.registration_number ?? ''} date_achat=${a.purchase_date ?? ''} lieu_achat="${a.purchase_location ?? ''}" dimensions="${a.dimensions ?? ''}" moteur="${a.engine_info ?? ''}" equipements="${a.equipment_list ?? ''}" caracteristiques="${a.key_characteristics ?? ''}" details="${a.object_details ?? ''}" adresse="${a.address ?? ''}" notes="${a.notes ?? ''}"`.trimEnd()
  );

  const docLines = data.docs.map((d: any) => {
    // Images are labeled "photo" so Gemini can distinguish them from typed documents
    const isImage = (d.mime_type ?? '').startsWith('image/');
    const typeLabel = isImage ? 'photo' : (DOC_TYPE_LABELS[d.document_type] ?? d.document_type ?? 'autre');
    const title = d.retained_title || d.original_filename || '';
    const contentLabel = isImage ? 'visuel' : 'contenu';
    // Cap per-doc extracted text to keep Gemini prompt within token limits
    const rawText = d.extracted_text
      ? String(d.extracted_text).replace(/\n+/g, ' ').slice(0, 2000)
      : '';
    const textSnippet = rawText ? ` ${contentLabel}="${rawText}"` : '';
    const amountLabel = d.amount_cents != null ? ` montant=${(d.amount_cents / 100).toFixed(2)}€` : '';
    const webLink = d.web_link_url ? ` lien="${d.web_link_url}"` : '';
    return `DOCUMENT id=${d.id} fichier="${title}" type="${typeLabel}" fonction="${d.retained_function_code ?? ''}" bien="${d.asset_name ?? ''}" fournisseur="${d.supplier ?? ''}" description="${d.description ?? ''}" date=${d.document_date ?? ''}${amountLabel}${webLink}${textSnippet}`.trimEnd();
  });

  const agendaLines = data.agenda.map((ag: any) =>
    `AGENDA id=${ag.id} titre="${ag.title}" description="${ag.description ?? ''}" date=${ag.start_date ?? ''} biens="${ag.linked_asset_names ?? ''}"`.trimEnd()
  );

  const supplierLines = data.suppliers.map((s: any) =>
    `FOURNISSEUR id=${s.id} nom="${s.name}" email="${s.email ?? ''}" telephone="${s.phone ?? ''}" ville="${s.city ?? ''}" siret="${s.siret ?? ''}" tva="${s.vat_number ?? ''}"`.trimEnd()
  );

  return [
    '=== BIENS ===',
    ...assetLines,
    '',
    '=== DOCUMENTS ===',
    ...docLines,
    '',
    '=== AGENDA ===',
    ...agendaLines,
    '',
    '=== FOURNISSEURS ===',
    ...supplierLines,
  ].join('\n');
}

/* ── Call Gemini ────────────────────────────────────────────────────────── */

interface GeminiMatch {
  type: 'asset' | 'document' | 'agenda' | 'supplier';
  id: number;
}

function loadSearchPrompt(query: string, contextText: string): string {
  try {
    const raw = readFileSync(
      join(process.cwd(), 'src', 'services', 'document-ai', 'prompts', 'search_v1.txt'),
      'utf8'
    );
    return raw.replace('{{QUERY}}', query).replace('{{CONTEXT}}', contextText);
  } catch {
    // Fallback if file missing
    return `Tu es un moteur de recherche PRÉCIS pour une application de gestion de patrimoine.\n\nRetourne UNIQUEMENT un tableau JSON valide: [{"type":"asset"|"document"|"agenda","id":number}, ...]\n\nRequête : "${query}"\n\nDONNÉES :\n${contextText}`;
  }
}

async function callGemini(query: string, contextText: string): Promise<GeminiMatch[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = loadSearchPrompt(query, contextText);

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item: any) =>
      item &&
      typeof item.id === 'number' &&
      ['asset', 'document', 'agenda', 'supplier'].includes(item.type)
  );
}

/* ── Map matched IDs back to result rows ────────────────────────────────── */

async function resolveMatches(
  matches: GeminiMatch[],
  data: { assets: any[]; docs: any[]; agenda: any[]; suppliers: any[] }
): Promise<GeminiSearchResult[]> {
  const results: GeminiSearchResult[] = [];

  for (const match of matches) {
    if (match.type === 'asset') {
      const a = data.assets.find((x: any) => Number(x.id) === match.id);
      if (a) {
        results.push({
          id: `asset-${a.id}`,
          category: 'Bien',
          label: a.name,
          sublabel: [a.subtype, a.city].filter(Boolean).join(' · ') || a.category || undefined,
          href: `/assets/${a.id}`,
          aiPowered: true,
        });
      }
    } else if (match.type === 'document') {
      const d = data.docs.find((x: any) => Number(x.id) === match.id);
      if (d) {
        const typeLabel = DOC_TYPE_LABELS[d.document_type] ?? d.document_type ?? '';
        results.push({
          id: `doc-${d.id}`,
          category: 'Document',
          label: d.retained_title || d.original_filename || 'Document',
          sublabel: [d.asset_name, typeLabel].filter(Boolean).join(' · ') || undefined,
          href: `/documents`,
          docId: Number(d.id),
          mimeType: d.mime_type,
          aiPowered: true,
        });
      }
    } else if (match.type === 'supplier') {
      const s = data.suppliers.find((x: any) => Number(x.id) === match.id);
      if (s) {
        results.push({
          id: `supplier-${s.id}`,
          category: 'Fournisseur',
          label: s.name,
          sublabel: [s.city, s.email].filter(Boolean).join(' · ') || undefined,
          href: `/fournisseurs`,
          supplierId: Number(s.id),
          aiPowered: true,
        });
      }
    } else if (match.type === 'agenda') {
      const ag = data.agenda.find((x: any) => Number(x.id) === match.id);
      if (ag) {
        const dateLabel = ag.start_date
          ? new Date(ag.start_date + 'T12:00:00').toLocaleDateString('fr-FR')
          : null;
        results.push({
          id: `agenda-${ag.id}`,
          category: 'Agenda',
          label: ag.title,
          sublabel: [ag.linked_asset_names, dateLabel].filter(Boolean).join(' · ') || undefined,
          href: `/agenda`,
          aiPowered: true,
        });
      }
    }
  }

  return results;
}

/* ── Public entry point ─────────────────────────────────────────────────── */

export async function geminiSearch(
  query: string,
  accountId: number
): Promise<GeminiSearchResult[]> {
  const data = await loadAccountData(accountId);
  const contextText = serializeForPrompt(data as any);

  const searchPromise = callGemini(query, contextText);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Gemini timeout')), TIMEOUT_MS)
  );

  const matches = await Promise.race([searchPromise, timeoutPromise]);
  return resolveMatches(matches, data);
}
