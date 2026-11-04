import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SmsConsole, SmsPort } from '../shared/sms';
import { TelephoneController } from './telephone.controller';
import { TelephoneService } from './telephone.service';

@Module({
  imports: [AuthModule],
  controllers: [TelephoneController],
  providers: [TelephoneService, { provide: SmsPort, useClass: SmsConsole }],
})
export class TelephoneModule {}
