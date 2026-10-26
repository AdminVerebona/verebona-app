/**
 * Cas de référence T1 dans la qualification par couple — lot 86A (CDC
 * Pilotage IA V2 P5, C-Q9 : le harnais historique est ABSORBÉ, pas doublé).
 *
 * Le corpus de référence §11.1 (28 documents synthétiques à attendus
 * champ par champ, `governance/corpus/corpus-cases.ts`) servait au
 * « comparateur de moteurs » (`corpus-runner`, cron `corpus-run`), retiré au
 * lot 86A. Ses cas et son comparateur (`corpus-comparator.ts`) deviennent des
 * cas de la qualification de `t1_analyze_document`, exécutés par la MÊME
 * passerelle que les autres cas (couple désigné, révision épinglée) ; seule
 * la construction des variables (fonction de production
 * `buildAnalyzeDocumentVariables`) et la lecture de la sortie (aplatissement
 * vers les champs comparés) viennent d'ici.
 *
 * ⚠️ Cas CONSULTATIFS (non bloquants) : leurs clés d'attendus (« prixAchat »,
 * « surfaceHabitable »…) sont antérieures aux clés canoniques du master T1 ;
 * tant que l'équipe IA ne les a pas validées (demande
 * `l86/demandes-ia/86A-contrats-qualite-operations.md`), un écart pourrait
 * venir du harnais et non du modèle. Leurs défauts sont relevés et affichés,
 * jamais comptés dans le verdict.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilitiesForPlan } from '@/services/account-capabilities.service';
import { buildAnalyzeDocumentVariables } from '../source-analysis/master/prompt-context';
import type { T1AnalyzeDocumentOutput } from '../source-analysis/master/t1-contract';
import type { CorpusCase } from '../governance/corpus/corpus-registry';
import type { ObservedResult } from '../governance/corpus/corpus-comparator';

/** Documents du corpus de référence (HTML anonymisés / synthétiques). */
export function readT1ReferenceFixture(fixturePath: string): string {
  const parSource = join(__dirname, '..', 'governance', 'corpus', 'fixtures');
  const dir = existsSync(parSource) ? parSource : join(process.cwd(), 'src', 'services', 'ai', 'governance', 'corpus', 'fixtures');
  return readFileSync(join(dir, fixturePath), 'utf-8');
}

/**
 * Aplatit la sortie ANALYZE_DOCUMENT vers la forme comparée : faits sous leur
 * clé canonique (à défaut la clé lue), métadonnées de tête ajoutées seulement
 * si un fait ne porte pas déjà la clé (le fait fait autorité).
 */
export function aplatir(sortie: T1AnalyzeDocumentOutput): Record<string, unknown> {
  const champs: Record<string, unknown> = {};
  for (const f of sortie.facts ?? []) {
    const cle = f.canonicalKey ?? f.rawKey ?? null;
    if (cle && f.normalizedValue !== undefined && f.normalizedValue !== null) champs[cle] = f.normalizedValue;
  }
  const doc = sortie.document ?? {};
  const tete: Array<[string, unknown]> = [
    ['title', doc.title?.value], ['description', doc.description?.value], ['documentDate', doc.documentDate?.value],
    ['dateFacture', doc.documentDate?.value], ['supplier', doc.supplier?.name], ['amountCents', doc.amountCents?.value],
  ];
  for (const [cle, v] of tete) if (v !== undefined && v !== null && champs[cle] === undefined) champs[cle] = v;
  return champs;
}

/**
 * Texte brut d'un document HTML du corpus : le moteur reçoit ce que
 * produirait une extraction, jamais la structure explicite du HTML.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(tr|p|h1|h2|div|li)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Variables du master T1 (fonction de PRODUCTION) pour un cas de référence :
 * source texte synthétique, biens candidats déclarés par le cas (identifiants
 * fictifs : la mesure de fuite porte sur les libellés), compte Premium (la
 * mesure porte sur le master, pas sur l'offre).
 */
export function t1ReferenceVariables(c: CorpusCase, html: string, accountId: number): Record<string, unknown> {
  const candidats = c.expected.assetRefs ?? [];
  return buildAnalyzeDocumentVariables({
    input: {
      sourceType: 'file', sourceIds: [0], accountId, userId: 0, mimeTypes: ['text/plain'],
      displayNames: [`${c.caseId}.txt`], extractedContent: htmlToPlainText(html),
    },
    groupIndices: [0],
    ctx: {
      accountId, userId: 0,
      assets: candidats.map((label, i) => ({ id: i + 1, name: label, category: null, subtype: null })),
      rooms: [], equipments: [], existingTitles: [], linkedAssetId: null,
    },
    v2Families: [],
    capabilities: capabilitiesForPlan('premium'),
  }) as unknown as Record<string, unknown>;
}

/** Sortie du master (déjà validée par la passerelle) → résultat comparé. */
export function observedFromT1Output(c: CorpusCase, output: T1AnalyzeDocumentOutput, meta: { durationMs?: number; costMicros?: number } = {}): ObservedResult {
  const candidats = c.expected.assetRefs ?? [];
  const cl = output.document?.classification;
  return {
    documentType: cl?.canonicalType ?? cl?.documentTypeCode ?? undefined,
    fields: aplatir(output),
    assetRefs: (output.entities?.assets ?? [])
      .map((a) => (a.entityId ? candidats[a.entityId - 1] : a.rawLabel) ?? null)
      .filter((x): x is string => Boolean(x)),
    schemaValid: true,
    usedFallback: false,
    costMicros: meta.costMicros ?? 0,
    durationMs: meta.durationMs ?? 0,
  };
}
