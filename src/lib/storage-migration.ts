/**
 * Migration localStorage : Verebona legacy → Verebona
 * 
 * Migre les anciennes clés localStorage préfixées par 'owntrack_' 
 * vers des noms neutres ou préfixés 'verebona_'
 * 
 * Cette migration s'exécute automatiquement au chargement de l'application.
 * Note: "owntrack" est le nom de code historique du projet, remplacé par "Verebona"
 */

export function migrateLocalStorage() {
  if (typeof window === 'undefined') return; // SSR safety

  try {
    // Migration map: ancienne clé → nouvelle clé
    const migrations: Record<string, string> = {
      'owntrack_settings': 'verebona_settings',
      'owntrack_preferences': 'verebona_preferences',
      'owntrack_theme': 'app_theme',
      'owntrack_locale': 'app_locale',
    };

    let migratedCount = 0;

    Object.entries(migrations).forEach(([oldKey, newKey]) => {
      const oldValue = localStorage.getItem(oldKey);
      
      // Si l'ancienne clé existe et la nouvelle n'existe pas encore
      if (oldValue && !localStorage.getItem(newKey)) {
        localStorage.setItem(newKey, oldValue);
        localStorage.removeItem(oldKey);
        migratedCount++;
      }
    });

    // Suppression de toutes les autres clés owntrack_* non mappées
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('owntrack_') && !migrations[key]) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
    });

    if (migratedCount > 0 || keysToRemove.length > 0) {
    }
  } catch (error) {
    console.error('Storage migration error:', error);
  }
}