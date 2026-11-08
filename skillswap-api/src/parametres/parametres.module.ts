import { Global, Module } from '@nestjs/common';
import { ParametresController } from './parametres.controller';
import { ParametresService } from './parametres.service';

@Global()
@Module({
  controllers: [ParametresController],
  providers: [ParametresService],
  exports: [ParametresService],
})
export class ParametresModule {}
