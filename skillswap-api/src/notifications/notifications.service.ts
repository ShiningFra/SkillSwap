import { Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';

export interface LigneNotification {
  id: string;
  type: string;
  contenu: string;
  creeLe: Date;
  lue: boolean;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly db: Db) {}

  /** Les 50 dernières notifications du membre, et le nombre de celles qui ne sont pas lues. */
  async lister(moiId: string) {
    const { rows } = await this.db.query<LigneNotification>(
      `SELECT id, type, contenu, cree_le AS "creeLe", (lu_le IS NOT NULL) AS lue
         FROM notification WHERE utilisateur_id = $1 ORDER BY cree_le DESC LIMIT 50`,
      [moiId],
    );
    const nonLues = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE utilisateur_id = $1 AND lu_le IS NULL',
      [moiId],
    );
    return { nonLues: nonLues.rows[0].n, notifications: rows };
  }

  async toutMarquerLu(moiId: string) {
    await this.db.query(
      'UPDATE notification SET lu_le = now() WHERE utilisateur_id = $1 AND lu_le IS NULL',
      [moiId],
    );
  }
}
