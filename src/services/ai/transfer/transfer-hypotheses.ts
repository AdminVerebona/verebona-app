/**
 * Lecture d'une réponse du fournisseur à l'ENVOI d'un fichier — lot 113R
 * (carte #717). PUR (aucune lecture), partagé par le BO et la recette.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DES HYPOTHÈSES, JAMAIS UNE CONCLUSION
 *
 * Ce module ne DÉCIDE pas de la cause d'un refus : il rapproche la réponse
 * CONSERVÉE (statut, statut fournisseur, raison `ErrorInfo.reason`, message)
 * des causes connues de la documentation Google, et chaque piste est
 * présentée comme une hypothèse à confirmer dans la console Google Cloud.
 * Sans détail fourni par le fournisseur, il le dit — sans rien deviner.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AttachmentTransferFailure } from '../gateway/diagnostics/taxonomy';

export interface TransferHypothesis {
  /** Code stable (tests, recette). */
  code:
    | 'KEY_API_RESTRICTION' | 'KEY_APPLICATION_RESTRICTION' | 'API_NOT_ENABLED' | 'BILLING' | 'PROJECT'
    | 'REGION' | 'KEY_INVALID' | 'ACCESS_DENIED_NO_REASON' | 'QUOTA' | 'PROVIDER_UNAVAILABLE' | 'NETWORK'
    | 'FILE_REJECTED' | 'SOURCE_STORAGE' | 'NO_PROVIDER_DETAIL';
  /** Constat (ce que dit la réponse) puis piste à vérifier. */
  text: string;
  /** Où vérifier (console Google Cloud, Scalingo, BO). */
  check: string;
}

type Input = Pick<AttachmentTransferFailure, 'step' | 'kind' | 'httpStatus' | 'providerStatus' | 'providerReason' | 'providerMessage' | 'providerDetail' | 'networkCode'>;

/** Hypothèses à confirmer, de la plus précise à la plus générale (pur). */
export function transferHypotheses(f: Input | null | undefined): TransferHypothesis[] {
  if (!f) return [];
  const out: TransferHypothesis[] = [];
  const reason = (f.providerReason ?? '').toUpperCase();
  const msg = f.providerMessage ?? '';
  const s = f.httpStatus;
  const add = (h: TransferHypothesis) => { if (!out.some((x) => x.code === h.code)) out.push(h); };

  if (f.step === 'source_download') {
    add({
      code: 'SOURCE_STORAGE',
      text: `La lecture du document dans le stockage Verebona a échoué${s !== null ? ` (HTTP ${s})` : ''} : le fournisseur n’a pas été contacté.`,
      check: 'Stockage objet (variables S3_* de Scalingo) ; ce n’est pas un problème de clé Google.',
    });
    return out;
  }
  if (f.kind === 'network') {
    add({
      code: 'NETWORK',
      text: `Aucune réponse du fournisseur${f.networkCode ? ` (${f.networkCode})` : ''} : hypothèse d’un incident réseau sortant ou DNS.`,
      check: 'Journaux Scalingo à l’heure de l’essai ; refaire le test d’envoi.',
    });
    return out;
  }
  if (/API_KEY_SERVICE_BLOCKED/.test(reason) || (/blocked/i.test(msg) && /api key|apikey/i.test(msg))) {
    add({
      code: 'KEY_API_RESTRICTION',
      text: 'Hypothèse à confirmer : la clé est restreinte à certaines API (« Restrictions d’API ») et l’envoi de fichiers n’y figure pas.',
      check: 'Console Google Cloud › API et services › Identifiants › la clé › Restrictions d’API : « Generative Language API » autorisée.',
    });
  }
  if (/API_KEY_(HTTP_REFERRER|IP_ADDRESS|ANDROID_APP|IOS_APP)_BLOCKED/.test(reason) || /referer|referrer|ip address|client ip/i.test(msg)) {
    add({
      code: 'KEY_APPLICATION_RESTRICTION',
      text: 'Hypothèse à confirmer : la clé porte une restriction d’application (référents HTTP, adresses IP…) qui ne correspond pas aux serveurs Scalingo.',
      check: 'Console Google Cloud › Identifiants › la clé › Restrictions d’application : « Aucune », ou adresses de sortie Scalingo autorisées.',
    });
  }
  if (/SERVICE_DISABLED|ACCESS_NOT_CONFIGURED/.test(reason) || /has not been used in project|is disabled|not been enabled|enable it by visiting/i.test(msg)) {
    add({
      code: 'API_NOT_ENABLED',
      text: 'Hypothèse à confirmer : « Generative Language API » n’est pas activée sur le projet Google Cloud de la clé.',
      check: 'Console Google Cloud › API et services › Bibliothèque › Generative Language API › Activer (projet de la clé).',
    });
  }
  if (/BILLING/.test(reason) || /billing/i.test(msg)) {
    add({
      code: 'BILLING',
      text: 'Hypothèse à confirmer : facturation absente ou désactivée sur le projet de la clé.',
      check: 'Console Google Cloud › Facturation du projet ; Google AI Studio › offre du projet.',
    });
  }
  if (/CONSUMER_INVALID|CONSUMER_SUSPENDED|PROJECT/.test(reason) || /project .*(not found|deleted|suspended|denied)|consumer/i.test(msg)) {
    add({
      code: 'PROJECT',
      text: 'Hypothèse à confirmer : le projet associé à la clé est invalide, supprimé ou suspendu.',
      check: 'Console Google Cloud › projet de la clé (état, propriétaire) ; Google AI Studio › clés d’API.',
    });
  }
  if (f.providerStatus === 'FAILED_PRECONDITION' || /location is not supported|not available in your country|region/i.test(msg)) {
    add({
      code: 'REGION',
      text: 'Hypothèse à confirmer : localisation de l’appel (région des serveurs) ou condition du projet non prise en charge pour cette API.',
      check: 'Documentation Google « available regions » ; région Scalingo de l’application ; offre du projet.',
    });
  }
  if (/API_KEY_INVALID|API_KEY_EXPIRED/.test(reason) || /api key (not valid|invalid|expired)/i.test(msg) || s === 401) {
    add({
      code: 'KEY_INVALID',
      text: 'Hypothèse à confirmer : clé invalide, expirée ou révoquée.',
      check: 'BO › Fournisseur IA : clé active et son test ; Google AI Studio › clés d’API.',
    });
  }
  if ((s === 403 || f.providerStatus === 'PERMISSION_DENIED') && out.length === 0) {
    add({
      code: 'ACCESS_DENIED_NO_REASON',
      text: 'Refus d’accès (403) sans raison détaillée exploitable : aucune cause précise ne peut être déduite de la réponse.',
      check: 'Vérifier dans l’ordre : restrictions de la clé (API, application), activation de « Generative Language API », facturation et état du projet.',
    });
  }
  if (s === 429 || f.providerStatus === 'RESOURCE_EXHAUSTED') {
    add({
      code: 'QUOTA',
      text: 'Hypothèse à confirmer : quota ou limite de débit du projet atteint pour l’envoi de fichiers.',
      check: 'Console Google Cloud › Quotas de « Generative Language API » ; Google AI Studio › usage.',
    });
  }
  if ((s !== null && s >= 500) || f.kind === 'invalid_response' || f.kind === 'activation_timeout') {
    add({
      code: 'PROVIDER_UNAVAILABLE',
      text: 'Hypothèse à confirmer : indisponibilité momentanée du service de fichiers du fournisseur.',
      check: 'Page d’état Google AI Studio ; refaire le test d’envoi plus tard.',
    });
  }
  if (f.kind === 'activation_failed' || s === 400 || s === 404 || s === 413) {
    if (f.providerStatus !== 'FAILED_PRECONDITION') {
      add({
        code: 'FILE_REJECTED',
        text: `Le fournisseur a refusé le fichier${s !== null ? ` (HTTP ${s})` : ''} : hypothèse d’un format, d’une taille ou d’un endpoint non accepté.`,
        check: 'Comparer avec le test d’envoi du BO (petit PDF) : s’il réussit, la cause tient au document.',
      });
    }
  }
  if (f.kind === 'http' && f.providerDetail === 'NONE') {
    add({
      code: 'NO_PROVIDER_DETAIL',
      text: 'Le fournisseur n’a donné aucun détail (corps de réponse vide) : aucune cause ne peut être déduite de la réponse.',
      check: 'Refaire le test d’envoi ; consulter les journaux de la clé dans la console Google Cloud (API et services › Métriques).',
    });
  }
  return out;
}
