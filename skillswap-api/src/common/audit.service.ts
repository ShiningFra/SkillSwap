import { Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';

@Injectable()
export class Audit {
  constructor(private readonly db: Db) {}

  /** ES10 : `detail` ne reçoit jamais de mot de passe, de code, de jeton ni de coordonnées. */
  async enregistrer(
    acteurId: string | null,
    action: string,
    cible?: string,
    detail: Record<string, unknown> = {},
  ) {
    await this.db.query(
      'INSERT INTO journal_audit (acteur_id, action, cible, detail) VALUES ($1, $2, $3, $4)',
      [acteurId, action, cible ?? null, detail],
    );
  }
}
