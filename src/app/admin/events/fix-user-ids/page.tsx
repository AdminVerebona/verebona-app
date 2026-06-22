"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function FixUserIdsPage() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFix = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const token = localStorage.getItem("bearer_token");
      const response = await fetch("/api/admin/events/fix-user-ids", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details || "Erreur lors de la correction");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle>Corriger les événements avec userId incohérent</CardTitle>
          <CardDescription>
            Cette action va identifier et corriger automatiquement les événements dont le userId ne correspond pas au propriétaire du bien.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Action Button */}
          <div>
            <Button onClick={handleFix} disabled={loading} size="lg">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Correction en cours..." : "Lancer la correction"}
            </Button>
          </div>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Erreur</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Success Result */}
          {result && (
            <div className="space-y-4">
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertTitle>Correction terminée</AlertTitle>
                <AlertDescription>
                  Les événements ont été analysés et corrigés avec succès.
                </AlertDescription>
              </Alert>

              {/* Summary */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Résumé</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-[color:var(--text-muted)]">Total événements</p>
                      <p className="text-2xl font-semibold">{result.summary.total}</p>
                    </div>
                    <div>
                      <p className="text-sm text-[color:var(--text-muted)]">Corrigés</p>
                      <p className="text-2xl font-semibold text-green-600">{result.summary.corrected}</p>
                    </div>
                    <div>
                      <p className="text-sm text-[color:var(--text-muted)]">Déjà corrects</p>
                      <p className="text-2xl font-semibold">{result.summary.alreadyCorrect}</p>
                    </div>
                    <div>
                      <p className="text-sm text-[color:var(--text-muted)]">Orphelins</p>
                      <p className="text-2xl font-semibold text-orange-600">{result.summary.orphaned}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Details */}
              {result.details && result.details.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Détails des corrections</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {result.details.map((detail: any, idx: number) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-card)] text-sm"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium">Événement #{detail.eventId}</span>
                            <span
                              className={`px-2 py-1 rounded-full text-xs ${
                                detail.status === "corrected"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-orange-100 text-orange-800"
                              }`}
                            >
                              {detail.status === "corrected" ? "Corrigé" : "Orphelin"}
                            </span>
                          </div>
                          <div className="space-y-1 text-[color:var(--text-muted)]">
                            <p>Bien ID: {detail.assetId}</p>
                            {detail.status === "corrected" && (
                              <>
                                <p>Ancien userId: {detail.oldUserId}</p>
                                <p>Nouveau userId: {detail.newUserId}</p>
                              </>
                            )}
                            {detail.status === "orphaned" && <p>{detail.message}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
