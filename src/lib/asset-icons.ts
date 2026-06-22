import {
  Building,
  Building2,
  Home,
  Store,
  Landmark,
  Car,
  Bike,
  Truck,
  type LucideIcon,
  Briefcase,
  Laptop,
  Wrench,
  Package,
  Smartphone,
  Tv,
  Camera,
  Gamepad2,
  Headphones,
  Dumbbell,
  Mountain,
  Tent,
  Microwave,
  Fan,
  ParkingSquare,
} from 'lucide-react';

// Icônes spécifiques par sous-type de véhicule
const VEHICULE_ICONS: Record<string, LucideIcon> = {
  'vélo': Bike,
  'voiture': Car,
  'camion': Truck,
  'moto': Bike,
  'citadine': Car,
  'berline': Car,
  'utilitaire': Truck,
  'scooter': Bike,
  'vtt': Bike,
};

// Icônes spécifiques par sous-type d'immobilier
const IMMOBILIER_ICONS: Record<string, LucideIcon> = {
  'maison': Home,
  'appartement': Building2,
  'studio': Building2,
  'terrain': Landmark,
  'local commercial': Store,
  'garage': ParkingSquare,
};

// Icônes spécifiques par sous-type de matériel pro
const MATERIEL_PRO_ICONS: Record<string, LucideIcon> = {
  'ordinateur portable': Laptop,
  'ordinateur': Laptop,
  'outillage': Wrench,
};

// Icônes pour les objets de type TECH
const OBJECT_TECH_ICONS: Record<string, LucideIcon> = {
  'SMARTPHONE': Smartphone,
  'LAPTOP': Laptop,
  'TABLET': Laptop,
  'TV': Tv,
  'CAMERA': Camera,
  'CONSOLE': Gamepad2,
  'HEADPHONES': Headphones,
  'OTHER': Package,
};

// Icônes pour les objets de type SPORT
const OBJECT_SPORT_ICONS: Record<string, LucideIcon> = {
  'DRONE': Camera,
  'SURF': Dumbbell,
  'SKI': Mountain,
  'INDOOR_BIKE': Bike,
  'SCOOTER': Bike,
  'CAMPING': Tent,
  'OTHER': Dumbbell,
};

// Icônes pour les objets de type HOME
const OBJECT_HOME_ICONS: Record<string, LucideIcon> = {
  'KITCHEN_ROBOT': Microwave,
  'VACUUM': Fan,
  'CLEANER': Fan,
  'TOOLS': Wrench,
  'SMALL_APPLIANCE': Microwave,
  'OTHER': Package,
};

// Icônes par défaut par catégorie
const DEFAULT_CATEGORY_ICONS: Record<string, LucideIcon> = {
  'IMMOBILIER': Building,
  'VEHICULE': Car,
  'MATERIEL_PRO': Briefcase,
  'OBJECT': Package,
  'AUTRE': Package,
};

/**
 * Détecte le type de véhicule à partir du nom ou du sous-type
 */
function detectVehicleType(name: string, subtype?: string | null): LucideIcon | null {
  const searchText = `${name} ${subtype || ''}`.toLowerCase();
  
  if (searchText.includes('vélo') || searchText.includes('velo') || searchText.includes('vtt')) {
    return Bike;
  }
  if (searchText.includes('moto') || searchText.includes('scooter')) {
    return Bike;
  }
  if (searchText.includes('camion') || searchText.includes('utilitaire')) {
    return Truck;
  }
  if (searchText.includes('voiture') || searchText.includes('auto')) {
    return Car;
  }
  
  return null;
}

/**
 * Retourne l'icône appropriée pour un bien de type OBJECT
 */
export function getObjectIcon(objectCategory?: string | null, objectDetails?: any): LucideIcon {
  if (!objectCategory) return Package;
  
  const details = typeof objectDetails === 'string' ? JSON.parse(objectDetails || '{}') : (objectDetails || {});
  
  if (objectCategory === 'OBJECT_CATEGORY_TECH') {
    const deviceType = details.deviceType;
    if (deviceType && OBJECT_TECH_ICONS[deviceType]) {
      return OBJECT_TECH_ICONS[deviceType];
    }
    return Laptop;
  }
  
  if (objectCategory === 'OBJECT_CATEGORY_SPORT') {
    const sportType = details.sportType;
    if (sportType && OBJECT_SPORT_ICONS[sportType]) {
      return OBJECT_SPORT_ICONS[sportType];
    }
    return Dumbbell;
  }
  
  if (objectCategory === 'OBJECT_CATEGORY_HOME') {
    const homeItemType = details.homeItemType;
    if (homeItemType && OBJECT_HOME_ICONS[homeItemType]) {
      return OBJECT_HOME_ICONS[homeItemType];
    }
    return Microwave;
  }
  
  return Package;
}

/**
 * Retourne l'icône appropriée pour un bien basée sur sa catégorie et son sous-type
 */
export function getAssetIcon(
  category: string, 
  subtype?: string | null, 
  name?: string,
  objectCategory?: string | null,
  objectDetails?: any
): LucideIcon {
  // Handle OBJECT type
  if (category === 'OBJECT') {
    return getObjectIcon(objectCategory, objectDetails);
  }

  // Normalisation du sous-type pour comparaison insensible à la casse
  const normalizedSubtype = subtype?.toLowerCase().trim();
  
  // Si on a un sous-type, on cherche une icône spécifique
  if (normalizedSubtype) {
    switch (category) {
      case 'VEHICULE':
        const vehicleIcon = VEHICULE_ICONS[normalizedSubtype];
        if (vehicleIcon) return vehicleIcon;
        break;
      case 'IMMOBILIER':
        const immobilierIcon = IMMOBILIER_ICONS[normalizedSubtype];
        if (immobilierIcon) return immobilierIcon;
        break;
      case 'MATERIEL_PRO':
        const materielIcon = MATERIEL_PRO_ICONS[normalizedSubtype];
        if (materielIcon) return materielIcon;
        break;
    }
  }
  
  // Détection intelligente basée sur le nom pour les véhicules
  if (category === 'VEHICULE' && name) {
    const detectedIcon = detectVehicleType(name, subtype);
    if (detectedIcon) return detectedIcon;
  }

  // Sinon on retourne l'icône par défaut de la catégorie
  return DEFAULT_CATEGORY_ICONS[category] || Package;
}

/**
 * Retourne le label de catégorie traduit
 */
export const CATEGORY_LABELS: Record<string, string> = {
  IMMOBILIER: 'Immobilier',
  VEHICULE: 'Véhicule',
  MATERIEL_PRO: 'Matériel pro',
  OBJECT: 'Objet',
  AUTRE: 'Autre',
};

/**
 * Retourne la classe CSS supplémentaire pour personnaliser certaines icônes
 * (par exemple pour différencier visuellement la moto du vélo)
 */
export function getAssetIconClass(category: string, subtype?: string | null): string {
  if (category === 'VEHICULE' && subtype === 'Moto') {
    // On peut ajouter une classe pour styliser différemment l'icône de moto
    return 'font-bold';
  }
  return '';
}