import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { uuidOuIntrouvable, valider } from '../common/erreurs';
import { SessionGuard, Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import {
  avisSchema,
  messageSchema,
  ouvertureConversationSchema,
  propositionSchema,
  lienSessionSchema,
  reponsePropositionSchema,
  signalementSchema,
} from '../shared/schemas';
import { ConversationsService } from './conversations.service';
import { SessionsService } from './sessions.service';
import { SignalementsService } from './signalements.service';

@UseGuards(SessionGuard)
@Controller()
export class EchangesController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly sessions: SessionsService,
    private readonly signalements: SignalementsService,
  ) {}

  @Post('conversations')
  ouvrir(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    return this.conversations.ouvrir(
      u.id,
      valider(ouvertureConversationSchema, corps).membreId,
    );
  }

  @Get('conversations')
  lister(@Utilisateur() u: UtilisateurCourant) {
    return this.conversations.lister(u.id);
  }

  @Get('conversations/:id')
  lire(@Utilisateur() u: UtilisateurCourant, @Param('id') id: string) {
    return this.conversations.lire(u.id, uuidOuIntrouvable(id));
  }

  // ES13 : 30 messages par minute au plus.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('conversations/:id/messages')
  async ecrire(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    await this.conversations.ecrire(
      u.id,
      uuidOuIntrouvable(id),
      valider(messageSchema, corps).texte,
    );
    return { ok: true };
  }

  @Post('conversations/:id/sessions')
  proposer(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    return this.sessions.proposer(
      u.id,
      uuidOuIntrouvable(id),
      valider(propositionSchema, corps),
    );
  }

  @Get('sessions')
  listerSessions(@Utilisateur() u: UtilisateurCourant) {
    return this.sessions.lister(u.id);
  }

  @Get('sessions/:id')
  session(@Utilisateur() u: UtilisateurCourant, @Param('id') id: string) {
    return this.sessions.obtenir(u.id, uuidOuIntrouvable(id));
  }

  @HttpCode(204)
  @Post('sessions/:id/reponse')
  async repondre(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    await this.sessions.repondre(
      u.id,
      uuidOuIntrouvable(id),
      valider(reponsePropositionSchema, corps).accepter,
    );
  }

  @HttpCode(204)
  @Put('sessions/:id/lien')
  async lien(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    await this.sessions.definirLien(
      u.id,
      uuidOuIntrouvable(id),
      valider(lienSessionSchema, corps).lien,
    );
  }

  @HttpCode(204)
  @Post('sessions/:id/confirmation')
  async confirmer(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
  ) {
    await this.sessions.confirmer(u.id, uuidOuIntrouvable(id));
  }

  @HttpCode(204)
  @Post('sessions/:id/absence')
  async absence(@Utilisateur() u: UtilisateurCourant, @Param('id') id: string) {
    await this.sessions.declarerAbsence(u.id, uuidOuIntrouvable(id));
  }

  @Post('sessions/:id/avis')
  async avis(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    await this.sessions.publierAvis(
      u.id,
      uuidOuIntrouvable(id),
      valider(avisSchema, corps),
    );
    return { ok: true };
  }

  @Post('signalements')
  async signaler(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    await this.signalements.signaler(u.id, valider(signalementSchema, corps));
    return { ok: true };
  }
}
