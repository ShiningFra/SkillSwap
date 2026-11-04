import { HttpStatus, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { config } from '../config';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { empreinte } from '../common/session.guard';
import { Db } from '../db/db.service';

/** ES2 : argon2id, paramètres OWASP (19 Mo, 2 itérations). Le mot de passe n'est jamais journalisé. */
const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const VERSION_CGU = 'cgu-2026-11';
const MAX_ECHECS_COMPTE = 5;
const MAX_ECHECS_IP = 20;
const FENETRE_MINUTES = 15;

/** « +237 6 •• •• 42 17 » (ES8 : jamais le numéro complet). */
export function masquerTelephone(tel: string): string {
  const m = /^(\+\d{3})(\d)\d*(\d{4})$/.exec(tel);
  return m
    ? `${m[1]} ${m[2]} •• •• ${m[3].slice(0, 2)} ${m[3].slice(2)}`
    : '••••';
}

@Injectable()
export class AuthService {
  private fauxHash?: Promise<string>;
  constructor(
    private readonly db: Db,
    private readonly audit: Audit,
  ) {}

  /** Hache un faux mot de passe pour que « e-mail inconnu » coûte le même temps que « mauvais mot de passe » (ES3). */
  private hashFactice() {
    return (this.fauxHash ??= hash('mot-de-passe-factice', PARAMS));
  }

  async inscrire(v: { email: string; pseudo: string; motDePasse: string }) {
    const motDePasseHash = await hash(v.motDePasse, PARAMS);
    try {
      const id = await this.db.transaction(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO utilisateur (email, mot_de_passe_hash, pseudo, majeur_confirme_le) VALUES ($1, $2, $3, now()) RETURNING id`,
          [v.email.trim(), motDePasseHash, v.pseudo],
        );
        await c.query(
          `INSERT INTO consentement (utilisateur_id, finalite, version_texte) VALUES ($1, 'CGU', $2)`,
          [rows[0].id, VERSION_CGU],
        );
        return rows[0].id;
      });
      return { id, pseudo: v.pseudo, jeton: await this.ouvrirSession(id) };
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ErreurMetier('errors.emailPris', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async connecter(email: string, motDePasse: string, ip: string) {
    const emailHash = empreinte(email.trim().toLowerCase());
    const { rows: compte } = await this.db.query<{
      echecs_compte: string;
      echecs_ip: string;
    }>(
      `SELECT count(*) FILTER (WHERE email_hash = $1) AS echecs_compte, count(*) FILTER (WHERE ip = $2) AS echecs_ip
         FROM tentative_connexion
        WHERE NOT reussie AND cree_le > now() - make_interval(mins => $3) AND (email_hash = $1 OR ip = $2)`,
      [emailHash, ip, FENETRE_MINUTES],
    );
    if (
      Number(compte[0].echecs_compte) >= MAX_ECHECS_COMPTE ||
      Number(compte[0].echecs_ip) >= MAX_ECHECS_IP
    ) {
      throw new ErreurMetier(
        'errors.tropDEssais',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { rows } = await this.db.query<{
      id: string;
      mot_de_passe_hash: string;
      statut: string;
    }>(
      'SELECT id, mot_de_passe_hash, statut FROM utilisateur WHERE lower(email) = lower($1)',
      [email.trim()],
    );
    const utilisateur = rows[0];
    const valide = await verify(
      utilisateur?.mot_de_passe_hash ?? (await this.hashFactice()),
      motDePasse,
    ).catch(() => false);
    await this.db.query(
      'INSERT INTO tentative_connexion (email_hash, ip, reussie) VALUES ($1, $2, $3)',
      [emailHash, ip, !!utilisateur && valide],
    );
    // Même message et même code pour un e-mail inconnu et un mauvais mot de passe.
    if (!utilisateur || !valide)
      throw new ErreurMetier('errors.identifiants', HttpStatus.UNAUTHORIZED);
    if (utilisateur.statut !== 'ACTIF')
      throw new ErreurMetier('errors.compteSuspendu', HttpStatus.FORBIDDEN);
    return {
      id: utilisateur.id,
      jeton: await this.ouvrirSession(utilisateur.id),
    };
  }

  /** ES4 : jeton aléatoire de 256 bits ; seule son empreinte est stockée. */
  private async ouvrirSession(utilisateurId: string): Promise<string> {
    const jeton = randomBytes(32).toString('base64url');
    await this.db.query(
      `INSERT INTO session_connexion (utilisateur_id, jeton_hash, expire_le) VALUES ($1, $2, now() + make_interval(days => $3))`,
      [utilisateurId, empreinte(jeton), config().sessionJours],
    );
    return jeton;
  }

  async deconnecter(jeton: string) {
    await this.db.query(
      'UPDATE session_connexion SET revoque_le = now() WHERE jeton_hash = $1 AND revoque_le IS NULL',
      [empreinte(jeton)],
    );
  }

  /** Ne renvoie jamais de téléphone, d'e-mail ni de coordonnées (ES8, ES9). */
  async moi(id: string) {
    const { rows } = await this.db.query<{
      telephone: string | null;
      telephoneVerifie: boolean;
    }>(
      `SELECT id, pseudo, bio, role, mdp_provisoire AS "mdpProvisoire", mode_localisation AS "modeLocalisation", ville, telephone, (telephone_verifie_le IS NOT NULL) AS "telephoneVerifie" FROM utilisateur WHERE id = $1`,
      [id],
    );
    const { telephone, ...reste } = rows[0];
    // Le numéro n'est jamais renvoyé en entier : seulement une forme masquée, pour que le membre reconnaisse le sien.
    return {
      ...reste,
      telephoneMasque:
        telephone && reste.telephoneVerifie
          ? masquerTelephone(telephone)
          : null,
    };
  }

  /**
   * Changement de mot de passe : demande l'ancien (ES2), puis révoque toutes les autres sessions du compte
   * (un jeton volé ne survit pas au changement) et garde celle de l'appareil courant.
   */
  async changerMotDePasse(
    id: string,
    jetonCourant: string | undefined,
    actuel: string,
    nouveau: string,
  ) {
    const { rows } = await this.db.query<{ hash: string }>(
      `SELECT mot_de_passe_hash AS hash FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`,
      [id],
    );
    if (!rows[0])
      throw new ErreurMetier('errors.nonConnecte', HttpStatus.UNAUTHORIZED);
    const valide = await verify(rows[0].hash, actuel).catch(() => false);
    if (!valide)
      throw new ErreurMetier('errors.identifiants', HttpStatus.UNAUTHORIZED);
    const nouveauHash = await hash(nouveau, PARAMS);
    await this.db.transaction(async (c) => {
      await c.query(
        'UPDATE utilisateur SET mot_de_passe_hash = $2, mdp_provisoire = false WHERE id = $1',
        [id, nouveauHash],
      );
      await c.query(
        `UPDATE session_connexion SET revoque_le = now()
          WHERE utilisateur_id = $1 AND revoque_le IS NULL AND jeton_hash <> $2`,
        [id, jetonCourant ? empreinte(jetonCourant) : ''],
      );
    });
    await this.audit.enregistrer(id, 'MOT_DE_PASSE_MODIFIE');
  }
}
