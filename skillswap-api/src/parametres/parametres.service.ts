import { HttpStatus, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';
import { ErreurMetier } from '../common/erreurs';

/** Interrupteurs pilotables depuis l'administration. Une clé inconnue est refusée, une clé absente de la base vaut « actif ». */
export const CLES_PARAMETRES = [
  'verification_telephone',
  'inscriptions',
  'propositions_competences',
  'recherche_semantique',
  'sessions_distance',
  'notifications_push',
  'portefeuille',
] as const;
export type ClePametre = (typeof CLES_PARAMETRES)[number];

export interface Parametre {
  cle: ClePametre;
  actif: boolean;
  message: string | null;
  modifieLe?: string;
}

const DUREE_CACHE_MS = 5_000;

@Injectable()
export class ParametresService {
  private cache?: { vers: number; valeurs: Parametre[] };
  constructor(private readonly db: Db) {}

  /** Lecture mise en cache 5 s : les contrôles se font à chaque requête sans charger la base. */
  async tous(): Promise<Parametre[]> {
    if (this.cache && Date.now() - this.cache.vers < DUREE_CACHE_MS)
      return this.cache.valeurs;
    const { rows } = await this.db.query<{
      cle: ClePametre;
      actif: boolean;
      message: string | null;
      modifieLe: Date;
    }>(`SELECT cle, actif, message, modifie_le AS "modifieLe" FROM parametre`);
    const parCle = new Map(rows.map((r) => [r.cle, r]));
    const valeurs = CLES_PARAMETRES.map((cle) => {
      const r = parCle.get(cle);
      return {
        cle,
        actif: r?.actif ?? true,
        message: r?.message ?? null,
        modifieLe: r?.modifieLe?.toISOString(),
      };
    });
    this.cache = { vers: Date.now(), valeurs };
    return valeurs;
  }

  async actif(cle: ClePametre): Promise<boolean> {
    return (await this.tous()).find((p) => p.cle === cle)?.actif ?? true;
  }

  /** Refuse l'opération (503) quand la fonctionnalité est « en révision ». */
  async exiger(cle: ClePametre): Promise<void> {
    if (!(await this.actif(cle)))
      throw new ErreurMetier(
        'errors.enRevision',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
  }

  async modifier(
    acteurId: string,
    cle: ClePametre,
    actif: boolean,
    message: string | null,
  ) {
    await this.db.query(
      `INSERT INTO parametre (cle, actif, message, modifie_par, modifie_le) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (cle) DO UPDATE SET actif = EXCLUDED.actif, message = EXCLUDED.message,
         modifie_par = EXCLUDED.modifie_par, modifie_le = now()`,
      [cle, actif, message, acteurId],
    );
    this.cache = undefined;
  }
}
