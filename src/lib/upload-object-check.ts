/**
 * Vérification de l'objet déposé avant confirmation — APP-PERF-30.
 *
 * `confirm` passait la ligne en COMPLETED sur la seule parole du client :
 * un objet jamais transféré (PUT échoué mais confirmation envoyée) ou d'une
 * autre taille que celle déclarée (quota et limites calculés sur une valeur
 * fausse) devenait un document « enregistré ».
 *
 * Un `HeadObject` (métadonnées seules, aucun octet du fichier relu) vérifie
 * désormais que l'objet existe et que sa taille est EXACTEMENT celle
 * déclarée au presign. Le hash fourni par le client n'est pas une preuve
 * d'intégrité et n'est pas utilisé ici.
 *
 * Interrupteur d'exploitation : `UPLOAD_CONFIRM_VERIFY_OBJECT=false`
 * désactive le contrôle (retour au comportement antérieur) sans redéploiement
 * de code.
 */

export type VerificationObjet =
  | { kind: 'ok' }
  | { kind: 'absent' }
  | { kind: 'taille'; attendue: number; reelle: number }
  | { kind: 'indisponible'; detail: string };

export function verificationObjetActive(): boolean {
  return (process.env.UPLOAD_CONFIRM_VERIFY_OBJECT ?? 'true').toLowerCase() !== 'false';
}

export async function verifierObjetDepose(f: {
  s3Key: string | null; s3Bucket: string | null; size: number | null;
}): Promise<VerificationObjet> {
  if (!f.s3Key || f.s3Key === 'temp') return { kind: 'absent' };
  try {
    const [{ HeadObjectCommand }, { s3Client, S3_BUCKET }] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@/lib/s3-client'),
    ]);
    const res = await s3Client.send(new HeadObjectCommand({ Bucket: f.s3Bucket || S3_BUCKET, Key: f.s3Key }));
    const reelle = Number(res.ContentLength ?? NaN);
    if (f.size !== null && Number.isFinite(reelle) && reelle !== Number(f.size)) {
      return { kind: 'taille', attendue: Number(f.size), reelle };
    }
    return { kind: 'ok' };
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
    if (err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return { kind: 'absent' };
    }
    return { kind: 'indisponible', detail: err?.message ?? String(e) };
  }
}
