"use client";

/**
 * Écran d'erreur global (`src/app/global-error.tsx`).
 *
 * APP-PERF-38 : la version précédente venait de l'outil ayant généré le
 * squelette du projet (Orchids). Elle affichait au client « Please try again
 * fixing with Orchids » et, dans une iframe, transmettait chaque erreur — pile
 * comprise — à la fenêtre parente avec la cible `"*"` (n'importe quelle
 * origine). Remplacée par un message maîtrisé, en français, sans aucun envoi
 * hors de la page. Le détail technique reste réservé au développement ; en
 * production, seule la référence (`digest`) est montrée, pour le support.
 */
import Link from "next/link";
import { useEffect } from "react";

type ReporterProps = {
  /*  ⎯⎯ fournies uniquement par la page global-error ⎯⎯ */
  error?: Error & { digest?: string };
  reset?: () => void;
};

export const GLOBAL_ERROR_TITLE = "Une erreur est survenue";
export const GLOBAL_ERROR_MESSAGE =
  "La page n’a pas pu s’afficher. Réessayez ; si le problème persiste, contactez le support Verebona.";

export default function ErrorReporter({ error, reset }: ReporterProps) {
  useEffect(() => {
    if (error) console.error("[global-error]", error.digest ?? "", error);
  }, [error]);

  if (!error) return null;

  return (
    <html lang="fr">
      <body className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-destructive">{GLOBAL_ERROR_TITLE}</h1>
            <p className="text-muted-foreground">{GLOBAL_ERROR_MESSAGE}</p>
            {error.digest && (
              <p className="text-xs text-muted-foreground">Référence : {error.digest}</p>
            )}
          </div>
          <div className="flex justify-center gap-3">
            {reset && (
              <button
                type="button"
                onClick={() => reset()}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Réessayer
              </button>
            )}
            <Link href="/" className="rounded-md border px-4 py-2 text-sm font-medium">
              Retour à l’accueil
            </Link>
          </div>
          {process.env.NODE_ENV === "development" && (
            <details className="mt-4 text-left">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Détails techniques
              </summary>
              <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto">
                {error.message}
                {error.stack ? `\n\n${error.stack}` : ""}
              </pre>
            </details>
          )}
        </div>
      </body>
    </html>
  );
}
