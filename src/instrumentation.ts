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

  if (process.env.ENABLE_ANALYSIS_RECOVERY_SCHEDULER !== "true") {
    return;
  }

  const { startAnalysisRecoveryScheduler } = await import(
    "@/services/document-ai/analysis-recovery-scheduler"
  );

  startAnalysisRecoveryScheduler();
}