// @nestjs packages
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

// Internal imports
import { GraphqlService } from './modules/graphql/services/graphql.service';

// Relative imports
import { AppModule } from './app.module';
import { initializeDatabase } from '../scripts/init-db';

async function bootstrap() {
  const startTime = Date.now();
  const logger = new Logger('Main');
  logger.log('🚀 Starting Cold Start');

  try {
    const initStart = Date.now();
    await initializeDatabase();
    logger.log(`⏱️  DB Init: ${Date.now() - initStart}ms`);
  } catch (err) {
    logger.error('Error during initialization:', err);
    process.exit(1);
  }

  const nestStart = Date.now();
  const app = await NestFactory.create(AppModule);
  logger.log(`⏱️  NestJS Create: ${Date.now() - nestStart}ms`);

  // Setup GraphQL endpoint
  try {
    const graphqlService = app.get(GraphqlService);
    const expressApp = app.getHttpAdapter().getInstance();
    
    expressApp.use('/graphql', (req, res, next) => {
      return graphqlService.getYogaInstance()(req, res, next);
    });
    logger.log('✅ GraphQL endpoint mounted at /graphql');
  } catch (error) {
    logger.warn('⚠️ GraphQL endpoint not available:', error.message);
  }

  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  const appInitStart = Date.now();
  await app.init();
  logger.log(`⏱️  App Init (Bootstrap): ${Date.now() - appInitStart}ms`);

  const listenStart = Date.now();
  await app.listen(configService.get('PORT') || 1105);
  logger.log(`⏱️  HTTP Listen: ${Date.now() - listenStart}ms`);

  const totalTime = Date.now() - startTime;
  logger.log(`🎉 Cold Start completed! Total time: ${totalTime}ms`);
}
bootstrap();
