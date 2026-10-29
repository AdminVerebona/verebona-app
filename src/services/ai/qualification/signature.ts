/**
 * Signature de qualification d'un couple — lot 86A (CDC Pilotage IA V2 P5 :
 * QUAL-01, QUAL-07, QUAL-08, R12, R44, §16.1 « lier la preuve à l'empreinte
 * exacte modèle + profil + opération + prompt + contrat + corpus +
 * évaluateur »).
 *
 * Une preuve n'est réutilisable QUE si la signature courante du couple est
 * identique à celle enregistrée avec elle. Un changement pertinent invalide
 * donc les preuves concernées — et elles seules (R12 : les autres opérations
 * ne sont pas retestées sans raison) :
 *   · prompt maître effectif de la branche (texte de la version de
 *     configuration, version administrée au BO ou fichier du dépôt) — une
 *     modification MANUELLE rend les anciennes preuves non applicables aux
 *     promotions automatiques sans empêcher l'administrateur d'activer
 *     (QUAL-08, R44) ;
 *   · contrat de sortie (schéma de la branche, version de contrat active) ;
 *   · corpus de l'opération (cas, contextes, attendus) ;
 *   · évaluateur (code du contrôle serveur, version des seuils, version du
 *     moteur de qualification) ;
 *   · capacités du modèle (fiche 85C : un changement constaté par la
 *     synchronisation rend la preuve obsolète — requalification sur
 *     événement) ;
 *   · profil effectif (paramètres CONSTRUITS par le constructeur de requête
 *     unique, délai de l'opération) et rang.
 * Les rejeux de données de préproduction (qui évoluent chaque jour) n'entrent
 * PAS dans la signature : ils complètent la mesure sans rendre les preuves
 * obsolètes à chaque nouvelle donnée.
 */
import { createHash } from 'node:crypto';

/** Version du moteur de qualification : la changer rend toutes les preuves obsolètes. */
/** Lot 97A : v2 — sortie réelle jugée avec le schéma de SON contrat de sortie (`cases.branchSchemaNames`). */
export const QUALIFICATION_ENGINE_VERSION = 'qualif-couple-v2' as const;

export interface CoupleSignatureParts {
  operationCode: string;
  rank: number;
  model: string;
  /** Paramètres effectifs construits (`buildModelRequest`) et délai de l'opération. */
  profile: Record<string, unknown>;
  promptFingerprint: string | null;
  contractFingerprint: string | null;
  corpusFingerprint: string | null;
  evaluatorFingerprint: string | null;
  capabilitiesSha256: string | null;
  thresholdsVersion: string;
}

/** JSON canonique (clés triées, récursif) : même objet → même texte. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Signature (SHA-256) d'un couple (pur). */
export function coupleSignature(p: CoupleSignatureParts): string {
  return sha256(canonicalJson({ engine: QUALIFICATION_ENGINE_VERSION, ...p }));
}

/** Parties qui diffèrent entre deux signatures (motif d'obsolescence lisible). */
export function changedParts(before: Partial<CoupleSignatureParts>, now: CoupleSignatureParts): Array<keyof CoupleSignatureParts> {
  const keys: Array<keyof CoupleSignatureParts> = ['model', 'rank', 'profile', 'promptFingerprint', 'contractFingerprint', 'corpusFingerprint', 'evaluatorFingerprint', 'capabilitiesSha256', 'thresholdsVersion'];
  return keys.filter((k) => before[k] !== undefined && canonicalJson(before[k]) !== canonicalJson(now[k]));
}

export const PART_LABELS: Readonly<Record<keyof CoupleSignatureParts, string>> = {
  operationCode: 'opération', rank: 'rang', model: 'modèle', profile: 'profil effectif', promptFingerprint: 'prompt',
  contractFingerprint: 'contrat de sortie', corpusFingerprint: 'corpus', evaluatorFingerprint: 'évaluateur',
  capabilitiesSha256: 'capacités du modèle', thresholdsVersion: 'version des seuils',
};
