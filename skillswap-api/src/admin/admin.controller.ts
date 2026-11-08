import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { inscriptionSchema, tribunalSchema } from '../shared/schemas';
import { AdminGuard } from '../common/admin.guard';
import { uuidOuIntrouvable, valider } from '../common/erreurs';
import { Utilisateur } from '../common/session.guard';
import type { UtilisateurCourant } from '../common/session.guard';
import { AdminService } from './admin.service';

const decisionSchema = z.object({
  decision: z.enum(['AVERTIR', 'SUSPENDRE', 'REJETER'], {
    error: 'errors.invalide',
  }),
  commentaire: z
    .string()
    .trim()
    .max(500, { error: 'errors.commentaire' })
    .optional(),
});

const confirmation = z.object({
  motDePasse: z
    .string()
    .min(1, { error: 'errors.invalide' })
    .max(128, { error: 'errors.invalide' }),
});
const parametreSchema = confirmation.extend({
  actif: z.boolean({ error: 'errors.invalide' }),
  message: z
    .string()
    .trim()
    .max(200, { error: 'errors.commentaire' })
    .nullish(),
});
const nommerSchema = confirmation.extend({
  email: inscriptionSchema.shape.email,
});
const creerSchema = nommerSchema.extend({
  pseudo: inscriptionSchema.shape.pseudo,
});

/** Toutes les routes exigent le rôle ADMIN, vérifié côté serveur. */
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Get('portefeuille')
  portefeuille() {
    return this.service.portefeuille();
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('sessions/:id/paiement')
  async trancher(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id') id: string,
    @Body() corps: unknown,
  ) {
    const v = valider(tribunalSchema, corps);
    await this.service.trancher(
      u.id,
      v.motDePasse,
      uuidOuIntrouvable(id),
      v.issue,
    );
  }

  @Get('parametres')
  parametres() {
    return this.service.listerParametres();
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Put('parametres/:cle')
  async modifierParametre(
    @Utilisateur() u: UtilisateurCourant,
    @Param('cle') cle: string,
    @Body() corps: unknown,
  ) {
    const v = valider(parametreSchema, corps);
    await this.service.modifierParametre(
      u.id,
      v.motDePasse,
      cle,
      v.actif,
      v.message || null,
    );
  }

  @Get('indicateurs')
  indicateurs() {
    return this.service.indicateurs();
  }

  @Get('signalements')
  lister() {
    return this.service.lister();
  }

  @Get('signalements/:id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.detail(id);
  }

  @HttpCode(204)
  @Post('signalements/:id/decision')
  async decider(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() corps: unknown,
  ) {
    const v = valider(decisionSchema, corps);
    await this.service.decider(u.id, id, v.decision, v.commentaire);
  }

  @Get('administrateurs')
  administrateurs() {
    return this.service.administrateurs();
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('administrateurs/nommer')
  async nommer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    const v = valider(nommerSchema, corps);
    await this.service.nommer(u.id, v.motDePasse, v.email);
  }

  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('administrateurs/creer')
  creer(@Utilisateur() u: UtilisateurCourant, @Body() corps: unknown) {
    const v = valider(creerSchema, corps);
    return this.service.creer(u.id, v.motDePasse, v.email, v.pseudo);
  }

  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('administrateurs/:id/retirer')
  async retirer(
    @Utilisateur() u: UtilisateurCourant,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() corps: unknown,
  ) {
    const v = valider(confirmation, corps);
    await this.service.retirer(u.id, v.motDePasse, id);
  }
}
