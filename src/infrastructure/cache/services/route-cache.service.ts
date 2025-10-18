import { Injectable, Logger, OnModuleInit, OnApplicationBootstrap } from '@nestjs/common';
import { QueryBuilderService } from '../../query-builder/query-builder.service';
import { RedisPubSubService } from './redis-pubsub.service';
import { CacheService } from './cache.service';
import { MetadataCacheService } from './metadata-cache.service';
import { InstanceService } from '../../../shared/services/instance.service';
import {
  ROUTE_CACHE_SYNC_EVENT_KEY,
  ROUTE_RELOAD_LOCK_KEY,
  REDIS_TTL,
} from '../../../shared/utils/constant';
import { getForeignKeyColumnName, getJunctionTableName } from '../../../shared/utils/naming-helpers';

@Injectable()
export class RouteCacheService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(RouteCacheService.name);
  private routesCache: any[] = [];
  private cacheLoaded = false;
  private messageHandler: ((channel: string, message: string) => void) | null = null;

  constructor(
    private readonly queryBuilder: QueryBuilderService,
    private readonly redisPubSubService: RedisPubSubService,
    private readonly cacheService: CacheService,
    private readonly metadataCacheService: MetadataCacheService,
    private readonly instanceService: InstanceService,
  ) {}

  async onModuleInit() {
    this.subscribe();
  }

  async onApplicationBootstrap() {
    // IMPORTANT: Check if system tables exist before loading routes
    // Even if metadata loads successfully, system tables may not exist yet
    await this.metadataCacheService.getMetadata();

    await this.reload();
  }

  /**
   * Subscribe to route sync messages from other instances
   */
  private subscribe() {
    const sub = this.redisPubSubService.sub;
    if (!sub) {
      this.logger.warn('Redis subscription not available for route cache sync');
      return;
    }

    // Only subscribe if not already subscribed
    if (this.messageHandler) {
      return;
    }

    // Create and store handler
    this.messageHandler = (channel: string, message: string) => {
      if (channel === ROUTE_CACHE_SYNC_EVENT_KEY) {
        try {
          const payload = JSON.parse(message);
          const myInstanceId = this.instanceService.getInstanceId();

          if (payload.instanceId === myInstanceId) {
            return;
          }

          this.logger.log(`📥 Received route cache sync from instance ${payload.instanceId.slice(0, 8)}...`);
          this.routesCache = payload.routes;
          this.cacheLoaded = true;
          this.logger.log(`✅ Route cache synced: ${payload.routes.length} routes`);
        } catch (error) {
          this.logger.error('Failed to parse route cache sync message:', error);
        }
      }
    };

    // Subscribe via RedisPubSubService (prevents duplicates)
    this.redisPubSubService.subscribeWithHandler(
      ROUTE_CACHE_SYNC_EVENT_KEY,
      this.messageHandler
    );
  }

  /**
   * Get routes from in-memory cache
   */
  async getRoutes(): Promise<any[]> {
    if (!this.cacheLoaded) {
      await this.reload();
    }
    return this.routesCache;
  }

  /**
   * Reload routes from DB (acquire lock → load → publish → save)
   */
  async reload(): Promise<void> {
    const instanceId = this.instanceService.getInstanceId();

    try {
      const acquired = await this.cacheService.acquire(
        ROUTE_RELOAD_LOCK_KEY,
        instanceId,
        REDIS_TTL.RELOAD_LOCK_TTL
      );

      if (!acquired) {
        this.logger.log('🔒 Another instance is reloading routes, waiting for broadcast...');
        return;
      }

      this.logger.log(`🔓 Acquired route reload lock (instance ${instanceId.slice(0, 8)})`);

      try {
        const start = Date.now();
        this.logger.log('🔄 Reloading routes cache...');

        // Load from DB
        const routes = await this.loadRoutes();
        this.logger.log(`✅ Loaded ${routes.length} routes in ${Date.now() - start}ms`);

        // Broadcast to other instances FIRST
        await this.publish(routes);

        // Then save to local memory cache
        this.routesCache = routes;
        this.cacheLoaded = true;
      } finally {
        await this.cacheService.release(ROUTE_RELOAD_LOCK_KEY, instanceId);
        this.logger.log('🔓 Released route reload lock');
      }
    } catch (error) {
      this.logger.error('❌ Failed to reload route cache:', error);
      throw error;
    }
  }
  
  private async publish(routes: any[]): Promise<void> {
    try {
      const payload = {
        instanceId: this.instanceService.getInstanceId(),
        routes: routes,
        timestamp: Date.now(),
      };

      await this.redisPubSubService.publish(
        ROUTE_CACHE_SYNC_EVENT_KEY,
        JSON.stringify(payload),
      );

      this.logger.log(`📤 Published route cache to other instances (${routes.length} routes)`);
    } catch (error) {
      this.logger.error('Failed to publish route cache sync:', error);
    }
  }

  private async loadRoutes(): Promise<any[]> {
    const result = await this.queryBuilder.select({
      tableName: 'route_definition',
      filter: { isEnabled: { _eq: true } },
      fields: [
        '*',
        'mainTable.*',
        'handlers.*',
        'handlers.method.*',
        'routePermissions.*',
        'routePermissions.role.*',
        'hooks.*',
        'hooks.methods.*',
        'publishedMethods.*',
        'targetTables.*',
      ],
    });
    const routes = result.data;

    // Debug: Check for duplicate hooks in routes
    for (const route of routes) {
      if (route.hooks && route.hooks.length > 0) {
        const hookIds = route.hooks.map((h: any) => h.id);
        const duplicates = hookIds.filter((id: any, index: number) => hookIds.indexOf(id) !== index);
        if (duplicates.length > 0) {
          this.logger.warn(`🚨 Route ${route.path} (id=${route.id}) has duplicate hooks:`, {
            totalHooks: route.hooks.length,
            hookIds: hookIds,
            duplicates: duplicates,
            hooks: route.hooks.map((h: any) => ({ id: h.id, name: h.name }))
          });
        }
      }
    }

    // Get global hooks separately
    const globalHooksResult = await this.queryBuilder.select({
      tableName: 'hook_definition',
      filter: {
        isEnabled: { _eq: true },
        routeId: { _null: true }
      },
      fields: ['*', 'methods.*'],
      sort: ['priority'],
    });
    const globalHooks = globalHooksResult.data;

    // Merge global hooks with route hooks (remove duplicates by id)
    for (const route of routes) {
      const allHooks = [...globalHooks, ...(route.hooks || [])];

      // Remove duplicate hooks by id
      const uniqueHooks = allHooks.filter((hook, index, self) =>
        index === self.findIndex((h) => h.id === hook.id)
      );

      route.hooks = uniqueHooks;

      if (!route.targetTables) {
        route.targetTables = [];
      }
    }

    return routes;
  }
}
