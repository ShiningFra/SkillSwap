import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ParametresService } from './parametres.service';

@Controller('parametres')
export class ParametresController {
  constructor(private readonly parametres: ParametresService) {}

  /** Public : l'application affiche « en révision » aux membres. Rien de confidentiel, seulement l'état et le message. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  async lister() {
    return (await this.parametres.tous()).map(({ cle, actif, message }) => ({
      cle,
      actif,
      message,
    }));
  }
}
