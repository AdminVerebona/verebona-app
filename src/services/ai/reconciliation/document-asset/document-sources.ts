/**
 * Sources de CONNAISSANCE DOCUMENTAIRE de T3 (lot 34E — ticket « T3 —
 * réconciliation continue des documents non résolus », §« Préparer T3 à
 * exploiter les futures source_units de T1 »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE INTERFACE, PLUSIEURS FOURNISSEURS
 *
 * Le Candidate Builder (`candidate-builder.ts`) ne lit jamais une table : il
 * reçoit des `DocumentKnowledgeSources` — textes (titre, description,
 * transcription, signaux), faits (clé canonique, valeur, sujet, cible,
 * période) — assemblés par des FOURNISSEURS enregistrés ici :
 *
 *   · EXTRACTION / TRANSCRIPTION / FACTS : représentation T1 persistée
 *     (`document_extractions`, `document_facts` actifs) — fournisseur par
 *     défaut, toujours présent ;
 *   · T1_CANDIDATES : preuves de T1 (signaux lus par T1 pour ses candidats) ;
 *   · SOURCE_UNITS / UNRESOLVED_FACTS (lot 49B, `source-unit-provider.ts`) :
 *     couche exhaustive T1 (`document_source_units`, `document_unresolved_facts`),
 *     enregistrée par `registerSourceUnitProviders` — sélection ciblée,
 *     textes INCERTAINS réduits à un indice de contexte. Ces textes entrent
 *     dans la découverte ; dans l'empreinte du contexte, seules les unités
 *     effectivement CONSIDÉRÉES (qui désignent un candidat) comptent
 *     (`context.ts`) — le digest ci-dessous ne les hache pas en bloc.
 *
 * Jamais le fichier, jamais d'OCR, jamais T1 : seulement ce qui est persisté.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { getDocumentKnowledge } from '../../knowledge/document-knowledge.service';
import type { StoredT1Candidate } from './resolution.repository';

/** Origine d'un élément de connaissance documentaire. */
export type DocumentSourceKind = 'EXTRACTION' | 'TRANSCRIPTION' | 'FACTS' | 'T1_CANDIDATES' | 'SOURCE_UNITS' | 'UNRESOLVED_FACTS' | (string & {});

/** Origines de la couche exhaustive T1 (lot 49B) : hors digest documentaire, comptées par unité considérée. */
export const EXHAUSTIVE_SOURCE_KINDS: readonly string[] = ['SOURCE_UNITS', 'UNRESOLVED_FACTS'];

/**
 * Zone du texte : un nom cité dans le TITRE, la DESCRIPTION ou un FAIT
 * désigne le document ; dans le CORPS (transcription), il peut n'être
 * qu'une mention incidente (« anciennement… ») ; SIGNAL : preuve lue par T1.
 */
export type DocumentTextZone = 'TITLE' | 'DESCRIPTION' | 'BODY' | 'SIGNAL';

export interface DocumentSourceText {
  origin: DocumentSourceKind;
  zone: DocumentTextZone;
  text: string;
  /** Unités source T1 dont le texte provient (lot 49B, monitoring « matchedSourceUnitIds »). */
  unitIds?: string[];
  /**
   * Lecture INCERTAINE (unité UNCERTAIN, fait mal formé) : jamais une preuve,
   * jamais un rattachement déterministe — indice de contexte seulement.
   */
  uncertain?: boolean;
}

export interface DocumentSourceFact {
  origin: DocumentSourceKind;
  canonicalKey: string | null;
  label: string | null;
  subject: string | null;
  value: string | null;
  excerpt: string | null;
  targetType: string | null;
  targetEntityId: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface DocumentExtractionSummary {
  extractedAt: string | null;
  title: string | null;
  description: string | null;
  documentType: string | null;
  documentDate: string | null;
  supplier: string | null;
  multiAsset: boolean | null;
}

export interface DocumentKnowledgeSources {
  accountId: number;
  fileId: number;
  /** Fournisseurs ayant contribué (monitoring : « sources testées »). */
  origins: DocumentSourceKind[];
  extraction: DocumentExtractionSummary | null;
  texts: DocumentSourceText[];
  facts: DocumentSourceFact[];
  /** Empreinte de la connaissance documentaire (côté document du contexte). */
  digest: string;
  /**
   * Lot 57B (journal par carte) : fournisseurs EN ÉCHEC (exception) — jamais
   * confondus avec « rien à dire ». Hors empreinte.
   */
  failedOrigins?: string[];
}

/**
 * Lot 57B : éléments exploitables chargés, par source (journal par carte :
 * « sources T1 effectivement chargées et nombre d'éléments »). Pure.
 */
export function knowledgeSourceCounts(s: Pick<DocumentKnowledgeSources, 'texts' | 'facts'> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!s) return out;
  for (const t of s.texts) out[String(t.origin)] = (out[String(t.origin)] ?? 0) + 1;
  if (s.facts.length > 0) out.FACTS = (out.FACTS ?? 0) + s.facts.length;
  return out;
}

/** Contribution d'un fournisseur (partielle). */
export interface DocumentSourceContribution {
  extraction?: DocumentExtractionSummary | null;
  texts?: DocumentSourceText[];
  facts?: DocumentSourceFact[];
}

export interface DocumentSourceProvider {
  /** Nom stable (unique) — `SOURCE_UNITS` pour les futures unités de source T1. */
  name: DocumentSourceKind;
  load(p: { accountId: number; fileId: number; t1Candidates: readonly StoredT1Candidate[] }): Promise<DocumentSourceContribution | null>;
}

const MAX_TEXT = 200_000;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** Fournisseur par défaut : représentation T1 persistée (extraction, transcription, faits actifs). */
const persistedKnowledgeProvider: DocumentSourceProvider = {
  name: 'EXTRACTION',
  async load({ accountId, fileId }) {
    const k = await getDocumentKnowledge(accountId, fileId);
    if (!k) return null;
    const e = k.extraction;
    const texts: DocumentSourceText[] = [];
    if (e.title) texts.push({ origin: 'EXTRACTION', zone: 'TITLE', text: e.title });
    if (e.description) texts.push({ origin: 'EXTRACTION', zone: 'DESCRIPTION', text: e.description });
    if (e.visualSummary) texts.push({ origin: 'EXTRACTION', zone: 'DESCRIPTION', text: e.visualSummary });
    if (e.fullText) texts.push({ origin: 'TRANSCRIPTION', zone: 'BODY', text: e.fullText.slice(0, MAX_TEXT) });
    const facts: DocumentSourceFact[] = k.facts.map((f) => ({
      origin: 'FACTS',
      canonicalKey: f.canonicalKey ?? null,
      label: f.label ?? null,
      subject: f.subject ?? null,
      value: str(f.normalizedValue) ?? str(f.valueText) ?? str(f.valueNumber),
      excerpt: f.excerpt ?? null,
      targetType: f.targetType ?? null,
      targetEntityId: f.targetEntityId == null ? null : Number(f.targetEntityId),
      periodStart: f.periodStart ?? null,
      periodEnd: f.periodEnd ?? null,
    }));
    return {
      extraction: {
        extractedAt: e.extractedAt ? new Date(String(e.extractedAt)).toISOString() : null,
        title: e.title, description: e.description, documentType: e.documentTypeCode, documentDate: e.documentDate,
        supplier: e.supplierName, multiAsset: e.multiAsset ?? null,
      },
      texts,
      facts,
    };
  },
};

/** Preuves lues par T1 pour ses candidats (signaux, raisons). */
const t1CandidatesProvider: DocumentSourceProvider = {
  name: 'T1_CANDIDATES',
  async load({ t1Candidates }) {
    const texts = t1Candidates
      .flatMap((c) => [c.signals, c.reason])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((text) => ({ origin: 'T1_CANDIDATES' as const, zone: 'SIGNAL' as const, text }));
    return texts.length ? { texts } : null;
  },
};

const providers = new Map<string, DocumentSourceProvider>([
  [persistedKnowledgeProvider.name, persistedKnowledgeProvider],
  [t1CandidatesProvider.name, t1CandidatesProvider],
]);

/**
 * Enregistre (ou remplace) un fournisseur de connaissance documentaire —
 * point d'extension des futures `document_source_units`.
 */
export function registerDocumentSourceProvider(p: DocumentSourceProvider): void {
  providers.set(p.name, p);
}

/** Fournisseurs enregistrés (ordre d'enregistrement). */
export function documentSourceProviders(): DocumentSourceProvider[] {
  return [...providers.values()];
}

/**
 * Empreinte de la connaissance documentaire (pure) : textes hachés, faits
 * triés. Les textes de la couche exhaustive (SOURCE_UNITS, UNRESOLVED_FACTS)
 * n'y entrent pas en bloc : seules les unités CONSIDÉRÉES entrent dans
 * l'empreinte du contexte (`documentAssetContextFingerprint`, lot 49B) — une
 * empreinte stable, qui ne change que pour une connaissance pertinente.
 */
export function documentKnowledgeDigest(s: Pick<DocumentKnowledgeSources, 'extraction' | 'texts' | 'facts'>): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(s.extraction ?? null));
  for (const t of s.texts.filter((x) => !EXHAUSTIVE_SOURCE_KINDS.includes(x.origin)).sort((a, b) => `${a.origin}|${a.zone}`.localeCompare(`${b.origin}|${b.zone}`) || a.text.localeCompare(b.text))) {
    h.update(`\u0001${t.origin}|${t.zone}|${t.text}`);
  }
  const facts = s.facts
    .map((f) => [f.origin, f.canonicalKey, f.label, f.subject, f.value, f.targetType, f.targetEntityId, f.periodStart, f.periodEnd])
    .map((x) => JSON.stringify(x))
    .sort();
  for (const f of facts) h.update(`\u0002${f}`);
  return h.digest('hex');
}

/**
 * Connaissance documentaire d'un document, tous fournisseurs confondus. Un
 * fournisseur en échec n'empêche pas les autres (journalisé) ; `null` si
 * aucune représentation T1 n'existe (rien à réconcilier).
 */
export async function loadDocumentKnowledgeSources(p: {
  accountId: number; fileId: number; t1Candidates?: readonly StoredT1Candidate[];
}): Promise<DocumentKnowledgeSources | null> {
  const out: Omit<DocumentKnowledgeSources, 'digest'> = {
    accountId: p.accountId, fileId: p.fileId, origins: [], extraction: null, texts: [], facts: [], failedOrigins: [],
  };
  for (const provider of providers.values()) {
    let c: DocumentSourceContribution | null = null;
    try {
      c = await provider.load({ accountId: p.accountId, fileId: p.fileId, t1Candidates: p.t1Candidates ?? [] });
    } catch (e) {
      console.error(`[t3-document-sources] fournisseur ${provider.name} en échec (document ${p.fileId}) :`, (e as Error).message);
      out.failedOrigins!.push(String(provider.name));
      continue;
    }
    if (!c) continue;
    out.origins.push(provider.name);
    if (c.extraction && !out.extraction) out.extraction = c.extraction;
    if (c.texts) out.texts.push(...c.texts);
    if (c.facts) out.facts.push(...c.facts);
  }
  if (!out.extraction) return null;
  return { ...out, digest: documentKnowledgeDigest(out) };
}

/**
 * Sources documentaires RÉELLEMENT utilisées (monitoring, lot 49B) :
 * EXTRACTION, TRANSCRIPTION, FACTS, T1_CANDIDATES, SOURCE_UNITS,
 * UNRESOLVED_FACTS — selon les textes et faits effectivement chargés. Pure.
 */
export function usedDocumentSources(s: Pick<DocumentKnowledgeSources, 'texts' | 'facts'> | null): string[] {
  if (!s) return [];
  const out = new Set<string>(s.texts.map((t) => String(t.origin)));
  if (s.facts.length > 0) out.add('FACTS');
  const ordre = ['EXTRACTION', 'TRANSCRIPTION', 'FACTS', 'T1_CANDIDATES', 'SOURCE_UNITS', 'UNRESOLVED_FACTS'];
  return [...out].sort((a, b) => (ordre.indexOf(a) + 1 || 99) - (ordre.indexOf(b) + 1 || 99) || a.localeCompare(b));
}
