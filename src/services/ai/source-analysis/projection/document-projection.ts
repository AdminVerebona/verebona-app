/**
 * Projection déterministe document → faits ciblés — CDC 15 §3 (« Source →
 * Fait canonique → Cible → Preuve »), T1-01 à T1-06, U5 à U16, §13, P-T1-02
 * à P-T1-05.
 *
 * FONCTION PURE : aucune lecture en base, aucun appel modèle, aucune date
 * courante. Tout ce qui dépend du compte (identifiants vérifiés, familles)
 * arrive par `ProjectionContext`, établi par l'étape `analyzeDocument`.
 *
 * Ce que le modèle a CONSTATÉ (sortie ANALYZE_DOCUMENT validée) devient une
 * liste de `ProjectedFact` prêts à persister :
 *
 *   1. CIBLE — chaque fait garde SA cible (U7, U8). Un identifiant non vérifié
 *      est neutralisé ; un fait « bien » sans identifiant n'est rattaché au
 *      bien du document que si le document ne mentionne AUCUN autre bien. En
 *      multi-biens, jamais : un fait ambigu reste ambigu (T1-05, P-T1-04).
 *
 *   2. CLÉ — `canonicalKey` du registre (T1-01, U5). Alias → clé canonique par
 *      `resolveAlias` dans la famille de la cible ; clé inconnue, inapplicable
 *      à la famille, ou cible autre qu'un bien (un équipement n'est jamais
 *      rabattu sur son bien parent) → connaissance GÉNÉRIQUE, jamais un alias
 *      libre dans les preuves canoniques.
 *
 *   3. VALEUR — normalisée par le registre, dans SON unité (T1-03, D-09) :
 *      euros pour la fiche, jamais de « ×100 » implicite. Une unité annoncée
 *      différente n'est convertie que si elle est lisible et convertible ; une
 *      valeur brute qui contredit la valeur normalisée (749 € lu, 74 900
 *      annoncé en EUR) rétrograde le fait en générique.
 *
 *   4. TEMPS — l'événement sémantique des clés du registre est celui du
 *      registre (lastRevision est HISTORICAL, maintenanceDueDate DEADLINE) ;
 *      une récurrence sans énoncé explicite est retirée (U12) ; « dernier
 *      entretien » n'est jamais une prochaine échéance (T1-06, U15) ; la date
 *      d'un DPE n'est jamais une expiration (U16).
 *
 *   5. FINALITÉ — règles d'acquisition après classification (T1-02) : ticket
 *      d'achat du bien → acquisitionDate / acquisitionPrice ; facture de
 *      prestation → jamais acquisitionPrice ; achat de pièce → pas
 *      d'acquisition du bien. Aucune règle en multi-biens.
 */
import {
  centsToEur,
  fieldTargetTypes,
  getEventEntry,
  getField,
  normalizeValue,
  resolveAliasDetailed,
  type AssetFamily,
  type CanonicalFieldDef,
} from '@/services/canonical/registry';
import type {
  PersistedFactTarget,
  ProjectedFact,
  T1AnalyzeDocumentOutput,
  T1Evidence,
  T1Fact,
  T1Recurrence,
  T1SemanticEvent,
  T1TargetType,
} from '../master/t1-contract';
import { factLabel } from '../master/fact-evidence';
import {
  classifyPurpose,
  countArticleLines,
  dateIntroducedAsPastEvent,
  documentEntryOf,
  excerptStatesDpeRealisationOnly,
  excerptStatesPastEventOnly,
  LAST_VS_DEADLINE,
  PROJECTION_RULES,
  provesPurchaseByInvoice,
  type DocumentPurpose,
  type ProjectionRuleCode,
} from './rules';

/** Types d'entité dont l'identifiant est vérifié en base. */
export type VerifiableTargetType = 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'SUPPLIER';

export interface ProjectionContext {
  /** Bien choisi explicitement par l'utilisateur (KNOWN_TARGET), sinon null. */
  knownAssetId: number | null;
  /**
   * Bien du document : le bien connu, sinon l'unique candidat vérifié et
   * certain (même règle que `resolveAssetId` du pipeline), sinon null.
   */
  documentAssetId: number | null;
  /** Famille canonique de chaque bien du compte connu du contexte. */
  assetFamilies: ReadonlyMap<number, AssetFamily | undefined>;
  /** Identifiants VÉRIFIÉS en base pour le compte, par type de cible. */
  verifiedIds: Readonly<Record<VerifiableTargetType, ReadonlySet<number>>>;
}

export type ProjectionWarningCode =
  | 'TARGET_UNVERIFIED'
  | 'ALIAS_RESOLVED'
  | 'UNKNOWN_CANONICAL_KEY'
  | 'KEY_NOT_APPLICABLE_TO_FAMILY'
  | 'CANONICAL_KEY_TARGET_MISMATCH'
  | 'VALUE_NOT_NORMALIZABLE'
  | 'UNIT_CONVERTED'
  | 'UNIT_MISMATCH'
  | 'SEMANTIC_EVENT_ALIGNED'
  | 'SEMANTIC_EVENT_UNKNOWN'
  | 'RECURRENCE_WITHOUT_EXPLICIT_SOURCE'
  | 'RULE_APPLIED'
  | 'FACT_REMOVED_BY_RULE'
  /** Fait canonique ramené à la connaissance générique par une règle (ex. acquisition sans preuve d'achat). */
  | 'FACT_REQUALIFIED_BY_RULE'
  /** Valeur dérivée gardée en `probable` faute de pouvoir l'établir (ex. lignes d'un ticket). */
  | 'DERIVED_VALUE_UNCERTAIN';

export interface ProjectionWarning {
  code: ProjectionWarningCode;
  message: string;
  /** Clé ou libellé du fait concerné (jamais sa valeur). */
  target?: string;
  ruleCode?: ProjectionRuleCode;
}

export interface DocumentProjection {
  facts: ProjectedFact[];
  warnings: ProjectionWarning[];
  /** Finalité retenue pour les règles d'acquisition. */
  purpose: DocumentPurpose;
  /** Le document concerne plusieurs biens (déclaré ou constaté sur les cibles). */
  multiAsset: boolean;
  /** Règles déterministes appliquées (dédoublonnées, dans l'ordre). */
  appliedRules: ProjectionRuleCode[];
}

/** Jeton d'unité comparable (« € » ≡ « EUR » ≡ « euros », « m² » ≡ « m2 »). */
function uniteJeton(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  const t = u.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s/g, '');
  if (['eur', '€', 'euro', 'euros'].includes(t)) return 'eur';
  if (['cents', 'cent', 'centimes', 'centime', 'cts', 'ct'].includes(t)) return 'cents';
  if (['m2', 'm²', 'mc'].includes(t)) return 'm2';
  return t || undefined;
}

/** Unité canonique d'une clé du registre (null si sans unité). */
function uniteCanonique(def: CanonicalFieldDef): string | null {
  if (def.unit) return def.unit;
  if (def.valueType === 'money_eur') return 'EUR';
  if (def.valueType === 'money_cents') return 'cents';
  return null;
}

const MONETAIRE_OU_NOMBRE = new Set(['money_eur', 'money_cents', 'number']);

function memeValeur(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  return a === b;
}

function scalaire(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

type Canonicalisation =
  | { ok: true; def: CanonicalFieldDef; value: unknown; converted?: string }
  | { ok: false; code: ProjectionWarningCode; reason: string };

/**
 * Normalise la valeur d'un fait pour une clé canonique (T1-03).
 * `aliasUnit` : unité portée par l'alias résolu (ex. `purchasePriceCents`).
 */
function normaliserPourCle(fact: T1Fact, def: CanonicalFieldDef, aliasUnit?: string): Canonicalisation {
  const canon = uniteCanonique(def);
  let sourceUnit: string | undefined;
  if (MONETAIRE_OU_NOMBRE.has(def.valueType)) {
    if (fact.valueType === 'money_cents' && def.valueType === 'money_eur') sourceUnit = 'cents';
    else if (fact.valueType === 'money_eur' && def.valueType === 'money_cents') sourceUnit = 'EUR';
    else if (fact.canonicalUnit && uniteJeton(fact.canonicalUnit) !== uniteJeton(canon)) sourceUnit = fact.canonicalUnit;
    else if (aliasUnit) sourceUnit = aliasUnit;
  }

  const candidate = fact.normalizedValue ?? fact.rawValue ?? null;
  const r = normalizeValue(def.key, candidate, sourceUnit ? { sourceUnit } : {});
  if (!r.ok) return { ok: false, code: 'VALUE_NOT_NORMALIZABLE', reason: r.reason };

  // Contre-épreuve sur la valeur brute (porte souvent son unité écrite : « 749 € »).
  // Une contradiction est une erreur d'unité ou de lecture : jamais tranchée ici.
  if (fact.rawValue !== undefined && fact.rawValue !== null && fact.rawValue !== ''
      && fact.normalizedValue !== null && fact.normalizedValue !== undefined
      && ['money_eur', 'money_cents', 'number', 'date'].includes(def.valueType)) {
    // Même unité source que la valeur normalisée : une unité ÉCRITE différente
    // rend la lecture brute non concluante (refus), jamais une fausse alerte.
    const brut = normalizeValue(def.key, fact.rawValue, sourceUnit ? { sourceUnit } : {});
    if (brut.ok && brut.value !== null && r.value !== null && !memeValeur(brut.value, r.value)) {
      return {
        ok: false,
        code: 'UNIT_MISMATCH',
        reason: `${def.key} : valeur lue (${String(fact.rawValue)}) incompatible avec la valeur normalisée annoncée (${String(fact.normalizedValue)}${fact.canonicalUnit ? ` ${fact.canonicalUnit}` : ''})`,
      };
    }
  }
  return { ok: true, def, value: r.value, ...(sourceUnit ? { converted: sourceUnit } : {}) };
}

/** Événement du catalogue, ou null si le type est inconnu. */
function evenementCatalogue(ev: T1SemanticEvent | null | undefined): T1SemanticEvent | null | 'inconnu' {
  if (!ev) return null;
  const entry = getEventEntry(ev.type);
  return entry ? { type: entry.businessType, nature: ev.nature } : 'inconnu';
}

/** U12 : une récurrence n'est retenue que si la source l'énonce (extrait ou échéancier). */
function recurrenceExplicite(r: T1Recurrence | null | undefined, fact: T1Fact): T1Recurrence | null | 'retiree' {
  if (!r) return null;
  if (fact.provenance !== 'TEXT_EXTRACTION') return 'retiree';
  const enoncee = Boolean(r.excerpt?.trim()) || (r.dates?.length ?? 0) >= 2;
  return enoncee ? r : 'retiree';
}

function genericKey(fact: T1Fact): string | null {
  return fact.rawKey ?? fact.canonicalKey ?? null;
}

/**
 * Projection complète d'une analyse ANALYZE_DOCUMENT. Les faits reçus ont
 * déjà passé le contrôle de preuve (`checkFactEvidence`).
 */
/** Analyse projetée : les tableaux servent à compter les lignes d'un ticket (T1-02). */
export type ProjectableAnalysis = Pick<T1AnalyzeDocumentOutput, 'document' | 'entities' | 'facts'>
  & Partial<Pick<T1AnalyzeDocumentOutput, 'tables' | 'transcription'>>;

export function projectDocumentFacts(
  analysis: ProjectableAnalysis,
  ctx: ProjectionContext,
): DocumentProjection {
  const warnings: ProjectionWarning[] = [];
  const appliedRules: ProjectionRuleCode[] = [];
  const noteRule = (code: ProjectionRuleCode) => { if (!appliedRules.includes(code)) appliedRules.push(code); };

  // ── Multi-biens : déclaré par le modèle, ou constaté sur les cibles ──────
  const verifiedAssetTargets = new Set(analysis.facts
    .filter((f) => f.target.type === 'ASSET' && f.target.entityId !== null && isVerified(ctx, 'ASSET', f.target.entityId))
    .map((f) => f.target.entityId as number));
  const multiAsset = analysis.entities.multiAsset || verifiedAssetTargets.size > 1;

  // Autres biens mentionnés : un fait « bien » sans identifiant reste alors ambigu.
  const autreBienMentionne = analysis.entities.assets.some(
    (c) => c.entityId === null ? Boolean(c.rawLabel?.trim()) : c.entityId !== ctx.documentAssetId,
  ) || [...verifiedAssetTargets].some((id) => id !== ctx.documentAssetId);

  // ── 1 à 4 : cible, clé, valeur, temps — fait par fait ────────────────────
  const facts: ProjectedFact[] = [];
  for (const fact of analysis.facts) {
    const label = factLabel(fact);
    const target = resolveTarget(fact, ctx, { multiAsset, autreBienMentionne }, warnings, label);
    const family = target.targetType === 'ASSET' && target.targetEntityId !== null
      ? ctx.assetFamilies.get(target.targetEntityId)
      : undefined;

    // Temps : événement du catalogue, récurrence explicite seulement.
    const evenement = evenementCatalogue(fact.semanticEvent);
    if (evenement === 'inconnu') {
      warnings.push({ code: 'SEMANTIC_EVENT_UNKNOWN', target: label,
        message: `Type d'événement « ${fact.semanticEvent?.type} » absent du catalogue : ignoré.` });
    }
    let semanticEvent: T1SemanticEvent | null = evenement === 'inconnu' ? null : evenement;
    let recurrence = recurrenceExplicite(fact.recurrence, fact);
    if (recurrence === 'retiree') {
      warnings.push({ code: 'RECURRENCE_WITHOUT_EXPLICIT_SOURCE', target: label,
        message: 'Récurrence retirée : la source ne l’énonce pas explicitement (U12).' });
      recurrence = null;
    }

    const base = {
      rawKey: fact.rawKey ?? null,
      label: fact.label ?? null,
      subject: fact.subject ?? null,
      attribute: fact.attribute ?? null,
      rawValue: fact.rawValue ?? null,
      target,
      provenance: fact.provenance,
      confidence: fact.confidence,
      evidence: fact.evidence ?? {},
      ...(fact.visualEvidence ? { visualEvidence: fact.visualEvidence } : {}),
      recurrence,
      periodStart: fact.periodStart ?? null,
      periodEnd: fact.periodEnd ?? null,
      ruleCode: null,
    };

    const generic = (): ProjectedFact => ({
      ...base,
      canonicalKey: null,
      rawKey: genericKey(fact),
      value: scalaire(fact.normalizedValue ?? fact.rawValue),
      valueType: fact.valueType ?? null,
      canonicalUnit: fact.canonicalUnit ?? null,
      semanticEvent,
      origin: 'GENERIC',
    });

    if (!fact.canonicalKey) { facts.push(generic()); continue; }

    // Clé : exacte, sinon alias résolu dans la famille, sinon générique (U5).
    let def = getField(fact.canonicalKey);
    let aliasUnit: string | undefined;
    if (!def) {
      const alias = resolveAliasDetailed(fact.canonicalKey, family);
      if (alias) {
        def = getField(alias.key);
        aliasUnit = alias.sourceUnit;
        warnings.push({ code: 'ALIAS_RESOLVED', target: fact.canonicalKey,
          message: `Clé « ${fact.canonicalKey} » ramenée à la clé canonique « ${alias.key} ».` });
      } else {
        warnings.push({ code: 'UNKNOWN_CANONICAL_KEY', target: fact.canonicalKey,
          message: `Clé « ${fact.canonicalKey} » absente du registre : conservée comme connaissance générique.` });
        facts.push(generic());
        continue;
      }
    }
    if (!def) { facts.push(generic()); continue; }

    // Cible du fait admise par le champ (lot 13, T1-04) : un champ de bien
    // n'accueille qu'un fait de BIEN ; un fait d'équipement ou de pièce n'est
    // canonique que si le champ déclare cette cible (`targetTypes`), et il
    // reste sur l'équipement ou la pièce — jamais rabattu sur le bien parent.
    // L'application à l'état de l'équipement / de la pièce relève d'un lot
    // ultérieur : seules les preuves ciblées sont écrites.
    const ciblesAdmises = fieldTargetTypes(def);
    if (!(ciblesAdmises as string[]).includes(target.targetType)) {
      warnings.push({ code: 'CANONICAL_KEY_TARGET_MISMATCH', target: def.key,
        message: `« ${def.key} » vise ${ciblesAdmises.join(' / ')}, le fait vise un ${target.targetType} : connaissance générique.` });
      facts.push(generic());
      continue;
    }
    if (family && !def.families.includes(family)) {
      warnings.push({ code: 'KEY_NOT_APPLICABLE_TO_FAMILY', target: def.key,
        message: `« ${def.key} » n'est pas applicable à la famille ${family} : connaissance générique.` });
      facts.push(generic());
      continue;
    }

    const n = normaliserPourCle(fact, def, aliasUnit);
    if (!n.ok) {
      warnings.push({ code: n.code, target: def.key, message: `${n.reason} : connaissance générique.` });
      facts.push(generic());
      continue;
    }
    if (n.value === null) continue; // « néant », « n/a » : aucune information.
    if (n.converted) {
      warnings.push({ code: 'UNIT_CONVERTED', target: def.key,
        message: `« ${def.key} » converti de ${n.converted} vers ${uniteCanonique(def) ?? 'l’unité du registre'} (conversion explicite).` });
    }

    // L'événement d'une clé du registre est celui du registre (§13).
    if (def.agendaEffect) {
      const attendu: T1SemanticEvent = { type: def.agendaEffect.businessType, nature: def.agendaEffect.nature };
      if (semanticEvent && (semanticEvent.type !== attendu.type || semanticEvent.nature !== attendu.nature)) {
        warnings.push({ code: 'SEMANTIC_EVENT_ALIGNED', target: def.key,
          message: `Événement ${semanticEvent.type}/${semanticEvent.nature} remplacé par ${attendu.type}/${attendu.nature} (registre).` });
      }
      semanticEvent = attendu;
    }

    facts.push({
      ...base,
      canonicalKey: def.key,
      value: scalaire(n.value),
      valueType: def.valueType,
      canonicalUnit: uniteCanonique(def),
      semanticEvent,
      origin: 'MODEL_CANONICAL',
    });
  }

  // ── 4 bis : dernier événement ≠ prochaine échéance ; DPE ≠ expiration ────
  applyTemporalRules(facts, analysis.document.documentDate?.value ?? null, warnings, noteRule);

  // ── 5 : finalité et règles d'acquisition ─────────────────────────────────
  const purpose = classifyPurpose({
    entry: documentEntryOf(analysis.document.classification),
    documentTypeCode: analysis.document.classification?.documentTypeCode ?? null,
    purchaseTargets: facts.filter((f) => f.semanticEvent?.type === 'purchase' && !ACQUISITION.has(f.canonicalKey ?? ''))
      .map((f) => f.target.targetType),
    acquisitionClaims: facts.filter((f) => ACQUISITION.has(f.canonicalKey ?? '')).map((f) => f.target.targetType),
    serviceEvents: facts.filter((f) => (f.semanticEvent?.type === 'repair' || f.semanticEvent?.type === 'maintenance')
      && f.semanticEvent.nature === 'HISTORICAL').length,
  });
  const projected = applyPurposeRules(facts, analysis, ctx, { purpose, multiAsset, autreBienMentionne }, warnings, noteRule);

  return { facts: projected, warnings, purpose, multiAsset, appliedRules };
}

function isVerified(ctx: ProjectionContext, type: VerifiableTargetType, id: number): boolean {
  if (type === 'ASSET' && id === ctx.knownAssetId) return true;
  return ctx.verifiedIds[type].has(id);
}

/** Cible persistée d'un fait (U7, U8, U9). */
function resolveTarget(
  fact: T1Fact,
  ctx: ProjectionContext,
  doc: { multiAsset: boolean; autreBienMentionne: boolean },
  warnings: ProjectionWarning[],
  label: string,
): PersistedFactTarget {
  const type: T1TargetType = fact.target.type;
  let entityId: number | null = null;
  const proposed = fact.target.entityId;

  if (type === 'ASSET' || type === 'EQUIPMENT' || type === 'ROOM' || type === 'SUPPLIER') {
    if (proposed !== null && proposed !== undefined) {
      if (isVerified(ctx, type, proposed)) entityId = proposed;
      else {
        warnings.push({ code: 'TARGET_UNVERIFIED', target: label,
          message: `Cible ${type} #${proposed} introuvable dans le compte : identifiant neutralisé, libellé conservé.` });
      }
    }
  }

  // Un fait « bien » sans identifiant ne rejoint le bien du document que si
  // celui-ci est le SEUL bien concerné (jamais en multi-biens : U8, T1-05).
  if (type === 'ASSET' && entityId === null && (proposed === null || proposed === undefined)
      && ctx.documentAssetId !== null && !doc.multiAsset && !doc.autreBienMentionne) {
    entityId = ctx.documentAssetId;
  }

  return {
    targetType: type,
    targetEntityId: entityId,
    targetEntityLabel: fact.target.rawLabel?.trim() || null,
    targetConfidence: fact.target.confidence,
  };
}

const memeCible = (a: ProjectedFact, b: ProjectedFact) =>
  a.target.targetType === b.target.targetType && a.target.targetEntityId === b.target.targetEntityId;

/** T1-06 / U15 / U16 : jamais d'échéance fabriquée à partir d'un événement réalisé. */
function applyTemporalRules(
  facts: ProjectedFact[],
  documentDate: string | null,
  warnings: ProjectionWarning[],
  noteRule: (c: ProjectionRuleCode) => void,
): void {
  // « Dernier entretien : … » annoncé comme prochaine échéance → dernier événement.
  for (const { deadline, last } of LAST_VS_DEADLINE) {
    const lastDef = getField(last);
    for (const f of facts) {
      if (f.canonicalKey !== deadline || !lastDef?.agendaEffect) continue;
      if (!excerptStatesPastEventOnly(f.evidence.excerpt) && !dateIntroducedAsPastEvent(f.evidence.excerpt, f.value)) continue;
      f.canonicalKey = last;
      f.semanticEvent = { type: lastDef.agendaEffect.businessType, nature: lastDef.agendaEffect.nature };
      f.ruleCode = PROJECTION_RULES.LAST_EVENT_NOT_DEADLINE;
      noteRule(PROJECTION_RULES.LAST_EVENT_NOT_DEADLINE);
      warnings.push({ code: 'RULE_APPLIED', target: deadline, ruleCode: PROJECTION_RULES.LAST_EVENT_NOT_DEADLINE,
        message: `« ${deadline} » prouvé par un événement réalisé : requalifié en « ${last} », aucune échéance créée (T1-06).` });
    }
  }

  // Date de réalisation d'un DPE annoncée comme expiration → dpeDate.
  const dpeDef = getField('dpeDate');
  for (const f of facts) {
    if (f.canonicalKey !== 'dpeExpiryDate' || !dpeDef?.agendaEffect) continue;
    if (!excerptStatesDpeRealisationOnly(f.evidence.excerpt)) continue;
    f.canonicalKey = 'dpeDate';
    f.semanticEvent = { type: dpeDef.agendaEffect.businessType, nature: dpeDef.agendaEffect.nature };
    f.ruleCode = PROJECTION_RULES.DPE_DATE_NOT_EXPIRY;
    noteRule(PROJECTION_RULES.DPE_DATE_NOT_EXPIRY);
    warnings.push({ code: 'RULE_APPLIED', target: 'dpeExpiryDate', ruleCode: PROJECTION_RULES.DPE_DATE_NOT_EXPIRY,
      message: 'Date de réalisation du DPE annoncée comme expiration : requalifiée en « dpeDate » (U16).' });
  }

  // Un fait requalifié qui double un fait déjà présent (même clé, cible et
  // valeur) n'apporte rien : il est retiré, le fait d'origine du modèle reste.
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f.ruleCode !== PROJECTION_RULES.LAST_EVENT_NOT_DEADLINE && f.ruleCode !== PROJECTION_RULES.DPE_DATE_NOT_EXPIRY) continue;
    if (!facts.some((g, j) => j !== i && g.canonicalKey === f.canonicalKey && memeCible(f, g) && g.value === f.value)) continue;
    facts.splice(i, 1);
  }

  // Échéance identique à la date de l'événement réalisé, sur la même cible : doublon.
  const doublons: Array<{ deadline: string; last: string; rule: ProjectionRuleCode }> = [
    ...LAST_VS_DEADLINE.map((p) => ({ ...p, rule: PROJECTION_RULES.DEADLINE_EQUALS_LAST_EVENT })),
    { deadline: 'dpeExpiryDate', last: 'dpeDate', rule: PROJECTION_RULES.DPE_DATE_NOT_EXPIRY },
  ];
  for (const { deadline, last, rule } of doublons) {
    for (let i = facts.length - 1; i >= 0; i--) {
      const f = facts[i];
      if (f.canonicalKey !== deadline) continue;
      const jumeau = facts.find((g) => g.canonicalKey === last && memeCible(f, g) && g.value === f.value);
      if (!jumeau) continue;
      facts.splice(i, 1);
      noteRule(rule);
      warnings.push({ code: 'FACT_REMOVED_BY_RULE', target: deadline, ruleCode: rule,
        message: `« ${deadline} » identique à « ${last} » sur la même cible : échéance retirée (événement réalisé, pas une échéance).` });
    }
  }

  // Échéance qui n'est pas POSTÉRIEURE à ce que le document constate : égale à
  // la date du document, ou antérieure / égale à la date de réalisation du
  // même document sur la même cible (« DPE du 12/03/2026 » annoncé en
  // expiration ; « Dernier entretien : 15/11/2026 — prochain dans 1 an »
  // annoncé en maintenanceDueDate 15/11/2026). Les dates ISO se comparent
  // lexicographiquement.
  const realisations = facts.filter((g) => g.semanticEvent?.nature === 'HISTORICAL' && typeof g.value === 'string' && ISO_DATE.test(g.value));
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (!f.canonicalKey || typeof f.value !== 'string' || !ISO_DATE.test(f.value)) continue;
    if (getField(f.canonicalKey)?.agendaEffect?.nature !== 'DEADLINE') continue;
    // La date du document n'est un indice que pour les échéances couplées à
    // un événement réalisé (entretien, contrôle) et pour le DPE : un avis
    // d'échéance daté du jour de l'échéance reste une échéance.
    const egaleAuDocument = documentDate !== null && f.value === documentDate && DEADLINES_COUPLEES.has(f.canonicalKey);
    const pasApres = realisations.some((g) => memeCible(f, g) && g.semanticEvent?.type === f.semanticEvent?.type
      && (g.value as string) >= (f.value as string));
    if (!egaleAuDocument && !pasApres) continue;
    facts.splice(i, 1);
    noteRule(PROJECTION_RULES.DEADLINE_NOT_AFTER_EVENT);
    warnings.push({ code: 'FACT_REMOVED_BY_RULE', target: f.canonicalKey, ruleCode: PROJECTION_RULES.DEADLINE_NOT_AFTER_EVENT,
      message: `« ${f.canonicalKey} » ${egaleAuDocument ? 'égale à la date du document' : 'non postérieure à l’événement réalisé'} : ce n’est pas une échéance à venir (T1-06).` });
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINES_COUPLEES = new Set([...LAST_VS_DEADLINE.map((p) => p.deadline), 'dpeExpiryDate']);
const ACQUISITION = new Set(['acquisitionDate', 'acquisitionPrice']);

/** T1-02 : trois finalités, trois effets. */
function applyPurposeRules(
  facts: ProjectedFact[],
  analysis: ProjectableAnalysis,
  ctx: ProjectionContext,
  doc: { purpose: DocumentPurpose; multiAsset: boolean; autreBienMentionne?: boolean },
  warnings: ProjectionWarning[],
  noteRule: (c: ProjectionRuleCode) => void,
): ProjectedFact[] {
  const retirer = (pred: (f: ProjectedFact) => boolean, rule: ProjectionRuleCode, pourquoi: string) => {
    const kept: ProjectedFact[] = [];
    for (const f of facts) {
      if (!pred(f)) { kept.push(f); continue; }
      noteRule(rule);
      warnings.push({ code: 'FACT_REMOVED_BY_RULE', target: f.canonicalKey ?? undefined, ruleCode: rule, message: pourquoi });
    }
    return kept;
  };

  if (doc.purpose === 'SERVICE') {
    // Ni prix ni date d'acquisition sur une facture de prestation (U14, §13),
    // et aucun événement purchase sur un fait du bien.
    const kept = retirer((f) => ACQUISITION.has(f.canonicalKey ?? ''), PROJECTION_RULES.SERVICE_INVOICE_NO_ACQUISITION,
      'Facture de réparation / entretien : aucune acquisition du bien (U14, §13).');
    for (const f of kept) {
      if (f.semanticEvent?.type !== 'purchase' || f.target.targetType !== 'ASSET') continue;
      f.semanticEvent = null;
      f.ruleCode = f.ruleCode ?? PROJECTION_RULES.SERVICE_INVOICE_NO_PURCHASE_EVENT;
      noteRule(PROJECTION_RULES.SERVICE_INVOICE_NO_PURCHASE_EVENT);
      warnings.push({ code: 'FACT_REMOVED_BY_RULE', target: f.canonicalKey ?? f.rawKey ?? undefined,
        ruleCode: PROJECTION_RULES.SERVICE_INVOICE_NO_PURCHASE_EVENT,
        message: 'Facture de réparation / entretien : événement d’achat du bien retiré (U14).' });
    }
    return kept;
  }
  if (doc.purpose === 'PART_PURCHASE') {
    // L'achat de la pièce (cible non-bien) garde son événement purchase.
    return retirer((f) => ACQUISITION.has(f.canonicalKey ?? ''), PROJECTION_RULES.PART_PURCHASE_NO_ASSET_ACQUISITION,
      'Achat d’une pièce ou d’un accessoire : pas d’acquisition du bien (T1-02).');
  }
  if (doc.purpose === 'OTHER') {
    // ══════════════════════════════════════════════════════════════════════
    // Finalité non établie (FACTURE sans type V2, garantie citant une date
    // d'achat…) : l'acquisition n'est PAS prouvée (U14). Choix : connaissance
    // GÉNÉRIQUE plutôt que retrait — la valeur a été lue avec sa preuve et ne
    // doit pas disparaître en silence (§3) ; elle reste consultable (T2,
    // À traiter) sans jamais atteindre la fiche (T3 ne lit que les preuves
    // canoniques). `ruleCode` marque ces faits : le rattrapage MIG-01 (lot 17)
    // ne doit pas les recanonicaliser par alias.
    // ══════════════════════════════════════════════════════════════════════
    return facts.map((f) => {
      if (!ACQUISITION.has(f.canonicalKey ?? '')) return f;
      noteRule(PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF);
      warnings.push({ code: 'FACT_REQUALIFIED_BY_RULE', target: f.canonicalKey ?? undefined,
        ruleCode: PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF,
        message: `« ${f.canonicalKey} » sans preuve d’achat du bien : conservé comme connaissance générique (U14).` });
      return {
        ...f, canonicalKey: null, rawKey: f.rawKey ?? f.canonicalKey, semanticEvent: null,
        origin: 'GENERIC' as const, ruleCode: PROJECTION_RULES.ACQUISITION_WITHOUT_PURCHASE_PROOF,
      };
    });
  }
  if (doc.multiAsset) {
    noteRule(PROJECTION_RULES.MULTI_ASSET_NO_ACQUISITION_RULE);
    warnings.push({ code: 'RULE_APPLIED', ruleCode: PROJECTION_RULES.MULTI_ASSET_NO_ACQUISITION_RULE,
      message: 'Justificatif d’achat multi-biens : aucune acquisition déduite, seuls les faits ciblés du modèle sont retenus (U8).' });
    return facts;
  }

  // Cible : le bien du document, vérifié, seul bien concerné. Sans bien
  // déterminé (document déposé seul, aucun bien mentionné), les faits
  // d'acquisition sont posés SANS identifiant : non rattachés à l'analyse, ils
  // le seront au rattachement tardif (T4-05, DOD-05 : même état final que si
  // le bien avait été choisi au dépôt). Jamais s'il en mentionne un (U8).
  const assetId = ctx.documentAssetId;
  if (assetId === null ? doc.autreBienMentionne !== false : !isVerified(ctx, 'ASSET', assetId)) return facts;
  const surLeBien = (f: ProjectedFact) => f.target.targetType === 'ASSET' && f.target.targetEntityId === assetId;
  if (facts.some((f) => f.semanticEvent?.type === 'purchase' && f.target.targetType === 'ASSET' && !surLeBien(f))) return facts;

  const purchase: T1SemanticEvent = { type: 'purchase', nature: 'HISTORICAL' };
  const classificationConfidence = analysis.document.classification?.confidence ?? 0;
  const target: PersistedFactTarget = {
    targetType: 'ASSET',
    targetEntityId: assetId,
    targetEntityLabel: null,
    targetConfidence: assetId !== null && assetId === ctx.knownAssetId ? 'certain' : 'probable',
  };
  const confiance = (c: 'certain' | 'probable' | 'conflictual') =>
    c === 'certain' && classificationConfidence < 0.9 ? 'probable' as const : c;
  const deRegle = (p: {
    key: string; value: string | number; rawValue: string | number; rule: ProjectionRuleCode;
    confidence: 'certain' | 'probable' | 'conflictual'; evidence: T1Evidence; rawKey: string;
  }): ProjectedFact => {
    const def = getField(p.key)!;
    return {
      canonicalKey: p.key, rawKey: p.rawKey, label: def.label, subject: null, attribute: p.key,
      rawValue: p.rawValue, value: p.value, valueType: def.valueType, canonicalUnit: uniteCanonique(def),
      target, provenance: 'TEXT_EXTRACTION', confidence: confiance(p.confidence), evidence: p.evidence,
      semanticEvent: purchase, recurrence: null, periodStart: null, periodEnd: null,
      origin: 'DETERMINISTIC_RULE', ruleCode: p.rule,
    };
  };

  const out = [...facts];

  // Faits d'acquisition fournis par le modèle : événement purchase (U14).
  for (const f of out) {
    if (f.canonicalKey === 'acquisitionPrice' && surLeBien(f) && f.semanticEvent?.type !== 'purchase') {
      f.semanticEvent = purchase;
      f.ruleCode = f.ruleCode ?? PROJECTION_RULES.PURCHASE_EVENT_ON_ACQUISITION;
      noteRule(PROJECTION_RULES.PURCHASE_EVENT_ON_ACQUISITION);
    }
  }

  // documentDate → acquisitionDate, si le modèle ne l'a pas fournie.
  const date = analysis.document.documentDate;
  if (!out.some((f) => f.canonicalKey === 'acquisitionDate' && surLeBien(f)) && date?.value && date.evidence?.excerpt?.trim()) {
    const n = normalizeValue('acquisitionDate', date.value);
    if (n.ok && typeof n.value === 'string') {
      out.push(deRegle({ key: 'acquisitionDate', value: n.value, rawValue: date.value, rawKey: 'documentDate',
        rule: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE, confidence: date.confidence, evidence: date.evidence }));
      noteRule(PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE);
      warnings.push({ code: 'RULE_APPLIED', target: 'acquisitionDate', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE,
        message: 'Justificatif d’achat du bien : date du document retenue comme date d’acquisition (T1-02).' });
    }
  }

  // Prix d'acquisition, si le modèle ne l'a pas fourni (T1-02, T1-03) :
  //   · ticket / facture à UNE seule ligne article : amountCents → euros ;
  //   · plusieurs lignes : seulement une ligne d'achat EXPLICITE du bien
  //     portant son montant ; sinon rien (le total n'est pas attribuable).
  const amount = analysis.document.amountCents;
  const entry = documentEntryOf(analysis.document.classification);
  if (!out.some((f) => f.canonicalKey === 'acquisitionPrice' && surLeBien(f)) && provesPurchaseByInvoice(entry)) {
    const tables = analysis.tables ?? [];
    const lignesTableau = Math.max(0, ...tables.map((t) => t.rows.length));
    // Lignes d'achat énoncées (hors faits d'acquisition eux-mêmes).
    const achats = out.filter((f) => f.semanticEvent?.type === 'purchase' && !ACQUISITION.has(f.canonicalKey ?? ''));
    // Nombre de lignes : établi par un tableau ou par des faits d'achat par
    // ligne ; sinon estimé sur la transcription (heuristique `countArticleLines`).
    const lignesTranscription = tables.length === 0 ? countArticleLines(analysis.transcription) : 0;
    const nombreEtabli = tables.length > 0 || achats.length > 0;
    const uneSeuleLigne = lignesTableau <= 1 && achats.length <= 1 && achats.every(surLeBien) && lignesTranscription <= 1;
    const lignesDuBien = achats.filter((f) => surLeBien(f) && f.canonicalKey === null
      && (f.valueType === 'money_eur' || f.valueType === 'money_cents') && f.evidence.excerpt?.trim());

    if (uneSeuleLigne && amount && amount.evidence?.excerpt?.trim() && Number.isInteger(amount.value) && amount.value >= 0) {
      const eur = centsToEur(amount.value);
      // Nombre de lignes NON établi : le prix est gardé, mais en `probable`
      // (proposition T3, jamais application automatique).
      const incertain = !nombreEtabli;
      out.push(deRegle({ key: 'acquisitionPrice', value: eur, rawValue: amount.value, rawKey: 'amountCents',
        rule: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE,
        confidence: incertain ? 'probable' : amount.confidence, evidence: amount.evidence }));
      noteRule(PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE);
      if (incertain) {
        noteRule(PROJECTION_RULES.ACQUISITION_PRICE_LINE_COUNT_UNKNOWN);
        warnings.push({ code: 'DERIVED_VALUE_UNCERTAIN', target: 'acquisitionPrice', ruleCode: PROJECTION_RULES.ACQUISITION_PRICE_LINE_COUNT_UNKNOWN,
          message: 'Nombre d’articles du ticket non établi : prix d’acquisition tiré du total, gardé comme proposition (probable).' });
      }
      warnings.push({ code: 'RULE_APPLIED', target: 'acquisitionPrice', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_PRICE,
        message: `Justificatif d’achat du bien : montant du document converti en euros (${amount.value} cents → ${eur} EUR).` });
    } else if (lignesDuBien.length === 1) {
      const ligne = lignesDuBien[0];
      const n = normalizeValue('acquisitionPrice', ligne.value, ligne.valueType === 'money_cents' ? { sourceUnit: 'cents' } : {});
      if (n.ok && typeof n.value === 'number') {
        out.push(deRegle({ key: 'acquisitionPrice', value: n.value, rawValue: typeof ligne.rawValue === 'string' || typeof ligne.rawValue === 'number' ? ligne.rawValue : String(ligne.value), rawKey: ligne.rawKey ?? 'ligne',
          rule: PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE, confidence: ligne.confidence, evidence: ligne.evidence }));
        noteRule(PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE);
        warnings.push({ code: 'RULE_APPLIED', target: 'acquisitionPrice', ruleCode: PROJECTION_RULES.PURCHASE_LINE_ACQUISITION_PRICE,
          message: 'Ticket à plusieurs articles : prix d’acquisition tiré de la ligne d’achat du bien.' });
      }
    } else if (amount) {
      noteRule(PROJECTION_RULES.ACQUISITION_PRICE_NOT_ATTRIBUTABLE);
      warnings.push({ code: 'RULE_APPLIED', target: 'acquisitionPrice', ruleCode: PROJECTION_RULES.ACQUISITION_PRICE_NOT_ATTRIBUTABLE,
        message: 'Plusieurs articles achetés : le total du document n’est pas attribuable au seul bien.' });
    }
  }

  return out;
}
