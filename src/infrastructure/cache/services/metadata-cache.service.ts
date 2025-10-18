import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { QueryBuilderService } from '../../query-builder/query-builder.service';
import { CacheService } from './cache.service';
import { RedisPubSubService } from './redis-pubsub.service';
import { InstanceService } from '../../../shared/services/instance.service';
import { DatabaseSchemaService } from '../../knex/services/database-schema.service';
import { getJunctionTableName, getForeignKeyColumnName, getJunctionColumnNames } from '../../../shared/utils/naming-helpers';
import { 
  METADATA_CACHE_KEY, 
  METADATA_CACHE_SYNC_EVENT_KEY,
  METADATA_RELOAD_LOCK_KEY,
  REDIS_TTL,
} from '../../../shared/utils/constant';

export interface EnfyraMetadata {
  tables: Map<string, any>;
  tablesList: any[];
  version: number;
  timestamp: Date;
}

@Injectable()
export class MetadataCacheService implements OnApplicationBootstrap, OnModuleInit {
  private readonly logger = new Logger(MetadataCacheService.name);
  private inMemoryCache: EnfyraMetadata | null = null; // In-memory cache to avoid Redis calls
  private messageHandler: ((channel: string, message: string) => void) | null = null;

  constructor(
    @Inject(forwardRef(() => QueryBuilderService))
    private readonly queryBuilder: QueryBuilderService,
    private readonly cacheService: CacheService,
    private readonly redisPubSubService: RedisPubSubService,
    private readonly instanceService: InstanceService,
    private readonly databaseSchemaService: DatabaseSchemaService,
  ) {}

  async onModuleInit() {
    this.subscribe();

  }

  async onApplicationBootstrap() {
    this.logger.log('🚀 MetadataCacheService.onApplicationBootstrap() called');
    try {
      await this.reload();
      this.logger.log('✅ MetadataCacheService initialization completed');
    } catch (error) {
      this.logger.error('❌ MetadataCacheService initialization failed:', error);
      throw error;
    }
  }

  /**
   * Subscribe to metadata sync messages from other instances
   */
  private subscribe() {
    const sub = this.redisPubSubService.sub;
    if (!sub) {
      this.logger.warn('Redis subscription not available for metadata cache sync');
      return;
    }

    // Only subscribe if not already subscribed
    if (this.messageHandler) {
      return;
    }

    // Create and store handler
    this.messageHandler = async (channel: string, message: string) => {
      if (channel === METADATA_CACHE_SYNC_EVENT_KEY) {
        try {
          const payload = JSON.parse(message);
          const myInstanceId = this.instanceService.getInstanceId();

          if (payload.instanceId === myInstanceId) {
            return;
          }

          this.logger.log(`📥 Received metadata cache sync from instance ${payload.instanceId.slice(0, 8)}...`);

          const metadata: EnfyraMetadata = {
            tables: new Map(Object.entries(payload.metadata.tables)),
            tablesList: payload.metadata.tablesList,
            version: payload.metadata.version,
            timestamp: new Date(payload.metadata.timestamp),
          };

          // Update in-memory cache immediately (no Redis write)
          this.inMemoryCache = metadata;

          this.logger.log(`✅ Metadata cache synced: ${metadata.tablesList.length} tables`);
        } catch (error) {
          this.logger.error('Failed to parse metadata cache sync message:', error);
        }
      }
    };

    // Subscribe via RedisPubSubService (prevents duplicates)
    this.redisPubSubService.subscribeWithHandler(
      METADATA_CACHE_SYNC_EVENT_KEY,
      this.messageHandler
    );
  }

  /**
   * Load metadata from actual database schema + metadata tables
   * This combines:
   * 1. Actual schema from INFORMATION_SCHEMA (physical structure)
   * 2. Metadata from table_definition, column_definition, relation_definition (logical structure)
   */
  private async loadMetadataFromDb(): Promise<EnfyraMetadata> {

    this.logger.log('🔄 Loading metadata from database schema + metadata tables...');

    // Get all table names from metadata
    const tablesResult = await this.queryBuilder.select({ tableName: 'table_definition' });
    const tables = tablesResult.data;

    const tablesList: any[] = [];
    const tablesMap = new Map<string, any>();

    for (const table of tables) {
      try {
        // Get actual schema from database
        const actualSchema = await this.databaseSchemaService.getActualTableSchema(table.name);

        if (!actualSchema) {
          this.logger.warn(`⚠️  Table ${table.name} not found in database, skipping...`);
          continue;
        }

        // Parse JSON fields from metadata
        let uniques = [];
        let indexes = [];
        if (table.uniques && typeof table.uniques === 'string') {
          try {
            uniques = JSON.parse(table.uniques);
          } catch (e) {
            this.logger.warn(`Failed to parse uniques for table ${table.name}`);
          }
        }
        if (table.indexes && typeof table.indexes === 'string') {
          try {
            indexes = JSON.parse(table.indexes);
          } catch (e) {
            this.logger.warn(`Failed to parse indexes for table ${table.name}`);
          }
        }

        // Get explicit columns from metadata
        const columnsResult = await this.queryBuilder.select({
          tableName: 'column_definition',
          filter: { tableId: { _eq: table.id } }
        });
        const explicitColumns = columnsResult.data;

        // Parse explicit columns
        const parsedExplicitColumns = explicitColumns.map((col: any) => {
          const column = { ...col };

          // Parse options (always try if string)
          if (col.options && typeof col.options === 'string') {
            try {
              column.options = JSON.parse(col.options);
            } catch (e) {
              // Keep as string if parse fails
            }
          }

          // Parse defaultValue (always try if string)
          if (col.defaultValue && typeof col.defaultValue === 'string') {
            try {
              column.defaultValue = JSON.parse(col.defaultValue);
            } catch (e) {
              // Keep as string if parse fails
            }
          }

          // Parse boolean fields (MySQL returns 1/0, convert to true/false)
          const booleanFields = ['isPrimary', 'isGenerated', 'isNullable', 'isSystem', 'isUpdatable', 'isHidden'];
          for (const field of booleanFields) {
            if (column[field] !== undefined && column[field] !== null) {
              column[field] = column[field] === 1 || column[field] === true;
            }
          }

          return column;
        });

        // Get relations from metadata
        const relationsResult = await this.queryBuilder.select({
          tableName: 'relation_definition',
          filter: { sourceTableId: { _eq: table.id } }
        });
        const relationsData = relationsResult.data;

        // Parse relations
        const relations: any[] = [];
        for (const rel of relationsData) {
          // Parse boolean fields for relation
          const relBooleanFields = ['isNullable', 'isSystem'];
          for (const field of relBooleanFields) {
            if (rel[field] !== undefined && rel[field] !== null) {
              rel[field] = rel[field] === 1 || rel[field] === true;
            }
          }

          // Get target table name
          const targetTableResult = await this.queryBuilder.select({
            tableName: 'table_definition',
            filter: { id: { _eq: rel.targetTableId } }
          });
          const targetTable = targetTableResult.data;

          const relationMetadata: any = {
            ...rel,
            sourceTableName: table.name,
            targetTableName: targetTable[0]?.name || rel.targetTableName,
          };

          // Mark inverse relations
          // O2M is ALWAYS inverse from this table's perspective (FK is on the other side)
          // M2M with mappedBy is inverse (the other side owns the relation)
          if (rel.type === 'one-to-many') {
            relationMetadata.isInverse = true;
          } else if (rel.type === 'many-to-many' && rel.mappedBy) {
            relationMetadata.isInverse = true;
          } else {
            relationMetadata.isInverse = false;
          }

          if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
            relationMetadata.foreignKeyColumn = getForeignKeyColumnName(rel.propertyName);
          }

          if (rel.type === 'one-to-many') {
            // For O2M, FK is on the target table
            // O2M naming convention: FK column = {inversePropertyName}Id
            if (!rel.inversePropertyName) {
              this.logger.error(`❌ O2M relation '${rel.propertyName}' in table '${table.name}' missing inversePropertyName`);
              throw new Error(`One-to-many relation '${rel.propertyName}' in table '${table.name}' MUST have inversePropertyName`);
            }

            relationMetadata.foreignKeyColumn = getForeignKeyColumnName(rel.inversePropertyName);
          }

          if (rel.type === 'many-to-many') {
            // Ensure junction metadata is complete
            relationMetadata.junctionTableName = rel.junctionTableName || getJunctionTableName(table.name, rel.propertyName, relationMetadata.targetTableName);
            const { sourceColumn, targetColumn } = getJunctionColumnNames(table.name, rel.propertyName, relationMetadata.targetTableName);
            relationMetadata.junctionSourceColumn = rel.junctionSourceColumn || sourceColumn;
            relationMetadata.junctionTargetColumn = rel.junctionTargetColumn || targetColumn;
          }

          relations.push(relationMetadata);
        }

        // Combine actual schema columns with explicit metadata columns
        // Priority: explicit metadata columns > actual schema columns
        const combinedColumns = [...parsedExplicitColumns];
        
        // Add FK columns from relations (if not already in explicit columns)
        for (const rel of relations) {
          if (['many-to-one', 'one-to-one'].includes(rel.type)) {
            const fkColumn = rel.foreignKeyColumn;
            const existsInExplicit = parsedExplicitColumns.some(col => col.name === fkColumn);
            
            if (!existsInExplicit) {
              // Find FK column in actual schema
              const actualFkColumn = actualSchema.columns.find(col => col.name === fkColumn);
              if (actualFkColumn) {
                combinedColumns.push({
                  ...actualFkColumn,
                  isForeignKey: true,
                  relationPropertyName: rel.propertyName,
                  description: `FK column for ${rel.propertyName} relation`
                });
              }
            }
          }
        }

        // Add system columns (createdAt, updatedAt) if not present
        const hasCreatedAt = combinedColumns.some(col => col.name === 'createdAt');
        const hasUpdatedAt = combinedColumns.some(col => col.name === 'updatedAt');
        
        if (!hasCreatedAt) {
          const actualCreatedAt = actualSchema.columns.find(col => col.name === 'createdAt');
          if (actualCreatedAt) {
            combinedColumns.push({
              ...actualCreatedAt,
              isSystem: true,
              isUpdatable: false
            });
          }
        }
        
        if (!hasUpdatedAt) {
          const actualUpdatedAt = actualSchema.columns.find(col => col.name === 'updatedAt');
          if (actualUpdatedAt) {
            combinedColumns.push({
              ...actualUpdatedAt,
              isSystem: true,
              isUpdatable: false
            });
          }
        }

        // Parse boolean fields for table (MySQL returns 1/0, convert to true/false)
        const tableData = { ...table };
        if (tableData.isSystem !== undefined && tableData.isSystem !== null) {
          tableData.isSystem = tableData.isSystem === 1 || tableData.isSystem === true;
        }

        // Combine metadata with actual schema
        const metadata: any = {
          ...tableData,
          uniques: uniques.length > 0 ? uniques : actualSchema.uniques,
          indexes: indexes.length > 0 ? indexes : actualSchema.indexes,
          columns: combinedColumns,
          relations,
        };

        tablesList.push(metadata);
        tablesMap.set(table.name, metadata);

      } catch (error) {
        this.logger.error(`Failed to load metadata for table ${table.name}:`, error.message);
      }
    }

    // Generate inverse relations (for consistency)
    this.generateInverseRelations(tablesList, tablesMap);

    const result = {
      tables: tablesMap,
      tablesList,
      version: Date.now(),
      timestamp: new Date(),
    };

    this.logger.log(`✅ Loaded metadata for ${tablesList.length} tables from database schema`);
    return result;
  }

  /**
   * Generate inverse relations for consistency
   */
  private generateInverseRelations(tablesList: any[], tablesMap: Map<string, any>): void {
    for (const table of tablesList) {
      for (const relation of table.relations || []) {
        // Only process relations with inversePropertyName
        if (!relation.inversePropertyName) {
          continue;
        }

        const targetTableName = relation.targetTableName || relation.targetTable;
        const targetTable = tablesMap.get(targetTableName);

        if (!targetTable) {
          continue;
        }

        // Check if inverse relation already exists
        const inverseExists = targetTable.relations?.some(
          (r: any) => r.propertyName === relation.inversePropertyName
        );

        if (inverseExists) {
          continue;
        }

        // Generate inverse relation
        let inverseType = 'one-to-many';
        if (relation.type === 'one-to-many') {
          inverseType = 'many-to-one';
        } else if (relation.type === 'many-to-one') {
          inverseType = 'one-to-many';
        } else if (relation.type === 'one-to-one') {
          inverseType = 'one-to-one';
        } else if (relation.type === 'many-to-many') {
          inverseType = 'many-to-many';
        }

        const inverseRelation: any = {
          propertyName: relation.inversePropertyName,
          type: inverseType,
          targetTable: table.name,
          targetTableName: table.name,
          sourceTableName: targetTableName,
          inversePropertyName: relation.propertyName,
          isNullable: true,
          isSystem: relation.isSystem || false,
          isGenerated: true, // Mark as auto-generated
          isInverse: true, // Mark as inverse relation
        };

        // Add foreign key column for M2O
        if (inverseType === 'many-to-one') {
          inverseRelation.foreignKeyColumn = relation.foreignKeyColumn || getForeignKeyColumnName(relation.inversePropertyName);
        }

        // Add foreign key column for O2M
        if (inverseType === 'one-to-many') {
          inverseRelation.foreignKeyColumn = getForeignKeyColumnName(relation.propertyName);
        }

        // Add junction table info for M2M
        if (inverseType === 'many-to-many') {
          inverseRelation.junctionTableName = relation.junctionTableName;
          inverseRelation.junctionSourceColumn = relation.junctionTargetColumn;
          inverseRelation.junctionTargetColumn = relation.junctionSourceColumn;
        }

        // Add inverse relation to target table
        if (!targetTable.relations) {
          targetTable.relations = [];
        }
        targetTable.relations.push(inverseRelation);
      }
    }
  }

  /**
   * Get metadata from in-memory cache
   * Loads from DB on first call
   */
  async getMetadata(): Promise<EnfyraMetadata> {
    // Return from in-memory cache if available (instant)
    if (this.inMemoryCache) {
      return this.inMemoryCache;
    }

    // If not in cache, load from DB
    this.logger.log('📦 Metadata not in memory cache, loading from DB...');
    return await this.loadAndCacheMetadata();
  }

  /**
   * Load metadata from DB and store in memory only
   */
  private async loadAndCacheMetadata(): Promise<EnfyraMetadata> {

    const loadStart = Date.now();
    const metadata = await this.loadMetadataFromDb();
    const loadTime = Date.now() - loadStart;

    this.logger.log(
      `📦 Loaded ${metadata.tablesList.length} tables from DB in ${loadTime}ms`,
    );

    // Store in memory only (no Redis)
    this.inMemoryCache = metadata;

    return metadata;
  }

  /**
   * Reload metadata from DB (acquire lock → load → publish → save)
   */
  async reload(): Promise<void> {
    this.logger.log('🔄 reload() called');
    const instanceId = this.instanceService.getInstanceId();
    this.logger.log(`🆔 Instance ID: ${instanceId.slice(0, 8)}`);

    try {
      this.logger.log('🔐 Attempting to acquire metadata reload lock...');
      const acquired = await this.cacheService.acquire(
        METADATA_RELOAD_LOCK_KEY,
        instanceId,
        REDIS_TTL.RELOAD_LOCK_TTL
      );

      this.logger.log(`🔐 Lock acquired: ${acquired}`);

      if (!acquired) {
        this.logger.log('🔒 Another instance is reloading metadata, waiting for broadcast...');
        return;
      }

      this.logger.log(`🔓 Acquired metadata reload lock (instance ${instanceId.slice(0, 8)})`);

      try {
        // Load from DB
        const metadata = await this.loadMetadataFromDb();
        this.logger.log(`✅ Metadata loaded from DB - ${metadata.tablesList.length} tables`);

        // Broadcast to other instances FIRST
        await this.publish(metadata);

        // Then save to local memory cache
        this.inMemoryCache = metadata;
      } finally {
        await this.cacheService.release(METADATA_RELOAD_LOCK_KEY, instanceId);
        this.logger.log('🔓 Released metadata reload lock');
      }
    } catch (error) {
      this.logger.error('❌ Failed to reload metadata cache:', error);
      throw error;
    }
  }

  /**
   * Publish metadata to other instances via Redis PubSub
   */
  private async publish(metadata: EnfyraMetadata): Promise<void> {
    try {
      const payload = {
        instanceId: this.instanceService.getInstanceId(),
        metadata: {
          tables: Object.fromEntries(metadata.tables),
          tablesList: metadata.tablesList,
          version: metadata.version,
          timestamp: metadata.timestamp,
        },
        timestamp: Date.now(),
      };

      await this.redisPubSubService.publish(
        METADATA_CACHE_SYNC_EVENT_KEY,
        JSON.stringify(payload),
      );

      this.logger.log(`📤 Published metadata cache to other instances (${metadata.tablesList.length} tables)`);
    } catch (error) {
      this.logger.error('Failed to publish metadata cache sync:', error);
    }
  }

  /**
   * Get metadata for a specific table
   */
  async getTableMetadata(tableName: string): Promise<any | null> {
    const metadata = await this.getMetadata();
    return metadata.tables.get(tableName) || null;
  }

  /**
   * Get all tables metadata
   */
  async getAllTablesMetadata(): Promise<any[]> {
    const metadata = await this.getMetadata();
    return metadata.tablesList;
  }

  /**
   * Lookup table metadata by table name
   * Alias for getTableMetadata() for backward compatibility
   */
  async lookupTableByName(tableName: string): Promise<any | null> {
    return this.getTableMetadata(tableName);
  }

  /**
   * Lookup table metadata by table ID
   */
  async lookupTableById(tableId: number | string): Promise<any | null> {
    const metadata = await this.getMetadata();
    const table = metadata.tablesList.find(t => t.id === tableId || t.id === Number(tableId));
    return table || null;
  }

  /**
   * Clear in-memory metadata cache
   */
  async clearMetadataCache(): Promise<void> {
    this.inMemoryCache = null;
    this.logger.log('🗑️ In-memory metadata cache cleared');
  }
}