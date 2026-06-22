"use client"

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, AlertCircle, RefreshCw } from 'lucide-react';

export default function DiagnosticPage() {
  const [diagnostics, setDiagnostics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  const runDiagnostics = async () => {
    setIsLoading(true);
    const results: any = {
      timestamp: new Date().toISOString(),
      localStorage: {},
      apis: {},
      data: {}
    };

    try {
      // 1. Vérifier localStorage
      results.localStorage.bearerToken = !!localStorage.getItem('bearer_token');
      results.localStorage.refreshToken = !!localStorage.getItem('refresh_token');
      results.localStorage.userExists = !!localStorage.getItem('user');
      
      if (results.localStorage.userExists) {
        try {
          const userData = JSON.parse(localStorage.getItem('user') || '{}');
          results.localStorage.userId = userData.id;
          results.localStorage.userEmail = userData.email;
          results.localStorage.userName = `${userData.firstName} ${userData.lastName}`;
        } catch (e) {
          results.localStorage.userParseError = true;
        }
      }

      const token = localStorage.getItem('bearer_token');

      // 2. Tester /api/users/me
      try {
        const meResponse = await fetch('/api/users/me', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        results.apis.usersMe = {
          status: meResponse.status,
          ok: meResponse.ok
        };
        
        if (meResponse.ok) {
          const meData = await meResponse.json();
          results.apis.usersMe.data = meData;
        } else {
          const errorData = await meResponse.json();
          results.apis.usersMe.error = errorData;
        }
      } catch (e: any) {
        results.apis.usersMe = {
          error: e.message,
          status: 'FETCH_ERROR'
        };
      }

      // 3. Tester /api/dashboard
      try {
        const dashboardResponse = await fetch('/api/dashboard', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        results.apis.dashboard = {
          status: dashboardResponse.status,
          ok: dashboardResponse.ok
        };
        
        if (dashboardResponse.ok) {
          const dashboardData = await dashboardResponse.json();
          results.data.totalAssets = dashboardData.assets?.total || 0;
          results.data.assetsItems = dashboardData.assets?.items?.length || 0;
          results.data.totalFiles = dashboardData.files?.total || 0;
          results.data.filesItems = dashboardData.files?.items?.length || 0;
          results.data.totalEvents = dashboardData.events?.total || 0;
          results.data.eventsItems = dashboardData.events?.items?.length || 0;
        } else {
          const errorData = await dashboardResponse.json();
          results.apis.dashboard.error = errorData;
        }
      } catch (e: any) {
        results.apis.dashboard = {
          error: e.message,
          status: 'FETCH_ERROR'
        };
      }

      // 4. Tester connexion directe base de données (via API debug)
      if (results.localStorage.userId) {
        try {
          const sqlResponse = await fetch('/api/debug/sql-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `SELECT COUNT(*) as count FROM assets WHERE user_id=${results.localStorage.userId}`
            })
          });
          
          if (sqlResponse.ok) {
            const sqlData = await sqlResponse.json();
            results.data.dbAssetsCount = sqlData.rows?.[0]?.count || 0;
          }
        } catch (e) {
          // Ignore errors
        }

        try {
          const sqlResponse = await fetch('/api/debug/sql-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `SELECT COUNT(*) as count FROM asset_files WHERE user_id=${results.localStorage.userId} AND deleted_at IS NULL`
            })
          });
          
          if (sqlResponse.ok) {
            const sqlData = await sqlResponse.json();
            results.data.dbFilesCount = sqlData.rows?.[0]?.count || 0;
          }
        } catch (e) {
          // Ignore errors
        }
      }

    } catch (e: any) {
      results.error = e.message;
    }

    setDiagnostics(results);
    setIsLoading(false);
  };

  const getStatusIcon = (ok: boolean) => {
    return ok ? (
      <CheckCircle2 className="w-5 h-5 text-green-500" />
    ) : (
      <XCircle className="w-5 h-5 text-red-500" />
    );
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Diagnostic de connexion</h1>
          <p className="text-muted-foreground">
            Vérifiez l'état de votre session et de vos données
          </p>
        </div>

        <Button onClick={runDiagnostics} disabled={isLoading} size="lg">
          {isLoading ? (
            <>
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              Diagnostic en cours...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Lancer le diagnostic
            </>
          )}
        </Button>

        {diagnostics && (
          <div className="space-y-4">
            {/* LocalStorage */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {getStatusIcon(diagnostics.localStorage.bearerToken)}
                  LocalStorage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between">
                  <span>Token d'authentification (bearer_token)</span>
                  <Badge variant={diagnostics.localStorage.bearerToken ? "default" : "destructive"}>
                    {diagnostics.localStorage.bearerToken ? "Présent" : "Absent"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Refresh token</span>
                  <Badge variant={diagnostics.localStorage.refreshToken ? "default" : "secondary"}>
                    {diagnostics.localStorage.refreshToken ? "Présent" : "Absent"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>Données utilisateur</span>
                  <Badge variant={diagnostics.localStorage.userExists ? "default" : "destructive"}>
                    {diagnostics.localStorage.userExists ? "Présent" : "Absent"}
                  </Badge>
                </div>
                {diagnostics.localStorage.userId && (
                  <>
                    <div className="flex items-center justify-between text-sm pt-2 border-t">
                      <span className="text-muted-foreground">User ID</span>
                      <span className="font-mono">{diagnostics.localStorage.userId}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Email</span>
                      <span className="font-mono">{diagnostics.localStorage.userEmail}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Nom</span>
                      <span className="font-mono">{diagnostics.localStorage.userName}</span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* API /users/me */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {getStatusIcon(diagnostics.apis.usersMe?.ok)}
                  API - Profil utilisateur (/api/users/me)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between">
                  <span>Statut HTTP</span>
                  <Badge variant={diagnostics.apis.usersMe?.ok ? "default" : "destructive"}>
                    {diagnostics.apis.usersMe?.status || 'N/A'}
                  </Badge>
                </div>
                {diagnostics.apis.usersMe?.error && (
                  <div className="p-3 bg-destructive/10 rounded-md text-sm">
                    <p className="font-semibold text-destructive mb-1">Erreur:</p>
                    <pre className="text-xs overflow-auto">
                      {JSON.stringify(diagnostics.apis.usersMe.error, null, 2)}
                    </pre>
                  </div>
                )}
                {diagnostics.apis.usersMe?.data && (
                  <div className="p-3 bg-green-500/10 rounded-md text-sm">
                    <p className="font-semibold text-green-700 dark:text-green-400 mb-1">Session valide ✓</p>
                    <p className="text-xs text-muted-foreground">
                      Utilisateur: {diagnostics.apis.usersMe.data.email}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* API /dashboard */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {getStatusIcon(diagnostics.apis.dashboard?.ok)}
                  API - Dashboard (/api/dashboard)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between">
                  <span>Statut HTTP</span>
                  <Badge variant={diagnostics.apis.dashboard?.ok ? "default" : "destructive"}>
                    {diagnostics.apis.dashboard?.status || 'N/A'}
                  </Badge>
                </div>
                {diagnostics.apis.dashboard?.error && (
                  <div className="p-3 bg-destructive/10 rounded-md text-sm">
                    <p className="font-semibold text-destructive mb-1">Erreur:</p>
                    <pre className="text-xs overflow-auto">
                      {JSON.stringify(diagnostics.apis.dashboard.error, null, 2)}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Données retournées */}
            {diagnostics.apis.dashboard?.ok && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-blue-500" />
                    Données retournées par l'API
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-muted rounded-lg">
                      <p className="text-sm text-muted-foreground mb-1">Biens (Total)</p>
                      <p className="text-3xl font-bold">{diagnostics.data.totalAssets || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Affichés: {diagnostics.data.assetsItems || 0}
                      </p>
                    </div>
                    <div className="p-4 bg-muted rounded-lg">
                      <p className="text-sm text-muted-foreground mb-1">Documents (Total)</p>
                      <p className="text-3xl font-bold">{diagnostics.data.totalFiles || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Affichés: {diagnostics.data.filesItems || 0}
                      </p>
                    </div>
                    <div className="p-4 bg-muted rounded-lg">
                      <p className="text-sm text-muted-foreground mb-1">Événements (Total)</p>
                      <p className="text-3xl font-bold">{diagnostics.data.totalEvents || 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Affichés: {diagnostics.data.eventsItems || 0}
                      </p>
                    </div>
                  </div>

                  {typeof diagnostics.data.dbAssetsCount !== 'undefined' && (
                    <div className="p-3 bg-blue-500/10 rounded-md">
                      <p className="font-semibold text-blue-700 dark:text-blue-400 mb-2">
                        Vérification directe base de données:
                      </p>
                      <div className="space-y-1 text-sm">
                        <p>• Biens en BDD: {diagnostics.data.dbAssetsCount}</p>
                        <p>• Fichiers actifs en BDD: {diagnostics.data.dbFilesCount}</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Résumé */}
            <Card className={diagnostics.apis.usersMe?.ok && diagnostics.apis.dashboard?.ok ? "border-green-500" : "border-red-500"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {diagnostics.apis.usersMe?.ok && diagnostics.apis.dashboard?.ok ? (
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500" />
                  )}
                  Diagnostic
                </CardTitle>
              </CardHeader>
              <CardContent>
                {diagnostics.apis.usersMe?.ok && diagnostics.apis.dashboard?.ok ? (
                  <div className="space-y-2">
                    <p className="text-green-700 dark:text-green-400 font-semibold">
                      ✅ Tout fonctionne correctement
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Votre session est valide et l'API retourne vos données ({diagnostics.data.totalAssets} biens, {diagnostics.data.totalFiles} documents).
                    </p>
                    {diagnostics.data.totalAssets === 0 && diagnostics.data.totalFiles === 0 && (
                      <p className="text-sm text-yellow-600 dark:text-yellow-400 mt-2">
                        ⚠️ Votre compte ne contient aucune donnée actuellement.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-red-700 dark:text-red-400 font-semibold">
                      ❌ Problème détecté
                    </p>
                    {!diagnostics.localStorage.bearerToken && (
                      <p className="text-sm text-muted-foreground">
                        • Vous n'êtes pas connecté (aucun token d'authentification trouvé)
                      </p>
                    )}
                    {diagnostics.localStorage.bearerToken && !diagnostics.apis.usersMe?.ok && (
                      <p className="text-sm text-muted-foreground">
                        • Votre session a expiré ou le token est invalide (erreur {diagnostics.apis.usersMe?.status})
                      </p>
                    )}
                    {diagnostics.apis.usersMe?.ok && !diagnostics.apis.dashboard?.ok && (
                      <p className="text-sm text-muted-foreground">
                        • L'API dashboard ne fonctionne pas correctement (erreur {diagnostics.apis.dashboard?.status})
                      </p>
                    )}
                    <Button 
                      onClick={() => window.location.href = '/login'} 
                      className="mt-4"
                    >
                      Se reconnecter
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Données brutes */}
            <details className="cursor-pointer">
              <summary className="text-sm text-muted-foreground hover:text-foreground">
                Voir les données brutes du diagnostic
              </summary>
              <pre className="mt-2 p-4 bg-muted rounded-md text-xs overflow-auto">
                {JSON.stringify(diagnostics, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
