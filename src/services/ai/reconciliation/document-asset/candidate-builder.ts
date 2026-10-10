/**
 * CANDIDATE BUILDER serveur de T3 DOCUMENT_ASSET (lot 34E — ticket « T3 —
 * réconciliation continue des documents non résolus »). Module PUR : aucune
 * base, aucun appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCOUVERTE ≠ DÉCISION
 *
 *   document non rattaché
 *     → buildDocumentAssetCandidates (CE module : propose, trace la provenance)
 *     → résolution déterministe (`decision.ts`)
 *     → si non conclusif : T3 IA sur les candidats (monde fermé, prompt
 *       INCHANGÉ)
 *     → APPLY / ABSTAIN
 *
 * Les candidats T1 restent des INDICES : la recherche ne dépend plus d'eux.
 * T3 retrouve un bien même si `t1Candidates = []`, à partir de la connaissance
 * persistée du document (`document-sources.ts`) et de l'état ACTUEL du compte
 * (`matching-index.ts` : TOUS les biens, sans borne de découverte).
 *
 * Sources (provenance tracée sur chaque candidat) :
 *   STRONG_IDENTIFIER  adresse, cadastre, immatriculation, VIN, n° de série
 *                      (du bien, ou d'un de ses équipements) — exact, serveur ;
 *   T1_CANDIDATE       bien proposé par T1 (identifiant vérifié) ;
 *   FACT_TARGET        cible d'un fait (bien, ou bien porteur d'un équipement /
 *                      d'une pièce ciblé) ;
 *   SECONDARY_LINK     lien SECONDARY existant ;
 *   MENTIONED_ASSET    lien MENTIONED existant (bien cité) ;
 *   EXACT_NAME         nom DISCRIMINANT du bien cité (« Maison de Valence ») ;
 *   ALIAS              alias du bien cité ;
 *   CATEGORY_SUBTYPE   catégorie citée (« maison ») → biens de cette catégorie
 *                      — indice de contexte, JAMAIS une preuve ;
 *   BRAND_MODEL        marque ET modèle du bien cités ;
 *   SHARED_REFERENCE   n° de contrat / police porté aussi par un document
 *                      DÉJÀ rattaché à ce bien ;
 *   CONTEXTUAL_MATCH   ville + code postal du bien, équipement / pièce du bien
 *                      cité par son nom — indice de contexte.
 *
 * Un nom générique (« Maison », « Voiture », « Maison 1 ») n'est jamais un
 * EXACT_NAME : seule la catégorie est retenue, sans valeur de preuve —
 * « Maison » ne rattache jamais automatiquement un document quand plusieurs
 * maisons existent (le modèle, puis l'utilisateur, tranchent).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { assetDesignationsIn, subtypeMatchesCategory, withoutAssetDesignations } from '@/lib/asset-taxonomy';
import type { AttachmentState } from './attachment-state';
import type { DocumentKnowledgeSources, DocumentTextZone } from './document-sources';
import {
  matchSignals, normalizeCode, normalizeText, resolveAssetByIdentifiers,
  type AssetIdentifierRecord, type IdentifierResolution,
} from './identifiers';
import { REFERENCE_KEYS, type AccountMatchingIndex } from './matching-index';
import type { StoredT1Candidate } from './resolution.repository';

/**
 * Version du Candidate Builder (entre dans l'empreinte du contexte). À
 * incrémenter à chaque changement des sources ou des règles de découverte.
 *   · 1 — lot 34E : première version.
 */
export const CANDIDATE_BUILDER_VERSION = 1;

export const CANDIDATE_SOURCES = [
  'STRONG_IDENTIFIER', 'T1_CANDIDATE', 'FACT_TARGET', 'SECONDARY_LINK', 'MENTIONED_ASSET',
  'EXACT_NAME', 'ALIAS', 'CATEGORY_SUBTYPE', 'BRAND_MODEL', 'SHARED_REFERENCE', 'CONTEXTUAL_MATCH',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** Sources qui ne sont que du CONTEXTE (jamais une preuve suffisante). */
export const CONTEXT_ONLY_SOURCES: readonly CandidateSource[] = ['CATEGORY_SUBTYPE', 'CONTEXTUAL_MATCH'];

export interface BuiltCandidate {
  assetId: number;
  sources: CandidateSource[];
  /** Preuves serveur (libellés SANS valeur) : comptent comme preuve fournie au modèle. */
  evidenceSignals: string[];
  /** Indices de contexte (catégorie, ville…) — transmis, jamais une preuve. */
  contextSignals: string[];
  /**
   * Nom ou alias DISCRIMINANT (au moins deux mots significatifs) cité dans une
   * zone qui désigne le document (titre, description, fait) — base de la
   * règle déterministe « nom distinctif unique ».
   */
  distinctiveNameMatch: boolean;
}

export interface CandidateBuildInput {
  index: AccountMatchingIndex;
  sources: DocumentKnowledgeSources | null;
  state: Pick<AttachmentState, 'secondaryAssetIds' | 'mentionedAssetIds'>;
  t1Candidates: readonly StoredT1Candidate[];
  /** Document en cours (ses propres faits ne comptent pas comme « autre document »). */
  fileId: number;
}

export interface CandidateBuildResult {
  /** Candidats triés par identifiant de bien. */
  candidates: BuiltCandidate[];
  /** Correspondances fortes (identifiants canoniques, séries d'équipements). */
  identification: IdentifierResolution;
  /** Sources effectivement testées (monitoring, NO_CANDIDATE expliqué). */
  testedSources: CandidateSource[];
  /** `assetId:NATURE` des correspondances fortes. */
  deterministicMatches: string[];
}

const STOPWORDS = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'en', 'et', 'mon', 'ma', 'mes', 'notre', 'nos', 'un', 'une', 'the', 'of',
]);

/** Mots significatifs d'un nom normalisé (sans mots vides). */
export function significantTokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Le nom désigne-t-il CE bien plutôt qu'une catégorie ? Il reste au moins un
 * mot de 3 lettres une fois retirés les désignations de biens (« maison »,
 * « voiture »…) et les mots vides : « Maison de Valence », « Polo » oui ;
 * « Maison », « Maison 1 », « Ma voiture » non.
 */
export function isDistinctiveName(normalized: string): boolean {
  const reste = significantTokens(withoutAssetDesignations(normalized));
  return reste.some((t) => /^[a-z]{3,}$/.test(t) || (/[a-z]/.test(t) && t.length >= 4));
}

/** Nom assez discriminant pour un rattachement déterministe : distinctif ET au moins deux mots significatifs. */
export function isStrongName(normalized: string): boolean {
  return isDistinctiveName(normalized) && significantTokens(normalized).length >= 2;
}

const pad = (s: string) => ` ${s} `;
const phraseIn = (hay: string, phrase: string) => !!phrase && hay.includes(pad(phrase));

/**
 * Pseudo-identifiants des équipements : un numéro de série d'équipement
 * désigne son bien porteur (rapprochement fort, serveur).
 */
function equipmentRecords(index: AccountMatchingIndex): AssetIdentifierRecord[] {
  return index.entities
    .filter((e) => e.type === 'EQUIPMENT' && e.serial && index.byId.has(e.assetId))
    .map((e) => ({ assetId: e.assetId, family: 'OBJECT' as const, values: { serialNumber: e.serial! } }));
}

/** Construit les candidats d'un document (pure, déterministe). */
export function buildDocumentAssetCandidates(input: CandidateBuildInput): CandidateBuildResult {
  const { index, sources, state } = input;
  const byAsset = new Map<number, BuiltCandidate>();
  const tested = new Set<CandidateSource>();
  const add = (assetId: number, source: CandidateSource, signal?: { evidence?: string; context?: string }) => {
    if (!index.byId.has(assetId)) return;
    const c = byAsset.get(assetId) ?? { assetId, sources: [], evidenceSignals: [], contextSignals: [], distinctiveNameMatch: false };
    if (!c.sources.includes(source)) c.sources.push(source);
    if (signal?.evidence && !c.evidenceSignals.includes(signal.evidence)) c.evidenceSignals.push(signal.evidence);
    if (signal?.context && !c.contextSignals.includes(signal.context)) c.contextSignals.push(signal.context);
    byAsset.set(assetId, c);
  };

  const texts = sources?.texts ?? [];
  const facts = sources?.facts ?? [];
  const zoneText = (zones: DocumentTextZone[]) => texts.filter((t) => zones.includes(t.zone)).map((t) => t.text);
  const factTexts = facts.flatMap((f) => [f.value, f.subject, f.label]).filter((x): x is string => !!x);
  // Zones qui DÉSIGNENT le document ; corps (transcription, signaux T1) à part.
  const designating = pad(normalizeText([...zoneText(['TITLE', 'DESCRIPTION']), ...factTexts].join(' \n ')));
  const body = pad(normalizeText(zoneText(['BODY', 'SIGNAL']).join(' \n ')));
  const anywhere = `${designating} ${body}`;

  // ── STRONG_IDENTIFIER (biens + séries d'équipements) ─────────────────────
  tested.add('STRONG_IDENTIFIER');
  const identification = resolveAssetByIdentifiers([...index.records, ...equipmentRecords(index)], {
    facts: facts.map((f) => ({ canonicalKey: f.canonicalKey, value: f.value })),
    texts: texts.map((t) => t.text),
  });
  for (const id of identification.assetIds) {
    for (const s of matchSignals(identification, id)) add(id, 'STRONG_IDENTIFIER', { evidence: s });
  }

  // ── Indices T1, faits, liens ─────────────────────────────────────────────
  if (input.t1Candidates.length) tested.add('T1_CANDIDATE');
  for (const c of input.t1Candidates) add(c.assetId, 'T1_CANDIDATE');
  tested.add('FACT_TARGET');
  for (const f of facts) {
    if (f.targetEntityId == null) continue;
    if (f.targetType === 'ASSET') add(f.targetEntityId, 'FACT_TARGET');
    else if (f.targetType === 'EQUIPMENT' || f.targetType === 'ROOM') {
      const e = index.entities.find((x) => x.type === f.targetType && x.id === f.targetEntityId);
      if (e) add(e.assetId, 'FACT_TARGET', { context: `${f.targetType === 'EQUIPMENT' ? 'équipement' : 'pièce'} du bien ciblé par un fait du document` });
    }
  }
  tested.add('SECONDARY_LINK');
  for (const id of state.secondaryAssetIds) add(id, 'SECONDARY_LINK');
  tested.add('MENTIONED_ASSET');
  for (const id of state.mentionedAssetIds) add(id, 'MENTIONED_ASSET');

  if (designating.trim() || body.trim()) {
    // ── Noms, alias ──────────────────────────────────────────────────────────
    tested.add('EXACT_NAME');
    tested.add('ALIAS');
    for (const a of index.assets) {
      const formes: Array<{ forme: string; source: 'EXACT_NAME' | 'ALIAS' }> = [
        { forme: a.normalizedName, source: 'EXACT_NAME' }, ...a.aliases.map((forme) => ({ forme, source: 'ALIAS' as const })),
      ];
      for (const { forme, source } of formes) {
        if (forme.length < 3 || !isDistinctiveName(forme)) continue;
        const dansDesignation = phraseIn(designating, forme);
        if (!dansDesignation && !phraseIn(body, forme)) continue;
        const ou = dansDesignation ? 'dans le titre, la description ou un fait du document' : 'dans le texte du document';
        add(a.assetId, source, { evidence: `${source === 'ALIAS' ? 'alias' : 'nom'} du bien cité ${ou} (contrôle serveur exact)` });
        if (dansDesignation && isStrongName(forme)) byAsset.get(a.assetId)!.distinctiveNameMatch = true;
      }
    }

    // ── Catégorie / sous-type (contexte) ─────────────────────────────────────
    tested.add('CATEGORY_SUBTYPE');
    const designations = assetDesignationsIn([...zoneText(['TITLE', 'DESCRIPTION']), ...factTexts].join(' \n '))
      .filter((d) => d.kind === 'category' && d.category);
    for (const d of designations) {
      for (const a of index.assets) {
        if (subtypeMatchesCategory(a.subtype, d.category!)) {
          add(a.assetId, 'CATEGORY_SUBTYPE', { context: `catégorie du bien citée par le document (${d.matched})` });
        }
      }
    }

    // ── Marque + modèle ──────────────────────────────────────────────────────
    tested.add('BRAND_MODEL');
    for (const a of index.assets) {
      if (a.brandModel && phraseIn(anywhere, a.brandModel)) add(a.assetId, 'BRAND_MODEL', { evidence: 'marque et modèle du bien cités par le document' });
    }
    for (const e of index.entities) {
      if (e.brandModel && phraseIn(anywhere, e.brandModel)) {
        add(e.assetId, 'BRAND_MODEL', { evidence: 'marque et modèle d’un équipement du bien cités par le document' });
      }
    }

    // ── Contexte : ville + code postal, équipement / pièce cité ─────────────
    tested.add('CONTEXTUAL_MATCH');
    for (const a of index.assets) {
      if (a.city && a.postalCode && phraseIn(anywhere, a.city) && anywhere.includes(pad(a.postalCode))) {
        add(a.assetId, 'CONTEXTUAL_MATCH', { context: 'ville et code postal du bien cités par le document' });
      }
    }
    for (const e of index.entities) {
      const n = e.normalizedName;
      if (n.length >= 3 && isDistinctiveName(n) && significantTokens(n).length >= (e.type === 'ROOM' ? 2 : 1) && phraseIn(designating, n)) {
        add(e.assetId, 'CONTEXTUAL_MATCH', { context: `${e.type === 'EQUIPMENT' ? 'équipement' : 'pièce'} du bien cité par son nom` });
      }
    }
  }

  // ── Référence partagée avec un document déjà rattaché ────────────────────
  const refs = facts
    .filter((f) => f.canonicalKey && (REFERENCE_KEYS as readonly string[]).includes(f.canonicalKey) && f.value)
    .map((f) => normalizeCode(f.value));
  if (refs.length) tested.add('SHARED_REFERENCE');
  for (const ref of refs) {
    const parBien = index.references.get(ref);
    if (!parBien) continue;
    for (const [assetId, docs] of parBien) {
      if ([...docs].some((d) => d !== input.fileId)) {
        add(assetId, 'SHARED_REFERENCE', { evidence: 'référence de contrat identique à celle d’un document déjà rattaché à ce bien' });
      }
    }
  }

  const candidates = [...byAsset.values()]
    .map((c) => ({ ...c, sources: CANDIDATE_SOURCES.filter((s) => c.sources.includes(s)), evidenceSignals: [...c.evidenceSignals].sort(), contextSignals: [...c.contextSignals].sort() }))
    .sort((a, b) => a.assetId - b.assetId);
  return {
    candidates,
    identification,
    testedSources: CANDIDATE_SOURCES.filter((s) => tested.has(s)),
    deterministicMatches: identification.matches.map((m) => `${m.assetId}:${m.kind}`).sort(),
  };
}
