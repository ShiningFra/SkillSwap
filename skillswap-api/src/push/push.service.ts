import { ParametresService } from '../parametres/parametres.service';
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { config } from '../config';
import { ErreurMetier } from '../common/erreurs';
import { Db } from '../db/db.service';

/** Seuls les services de push des navigateurs sont appelés : un endpoint choisi par un membre ne doit pas viser le réseau interne (SSRF). */
const HOTES_AUTORISES = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',
];
const MAX_APPAREILS = 10;

/** Texte envoyé au navigateur : fixe pour chaque type, jamais le contenu du message (il transite par Google, Mozilla ou Apple). */
const TEXTES: Record<string, string> = {
  NOUVEAU_MESSAGE: 'Tu as un nouveau message',
  SESSION_PROPOSEE: 'Tu as reçu une proposition de session',
  SESSION_ACCEPTEE: 'Ta proposition de session est acceptée',
  SESSION_REFUSEE: 'Ta proposition de session est refusée',
  NOUVEAU_SIGNALEMENT: 'Nouveau signalement à traiter',
  LIEN_SESSION: 'Le lien de ta session à distance est disponible',
  RAPPEL_AVIS: 'Pense à laisser ton avis',
  NOUVELLE_SUGGESTION: 'Une nouvelle personne compatible',
  AVERTISSEMENT_ABSENCE: 'Une absence a été déclarée sur une de tes sessions',
  AVERTISSEMENT: 'Tu as reçu un avertissement',
  SUSPENSION: 'Ton compte a été suspendu',
};

export function endpointAutorise(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || u.port) return false;
    return HOTES_AUTORISES.some((h) =>
      h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h,
    );
  } catch {
    return false;
  }
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly journal = new Logger('Push');
  constructor(
    private readonly db: Db,
    private readonly parametres: ParametresService,
  ) {}

  actif() {
    return config().vapid !== null;
  }

  async onModuleInit() {
    const v = config().vapid;
    if (!v) return;
    webpush.setVapidDetails(v.contact, v.publique, v.privee);
    await this.db.ecouter('nouvelle_notification', (id) => {
      void this.envoyerNotification(id).catch((e: unknown) =>
        this.journal.error(`Envoi push impossible : ${String(e)}`),
      );
    });
  }

  cle() {
    return { cle: config().vapid?.publique ?? null };
  }

  async abonner(
    utilisateurId: string,
    s: { endpoint: string; p256dh: string; auth: string },
  ) {
    if (!this.actif())
      throw new ErreurMetier(
        'errors.pushIndisponible',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    await this.parametres.exiger('notifications_push');
    if (!endpointAutorise(s.endpoint))
      throw new ErreurMetier('errors.invalide', HttpStatus.BAD_REQUEST);
    await this.db.transaction(async (c) => {
      // Un même appareil peut passer d'un compte à un autre : l'endpoint appartient au dernier compte connecté.
      await c.query(
        `INSERT INTO push_abonnement (utilisateur_id, endpoint, cle_p256dh, cle_auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET utilisateur_id = $1, cle_p256dh = $3, cle_auth = $4, cree_le = now()`,
        [utilisateurId, s.endpoint, s.p256dh, s.auth],
      );
      await c.query(
        `DELETE FROM push_abonnement WHERE utilisateur_id = $1 AND id NOT IN
           (SELECT id FROM push_abonnement WHERE utilisateur_id = $1 ORDER BY cree_le DESC LIMIT $2)`,
        [utilisateurId, MAX_APPAREILS],
      );
    });
  }

  async retirer(utilisateurId: string, endpoint: string) {
    await this.db.query(
      'DELETE FROM push_abonnement WHERE utilisateur_id = $1 AND endpoint = $2',
      [utilisateurId, endpoint],
    );
  }

  /** Appelé par le signal de la base : une notification vient d'être enregistrée. */
  async envoyerNotification(notificationId: string) {
    if (!(await this.parametres.actif('notifications_push'))) return;
    const { rows } = await this.db.query<{
      utilisateur_id: string;
      type: string;
      lien: string | null;
    }>('SELECT utilisateur_id, type, lien FROM notification WHERE id = $1', [
      notificationId,
    ]);
    const n = rows[0];
    if (!n) return;
    const { rows: abonnements } = await this.db.query<{
      id: string;
      endpoint: string;
      cle_p256dh: string;
      cle_auth: string;
    }>(
      'SELECT id, endpoint, cle_p256dh, cle_auth FROM push_abonnement WHERE utilisateur_id = $1',
      [n.utilisateur_id],
    );
    const charge = JSON.stringify({
      titre: 'SkillSwap',
      corps: TEXTES[n.type] ?? 'Tu as une nouvelle notification',
      lien: n.lien ?? '/notifications',
      tag: n.type,
    });
    await Promise.all(
      abonnements.map(async (a) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: a.endpoint,
              keys: { p256dh: a.cle_p256dh, auth: a.cle_auth },
            },
            charge,
            { TTL: 86_400 },
          );
        } catch (e) {
          const statut = (e as { statusCode?: number }).statusCode;
          // 404 et 410 : l'appareil s'est désabonné ; on ne garde pas un abonnement mort.
          if (statut === 404 || statut === 410)
            await this.db.query('DELETE FROM push_abonnement WHERE id = $1', [
              a.id,
            ]);
          else {
            const err = e as { code?: string; message?: string; body?: string };
            const hote = new URL(a.endpoint).hostname;
            this.journal.warn(
              `Push non envoyé vers ${hote} : ${statut ? `statut ${statut} ${err.body ?? ''}`.trim() : (err.code ?? err.message ?? 'erreur inconnue')}`,
            );
          }
        }
      }),
    );
  }
}
