import { HttpStatus, Injectable } from '@nestjs/common';
import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config';
import { Audit } from '../common/audit.service';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';
import { CODE_SMS } from '../shared/domain';
import { SmsPort } from '../shared/sms';

/** ES5 : au plus 3 codes par heure, par membre et par numéro. */
const MAX_CODES_PAR_HEURE = 3;

@Injectable()
export class TelephoneService {
  constructor(
    private readonly db: Db,
    private readonly sms: SmsPort,
    private readonly audit: Audit,
  ) {}

  /** RG17 : le code n'est jamais stocké. On garde un HMAC avec un secret serveur (un simple SHA-256 de 6 chiffres se casse en une seconde). */
  private empreinteCode(id: string, code: string) {
    return createHmac('sha256', config().smsPepper)
      .update(`${id}:${code}`)
      .digest('hex');
  }

  async demander(utilisateurId: string, telephone: string) {
    // Changement de numéro : l'ancien reste vérifié tant que le nouveau ne l'est pas. Redemander le même ne sert à rien.
    const actuel = await this.db.query(
      `SELECT 1 FROM utilisateur WHERE id = $1 AND telephone = $2 AND telephone_verifie_le IS NOT NULL`,
      [utilisateurId, telephone],
    );
    if (actuel.rowCount === 1)
      throw new ErreurMetier('errors.telephoneIdentique', HttpStatus.CONFLICT);
    const { rows } = await this.db.query<{
      par_membre: string;
      par_numero: string;
    }>(
      `SELECT count(*) FILTER (WHERE utilisateur_id = $1) AS par_membre, count(*) FILTER (WHERE telephone = $2) AS par_numero
         FROM verification_telephone WHERE cree_le > now() - interval '1 hour' AND (utilisateur_id = $1 OR telephone = $2)`,
      [utilisateurId, telephone],
    );
    if (
      Number(rows[0].par_membre) >= MAX_CODES_PAR_HEURE ||
      Number(rows[0].par_numero) >= MAX_CODES_PAR_HEURE
    ) {
      throw new ErreurMetier(
        'errors.tropDEnvois',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const id = randomUUID();
    const code = randomInt(0, 10 ** CODE_SMS.longueur)
      .toString()
      .padStart(CODE_SMS.longueur, '0');
    await this.db.query(
      `INSERT INTO verification_telephone (id, utilisateur_id, telephone, code_hash, expire_le)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [
        id,
        utilisateurId,
        telephone,
        this.empreinteCode(id, code),
        CODE_SMS.validiteMinutes,
      ],
    );
    await this.sms.envoyerCode(telephone, code);
  }

  async verifier(utilisateurId: string, code: string) {
    await this.db
      .transaction(async (c) => {
        const { rows } = await c.query<{
          id: string;
          telephone: string;
          code_hash: string;
          tentatives: number;
        }>(
          `SELECT id, telephone, code_hash, tentatives FROM verification_telephone
          WHERE utilisateur_id = $1 AND valide_le IS NULL AND expire_le > now()
          ORDER BY cree_le DESC LIMIT 1 FOR UPDATE`,
          [utilisateurId],
        );
        const v = rows[0];
        if (!v || v.tentatives >= CODE_SMS.essaisMax)
          throw new ErreurMetier('errors.codeFaux', HttpStatus.BAD_REQUEST);
        await c.query(
          'UPDATE verification_telephone SET tentatives = tentatives + 1 WHERE id = $1',
          [v.id],
        );
        const attendu = Buffer.from(v.code_hash, 'hex');
        const recu = Buffer.from(this.empreinteCode(v.id, code), 'hex');
        if (attendu.length !== recu.length || !timingSafeEqual(attendu, recu)) {
          // L'incrément de tentatives doit survivre : on valide la transaction puis on signale l'erreur.
          return { echec: true };
        }
        await c.query(
          'UPDATE verification_telephone SET valide_le = now() WHERE id = $1',
          [v.id],
        );
        try {
          await c.query(
            'UPDATE utilisateur SET telephone = $2, telephone_verifie_le = now() WHERE id = $1',
            [utilisateurId, v.telephone],
          );
        } catch (e) {
          // RG17 : un numéro vérifié n'appartient qu'à un seul compte.
          if ((e as { code?: string }).code === '23505') return { pris: true };
          throw e;
        }
        return { ok: true };
      })
      .then(async (resultat) => {
        if ('echec' in resultat)
          throw new ErreurMetier('errors.codeFaux', HttpStatus.BAD_REQUEST);
        if ('pris' in resultat)
          throw new ErreurMetier('errors.telephonePris', HttpStatus.CONFLICT);
        await this.audit.enregistrer(utilisateurId, 'TELEPHONE_VERIFIE');
      });
  }
}
