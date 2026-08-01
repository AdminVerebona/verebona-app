/**
 * GET/POST /api/cron/s3-cors — configuration CORS du bucket.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE SERVEUR A DÉJÀ TOUT CE QU'IL FAUT
 *
 * Sans CORS sur le bucket, aucun document ne peut être ajouté : le navigateur
 * envoie le fichier DIRECTEMENT au stockage, sur un autre domaine, et bloque
 * si l'origine n'est pas autorisée.
 *
 * La console OVH n'expose pas ce réglage pour les conteneurs S3 — quatre
 * onglets, aucun CORS — et un client en ligne de commande n'est pas
 * installable sur tous les postes.
 *
 * Or l'application embarque déjà `@aws-sdk/client-s3` et les clés du bucket.
 * Elle peut donc poser la configuration elle-même.
 *
 * ── L'ORIGINE N'EST PAS DEVINÉE ───────────────────────────────────────────
 *
 * Elle vient de `NEXT_PUBLIC_APP_URL`, celle-là même que le navigateur
 * présentera. Une origine saisie à la main finirait par diverger de l'URL
 * réelle, et le blocage reviendrait sans que rien ne l'explique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { s3Client } from '@/lib/s3-client';

export const dynamic = 'force-dynamic';

const BUCKET = process.env.OVH_S3_BUCKET ?? '';

/**
 * Origines autorisées.
 *
 * `localhost` n'est ajouté qu'en dehors de la production : un poste de
 * développement n'a rien à écrire dans le bucket de production.
 */
function origines(): string[] {
  const app = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '');
  const liste = app ? [app] : [];
  if (process.env.NEXT_PUBLIC_APP_ENV !== 'production') {
    liste.push('http://localhost:3000');
  }
  return liste;
}

function regle(): CORSRule {
  return {
    AllowedOrigins: origines(),
    // `PUT` pour l'envoi, `GET` et `HEAD` pour la relecture. Pas de `DELETE` :
    // les suppressions passent par le serveur, jamais par le navigateur.
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedHeaders: ['*'],
    // Le SDK lit `ETag` pour confirmer l'intégrité du fichier envoyé.
    ExposeHeaders: ['ETag'],
    // Le navigateur ne redemande pas l'autorisation à chaque fichier.
    MaxAgeSeconds: 3000,
  };
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!BUCKET) {
    return NextResponse.json({ error: 'OVH_S3_BUCKET absente.' }, { status: 409 });
  }

  try {
    const actuel = await s3Client.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
    const autorisees = actuel.CORSRules?.flatMap((r) => r.AllowedOrigins ?? []) ?? [];
    const attendues = origines();

    return NextResponse.json({
      bucket: BUCKET,
      reglesExistantes: actuel.CORSRules,
      originesAttendues: attendues,
      // Une règle présente mais incomplète bloque aussi sûrement qu'une règle
      // absente : c'est la couverture qui compte, pas l'existence.
      couvert: attendues.every((o) => autorisees.includes(o) || autorisees.includes('*')),
      avertissement: autorisees.includes('*')
        ? "AllowedOrigins vaut '*'. Une URL signée reste valable quelques minutes : " +
          "n'importe quel site pourrait s'en servir si elle fuitait."
        : undefined,
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    // OVH répond `NoSuchCORSConfiguration` quand aucune règle n'est posée.
    if (/NoSuchCORSConfiguration/i.test(err.name ?? '')) {
      return NextResponse.json({
        bucket: BUCKET,
        reglesExistantes: null,
        originesAttendues: origines(),
        couvert: false,
        note: 'Aucune règle CORS. Appeler cette route en POST pour la poser.',
      });
    }
    return NextResponse.json(
      { error: 'Lecture impossible.', cause: err.message, code: err.name },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!BUCKET) {
    return NextResponse.json({ error: 'OVH_S3_BUCKET absente.' }, { status: 409 });
  }

  const attendues = origines();
  if (attendues.length === 0) {
    // Poser une règle sans origine reviendrait à tout bloquer, en laissant
    // croire que la configuration est faite.
    return NextResponse.json(
      {
        error: 'Aucune origine à autoriser.',
        code: 'NO_ORIGIN',
        remede: 'Renseigner NEXT_PUBLIC_APP_URL.',
      },
      { status: 409 },
    );
  }

  try {
    await s3Client.send(
      new PutBucketCorsCommand({
        Bucket: BUCKET,
        CORSConfiguration: { CORSRules: [regle()] },
      }),
    );

    // Relecture immédiate : une écriture acceptée n'est pas une écriture
    // effective, et l'utilisateur n'a pas à me croire sur parole.
    const relu = await s3Client.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
    const autorisees = relu.CORSRules?.flatMap((r) => r.AllowedOrigins ?? []) ?? [];

    return NextResponse.json({
      bucket: BUCKET,
      applique: relu.CORSRules,
      couvert: attendues.every((o) => autorisees.includes(o)),
      note: "Rechargez la page avant de retester : le navigateur garde en cache " +
            'la réponse négative du contrôle préalable quelques minutes.',
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    return NextResponse.json(
      {
        error: 'Écriture refusée.',
        cause: err.message,
        code: err.name,
        remede: /AccessDenied/i.test(err.name ?? '')
          ? "Les clés du bucket peuvent écrire des objets mais pas modifier sa " +
            'configuration. Ajouter le droit s3:PutBucketCORS à l’utilisateur S3.'
          : undefined,
      },
      { status: 500 },
    );
  }
}
