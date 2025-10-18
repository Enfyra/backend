import { Global, Module } from '@nestjs/common';
import { CacheService } from './services/cache.service';
import { RedisPubSubService } from './services/redis-pubsub.service';
import { RouteCacheService } from './services/route-cache.service';
import { MetadataCacheService } from './services/metadata-cache.service';

@Global()
@Module({
  providers: [CacheService, RedisPubSubService, MetadataCacheService, RouteCacheService],
  exports: [CacheService, RedisPubSubService, MetadataCacheService, RouteCacheService],
})
export class CacheModule {}
