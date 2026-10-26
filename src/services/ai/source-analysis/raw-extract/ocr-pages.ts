/**
 * Lot 75C (ticket T1 résiduels, point B) — transcription DURABLE des pages
 * sans couche texte, à partir de la lecture que T1 a DÉJÀ faite (fonctions
 * pures, aucun appel IA).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'extract déterministe (`extract.ts`) signale les pages sans couche texte
 * (`pagesWithoutText` : scans, images, pages blanches) ; leur lecture est
 * déléguée au modèle multimodal, dont la transcription est découpée en
 * unités de la couche A (`document_source_units`, paginées par les marques
 * « --- page N --- »). Ce module rattache, PAR PAGE sans couche texte :
 *
 *   · le texte RECONNU (blocs de texte de la page, dans l'ordre de lecture),
 *     provenance `MODEL_TRANSCRIPTION` — distincte de `PDF_TEXT_LAYER` ;
 *   · les unités source de la page (provenance fait → unité) ;
 *   · les ZONES observées (observations visuelles de la page : région et
 *     description) — conservées À PART : une interprétation visuelle n'est
 *     jamais présentée comme du texte lu ;
 *   · un statut explicite : RECOGNIZED, UNREADABLE (page scannée sans texte
 *     reconnu), EMPTY (page blanche vérifiée par la sonde), UNATTRIBUTED
 *     (transcription non paginée, ou groupe de plusieurs fichiers : le texte
 *     ne peut pas être attribué à CETTE page sans l'inventer).
 *
 * Rien n'est inventé : une page sans texte reconnu reste une LACUNE visible.
 * L'extract d'origine (`full_text`) n'est jamais modifié.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isNonInformational, pageMarker, plat } from '../source-units/text';

type OcrPageStatus = 'RECOGNIZED' | 'UNREADABLE' | 'EMPTY' | 'UNATTRIBUTED';
export type OcrStatus = 'NOT_REQUIRED' | 'COMPLETE' | 'PARTIAL' | 'NONE' | 'UNATTRIBUTED';

/** Provenance du texte reconnu : lecture du modèle multimodal (≠ couche texte PDF). */
const OCR_PROVENANCE = 'MODEL_TRANSCRIPTION' as const;

interface OcrZone {
  sourceUnitId: string;
  /** Région de la page quand le modèle l'a localisée (boîte, libellé de zone…). */
  region: unknown;
  /** Description de l'observation (interprétation visuelle, jamais du texte lu). */
  description: string | null;
}

export interface OcrPage {
  page: number;
  status: OcrPageStatus;
  provenance: typeof OCR_PROVENANCE;
  /** Texte reconnu (null sauf RECOGNIZED). */
  text: string | null;
  chars: number;
  sourceUnitIds: string[];
  zones: OcrZone[];
  /** Motif d'une lacune (UNREADABLE, UNATTRIBUTED, EMPTY). */
  reason: string | null;
}

export interface OcrResult {
  status: OcrStatus;
  pages: OcrPage[];
  recognized: number[];
  unreadable: number[];
  chars: number;
}

/** Unité de la couche A (sous-ensemble lu ici). */
interface OcrUnitInput {
  sourceUnitId: string;
  kind: string;
  page: number | null;
  ordinal: number;
  text: string | null;
  location?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}

interface BuildOcrPagesInput {
  /** Pages sans couche texte de l'extract déterministe. */
  pagesWithoutText: readonly number[];
  /** Pages du document (null : inconnu). */
  pageCount: number | null;
  /** Unités de la couche A (transcription paginée du modèle). */
  units?: readonly OcrUnitInput[] | null;
  /** Repli sans couche A : transcription brute du modèle. */
  transcription?: string | null;
  /** Fichiers du groupe analysés ensemble (> 1 : pagination non attribuable à un fichier). */
  groupSize: number;
  /** Pages image seule selon la sonde de couverture (null : sonde indisponible). */
  scannedPages?: readonly number[] | null;
}

const texteUtile = (t: string | null | undefined): t is string => !!t && !isNonInformational(t) && plat(t).length >= 2;

/** Texte de la transcription brute, par page (marques « --- page N --- »). Pure. */
export function transcriptionByPage(transcription: string): { paginated: boolean; pages: Map<number, string> } {
  const pages = new Map<number, string[]>();
  let page = 1;
  let paginated = false;
  for (const brute of transcription.replace(/\r\n?/g, '\n').split('\n')) {
    const m = pageMarker(brute);
    if (m !== null) { paginated = true; page = m; continue; }
    const l = pages.get(page) ?? [];
    l.push(brute);
    pages.set(page, l);
  }
  return { paginated, pages: new Map([...pages].map(([k, v]) => [k, v.join('\n').trim()])) };
}

/** Transcription par page des pages sans couche texte (pure). */
export function buildOcrPages(p: BuildOcrPagesInput): OcrResult {
  const cibles = [...new Set(p.pagesWithoutText)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (cibles.length === 0) return { status: 'NOT_REQUIRED', pages: [], recognized: [], unreadable: [], chars: 0 };

  const lacune = (page: number, status: Exclude<OcrPageStatus, 'RECOGNIZED'>, reason: string): OcrPage => ({
    page, status, provenance: OCR_PROVENANCE, text: null, chars: 0, sourceUnitIds: [], zones: [], reason,
  });
  if (p.groupSize > 1) {
    const pages = cibles.map((n) => lacune(n, 'UNATTRIBUTED',
      'Groupe de plusieurs fichiers lus ensemble : la transcription n’est pas attribuable à cette page de ce fichier.'));
    return { status: 'UNATTRIBUTED', pages, recognized: [], unreadable: [], chars: 0 };
  }

  // Texte et unités par page : couche A si disponible, sinon transcription brute.
  const textes = new Map<number, string[]>();
  const unites = new Map<number, string[]>();
  const zones = new Map<number, OcrZone[]>();
  let paginated: boolean;
  const units = p.units ?? [];
  if (units.length > 0) {
    paginated = (p.pageCount ?? 1) <= 1 || units.some((u) => (u.page ?? 1) > 1);
    for (const u of [...units].sort((a, b) => a.ordinal - b.ordinal)) {
      if (u.page == null) continue;
      if (u.kind === 'VISUAL_OBSERVATION') {
        const l = zones.get(u.page) ?? [];
        l.push({ sourceUnitId: u.sourceUnitId, region: u.location?.region ?? u.payload?.region ?? null, description: u.text ?? null });
        zones.set(u.page, l);
        continue;
      }
      if (u.kind === 'PAGE_GAP') continue;
      const ids = unites.get(u.page) ?? [];
      ids.push(u.sourceUnitId);
      unites.set(u.page, ids);
      if (u.kind === 'TEXT_BLOCK' && texteUtile(u.text)) {
        const t = textes.get(u.page) ?? [];
        t.push(u.text);
        textes.set(u.page, t);
      }
    }
  } else {
    const t = transcriptionByPage(p.transcription ?? '');
    paginated = t.paginated || (p.pageCount ?? 1) <= 1;
    for (const [n, txt] of t.pages) if (texteUtile(txt)) textes.set(n, [txt]);
  }

  const scan = p.scannedPages ? new Set(p.scannedPages) : null;
  const pages: OcrPage[] = cibles.map((n) => {
    if (!paginated) {
      return lacune(n, 'UNATTRIBUTED', 'Transcription du modèle non paginée : le texte reconnu n’est pas attribuable à cette page.');
    }
    const t = textes.get(n);
    if (t?.length) {
      const text = t.join('\n\n');
      return { page: n, status: 'RECOGNIZED', provenance: OCR_PROVENANCE, text, chars: text.length, sourceUnitIds: unites.get(n) ?? [], zones: zones.get(n) ?? [], reason: null };
    }
    // Page blanche vérifiée par la sonde (ni texte, ni image) : aucune information à lire.
    if (scan && !scan.has(n)) return { ...lacune(n, 'EMPTY', 'Page sans contenu (ni couche texte, ni image) selon la sonde du document.'), zones: zones.get(n) ?? [] };
    return {
      ...lacune(n, 'UNREADABLE', 'Page sans couche texte : aucun texte reconnu par la lecture du modèle (illisible ou non transcrite).'),
      sourceUnitIds: unites.get(n) ?? [], zones: zones.get(n) ?? [],
    };
  });
  const recognized = pages.filter((x) => x.status === 'RECOGNIZED').map((x) => x.page);
  const unreadable = pages.filter((x) => x.status === 'UNREADABLE').map((x) => x.page);
  const resolues = pages.filter((x) => x.status === 'RECOGNIZED' || x.status === 'EMPTY').length;
  const status: OcrStatus = pages.some((x) => x.status === 'UNATTRIBUTED') ? 'UNATTRIBUTED'
    : resolues === pages.length ? 'COMPLETE' : recognized.length === 0 ? 'NONE' : 'PARTIAL';
  return { status, pages, recognized, unreadable, chars: pages.reduce((s, x) => s + x.chars, 0) };
}

/** Lacunes lisibles de la transcription (rapport, phase d'extraction). Pure. */
export function ocrGaps(o: Pick<OcrResult, 'pages'>): string[] {
  return o.pages.filter((x) => x.status === 'UNREADABLE' || x.status === 'UNATTRIBUTED')
    .map((x) => `page ${x.page} sans couche texte : ${x.status === 'UNREADABLE' ? 'aucun texte reconnu' : 'transcription non attribuable'}`);
}
