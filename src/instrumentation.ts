/**
 * Instrumentation serveur Next.js.
 *
 * Le scheduler de reprise d'analyse est désactivé par défaut.
 * Pour l'activer explicitement :
 * ENABLE_ANALYSIS_RECOVERY_SCHEDULER=true
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Verebona Assistant — contrôle de configuration au démarrage (CDC §15.14).
  // Échoue vite en cas de config incohérente (web grounding activé, > 2 appels IA,
  // store=true, alias "latest"…). N'empêche pas le boot ici ; en prod stricte, on
  // peut relancer l'erreur pour bloquer un démarrage mal configuré.
  try {
    const { assertAssistantStartup } = await import("@/services/verebona-assistant");
    assertAssistantStartup();
  } catch (e) {
    console.error(
      "[verebona-assistant] configuration refusée au démarrage:",
      (e as Error).message,
    );
  }

  if (process.env.ENABLE_ANALYSIS_RECOVERY_SCHEDULER !== "true") {
    return;
  }

  const { startAnalysisRecoveryScheduler } = await import(
    "@/services/document-ai/analysis-recovery-scheduler"
  );

  startAnalysisRecoveryScheduler();
}