/**
 * Acceptations des CGVU — CDC 7 §9, §8.2, §18.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA VERSION ENREGISTRÉE EST CELLE QUI A ÉTÉ PRÉSENTÉE
 *
 * Le §18 est explicite sur le cas où une nouvelle version devient courante
 * pendant qu'un utilisateur remplit un formulaire : « ne pas remplacer
 * silencieusement le document ; enregistrer l'acceptation de la version
 * effectivement présentée ».
 *
 * Toutes les fonctions d'écriture prennent donc un CODE DE VERSION explicite,
 * jamais « la version courante au moment de l'écriture ». Résoudre la version
 * courante côté serveur au moment de l'enregistrement produirait exactement la
 * faute que le §18 décrit : l'utilisateur aurait lu un texte et accepté
 * l'autre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { legalAcceptances, legalDocumentVersions } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { AcceptanceChannel } from '@/lib/legal/public-legal';
import { recordLegalAudit } from './legal-audit.service';
import { DOCUMENT_TYPE_CGVU, LegalVersionError, getCurrentVersion } from './legal-versions.service';
import { proofStatusFor, versionProofInfo, type ProofStatus } from './cguv-referential.service';

/**
 * Contexte d'une preuve (lot 102B) : inscription (ACCOUNT_CREATION), connexion
 * sociale Google / Apple (SOCIAL_SIGNUP), réacceptation d'une version
 * substantielle (VERSION_UPDATE), souscription (PAID_SUBSCRIPTION), demande
 * expresse de démarrage immédiat pendant le délai de rétractation
 * (IMMEDIATE_START_REQUEST). Le canal (web / mobile) est une colonne à part.
 */
export type AcceptanceContext =
  | 'ACCOUNT_CREATION'
  | 'SOCIAL_SIGNUP'
  | 'TRIAL_START'
  | 'PAID_SUBSCRIPTION'
  | 'VERSION_UPDATE'
  | 'IMMEDIATE_START_REQUEST';

const ACCEPTANCE_CONTEXTS: readonly AcceptanceContext[] = [
  'ACCOUNT_CREATION',
  'SOCIAL_SIGNUP',
  'TRIAL_START',
  'PAID_SUBSCRIPTION',
  'VERSION_UPDATE',
  'IMMEDIATE_START_REQUEST',
] as const;

export function isAcceptanceContext(value: unknown): value is AcceptanceContext {
  return typeof value === 'string' && (ACCEPTANCE_CONTEXTS as readonly string[]).includes(value);
}

interface RecordAcceptanceInput {
  userId: number;
  /** Code de la version RÉELLEMENT affichée à l'utilisateur (§18). */
  versionCode: string;
  context: AcceptanceContext;
  subscriptionId?: number | null;
  offerCode?: string | null;
  /** §9 : uniquement si déjà collectés à des fins de sécurité. */
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptedAt?: Date;
  documentType?: string;
  /** Lot 102B : canal (WEB, IOS, ANDROID, MOBILE). */
  channel?: AcceptanceChannel;
  /** Lot 102B : abonnement Stripe concerné (ou session de paiement). */
  subscriptionReference?: string | null;
}

interface AcceptanceRecord {
  id: string;
  versionCode: string;
  versionId: string;
  permalink: string | null;
  /** Lot 102B : URL absolue et empreinte figées dans la preuve. */
  permalinkUrl: string;
  textSha256: string | null;
  acceptedAt: Date;
  context: AcceptanceContext;
  /** `true` lorsque l'appel a été rejoué et n'a rien créé de nouveau. */
  alreadyRecorded: boolean;
}

/**
 * Enregistre une acceptation.
 *
 * IDEMPOTENT (§18, « double clic ou double requête ») : un second appel avec
 * les mêmes paramètres retourne la preuve existante sans en créer une seconde.
 * L'unicité est garantie par un index en base, pas par une lecture préalable —
 * deux requêtes simultanées passeraient toutes deux un simple `SELECT`.
 */
export async function recordAcceptance(
  input: RecordAcceptanceInput,
): Promise<AcceptanceRecord> {
  const documentType = input.documentType ?? DOCUMENT_TYPE_CGVU;

  const [version] = await db
    .select({
      id: legalDocumentVersions.id,
      versionCode: legalDocumentVersions.versionCode,
      status: legalDocumentVersions.status,
      permalink: legalDocumentVersions.permalink,
      sha256: legalDocumentVersions.sha256,
      source: legalDocumentVersions.source,
      publicPermalink: legalDocumentVersions.publicPermalink,
      publicSha256: legalDocumentVersions.publicSha256,
    })
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.documentType, documentType),
        eq(legalDocumentVersions.versionCode, input.versionCode),
      ),
    )
    .limit(1);

  if (!version) {
    throw new LegalVersionError(
      'VERSION_NOT_FOUND',
      `Version ${input.versionCode} inconnue : aucune acceptation ne peut y être rattachée.`,
    );
  }
  if (version.status === 'DRAFT') {
    // Accepter un brouillon n'aurait aucune valeur probante : son contenu
    // reste modifiable.
    throw new LegalVersionError(
      'VERSION_NOT_PUBLISHED',
      `Version ${input.versionCode} en brouillon : elle ne peut pas être acceptée.`,
    );
  }

  const acceptedAt = input.acceptedAt ?? new Date();
  // Preuve complète (lot 102B) : version + permalien + empreinte + date + contexte + canal.
  const typed = { ...version, source: version.source as 'APP_LEGACY' | 'PUBLIC_SITE' | 'BO_MANUAL' };
  const proof = versionProofInfo(typed);
  // Site public pas encore livré : preuve « en attente du site public »
  // (permalien d'archive et empreinte d'origine de la version présentée).
  const proofStatus = proofStatusFor(typed);

  const inserted = await db
    .insert(legalAcceptances)
    .values({
      userId: input.userId,
      legalDocumentVersionId: version.id,
      acceptedAt,
      acceptanceContext: input.context,
      subscriptionId: input.subscriptionId ?? null,
      offerCode: input.offerCode ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      versionCode: version.versionCode,
      permalinkUrl: proof.permalinkUrl,
      textSha256: proof.sha256,
      proofStatus,
      channel: input.channel ?? 'UNKNOWN',
      subscriptionReference: input.subscriptionReference ?? null,
      createdAt: acceptedAt,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    await recordLegalAudit({
      action: 'USER_ACCEPTED',
      actorUserId: input.userId,
      versionCode: version.versionCode,
      versionId: version.id,
      details: `contexte ${input.context} ; canal ${input.channel ?? 'UNKNOWN'} ; sha256=${proof.sha256 ?? 'inconnue'}`,
      occurredAt: acceptedAt,
    });

    return {
      id: inserted[0].id,
      versionCode: version.versionCode,
      versionId: version.id,
      permalink: version.permalink,
      permalinkUrl: proof.permalinkUrl,
      textSha256: proof.sha256,
      acceptedAt,
      context: input.context,
      alreadyRecorded: false,
    };
  }

  // Rejeu : la preuve existe déjà. On la relit plutôt que d'en fabriquer une.
  const [existing] = await db
    .select()
    .from(legalAcceptances)
    .where(
      and(
        eq(legalAcceptances.userId, input.userId),
        eq(legalAcceptances.legalDocumentVersionId, version.id),
        eq(legalAcceptances.acceptanceContext, input.context),
      ),
    )
    .limit(1);

  return {
    id: existing.id,
    versionCode: version.versionCode,
    versionId: version.id,
    permalink: version.permalink,
    permalinkUrl: existing.permalinkUrl ?? proof.permalinkUrl,
    textSha256: existing.textSha256 ?? proof.sha256,
    acceptedAt: existing.acceptedAt,
    context: input.context,
    alreadyRecorded: true,
  };
}

interface UserAcceptance {
  id: string;
  versionCode: string;
  versionId: string;
  title: string;
  permalink: string | null;
  /** Lot 102B : permalien à consulter (figé dans la preuve, sinon celui de la version). */
  permalinkUrl: string;
  textSha256: string | null;
  proofStatus: ProofStatus;
  channel: string;
  acceptedAt: Date;
  context: string;
  offerCode: string | null;
}

/** Acceptations d'un utilisateur, la plus récente d'abord (§11). */
export async function listUserAcceptances(
  userId: number,
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<UserAcceptance[]> {
  const rows = await db
    .select({
      id: legalAcceptances.id,
      acceptedAt: legalAcceptances.acceptedAt,
      context: legalAcceptances.acceptanceContext,
      offerCode: legalAcceptances.offerCode,
      versionId: legalDocumentVersions.id,
      versionCode: legalDocumentVersions.versionCode,
      title: legalDocumentVersions.title,
      permalink: legalDocumentVersions.permalink,
      sha256: legalDocumentVersions.sha256,
      source: legalDocumentVersions.source,
      publicPermalink: legalDocumentVersions.publicPermalink,
      publicSha256: legalDocumentVersions.publicSha256,
      proofPermalinkUrl: legalAcceptances.permalinkUrl,
      proofSha256: legalAcceptances.textSha256,
      proofStatus: legalAcceptances.proofStatus,
      channel: legalAcceptances.channel,
    })
    .from(legalAcceptances)
    .innerJoin(
      legalDocumentVersions,
      eq(legalAcceptances.legalDocumentVersionId, legalDocumentVersions.id),
    )
    .where(
      and(
        eq(legalAcceptances.userId, userId),
        eq(legalDocumentVersions.documentType, documentType),
      ),
    )
    .orderBy(desc(legalAcceptances.acceptedAt));

  return rows.map((r) => {
    // Preuve HISTORIQUE : aucune empreinte inventée ; le lien de consultation
    // est celui de la version (permalien public si le site l'a republiée,
    // sinon archive figée de l'application).
    const fallback = versionProofInfo({ ...r, source: r.source as 'APP_LEGACY' | 'PUBLIC_SITE' | 'BO_MANUAL' });
    return {
    id: r.id,
    versionCode: r.versionCode,
    versionId: r.versionId,
    title: r.title,
    permalink: r.permalink,
    permalinkUrl: r.proofPermalinkUrl ?? fallback.permalinkUrl,
    textSha256: r.proofSha256 ?? null,
    proofStatus: (['HISTORIQUE', 'EN_ATTENTE_SITE_PUBLIC'].includes(r.proofStatus) ? r.proofStatus : 'COMPLETE') as ProofStatus,
    channel: r.channel,
    acceptedAt: r.acceptedAt,
    context: r.context,
    offerCode: r.offerCode,
    };
  });
}

interface ApplicableVersion {
  versionCode: string;
  versionId: string;
  title: string;
  permalink: string | null;
  effectiveAt: Date | null;
  requiresReacceptance: boolean;
  /** L'utilisateur a-t-il déjà accepté exactement cette version ? */
  alreadyAccepted: boolean;
  /**
   * Faut-il lui présenter une case à cocher avant de poursuivre ?
   *
   * §8.2 : « demander une nouvelle acceptation uniquement si l'utilisateur n'a
   * jamais accepté cette version ». Recocher une version déjà acceptée
   * n'ajoute rien à la preuve et alourdit le parcours de souscription.
   */
  acceptanceRequired: boolean;
}

/**
 * Version applicable à un utilisateur, et ce qu'il reste à lui demander.
 *
 * Utilisée avant une souscription payante (§8.2) et pour détecter une
 * modification substantielle à faire réaccepter (§8.3).
 */
export async function getApplicableVersion(
  userId: number | null,
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<ApplicableVersion | null> {
  const current = await getCurrentVersion(documentType);
  if (!current) return null;

  let alreadyAccepted = false;
  if (userId !== null) {
    const [existing] = await db
      .select({ id: legalAcceptances.id })
      .from(legalAcceptances)
      .where(
        and(
          eq(legalAcceptances.userId, userId),
          eq(legalAcceptances.legalDocumentVersionId, current.id),
        ),
      )
      .limit(1);
    alreadyAccepted = Boolean(existing);
  }

  return {
    versionCode: current.versionCode,
    versionId: current.id,
    title: current.title,
    permalink: current.permalink,
    effectiveAt: current.effectiveAt,
    requiresReacceptance: current.requiresReacceptance,
    alreadyAccepted,
    acceptanceRequired: !alreadyAccepted,
  };
}

/**
 * Pseudonymise les acceptations d'un compte supprimé (§14.2).
 *
 * La preuve contractuelle survit — elle est ce qui permet de justifier un
 * contrat conclu — mais elle cesse d'être nominative. Le déclencheur de la
 * migration 0115 autorise cette seule mise à jour.
 */
export async function pseudonymizeAcceptances(userId: number): Promise<number> {
  const rows = await db
    .update(legalAcceptances)
    .set({ userId: null, ipAddress: null, userAgent: null })
    .where(eq(legalAcceptances.userId, userId))
    .returning({ id: legalAcceptances.id });
  return rows.length;
}
