/**
 * Types du domaine, dérivés du schéma PostgreSQL (skillswap_schema.sql).
 * Chaque liste reprend le CHECK de la colonne correspondante : si le SQL change, ce fichier aussi.
 */

export const MODES_LOCALISATION = [
  'AUCUNE',
  'MANUELLE',
  'AUTOMATIQUE',
] as const; // utilisateur.mode_localisation
export const SENS_COMPETENCE = ['OFFERTE', 'RECHERCHEE'] as const; // declaration_competence.sens
export const NIVEAUX = ['DEBUTANT', 'INTERMEDIAIRE', 'AVANCE'] as const; // declaration_competence.niveau
export const FORMATS = ['PRESENTIEL', 'DISTANCE', 'LES_DEUX'] as const; // format (compétence, créneau, session)
export const TYPES_LIEU = ['PUBLIC', 'ESPACE_PARTAGE', 'DOMICILE'] as const; // session_echange.lieu_type (RG20)
export const CONTREPARTIES = [
  'TROC',
  'ARGENT_HORS_PLATEFORME',
  'GRATUIT',
] as const; // session_echange.contrepartie (RG16)
export const STATUTS_SESSION = [
  'PROPOSEE',
  'ACCEPTEE',
  'REFUSEE',
  'EXPIREE',
  'ANNULEE',
  'REALISEE',
  'NON_REALISEE',
] as const;

export type ModeLocalisation = (typeof MODES_LOCALISATION)[number];
export type SensCompetence = (typeof SENS_COMPETENCE)[number];
export type Niveau = (typeof NIVEAUX)[number];
export type Format = (typeof FORMATS)[number];
export type TypeLieu = (typeof TYPES_LIEU)[number];
export type Contrepartie = (typeof CONTREPARTIES)[number];
export type StatutSession = (typeof STATUTS_SESSION)[number];

/** Seuils de la règle RG21 (compétence confirmée par l'usage), identiques à la vue SQL v_competence_confirmee. */
export const CONFIRMATION = { sessionsMin: 3, noteMoyenneMin: 4 } as const;

/** Limites de la règle RG17 (code SMS), identiques au schéma. */
export const CODE_SMS = {
  longueur: 6,
  validiteMinutes: 10,
  essaisMax: 5,
} as const;

export interface Categorie {
  id: string;
  libelle: string;
}

export interface Competence {
  id: string;
  libelle: string;
  categorieId: string;
}

export interface DeclarationCompetence {
  competenceId: string;
  sens: SensCompetence;
  niveau: Niveau;
  format: Format;
  description?: string;
  /** RG18 : lien vers une réalisation, seulement pour une compétence offerte. */
  preuveUrl?: string;
}

/** RG21 : une compétence offerte est « confirmée » à partir de 3 sessions notées 4 sur 5 en moyenne. */
export function estConfirmee(
  sessionsNotees: number,
  noteMoyenne: number,
): boolean {
  return (
    sessionsNotees >= CONFIRMATION.sessionsMin &&
    noteMoyenne >= CONFIRMATION.noteMoyenneMin
  );
}

/** Compétence offerte telle qu'elle apparaît sur le profil d'un autre membre. */
export interface CompetenceOfferte {
  competenceId: string;
  niveau: Niveau;
  format: Format;
  preuveUrl?: string;
  sessionsNotees: number;
  noteMoyenne: number;
}

export interface Avis {
  auteur: string;
  note: 1 | 2 | 3 | 4 | 5;
  commentaire: string;
}

export interface Creneau {
  id: string;
  /** Date lisible, déjà formatée par le serveur (fuseau du membre). */
  libelle: string;
  format: Format;
}

/**
 * Profil public d'un membre. Il ne contient jamais le téléphone, l'e-mail ni les coordonnées :
 * seule une distance arrondie est exposée (RG4, ES8, ES9).
 */
export interface ProfilMembre {
  id: string;
  pseudo: string;
  ville?: string;
  distanceKm?: number;
  telephoneVerifie: boolean;
  noteMoyenne?: number;
  nbAvis: number;
  offertes: CompetenceOfferte[];
  recherchees: string[];
  avis: Avis[];
  creneaux: Creneau[];
}

export interface Message {
  id: string;
  deMoi: boolean;
  texte: string;
}

export interface ResumeConversation {
  id: string;
  membre: Pick<ProfilMembre, 'id' | 'pseudo'>;
  dernierMessage: string;
}

/** signalement.motif (ck_signalement_motif). */
export const MOTIFS_SIGNALEMENT = [
  'FAUX_PROFIL',
  'COMPORTEMENT_INAPPROPRIE',
  'ABSENCE_SANS_PREVENIR',
  'SPAM',
  'AUTRE',
] as const;
export type MotifSignalement = (typeof MOTIFS_SIGNALEMENT)[number];

/** Session vue par le membre connecté. */
export interface SessionEchange {
  id: string;
  membre: Pick<ProfilMembre, 'id' | 'pseudo'>;
  competenceId: string;
  creneauLibelle: string;
  format: 'PRESENTIEL' | 'DISTANCE';
  lieuType?: TypeLieu;
  contrepartie: Contrepartie;
  statut: StatutSession;
  proposeParMoi: boolean;
  mesConfirmation: boolean;
  saConfirmation: boolean;
  /** RG19 : qui ne s'est pas présenté, pour une session NON_REALISEE. */
  absent?: 'moi' | 'autre';
  /** RG11 : un seul avis par auteur et par session. */
  avisDonne: boolean;
}

/** RG19 : seuils d'absence sur 90 jours, valeurs de départ ajustables ici. */
export const ABSENCES = { avertissementDes: 1, suspensionDes: 3 } as const;

/** RG10 : une proposition sans réponse expire au bout de 72 heures. */
export const EXPIRATION_PROPOSITION_HEURES = 72;

/** ES8 : distances annoncées par paliers (km) pour empêcher de retrouver une position par recoupements. */
export const PALIERS_DISTANCE_KM = [1, 2, 5, 10, 20, 50, 100, 200] as const;
export const palierKm = (distanceKm: number): number =>
  PALIERS_DISTANCE_KM.find((p) => distanceKm <= p) ?? 200;
