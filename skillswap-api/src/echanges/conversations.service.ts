/* eslint-disable @typescript-eslint/no-unsafe-assignment -- lignes SQL aliasées, formes vérifiées par les tests e2e */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ErreurMetier, traduirePg } from '../common/erreurs';
import { Db } from '../db/db.service';
import { ProfilsService } from '../profils/profils.service';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly db: Db,
    private readonly profils: ProfilsService,
  ) {}

  /** RG2 : un seul fil par couple de membres. RG17 : le déclencheur refuse l'initiateur sans téléphone vérifié. */
  async ouvrir(moiId: string, membreId: string) {
    if (membreId === moiId)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const cible = await this.db.query(
      `SELECT 1 FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`,
      [membreId],
    );
    if (cible.rowCount === 0)
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    const existante = () =>
      this.db.query<{ id: string }>(
        `SELECT id FROM conversation WHERE LEAST(initiateur_id, destinataire_id) = LEAST($1::uuid, $2::uuid) AND GREATEST(initiateur_id, destinataire_id) = GREATEST($1::uuid, $2::uuid)`,
        [moiId, membreId],
      );
    const deja = await existante();
    if (deja.rows[0]) return { id: deja.rows[0].id };
    try {
      const { rows } = await this.db.query<{ id: string }>(
        'INSERT INTO conversation (initiateur_id, destinataire_id) VALUES ($1, $2) RETURNING id',
        [moiId, membreId],
      );
      return { id: rows[0].id };
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        return { id: (await existante()).rows[0].id };
      return traduirePg(e);
    }
  }

  async lister(moiId: string) {
    const { rows } = await this.db.query(
      `SELECT c.id, o.id AS "membreId", o.pseudo,
              (SELECT m.contenu FROM message m WHERE m.conversation_id = c.id ORDER BY m.envoye_le DESC LIMIT 1) AS "dernierMessage",
              (SELECT count(*)::int FROM message m WHERE m.conversation_id = c.id AND m.expediteur_id <> $1 AND m.lu_le IS NULL) AS "nonLus",
              COALESCE((SELECT max(m.envoye_le) FROM message m WHERE m.conversation_id = c.id), c.cree_le) AS activite
         FROM conversation c
         JOIN utilisateur o ON o.id = CASE WHEN c.initiateur_id = $1 THEN c.destinataire_id ELSE c.initiateur_id END
        WHERE $1 IN (c.initiateur_id, c.destinataire_id) ORDER BY activite DESC`,
      [moiId],
    );
    return rows.map((r) => ({
      id: r.id,
      membre: { id: r.membreId, pseudo: r.pseudo },
      dernierMessage: r.dernierMessage ?? '',
      nonLus: r.nonLus as number,
    }));
  }

  /** ES6 : seuls les deux membres du fil le lisent ; un autre membre reçoit « introuvable ». */
  private async interlocuteur(moiId: string, conversationId: string) {
    const { rows } = await this.db.query<{
      id: string;
      pseudo: string;
      statut: string;
    }>(
      `SELECT o.id, o.pseudo, o.statut FROM conversation c
         JOIN utilisateur o ON o.id = CASE WHEN c.initiateur_id = $1 THEN c.destinataire_id ELSE c.initiateur_id END
        WHERE c.id = $2 AND $1 IN (c.initiateur_id, c.destinataire_id)`,
      [moiId, conversationId],
    );
    if (!rows[0])
      throw new ErreurMetier('errors.introuvable', HttpStatus.NOT_FOUND);
    return rows[0];
  }

  async lire(moiId: string, conversationId: string) {
    const autre = await this.interlocuteur(moiId, conversationId);
    await this.db.query(
      'UPDATE message SET lu_le = now() WHERE conversation_id = $1 AND expediteur_id <> $2 AND lu_le IS NULL',
      [conversationId, moiId],
    );
    // Lire la conversation vaut lecture des notifications de message qui y mènent.
    await this.db.query(
      'UPDATE notification SET lu_le = now() WHERE utilisateur_id = $1 AND lien = $2 AND lu_le IS NULL',
      [moiId, `/messages/${conversationId}`],
    );
    const [messages, creneaux] = await Promise.all([
      this.db.query(
        `SELECT id, (expediteur_id = $2) AS "deMoi", contenu AS texte FROM message WHERE conversation_id = $1 ORDER BY envoye_le`,
        [conversationId, moiId],
      ),
      this.profils.creneauxLibres(autre.id),
    ]);
    return {
      membre: { id: autre.id, pseudo: autre.pseudo, creneaux },
      messages: messages.rows,
    };
  }

  async ecrire(moiId: string, conversationId: string, texte: string) {
    const autre = await this.interlocuteur(moiId, conversationId);
    // RG14 : on n'écrit plus à un compte supprimé.
    if (autre.statut === 'SUPPRIME')
      throw new ErreurMetier('errors.membreSupprime', HttpStatus.GONE);
    await this.db.transaction(async (c) => {
      await c.query(
        'INSERT INTO message (conversation_id, expediteur_id, contenu) VALUES ($1, $2, $3)',
        [conversationId, moiId, texte],
      );
      await c.query(
        `INSERT INTO notification (utilisateur_id, type, contenu, lien) VALUES ($1, 'NOUVEAU_MESSAGE', 'Tu as un nouveau message', $2)`,
        [autre.id, `/messages/${conversationId}`],
      );
    });
  }

  /** Utilisé par les sessions : renvoie l'interlocuteur ou « introuvable ». */
  interlocuteurDe(moiId: string, conversationId: string) {
    return this.interlocuteur(moiId, conversationId);
  }
}
