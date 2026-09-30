/**
 * Contenu riche pour la synthèse — CDC 15 T2-11 (lot 15).
 *
 * « Résume les garanties » ne peut pas s'appuyer sur titre, type et date :
 * ce fournisseur rend, par document, des sources SÉMANTIQUES structurées —
 * type, date, montant, fournisseur, biens liés, faits T1 (clé : valeur) et
 * une transcription COURTE bornée (autour des termes de la question, sinon le
 * début). Destiné à Y (planificateurs de synthèse, `buildSynthesisContext`).
 * Borné au compte ; budgets explicites.
 *
 * Données sensibles (relecture lot 15) :
 *   - un fait T1 dont la clé canonique est `sensitive` au registre
 *     (n° client assurance, adresse, coordonnées GPS…) n'entre JAMAIS dans
 *     le contenu, comme dans `field-reader` (lecture refusée en clair) ; un
 *     fait générique dont la clé (alias) se résout vers une clé sensible est
 *     écarté de même ;
 *   - l'extrait de transcription est masqué ICI selon §29.4
 *     (`maskSensitiveText`, nécessité déduite des termes de la question) —
 *     défense en profondeur : les sources de synthèse repassent ensuite par
 *     `applySensitiveDataPolicy` dans `generation.adapter` avant tout appel
 *     modèle (exclusion des documents d'identité ou médicaux, masquage du
 *     titre et du contenu). Le libellé de type est porté en méta
 *     (`documentTypeLabel`) pour que cette exclusion le voie.
 */
import { pgClient } from '@/db';
import { getField, resolveAlias } from '@/services/canonical/registry';
import type { RetrievedSource } from '../types/sources';
import { maskSensitiveText, sensitiveNecessityFor, type SensitiveNecessity } from '../core/sensitive-data.policy';
import { getCanonicalDocumentState, type CanonicalDocumentState } from './document-state';

export interface SynthesisContentOptions {
  /** Documents visés ; à défaut, ceux des biens (`assetIds`, relation N-N). */
  fileIds?: number[];
  assetIds?: number[];
  /** Termes de la question : ciblent l'extrait de transcription. */
  terms?: string[];
  /** Nombre de documents (défaut 8, max 20). */
  maxDocuments?: number;
  /** Faits par document (défaut 12, max 40). */
  maxFacts?: number;
  /** Longueur de l'extrait de transcription (défaut 400, max 800). */
  excerptChars?: number;
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Extrait borné autour du premier terme trouvé, sinon le début (pure, testée). */
export function boundedExcerpt(text: string | null, terms: string[], max: number): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const p = plain(t);
  const pos = terms.map((x) => p.indexOf(plain(x))).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const debut = pos === undefined ? 0 : Math.max(0, Math.min(pos - Math.floor(max / 3), t.length - max));
  return `${debut > 0 ? '…' : ''}${t.slice(debut, debut + max).trim()}${debut + max < t.length ? '…' : ''}`;
}

/**
 * Un fait est sensible si sa clé canonique l'est au registre, ou si sa clé
 * générique (alias) se résout vers une clé sensible (pure, testée).
 */
export function isSensitiveFact(f: { key: string; canonicalKey: string | null }): boolean {
  for (const k of [f.canonicalKey, f.key]) {
    if (!k) continue;
    const canon = getField(k) ? k : resolveAlias(k);
    if (canon && getField(canon)?.sensitive) return true;
  }
  return false;
}

/** Extrait de transcription masqué selon §29.4 (pure, testée). */
export function maskedExcerpt(excerpt: string | null, necessity: SensitiveNecessity = {}): string | null {
  if (!excerpt) return null;
  return maskSensitiveText(excerpt, necessity).text;
}

/** Contenu d'une source de synthèse (pure, testée). */
export function synthesisSourceContent(d: CanonicalDocumentState, transcription: string | null, maxFacts: number): string {
  const lignes = [
    [d.documentTypeLabel ?? d.catalogCode, d.documentDate, d.supplier ? `fournisseur ${d.supplier}` : null,
      d.amountCents != null ? `montant ${(d.amountCents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : null,
      d.assets.length ? `bien${d.assets.length > 1 ? 's' : ''} : ${d.assets.map((a) => a.name).join(', ')}` : null,
    ].filter(Boolean).join(' · '),
    ...d.facts.filter((f) => f.value && !isSensitiveFact(f)).slice(0, maxFacts).map((f) => `- ${f.label ?? f.key} : ${f.value}${f.unit ? ` ${f.unit}` : ''}`),
    transcription ? `Extrait : ${transcription}` : null,
  ].filter((x): x is string => !!x);
  return lignes.join('\n').slice(0, 1500);
}

export async function buildSynthesisContent(accountId: number, opts: SynthesisContentOptions = {}): Promise<RetrievedSource[]> {
  const max = Math.min(Math.max(opts.maxDocuments ?? 8, 1), 20);
  let fileIds = [...new Set(opts.fileIds ?? [])].slice(0, max);
  if (fileIds.length === 0 && opts.assetIds?.length) {
    const rows = (await pgClient.unsafe(
      `SELECT f.id FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL
          AND (EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                        AND l.status = 'ACTIVE' AND l.asset_id = ANY($2::int[]))
               OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT $3`,
      [accountId, opts.assetIds, max] as never[],
    )) as unknown as Array<{ id: number }>;
    fileIds = rows.map((r) => Number(r.id));
  }
  if (fileIds.length === 0) return [];
  const textes = (await pgClient.unsafe(
    `SELECT file_id AS "fileId", coalesce(description, '') || ' ' || coalesce(full_text, '') AS t
       FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
    [accountId, fileIds] as never[],
  ).catch(() => [])) as unknown as Array<{ fileId: number; t: string }>;
  const parFichier = new Map(textes.map((x) => [Number(x.fileId), x.t]));
  const excerpt = Math.min(Math.max(opts.excerptChars ?? 400, 80), 800);
  const maxFacts = Math.min(Math.max(opts.maxFacts ?? 12, 0), 40);
  const besoin = sensitiveNecessityFor((opts.terms ?? []).join(' '));
  const out: RetrievedSource[] = [];
  for (const id of fileIds) {
    const d = await getCanonicalDocumentState(accountId, id, { factsLimit: maxFacts * 2 + 5 }) // marge : faits sensibles écartés ensuite;
    if (!d) continue;
    out.push({
      id: `doc_${d.fileId}`,
      type: 'document_extraction',
      title: d.title,
      content: synthesisSourceContent(d, maskedExcerpt(boundedExcerpt(parFichier.get(d.fileId) ?? null, opts.terms ?? [], excerpt), besoin), maxFacts),
      relevanceScore: 0.8,
      meta: {
        fileId: d.fileId, date: d.documentDate, documentType: d.documentTypeCode ?? d.catalogCode,
        documentTypeLabel: d.documentTypeLabel,
        amountCents: d.amountCents, supplier: d.supplier, assetName: d.assets[0]?.name ?? null,
      },
    });
  }
  return out;
}
