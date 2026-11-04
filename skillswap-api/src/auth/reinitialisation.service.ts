import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Audit } from '../common/audit.service';
import { config } from '../config';
import { ErreurMetier } from '../common/erreurs';
import { empreinte } from '../common/session.guard';
import { Db } from '../db/db.service';
import { MailPort } from '../shared/mail';

const VALIDITE_MINUTES = 60;
const MAX_DEMANDES_PAR_HEURE = 3;
const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class ReinitialisationService {
  private readonly journal = new Logger('Reinitialisation');
  constructor(
    private readonly db: Db,
    private readonly mail: MailPort,
    private readonly audit: Audit,
  ) {}

  /**
   * ES3 : la réponse est identique que l'adresse existe ou non (aucun indice sur l'existence d'un compte),
   * et l'envoi n'est pas attendu pour que le temps de réponse ne trahisse rien.
   */
  /** Aide au débogage, hors production seulement : la réponse HTTP reste identique (ES3). */
  private diagnostic(raison: string) {
    if (process.env.NODE_ENV !== 'production')
      this.journal.warn(`[dev] aucun mail envoyé : ${raison}`);
  }

  async demander(email: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM utilisateur WHERE lower(email) = lower($1) AND statut = 'ACTIF'`,
      [email.trim()],
    );
    const u = rows[0];
    if (!u) {
      this.diagnostic('aucun compte actif avec cette adresse');
      return;
    }
    const recentes = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reinitialisation_mdp WHERE utilisateur_id = $1 AND cree_le > now() - interval '1 hour'`,
      [u.id],
    );
    if (recentes.rows[0].n >= MAX_DEMANDES_PAR_HEURE) {
      // silencieux pour l'appelant : pas de signal pour un attaquant
      this.diagnostic(
        `déjà ${MAX_DEMANDES_PAR_HEURE} demandes dans l'heure pour ce compte`,
      );
      return;
    }
    const jeton = randomBytes(32).toString('base64url');
    await this.db.transaction(async (c) => {
      await c.query(
        `UPDATE reinitialisation_mdp SET utilise_le = now() WHERE utilisateur_id = $1 AND utilise_le IS NULL`,
        [u.id],
      );
      await c.query(
        `INSERT INTO reinitialisation_mdp (utilisateur_id, jeton_hash, expire_le) VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [u.id, empreinte(jeton), VALIDITE_MINUTES],
      );
    });
    const lien = `${config().appUrl}/reinitialisation?jeton=${jeton}`;
    void this.mail
      .envoyer(
        email.trim(),
        'Réinitialise ton mot de passe SkillSwap',
        `Bonjour,\n\nTu as demandé à réinitialiser ton mot de passe SkillSwap. Ouvre ce lien dans l'heure qui suit :\n\n${lien}\n\nSi tu n'es pas à l'origine de cette demande, ignore ce message : ton mot de passe ne change pas.\n`,
      )
      .catch((e: unknown) =>
        this.journal.error(`Envoi impossible : ${String(e)}`),
      );
    await this.audit.enregistrer(u.id, 'MDP_OUBLIE_DEMANDE');
  }

  /** Le jeton sert une seule fois ; toutes les sessions du compte sont révoquées (un jeton de session volé ne survit pas). */
  async reinitialiser(jeton: string, nouveau: string): Promise<void> {
    const nouveauHash = await hash(nouveau, PARAMS);
    const ok = await this.db.transaction(async (c) => {
      const r = await c.query<{ utilisateur_id: string }>(
        `UPDATE reinitialisation_mdp SET utilise_le = now()
          WHERE jeton_hash = $1 AND utilise_le IS NULL AND expire_le > now()
          RETURNING utilisateur_id`,
        [empreinte(jeton)],
      );
      const id = r.rows[0]?.utilisateur_id;
      if (!id) return null;
      await c.query(
        `UPDATE utilisateur SET mot_de_passe_hash = $2 WHERE id = $1 AND statut = 'ACTIF'`,
        [id, nouveauHash],
      );
      await c.query(
        `UPDATE session_connexion SET revoque_le = now() WHERE utilisateur_id = $1 AND revoque_le IS NULL`,
        [id],
      );
      return id;
    });
    if (!ok)
      throw new ErreurMetier('errors.jetonInvalide', HttpStatus.BAD_REQUEST);
    await this.audit.enregistrer(ok, 'MDP_REINITIALISE');
  }
}
