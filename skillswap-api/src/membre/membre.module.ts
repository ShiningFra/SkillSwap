import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MembreController } from './membre.controller';
import { MembreService } from './membre.service';

@Module({
  imports: [AuthModule],
  controllers: [MembreController],
  providers: [MembreService],
})
export class MembreModule {}
