import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db, ensureMigrations, ensureUnaccent } from '@/db';
import { geminiSearch } from '@/lib/gemini-search';

const PREMIUM_PLANS = new Set(['PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO']);

/** Escape a LIKE pattern value for safe SQL interpolation (prevents SQL injection). */
function escapeLike(val: string): string {
  // Escape single quotes by doubling them, then wrap in quotes
  return "'" + val.replace(/'/g, "''") + "'";
}

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });

    await ensureMigrations();
    await ensureUnaccent();

    const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
    if (!q || q.length < 1) return NextResponse.json({ results: [], aiPowered: false });

    /* ── SQL keyword search (toutes formules, résultats immédiats) ─────── */
    // Chaque token peut matcher n'importe quel champ de l'entité (titre, desc, bien lié…).
    // Score = nb de tokens qui matchent. On filtre avec score >= ceil(tokens/2) pour éviter
    // les faux positifs sur les mots courants ("date", "achat"…).
    const tokens = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (tokens.length === 0) return NextResponse.json({ results: [], aiPowered: false });

    const likePatterns = tokens.map(t => escapeLike('%' + t + '%'));
    const minScore = tokens.length; // Tous les tokens doivent matcher

    // ── Assets ──────────────────────────────────────────────────────────────
    const assetTokenExprs = likePatterns.map(p =>
      `(CASE WHEN unaccent(lower(a.name)) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.notes,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.city,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.address,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.subtype,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.key_characteristics,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.equipment_list,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.object_details,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.general_condition,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.dimensions,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.engine_info,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.registration_number,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.purchase_location,''))) ILIKE unaccent(lower(${p}))
               THEN 1 ELSE 0 END)`
    );
    const assetScore = assetTokenExprs.join(' + ');

    const assetRows = await db.$client.unsafe(
      `SELECT a.id, a.name, a.category, a.subtype, a.city,
              (${assetScore}) AS score
       FROM assets a
       WHERE a.account_id = ${accountId}
         AND a.deleted_at IS NULL
         AND (${assetScore}) >= ${minScore}
       ORDER BY score DESC, a.name
       LIMIT 5`
    );

    // ── Documents ────────────────────────────────────────────────────────────
    const docTokenExprs = likePatterns.map(p =>
      `(CASE WHEN unaccent(lower(coalesce(af.original_filename,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.filename,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.description,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.supplier,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.notes,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.document_type,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.retained_title,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.web_link_title,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.extracted_text,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(af.retained_function_code,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(a.name,''))) ILIKE unaccent(lower(${p}))
               THEN 1 ELSE 0 END)`
    );
    const docScore = docTokenExprs.join(' + ');

    const docRows = await db.$client.unsafe(
      `SELECT af.id, af.original_filename, af.filename, af.mime_type, af.document_type,
              af.document_date, af.asset_id, a.name AS asset_name,
              (${docScore}) AS score
       FROM asset_files af
       LEFT JOIN assets a ON a.id = af.asset_id
       WHERE af.account_id = ${accountId}
         AND af.deleted_at IS NULL
         AND af.upload_status = 'COMPLETED'
         AND af.is_draft = false
         AND (${docScore}) >= ${minScore}
       ORDER BY score DESC, af.created_at DESC
       LIMIT 8`
    );

    // ── Fournisseurs ─────────────────────────────────────────────────────────
    const supplierTokenExprs = likePatterns.map(p =>
      `(CASE WHEN unaccent(lower(s.name)) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(s.email,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(s.city,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(s.siren,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(s.siret,''))) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(s.vat_number,''))) ILIKE unaccent(lower(${p}))
               THEN 1 ELSE 0 END)`
    );
    const supplierScore = supplierTokenExprs.join(' + ');

    const supplierRows = await db.$client.unsafe(
      `SELECT s.id, s.public_id, s.name, s.email, s.city, s.contact_status
       FROM suppliers s
       WHERE s.account_id = ${accountId}
         AND s.status = 'active'
         AND (${supplierScore}) >= ${minScore}
       ORDER BY score DESC, s.name
       LIMIT 5`.replace('score DESC', `(${supplierScore}) DESC`)
    );

    // ── Agenda ───────────────────────────────────────────────────────────────
    // Chaque token peut matcher titre, description, ou le nom d'un bien lié
    const agendaTokenExprs = likePatterns.map(p =>
      `(CASE WHEN unaccent(lower(ai.title)) ILIKE unaccent(lower(${p}))
               OR unaccent(lower(coalesce(ai.description,''))) ILIKE unaccent(lower(${p}))
               OR EXISTS (
                 SELECT 1 FROM agenda_asset_links aal
                 INNER JOIN assets a ON a.id = aal.asset_id
                 WHERE aal.agenda_item_id = ai.id
                   AND unaccent(lower(a.name)) ILIKE unaccent(lower(${p}))
               ) THEN 1 ELSE 0 END)`
    );
    const agendaScore = agendaTokenExprs.join(' + ');

    const agendaRows = await db.$client.unsafe(
      `SELECT ai.id, ai.title, ai.start_date, ai.manual_status,
              (SELECT STRING_AGG(DISTINCT a.name, ', ')
               FROM agenda_asset_links aal
               INNER JOIN assets a ON a.id = aal.asset_id
               WHERE aal.agenda_item_id = ai.id) AS linked_asset_names,
              (${agendaScore}) AS score
       FROM agenda_items ai
       WHERE ai.account_id = ${accountId}
         AND (${agendaScore}) >= ${minScore}
       ORDER BY score DESC, ai.start_date ASC NULLS LAST
       LIMIT 5`
    );

    const results = [
      ...assetRows.map((r: any) => ({
        id: `asset-${r.id}`,
        category: 'Bien' as const,
        label: r.name,
        sublabel: [r.subtype, r.city].filter(Boolean).join(' · ') || r.category || undefined,
        href: `/assets/${r.id}`,
      })),
      ...supplierRows.map((r: any) => ({
        id: `supplier-${r.id}`,
        category: 'Fournisseur' as const,
        label: r.name,
        sublabel: [r.city, r.email].filter(Boolean).join(' · ') || undefined,
        href: `/fournisseurs`,
        supplierId: Number(r.id),
      })),
      ...docRows.map((r: any) => ({
        id: `doc-${r.id}`,
        category: 'Document' as const,
        label: r.retained_title || r.original_filename || r.filename || 'Document',
        sublabel: r.asset_name || r.document_type || undefined,
        href: `/documents`,
        docId: Number(r.id),
        mimeType: r.mime_type,
      })),
      ...agendaRows.map((r: any) => {
        const dateLabel = r.start_date
          ? new Date(r.start_date + 'T12:00:00').toLocaleDateString('fr-FR')
          : null;
        const parts = [r.linked_asset_names, dateLabel].filter(Boolean);
        return {
          id: `agenda-${r.id}`,
          category: 'Agenda' as const,
          label: r.title,
          sublabel: parts.join(' · ') || undefined,
          href: `/agenda`,
        };
      }),
    ];

    // SQL a trouvé des résultats → les retourner immédiatement
    if (results.length > 0) {
      return NextResponse.json({ results, aiPowered: false });
    }

    // Aucun résultat SQL → tenter Gemini pour les comptes Premium (sémantique)
    if (PREMIUM_PLANS.has(session.planType)) {
      try {
        const aiResults = await geminiSearch(q, accountId);
        if (aiResults.length > 0) {
          return NextResponse.json({ results: aiResults, aiPowered: true });
        }
      } catch (err) {
        console.warn('[search] Gemini failed:', (err as Error).message);
      }
    }

    return NextResponse.json({ results: [], aiPowered: false });
  } catch (err) {
    console.error('[search] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
