import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';
import { signalementSchema } from '../shared/schemas';

/** Plafond de signalements par membre et par heure : limite les abus et la charge de modération. */
const MAX_SIGNALEMENTS_PAR_HEURE = 5;

@Injectable()
export class SignalementsService {
  constructor(private readonly db: Db) {}

  async signaler(moiId: string, v: z.infer<typeof signalementSchema>) {
    if (v.membreId === moiId)
      throw new ErreurMetier('errors.invalide', HttpStatus.BAD_REQUEST); // RG13
    const cible = await this.db.query(
      `SELECT 1 FROM utilisateur WHERE id = $1`,
      [v.membreId],
    );
    if (cible.rowCount === 0)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const { rows } = await this.db.query<{ recents: number; ouvert: number }>(
      `SELECT count(*) FILTER (WHERE cree_le > now() - interval '1 hour')::int AS recents,
              count(*) FILTER (WHERE cible_id = $2 AND statut IN ('OUVERT', 'EN_COURS'))::int AS ouvert
         FROM signalement WHERE auteur_id = $1`,
      [moiId, v.membreId],
    );
    if (rows[0].recents >= MAX_SIGNALEMENTS_PAR_HEURE)
      throw new ErreurMetier(
        'errors.tropDeSignalements',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // Un même membre ne peut pas multiplier les signalements ouverts contre la même personne.
    if (rows[0].ouvert > 0)
      throw new ErreurMetier('errors.dejaSignale', HttpStatus.CONFLICT);
    await this.db.query(
      'INSERT INTO signalement (auteur_id, cible_id, motif, description) VALUES ($1, $2, $3, $4)',
      [moiId, v.membreId, v.motif, v.description || null],
    );
    // Les administrateurs actifs (hors auteur et cible) sont prévenus ; la notification déclenche aussi la notification push.
    await this.db.query(
      `INSERT INTO notification (utilisateur_id, type, contenu, lien)
       SELECT a.id, 'NOUVEAU_SIGNALEMENT', 'Nouveau signalement à traiter', $3
         FROM utilisateur a
        WHERE a.role = 'ADMIN' AND a.statut = 'ACTIF' AND a.id NOT IN ($1, $2)`,
      [moiId, v.membreId, '/admin'],
    );
  }
}
