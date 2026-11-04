import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfilsController } from './profils.controller';
import { ProfilsService } from './profils.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfilsController],
  providers: [ProfilsService],
  exports: [ProfilsService],
})
export class ProfilsModule {}
