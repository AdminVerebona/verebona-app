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
 *   · demain SOURCE_UNITS (`document_source_units`, ticket T1 « extraction
 *     exhaustive ») : il suffira d'appeler `registerDocumentSourceProvider`
 *     depuis le module qui crée ces unités — aucune refonte du moteur. Ses
 *     textes et faits entreront dans la découverte ET dans l'empreinte du
 *     contexte (`digest`), donc une nouvelle unité rendra les anciennes
 *     décisions réévaluables.
 *
 * Jamais le fichier, jamais d'OCR, jamais T1 : seulement ce qui est persisté.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { getDocumentKnowledge } from '../../knowledge/document-knowledge.service';
import type { StoredT1Candidate } from './resolution.repository';

/** Origine d'un élément de connaissance documentaire. */
export type DocumentSourceKind = 'EXTRACTION' | 'TRANSCRIPTION' | 'FACTS' | 'T1_CANDIDATES' | 'SOURCE_UNITS' | (string & {});

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
export const persistedKnowledgeProvider: DocumentSourceProvider = {
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
export const t1CandidatesProvider: DocumentSourceProvider = {
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

/** Empreinte de la connaissance documentaire (pure) : textes hachés, faits triés. */
export function documentKnowledgeDigest(s: Pick<DocumentKnowledgeSources, 'extraction' | 'texts' | 'facts'>): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(s.extraction ?? null));
  for (const t of [...s.texts].sort((a, b) => `${a.origin}|${a.zone}`.localeCompare(`${b.origin}|${b.zone}`) || a.text.localeCompare(b.text))) {
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
    accountId: p.accountId, fileId: p.fileId, origins: [], extraction: null, texts: [], facts: [],
  };
  for (const provider of providers.values()) {
    let c: DocumentSourceContribution | null = null;
    try {
      c = await provider.load({ accountId: p.accountId, fileId: p.fileId, t1Candidates: p.t1Candidates ?? [] });
    } catch (e) {
      console.error(`[t3-document-sources] fournisseur ${provider.name} en échec (document ${p.fileId}) :`, (e as Error).message);
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
