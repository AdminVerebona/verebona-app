/**
 * Étape « périmètre sémantique » de l'orchestrateur — lot 49.
 *
 *   question → règle déterministe FORTE ? → traitement direct
 *            → sinon (WEAK, périmètre non résolu, doute) :
 *                T2 UNDERSTAND (intention, cible, faits, sujets, filtres)
 *              → cible résolue par le SERVEUR (biens disponibles)
 *              → sources métier RÉELLES exposées (opérations d'abord)
 *              → 1 interprétation : lecture canonique, réponse serveur
 *                ≥ 2             : clarification, choix issus des données
 *                0               : information insuffisante — jamais un
 *                                  total plus large.
 *
 * UNDERSTAND est appelé AU PLUS une fois par demande (budget du message,
 * annulation et plafond mensuel contrôlés par l'orchestrateur, qui fournit
 * `understand`). Sans IA (offre, arrêt d'urgence, budget), la même sélection
 * s'applique au seul résidu déterministe : jamais de compréhension inventée.
 */
import { randomUUID } from 'crypto';
import type { AssistantRequestInput, IntentRoute } from '../types/contracts';
import type { ClarificationState } from '../types/machine';
import type { Claim, RetrievedSource } from '../types/sources';
import type { VerebonaIntent } from '../types/intents';
import type { AssistantTargets } from './assistant-targets';
import { CLARIFICATION_TTL_MS } from './clarification-builder';
import {
  amountNatureOf, carriesRequestedValue, contextualQuestion, detectValueNeed, diversifiedCandidates, lexicalMatchEstablished, selectInterpretations,
  semanticQuestion, semanticTerms, sourceDomain, validateSemanticDecision, wantsAggregate,
  type BusinessSource, type RawSemanticDecision, type SemanticNeed, type SemanticTrace, type ValueNeed,
} from './semantic-scope';
import { interactionHandling, type ValidatedContextFact } from './interaction';
import { answerFromBusinessSource } from '../canonical/business-sources';
import { buildTargetClarification } from './clarification-builder';
import { routeForIntent } from './intent-router.service';
import { analyserPeriode, aujourdhuiParis, type PeriodeResolue } from './query-period';

/**
 * Période RÉSOLUE de la question (lot 53, PO D21) : « en 2025 », « mars
 * 2026 » (une période ambiguë a déjà fait l'objet d'une clarification de
 * période en amont ; la reprise rejoue la demande avec la période choisie).
 */
function periodeDe(message: string): PeriodeResolue | null {
  const p = analyserPeriode(message ?? '', aujourdhuiParis());
  return p?.kind === 'resolved' ? p : null;
}

/** Bornes d'une clarification contextuelle (lot 53, PO Q24). */
const CONTEXTUAL_MIN = 2;
const CONTEXTUAL_MAX = 6;
/** Candidats présentés au plus à T2 pour l'arbitrage (lot 54E, #419 écart 1). */
const ARBITRATION_MAX = 12;

/** Candidat présenté à T2 (référence OPAQUE, données déjà bornées par le serveur). */
export interface ArbitrationCandidate {
  ref: string;
  kind: string;
  label: string;
  detail: string | null;
  asset: string | null;
  carriesRequestedValue: boolean;
  /** Lot 75J (#419 R01) : nature du montant (montant demandé seulement). */
  amountNature?: string | null;
}

/** Ports utilisés par l'étape (sous-ensemble de `OrchestratorPorts`). */
interface SemanticPorts {
  resolveTargets?(input: AssistantRequestInput, route: IntentRoute): Promise<AssistantTargets>;
  listBusinessSources?(accountId: number, req: { assetIds: number[]; assetNames?: Record<number, string>; need: SemanticNeed; includeUntargeted?: boolean }): Promise<{ sources: BusinessSource[]; domains: string[] }>;
  readBusinessSource?(accountId: number, ref: string, ctx: { assetIds: number[]; assetNames?: Record<number, string> }): Promise<BusinessSource | null>;
}

export type SemanticOutcome =
  | { kind: 'answer'; text: string; sources: RetrievedSource[]; claims: Claim[]; strategy: string; intent: VerebonaIntent }
  | { kind: 'clarify'; state: ClarificationState; intent: VerebonaIntent }
  | { kind: 'insufficient'; text: string; intent: VerebonaIntent; strategy: string }
  /** UNDERSTAND lit autre chose qu'une question sur les données (aide…) : sa route prime. */
  | { kind: 'reroute'; route: IntentRoute }
  /** Lot 54E (#419 §15) : l'utilisateur APPORTE une information — traitée par l'orchestrateur (proposition, contexte). */
  | { kind: 'interaction'; route: IntentRoute }
  /** Étape non applicable (aucun port, aucune cible lisible) : la cascade suit son cours, sans élargissement. */
  | { kind: 'continue' };

/** Phrase « information insuffisante » (jamais « rien trouvé » d'un total plus large). */
function insufficientMessage(terms: readonly string[], assetName: string | null): string {
  const sujet = terms.length ? ` sur « ${terms.slice(0, 3).join(' ')} »` : '';
  return `Je n’ai trouvé aucune donnée${sujet}${assetName ? ` pour ${assetName}` : ''} qui réponde précisément à votre question. `
    + 'Je préfère ne pas vous donner un total plus large qui n’y répondrait pas : précisez le contrat, le service ou le document concerné.';
}

/** Intention de données conservée (celle d'UNDERSTAND si elle porte sur le compte). */
function intentionDonnees(route: IntentRoute, compris: IntentRoute | null): VerebonaIntent {
  if (compris && compris.intent.startsWith('ACCOUNT_')) return compris.intent;
  return route.intent.startsWith('ACCOUNT_') ? route.intent : 'ACCOUNT_FACT_ASSET';
}

/** Réponse d'une interprétation unique (lecture canonique). */
function repondre(
  s: BusinessSource, need: ValueNeed | null, assetName: string | null, intent: VerebonaIntent, trace: SemanticTrace,
  period: PeriodeResolue | null = null, aggregate = false,
): SemanticOutcome {
  const r = s.domain === 'context'
    ? contextAnswer(s, assetName)
    : answerFromBusinessSource(s, need, { assetName, period, aggregate });
  trace.semanticScopeResolved = true;
  trace.selectedSource = s.ref;
  trace.selectedOperationId = s.domain === 'operation' ? Number(s.ref.split(':')[1]) : null;
  const claims: Claim[] = [{ claimKey: `semantic:${s.ref}`, text: r.text, sourceIds: r.sources.map((x) => x.id), derivation: 'direct' }];
  return { kind: 'answer', text: r.text, sources: r.sources, claims, strategy: `semantic.${s.domain}`, intent };
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 75J (#419 R07) — INFORMATIONS DE CONTEXTE AU SERVICE DE LA QUESTION
//
// Une information apportée « pour contexte » dans un message MIXED (valeur
// RELUE dans le message par le serveur, clé du registre, cible résolue par le
// serveur) devient une source TEMPORAIRE de cette seule demande :
//   · même clé enregistrée, même valeur → la donnée enregistrée répond ;
//   · même clé enregistrée, valeur DIFFÉRENTE → contradiction SIGNALÉE,
//     jamais tranchée, jamais remplacée ;
//   · sinon → source `context:<bien>:<clé>`, sélectionnable comme un champ ;
//     la réponse dit qu'elle n'a pas été enregistrée.
// Une information non utilisée par la réponse est dite (jamais ignorée en
// silence). AUCUNE écriture.
// ══════════════════════════════════════════════════════════════════════════

/** Source temporaire d'une information de contexte (pure, testée). */
function contextFactSource(f: ValidatedContextFact, assetId: number | null): BusinessSource {
  const date = f.valueType === 'date' ? f.value : null;
  const montant = f.valueType === 'money_eur' && Number.isFinite(Number(f.value)) ? Math.round(Number(f.value) * 100) : null;
  const affiche = date ? frDateIso(date) : f.value;
  return {
    ref: `context:${assetId ?? 0}:${f.fieldKey}`, domain: 'context', label: f.label, detail: affiche, text: `${f.label} ${f.fieldKey}`,
    fieldKey: f.fieldKey, assetId, date, endDate: f.endDate, amountCents: montant, amountNature: montant != null ? 'documented' : null,
    meta: { display: affiche, temporary: true },
  };
}

function frDateIso(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Réponse depuis une information de contexte (pure). */
function contextAnswer(s: BusinessSource, assetName: string | null): { text: string; sources: RetrievedSource[] } {
  const pour = assetName ? ` (${assetName})` : '';
  return {
    text: `${s.label}${pour} : ${String((s.meta as { display?: unknown } | undefined)?.display ?? s.detail ?? '')} — valeur indiquée dans votre message, utilisée pour cette réponse seulement : elle n’a pas été enregistrée.`,
    sources: [],
  };
}

/** Phrase « information de contexte non utilisée » (jamais un abandon silencieux). */
function unusedContextNote(facts: readonly ValidatedContextFact[]): string {
  if (!facts.length) return '';
  const liste = facts.map((f) => `« ${f.label} » : ${f.valueType === 'date' ? frDateIso(f.value) : f.value}`).join(', ');
  return ` L’information indiquée dans votre message (${liste}) n’a pas servi à cette réponse ; elle n’a pas été enregistrée.`;
}

interface SemanticStageParams {
  input: AssistantRequestInput;
  route: IntentRoute;
  ports: SemanticPorts;
  trace: SemanticTrace;
  messageId: string;
  /** Résidu déterministe (sujet non consommé). */
  residue: string[];
  /** Compréhension UNDERSTAND (déjà obtenue, ou à obtenir via `understand`). */
  understood?: IntentRoute | null;
  /** Appel UNDERSTAND borné par l'orchestrateur ; `null` : IA non autorisée. */
  understand?: (() => Promise<IntentRoute | null>) | null;
  /** Besoin déjà compris (reprise après clarification de cible) : aucun appel modèle. */
  preset?: { terms: string[]; facts: string[]; need: ValueNeed | null } | null;
  /** Délai des lectures (ms). */
  withDeadline: <T>(p: Promise<T>) => Promise<T>;
  /**
   * Lot 54E (#419 écart 1) : ARBITRAGE par T2 entre candidats prévalidés
   * (budget, annulation, offre contrôlés par l'orchestrateur) ; `null` /
   * absent : aucun appel — clarification, jamais un choix lexical.
   */
  arbitrate?: ((cands: ArbitrationCandidate[]) => Promise<RawSemanticDecision | null>) | null;
  /**
   * Lot 75J (#419 R07) : informations de CONTEXTE validées par le serveur
   * (message MIXED), avec la cible résolue par le serveur. Présentes :
   * l'étape répond à la question (aucun renvoi vers l'interaction).
   */
  contextFacts?: { facts: ValidatedContextFact[]; assetId: number | null } | null;
}

/** Exécute l'étape sémantique (voir en-tête). */
export async function runSemanticStage(p: SemanticStageParams): Promise<SemanticOutcome> {
  const issue = await runSemanticStageInner(p);
  // Lot 75J (#419 R07) : une information de contexte non utilisée par la réponse est DITE.
  const ctx = p.contextFacts?.facts ?? [];
  if (ctx.length && (issue.kind === 'answer' || issue.kind === 'insufficient') && !p.trace.contextContradiction) {
    const utilisees = new Set(p.trace.contextFactsUsed);
    const reste = ctx.filter((f) => !utilisees.has(f.fieldKey));
    if (reste.length) return { ...issue, text: `${issue.text}${unusedContextNote(reste)}` };
  }
  return issue;
}

async function runSemanticStageInner(p: SemanticStageParams): Promise<SemanticOutcome> {
  const { input, route, ports, trace } = p;
  if (!ports.listBusinessSources) return { kind: 'continue' };

  // ── 1. Compréhension (UNDERSTAND au plus une fois) ──────────────────────
  let compris = p.understood ?? null;
  if (!compris && !p.preset && p.understand) {
    trace.classificationEscalated = true;
    compris = await p.understand().catch(() => null);
  }
  if (compris) {
    trace.intent = compris.intent;
    trace.understandConfidence = compris.confidence;
    trace.requestedFacts = compris.understanding?.requestedFacts ?? [];
    trace.requestedTopics = compris.understanding?.requestedTopics ?? [];
    const inter = compris.understanding?.interaction;
    if (inter) {
      trace.interactionMode = inter.mode;
      trace.suppliedFactsCount = inter.suppliedFacts.length;
      // Information APPORTÉE (proposition, contexte seul) : jamais servie comme une lecture.
      // Lot 75J : informations de contexte déjà validées par le serveur — la question suit son cours ici.
      if (!p.contextFacts && interactionHandling(inter, input.message)) return { kind: 'interaction', route: compris };
    }
    if (!compris.intent.startsWith('ACCOUNT_') && compris.intent !== 'UNKNOWN' && compris.confidence !== 'ambiguous') {
      trace.fallbackReason = 'UNDERSTAND_NON_DATA_INTENT';
      return { kind: 'reroute', route: compris };
    }
  }
  const intent = intentionDonnees(route, compris);

  // ── 2. Cible : résolue par le SERVEUR (biens disponibles) ───────────────
  const routeCible: IntentRoute = compris && compris.intent.startsWith('ACCOUNT_') ? { ...compris } : route;
  const cibles = ports.resolveTargets ? await p.withDeadline(ports.resolveTargets(input, routeCible)).catch(() => null) : null;
  const catalogue = cibles?.catalog ?? [];
  const assetNames: Record<number, string> = Object.fromEntries(catalogue.map((a) => [a.id, a.name]));
  const repriseBien = Number(input.resume?.assetId ?? input.resume?.semanticSource?.assetId) || null;
  // Nom lu dans le CATALOGUE (le libellé d'une cible de reprise est celui du choix).
  const bien = cibles?.asset ? { id: cibles.asset.id, name: assetNames[cibles.asset.id] ?? cibles.asset.label ?? '' }
    : repriseBien ? { id: repriseBien, name: assetNames[repriseBien] ?? '' } : null;

  // Besoin : termes (résidu + sujets UNDERSTAND), faits du registre, valeur.
  const need: SemanticNeed = p.preset
    ? { terms: p.preset.terms, facts: p.preset.facts, need: p.preset.need }
    : {
      terms: semanticTerms(p.residue, compris?.understanding?.requestedTopics ?? [], compris?.understanding?.filters?.supplier ?? null),
      facts: compris?.understanding?.requestedFacts ?? [],
      need: detectValueNeed(input.message),
    };
  // Lot 75J (#419 R01) : demande de TOTAL (jamais servie par la seule dernière pièce).
  need.aggregate = need.need === 'amount' && wantsAggregate(input.message);
  trace.semanticResidue = [...p.residue];

  if (!bien && cibles?.ambiguity?.kind === 'asset' && cibles.ambiguity.candidates.length >= 2) {
    // Cible ambiguë : la clarification porte d'abord sur le BIEN ; le besoin
    // compris est conservé pour la reprise (aucun nouvel appel modèle).
    const etat = buildTargetClarification({
      ambiguity: cibles.ambiguity, question: 'De quel bien parlez-vous ?',
      accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
      originalMessage: input.message, originalMessageId: p.messageId, originalIntent: intent,
      pageAssetId: Number(input.pageContext?.assetId) || null, requestedFacts: need.facts, chainDepth: (input.resume?.chainDepth ?? 0) + 1,
    });
    trace.clarificationCreated = true;
    trace.clarificationReason = 'SEMANTIC_TARGET_AMBIGUOUS';
    trace.semanticAmbiguity = true;
    return {
      kind: 'clarify', intent,
      state: { ...etat, resolvedContext: { ...etat.resolvedContext, semantic: { terms: need.terms, facts: need.facts, need: need.need, strategyCandidate: trace.structuredStrategyCandidate } } },
    };
  }
  const assetIds = bien ? [bien.id] : catalogue.map((a) => a.id).slice(0, 50);
  trace.resolvedTargets = bien ? [bien.id] : [];

  if (!need.terms.length && !need.facts.length) {
    trace.fallbackReason = 'NO_SEMANTIC_TERMS';
    return { kind: 'insufficient', text: insufficientMessage([], bien?.name ?? null), intent, strategy: 'semantic.insufficient' };
  }

  // ── 3. Sources métier réelles ────────────────────────────────────────────
  // Lot 75J (#419 R04) : aucun bien nommé — les sources du compte SANS bien sont aussi examinées.
  // Lot 75J (#419 R07) : les valeurs ENREGISTRÉES des informations de contexte sont relues (comparaison).
  const ctxFaits = p.contextFacts?.facts ?? [];
  const ctxBien = bien?.id ?? p.contextFacts?.assetId ?? null;
  const besoinLecture: SemanticNeed = ctxFaits.length ? { ...need, facts: [...new Set([...need.facts, ...ctxFaits.map((f) => f.fieldKey)])] } : need;
  const lues = await p.withDeadline(ports.listBusinessSources(input.accountId, { assetIds, assetNames, need: besoinLecture, includeUntargeted: !bien })).catch(() => null);
  if (!lues) {
    trace.fallbackReason = 'BUSINESS_SOURCES_UNREADABLE';
    return { kind: 'insufficient', text: insufficientMessage(need.terms, bien?.name ?? null), intent, strategy: 'semantic.insufficient' };
  }
  trace.sourceDomainsAvailable = lues.domains;
  let sources = lues.sources;
  if (ctxFaits.length) {
    const ajout: BusinessSource[] = [];
    for (const f of ctxFaits) {
      const enregistre = sources.find((x) => x.domain === 'field' && x.fieldKey === f.fieldKey && (ctxBien == null || x.assetId === ctxBien));
      if (enregistre) {
        const valeur = String(enregistre.date ?? (enregistre.amountCents != null ? enregistre.amountCents / 100 : (enregistre.meta as { display?: unknown } | undefined)?.display ?? ''));
        if (valeur.slice(0, 10) === f.value.slice(0, 10) || valeur === f.value) { trace.contextFactsUsed.push(f.fieldKey); continue; }
        // Contradiction : SIGNALÉE, jamais tranchée, jamais remplacée.
        trace.contextContradiction = true;
        trace.contextFactsUsed.push(f.fieldKey);
        trace.fallbackReason = 'CONTEXT_CONTRADICTION';
        const vu = f.valueType === 'date' ? frDateIso(f.value) : f.value;
        const nom = ctxBien != null ? assetNames[ctxBien] ?? bien?.name ?? null : null;
        return {
          kind: 'insufficient', intent, strategy: 'semantic.context_contradiction',
          text: `Votre message indique « ${f.label} » : ${vu}, mais vos données indiquent${nom ? ` pour ${nom}` : ''} : ${String((enregistre.meta as { display?: unknown } | undefined)?.display ?? enregistre.detail ?? '')}. `
            + 'Je ne tranche pas entre les deux : précisez la bonne valeur (et corrigez la fiche si besoin). Rien n’a été modifié.',
        };
      }
      ajout.push(contextFactSource(f, ctxBien));
    }
    sources = [...sources, ...ajout];
  }
  const periode = periodeDe(input.message);
  const sel = selectInterpretations(sources, need, { period: periode });
  trace.semanticCandidates = sel.scored.filter((x) => x.score > 0).slice(0, 20);
  trace.selectionReason = sel.reason;
  trace.candidatesExcluded = sel.excluded.slice(0, 20);
  trace.operationCandidates = sel.selected.filter((s) => s.domain === 'operation').map((s) => Number(s.ref.split(':')[1]));
  /** UNDERSTAND a signalé une ambiguïté (#419 écart 6) : elle pèse sur la décision finale. */
  const ambigu = compris?.confidence === 'ambiguous';
  const nomPour = (s: BusinessSource) => bien?.name || (s.assetId != null ? assetNames[s.assetId] ?? null : null);

  // ── 4. Une / plusieurs / aucune interprétation ──────────────────────────
  // Réservoir d'arbitrage / de clarification ; `contextuelle` : aucune
  // source ne mentionne les termes compris (lot 53, Q24).
  let pool: BusinessSource[];
  /** Clarification de repli (sans arbitrage) — Q24 : opérations seulement. */
  let repliClarification: BusinessSource[] | null = null;
  let motif: 'SEMANTIC_MULTIPLE_INTERPRETATIONS' | 'SEMANTIC_UNDERSTANDING_AMBIGUOUS' | 'SEMANTIC_NO_MATCH_CONTEXTUAL' | 'SEMANTIC_PARTIAL_MATCH';
  if (sel.selected.length === 1) {
    const s = sel.selected[0];
    // Autres sources capables de porter la valeur sur le même périmètre :
    // ce sont les interprétations concurrentes d'une demande ambiguë.
    const concurrentes = sel.eligible.filter((x) => x !== s && carriesRequestedValue(x, need.need) && sourceDomain(x.domain).authority >= 2
      && (!bien || x.assetId === bien.id));
    const champDemande = s.fieldKey != null && need.facts.includes(s.fieldKey);
    // Lot 59 (#419 R04) : une correspondance de mots PARTIELLE n'est pas une
    // preuve — la sélection directe est réservée aux cas établis.
    const sujets = compris?.understanding?.requestedTopics ?? [];
    // Lot 75J : une pièce RATTACHÉE (lien documentaire effectif) à une opération dont la
    // correspondance est établie hérite de cette preuve — lien structuré, pas une proximité de mots.
    const via = sel.scored.find((x) => x.ref === s.ref)?.via;
    const opVia = via ? sources.find((x) => x.ref === via) ?? null : null;
    const etabli = sel.reason === 'COMPLEMENTARY_SAME_REALITY' || lexicalMatchEstablished(s, need, sujets)
      || (opVia != null && lexicalMatchEstablished(opVia, need, sujets));
    trace.lexicalMatchEstablished = etabli;
    // Lot 59 (#419 R05) : une ambiguïté signalée par T2 n'est levée que par
    // une preuve STRUCTURÉE (champ du registre demandé) ou un arbitrage IA
    // validé — l'absence de concurrent n'est PAS une preuve positive.
    // Lot 75J (#419 R04) : hors ambiguïté non plus — l'absence de concurrent ne
    // prouve jamais la pertinence ; seule une correspondance ÉTABLIE (ou le champ
    // du registre demandé) autorise la sélection directe. Sinon : T2 confirme
    // (arbitrage) ou l'utilisateur.
    const preuveForte = ambigu ? champDemande : (etabli || champDemande);
    if (preuveForte) {
      trace.candidateSelectionMode = 'deterministic';
      if (s.domain === 'context') trace.contextFactsUsed.push(s.fieldKey ?? '');
      return repondre(s, need.need, nomPour(s), intent, trace, periode, need.aggregate);
    }
    pool = [s, ...concurrentes];
    motif = ambigu ? 'SEMANTIC_UNDERSTANDING_AMBIGUOUS' : 'SEMANTIC_PARTIAL_MATCH';
  } else if (sel.selected.length > 1) {
    pool = sel.selected;
    motif = 'SEMANTIC_MULTIPLE_INTERPRETATIONS';
  } else {
    // ── Lot 53 (PO Q24) / lot 59 (#419 R04) : aucune correspondance ──────
    // T2 reçoit les candidats de TOUS les domaines qui portent la valeur
    // demandée sur le bien (opérations, champs, agenda, documents), bornés
    // et répartis par domaine ; sans bien, seulement des opérations peu
    // nombreuses. Jamais une seule source servie sans arbitrage.
    // Lot 75J (#419 R04) : avec OU sans bien nommé, T2 reçoit des candidats de TOUS
    // les domaines autorisés qui portent la valeur demandée, répartis par domaine
    // (aucun domaine privilégié) et bornés ; les candidats au-delà de la limite ne
    // sont jamais présentés ni choisis (nombre tracé).
    const ctxOps = sel.eligible.filter((s) => s.domain === 'operation' && porteValeurDemandee(s, need.need) && (!bien || s.assetId === bien.id));
    const ctxTous = sel.eligible.filter((s) => porteValeurDemandee(s, need.need) && (!bien || s.assetId === bien.id));
    pool = diversifiedCandidates(ctxTous, ARBITRATION_MAX);
    trace.candidatesNotPresented = Math.max(0, ctxTous.length - pool.length);
    repliClarification = bien || ctxOps.length <= ARBITRATION_MAX ? ctxOps : [];
    motif = 'SEMANTIC_NO_MATCH_CONTEXTUAL';
  }

  // ── 5. Arbitrage par T2 (#419 écart 1) : candidats PRÉVALIDÉS seulement ──
  if (p.arbitrate && pool.length >= 1 && pool.length <= ARBITRATION_MAX) {
    const presentes = new Map<string, BusinessSource>(pool.map((s, i) => [`C${i + 1}`, s]));
    trace.candidateRefsPresentedToAI = pool.map((s) => s.ref);
    const brut = await p.arbitrate([...presentes].map(([ref, s]) => ({
      ref, kind: s.kindNoun ?? sourceDomain(s.domain).noun, label: s.label, detail: s.detail,
      asset: s.assetId != null ? assetNames[s.assetId] ?? null : null, carriesRequestedValue: carriesRequestedValue(s, need.need),
      ...(need.need === 'amount' && s.amountCents != null ? { amountNature: amountNatureOf(s) } : {}),
    }))).catch(() => null);
    const v = validateSemanticDecision(brut, presentes, { requireExact: ambigu });
    trace.semanticDecision = brut?.decision ?? null;
    trace.semanticDecisionConfidence = brut?.confidence ?? null;
    trace.candidateRefSelectedByAI = brut?.decision === 'SELECT'
      ? (presentes.get((brut.selectedCandidateRef ?? '').trim())?.ref ?? (brut.selectedCandidateRef ?? null)) : null;
    trace.candidateRefValidated = brut?.decision === 'SELECT' ? v.kind === 'select' : null;
    trace.candidateValidationFailure = v.kind === 'clarify' ? v.failure : null;
    if (v.kind === 'select') {
      trace.candidateSelectionMode = 'ai';
      if (v.source.domain === 'context') trace.contextFactsUsed.push(v.source.fieldKey ?? '');
      return repondre(v.source, need.need, nomPour(v.source), intent, trace, periode, need.aggregate);
    }
    if (v.kind === 'none') {
      trace.fallbackReason = 'AI_NO_MATCHING_CANDIDATE';
      return { kind: 'insufficient', text: insufficientMessage(need.terms, bien?.name ?? null), intent, strategy: 'semantic.insufficient' };
    }
  }

  // ── 6. Clarification (choix issus des données) ou information insuffisante ──
  if (repliClarification) pool = repliClarification;
  if (motif === 'SEMANTIC_NO_MATCH_CONTEXTUAL' && (!bien || pool.length < CONTEXTUAL_MIN || pool.length > CONTEXTUAL_MAX)) {
    trace.fallbackReason = 'NO_MATCHING_SOURCE';
    return { kind: 'insufficient', text: insufficientMessage(need.terms, bien?.name ?? null), intent, strategy: 'semantic.insufficient' };
  }
  // Une information de contexte n'est pas un choix relisible (temporaire) : jamais proposée en clarification.
  const contextuels = pool.filter((x) => x.domain !== 'context');
  const contextuelle = motif === 'SEMANTIC_NO_MATCH_CONTEXTUAL';
  const now = new Date();
  const cands = contextuels.slice(0, CONTEXTUAL_MAX);
  // Plusieurs biens parmi les choix : le nom du bien les distingue (lot 53, D21).
  const plusieursBiens = new Set(cands.map((c) => c.assetId ?? null)).size > 1;
  trace.semanticAmbiguity = true;
  trace.clarificationCreated = true;
  trace.clarificationReason = motif;
  if (contextuelle) trace.fallbackReason = 'NO_MATCHING_SOURCE';
  const state: ClarificationState = {
    clarificationId: randomUUID(),
    conversationId: input.conversationId, accountId: input.accountId, userId: input.userId,
    originalMessageId: p.messageId, originalMessage: input.message, originalIntent: intent,
    resolvedContext: {
      pageAssetId: Number(input.pageContext?.assetId) || null, assetId: bien?.id ?? null, requestedFacts: need.facts,
      semantic: { terms: need.terms, facts: need.facts, need: need.need, strategyCandidate: trace.structuredStrategyCandidate },
    },
    ambiguity: { kind: 'semantic', field: 'source', reason: motif },
    candidateType: 'business_source',
    candidates: cands.map((s) => {
      const second = [plusieursBiens && s.assetId != null ? assetNames[s.assetId] ?? null : null, s.detail].filter(Boolean).join(' · ');
      return {
        id: `src_${s.ref.replace(/[^a-zA-Z0-9]+/g, '_')}`,
        label: s.label,
        ...(second ? { secondaryLabel: second } : {}),
        sourceRef: s.ref,
        assetId: s.assetId ?? bien?.id ?? null,
      };
    }),
    question: contextuelle ? contextualQuestion(need.terms, cands, bien?.name ?? null) : semanticQuestion(cands),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CLARIFICATION_TTL_MS).toISOString(),
    attemptCount: 0,
    chainDepth: (input.resume?.chainDepth ?? 0) + 1,
    status: 'PENDING',
  };
  return { kind: 'clarify', state, intent };
}

/**
 * Reprise après une clarification sémantique : la source CHOISIE est relue
 * (compte, disponibilité) puis servie — aucune reformulation, aucun
 * reclassement, aucun appel modèle.
 */
export async function resumeSemanticChoice(p: {
  input: AssistantRequestInput; ports: SemanticPorts; trace: SemanticTrace; withDeadline: <T>(x: Promise<T>) => Promise<T>;
}): Promise<SemanticOutcome> {
  const choix = p.input.resume?.semanticSource;
  if (!choix || !p.ports.readBusinessSource) return { kind: 'continue' };
  const intent = (p.input.resume?.intent ?? 'ACCOUNT_FACT_ASSET') as VerebonaIntent;
  const cibles = p.ports.resolveTargets && choix.assetId
    ? await p.withDeadline(p.ports.resolveTargets(p.input, routeForIntent(intent, p.input.planType, 'reprise sémantique'))).catch(() => null) : null;
  const assetNames: Record<number, string> = Object.fromEntries((cibles?.catalog ?? []).map((a) => [a.id, a.name]));
  // Bien de la reprise : seulement s'il est toujours DISPONIBLE (règle unique, résolution serveur).
  const indisponible = choix.assetId != null && (
    (cibles?.unavailable ?? []).some((u) => u.type === 'asset' && u.id === choix.assetId)
    || (cibles?.catalog != null && !cibles.catalog.some((a) => a.id === choix.assetId)));
  if (indisponible) {
    p.trace.fallbackReason = 'CHOICE_TARGET_UNAVAILABLE';
    return { kind: 'insufficient', text: 'Cet élément n’est plus disponible dans vos biens actifs.', intent, strategy: 'semantic.choice_unavailable' };
  }
  const s = await p.withDeadline(p.ports.readBusinessSource(p.input.accountId, choix.ref, { assetIds: choix.assetId ? [choix.assetId] : [], assetNames })).catch(() => null);
  if (!s) {
    p.trace.fallbackReason = 'CHOICE_UNAVAILABLE';
    return { kind: 'insufficient', text: 'Cet élément n’est plus disponible.', intent, strategy: 'semantic.choice_unavailable' };
  }
  p.trace.resolvedTargets = choix.assetId ? [choix.assetId] : [];
  return repondre(s, choix.need, choix.assetId ? assetNames[choix.assetId] ?? null : null, intent, p.trace, periodeDe(p.input.message),
    choix.need === 'amount' && wantsAggregate(p.input.message));
}

/** L'opération porte-t-elle la valeur demandée (clarification contextuelle, Q24) ? */
function porteValeurDemandee(s: BusinessSource, need: ValueNeed | null): boolean {
  if (need === 'amount') return s.amountCents != null;
  if (need === 'end_date') return Boolean(s.endDate);
  if (need === 'date') return Boolean(s.endDate ?? s.date);
  return false;
}
