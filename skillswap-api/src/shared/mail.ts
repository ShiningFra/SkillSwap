import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';

/** Port d'envoi d'e-mails : seul usage actuel, le lien de réinitialisation du mot de passe. */
export abstract class MailPort {
  abstract envoyer(
    destinataire: string,
    sujet: string,
    texte: string,
  ): Promise<void>;
}

/**
 * Envoi par SMTP, compatible avec n'importe quel prestataire (variable SMTP_URL, par exemple
 * `smtps://utilisateur:motdepasse@smtp.exemple.com:465`, et MAIL_EXPEDITEUR pour l'adresse d'envoi).
 * Sans SMTP_URL, le développement écrit le message dans la console ; la production refuse de démarrer l'envoi.
 */
@Injectable()
export class MailSmtpOuConsole extends MailPort {
  private readonly journal = new Logger('Mail');
  private transport?: Transporter;

  private transporteur(): Transporter | undefined {
    const url = process.env.SMTP_URL;
    if (!url) return undefined;
    return (this.transport ??= createTransport(url));
  }

  async envoyer(
    destinataire: string,
    sujet: string,
    texte: string,
  ): Promise<void> {
    const t = this.transporteur();
    if (!t) {
      if (process.env.NODE_ENV === 'production')
        throw new Error('SMTP_URL est obligatoire en production');
      this.journal.warn(`[dev] à ${destinataire} — ${sujet}\n${texte}`);
      return;
    }
    const expediteur =
      process.env.MAIL_EXPEDITEUR ?? 'SkillSwap <no-reply@skillswap.example>';
    const r = await t.sendMail({
      from: expediteur,
      to: destinataire,
      subject: sujet,
      text: texte,
    });
    const refuses = Array.isArray(r.rejected) ? r.rejected.length : 0;
    this.journal.log(
      `Envoyé à ${destinataire} depuis ${expediteur} (${refuses ? 'refusé par le serveur' : 'accepté par le serveur'}) ${String(r.response ?? '')}`,
    );
  }
}
