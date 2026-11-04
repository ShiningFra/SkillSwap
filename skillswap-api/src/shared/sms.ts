import { Injectable, Logger } from '@nestjs/common';

/** Port d'envoi de SMS : l'implémentation réelle (prestataire) viendra se brancher ici. */
export abstract class SmsPort {
  abstract envoyerCode(telephone: string, code: string): Promise<void>;
}

/** Développement uniquement : le code est écrit dans la console, jamais en production. */
@Injectable()
export class SmsConsole extends SmsPort {
  private readonly journal = new Logger('SMS');
  envoyerCode(telephone: string, code: string): Promise<void> {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Aucun prestataire SMS configuré');
    this.journal.warn(`[dev] code pour ${telephone.slice(0, 5)}… : ${code}`);
    return Promise.resolve();
  }
}
