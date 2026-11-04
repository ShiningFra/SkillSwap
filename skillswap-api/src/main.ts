import './env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configurerApp } from './app.setup';

async function demarrer() {
  const app = await NestFactory.create(AppModule);
  configurerApp(app);
  await app.listen(process.env.PORT ?? 3001);
}
void demarrer();
