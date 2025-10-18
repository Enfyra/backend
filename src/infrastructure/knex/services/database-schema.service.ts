import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { KnexService } from '../knex.service';
import { MetadataCacheService } from '../../cache/services/metadata-cache.service';

/**
 * Service to extract actual database schema from INFORMATION_SCHEMA
 * Supports both MySQL and PostgreSQL
 */
@Injectable()
export class DatabaseSchemaService {
  private readonly logger = new Logger(DatabaseSchemaService.name);

  constructor(private readonly knexService: KnexService) {}

  /**
   * Get actual database schema for a table
   */
  async getActualTableSchema(tableName: string): Promise<any> {
    const knex = this.knexService.getKnex();
    const dbType = process.env.DB_TYPE || 'mysql';

    if (dbType === 'mysql') {
      return await this.getMySQLTableSchema(tableName, knex);
    } else if (dbType === 'postgres') {
      return await this.getPostgreSQLTableSchema(tableName, knex);
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  }

  /**
   * Get MySQL table schema from INFORMATION_SCHEMA
   */
  private async getMySQLTableSchema(tableName: string, knex: any): Promise<any> {
    // Get table info
    const tableInfo = await knex('INFORMATION_SCHEMA.TABLES')
      .select('TABLE_NAME', 'TABLE_COMMENT')
      .where('TABLE_SCHEMA', knex.client.database())
      .where('TABLE_NAME', tableName)
      .first();

    if (!tableInfo) {
      return null;
    }

    // Get columns
    const columns = await knex('INFORMATION_SCHEMA.COLUMNS')
      .select([
        'COLUMN_NAME as name',
        'DATA_TYPE as type',
        'IS_NULLABLE as isNullable',
        'COLUMN_DEFAULT as defaultValue',
        'COLUMN_KEY as columnKey',
        'EXTRA as extra',
        'COLUMN_COMMENT as description',
        'CHARACTER_MAXIMUM_LENGTH as maxLength',
        'NUMERIC_PRECISION as precision',
        'NUMERIC_SCALE as scale'
      ])
      .where('TABLE_SCHEMA', knex.client.database())
      .where('TABLE_NAME', tableName)
      .orderBy('ORDINAL_POSITION');

    // Transform columns to match our metadata format
    const transformedColumns = columns.map(col => ({
      name: col.name,
      type: this.mapMySQLDataType(col.type, col),
      isPrimary: col.columnKey === 'PRI',
      isGenerated: col.extra?.includes('auto_increment') || false,
      isNullable: col.isNullable === 'YES',
      isSystem: this.isSystemColumn(col.name),
      isUpdatable: !col.extra?.includes('auto_increment'),
      isHidden: false,
      defaultValue: col.defaultValue,
      description: col.description,
      // MySQL specific options
      options: {
        length: col.maxLength,
        precision: col.precision,
        scale: col.scale
      }
    }));

    // Get indexes
    const indexes = await knex('INFORMATION_SCHEMA.STATISTICS')
      .select('INDEX_NAME', 'COLUMN_NAME', 'NON_UNIQUE')
      .where('TABLE_SCHEMA', knex.client.database())
      .where('TABLE_NAME', tableName)
      .where('INDEX_NAME', '!=', 'PRIMARY')
      .orderBy('INDEX_NAME', 'SEQ_IN_INDEX');

    // Group indexes
    const indexGroups = this.groupMySQLIndexes(indexes);

    // Get foreign keys
    const foreignKeys = await knex('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')
      .select([
        'COLUMN_NAME',
        'REFERENCED_TABLE_NAME',
        'REFERENCED_COLUMN_NAME',
        'CONSTRAINT_NAME'
      ])
      .where('TABLE_SCHEMA', knex.client.database())
      .where('TABLE_NAME', tableName)
      .whereNotNull('REFERENCED_TABLE_NAME');

    // Transform foreign keys to relations
    const relations = this.transformForeignKeysToRelations(foreignKeys);

    return {
      name: tableName,
      isSystem: false,
      uniques: indexGroups.uniques,
      indexes: indexGroups.indexes,
      columns: transformedColumns,
      relations
    };
  }

  /**
   * Get PostgreSQL table schema from INFORMATION_SCHEMA
   */
  private async getPostgreSQLTableSchema(tableName: string, knex: any): Promise<any> {
    // Get table info
    // Note: PostgreSQL doesn't have TABLE_COMMENT in information_schema.tables like MySQL
    // Table comments in PostgreSQL are stored in pg_description catalog, not information_schema
    const tableInfo = await knex('information_schema.tables')
      .select('table_name')
      .where('table_schema', 'public')
      .where('table_name', tableName)
      .first();

    if (!tableInfo) {
      return null;
    }

    // Get columns
    const columns = await knex('information_schema.columns')
      .select([
        'column_name as name',
        'data_type as type',
        'is_nullable as isNullable',
        'column_default as defaultValue',
        'character_maximum_length as maxLength',
        'numeric_precision as precision',
        'numeric_scale as scale'
      ])
      .where('table_schema', 'public')
      .where('table_name', tableName)
      .orderBy('ordinal_position');

    // Transform columns to match our metadata format
    const transformedColumns = columns.map(col => ({
      name: col.name,
      type: this.mapPostgreSQLDataType(col.type, col),
      isPrimary: false, // Will be determined separately
      isGenerated: col.defaultValue?.includes('nextval') || false,
      isNullable: col.isNullable === 'YES',
      isSystem: this.isSystemColumn(col.name),
      isUpdatable: true,
      isHidden: false,
      defaultValue: col.defaultValue,
      description: null,
      options: {
        length: col.maxLength,
        precision: col.precision,
        scale: col.scale
      }
    }));

    // Get primary key
    const primaryKeys = await knex('information_schema.table_constraints')
      .join('information_schema.key_column_usage', function() {
        this.on('table_constraints.constraint_name', '=', 'key_column_usage.constraint_name')
          .andOn('table_constraints.table_schema', '=', 'key_column_usage.table_schema');
      })
      .select('key_column_usage.column_name')
      .where('table_constraints.table_schema', 'public')
      .where('table_constraints.table_name', tableName)
      .where('table_constraints.constraint_type', 'PRIMARY KEY');

    // Mark primary key columns
    primaryKeys.forEach(pk => {
      const col = transformedColumns.find(c => c.name === pk.column_name);
      if (col) {
        col.isPrimary = true;
      }
    });

    // Get indexes (simplified for PostgreSQL)
    const indexes = await knex('pg_indexes')
      .select('indexname', 'indexdef')
      .where('tablename', tableName)
      .where('schemaname', 'public');

    return {
      name: tableName,
      isSystem: false,
      uniques: [], // TODO: Extract from constraints
      indexes: [], // TODO: Parse index definitions
      columns: transformedColumns,
      relations: [] // TODO: Extract foreign keys
    };
  }

  /**
   * Map MySQL data types to our standard types
   */
  private mapMySQLDataType(mysqlType: string, col: any): string {
    const type = mysqlType.toLowerCase();
    
    if (type.includes('int')) return 'int';
    if (type.includes('bigint')) return 'bigint';
    if (type.includes('varchar') || type.includes('char')) return 'varchar';
    if (type.includes('text')) return 'text';
    if (type.includes('longtext')) return 'longtext';
    if (type.includes('decimal') || type.includes('numeric')) return 'decimal';
    if (type.includes('datetime') || type.includes('timestamp')) return 'datetime';
    if (type.includes('date')) return 'date';
    if (type.includes('json')) return 'json';
    if (type.includes('enum')) return 'enum';
    if (type.includes('boolean') || type.includes('tinyint(1)')) return 'boolean';
    
    return 'varchar'; // Default fallback
  }

  /**
   * Map PostgreSQL data types to our standard types
   */
  private mapPostgreSQLDataType(pgType: string, col: any): string {
    const type = pgType.toLowerCase();
    
    if (type.includes('integer') || type.includes('int4')) return 'int';
    if (type.includes('bigint') || type.includes('int8')) return 'bigint';
    if (type.includes('varchar') || type.includes('character varying')) return 'varchar';
    if (type.includes('text')) return 'text';
    if (type.includes('numeric') || type.includes('decimal')) return 'decimal';
    if (type.includes('timestamp')) return 'datetime';
    if (type.includes('date')) return 'date';
    if (type.includes('json') || type.includes('jsonb')) return 'json';
    if (type.includes('boolean') || type.includes('bool')) return 'boolean';
    if (type.includes('uuid')) return 'uuid';
    
    return 'varchar'; // Default fallback
  }

  /**
   * Group MySQL indexes into unique and regular indexes
   */
  private groupMySQLIndexes(indexes: any[]): { uniques: string[][], indexes: string[][] } {
    const indexMap = new Map<string, string[]>();
    const uniqueMap = new Map<string, string[]>();

    indexes.forEach(idx => {
      if (idx.NON_UNIQUE === 0) {
        // Unique index
        if (!uniqueMap.has(idx.INDEX_NAME)) {
          uniqueMap.set(idx.INDEX_NAME, []);
        }
        uniqueMap.get(idx.INDEX_NAME)!.push(idx.COLUMN_NAME);
      } else {
        // Regular index
        if (!indexMap.has(idx.INDEX_NAME)) {
          indexMap.set(idx.INDEX_NAME, []);
        }
        indexMap.get(idx.INDEX_NAME)!.push(idx.COLUMN_NAME);
      }
    });

    return {
      uniques: Array.from(uniqueMap.values()),
      indexes: Array.from(indexMap.values())
    };
  }

  /**
   * Transform foreign keys to relations format
   */
  private transformForeignKeysToRelations(foreignKeys: any[]): any[] {
    const relations: any[] = [];
    const fkMap = new Map<string, any>();

    foreignKeys.forEach(fk => {
      const key = fk.COLUMN_NAME;
      if (!fkMap.has(key)) {
        fkMap.set(key, {
          propertyName: this.getPropertyNameFromColumn(fk.COLUMN_NAME),
          type: 'many-to-one',
          targetTable: fk.REFERENCED_TABLE_NAME,
          isNullable: true,
          isSystem: false,
          foreignKeyColumn: fk.COLUMN_NAME
        });
      }
    });

    return Array.from(fkMap.values());
  }

  /**
   * Get property name from FK column name
   */
  private getPropertyNameFromColumn(columnName: string): string {
    // Remove common FK suffixes
    const suffixes = ['Id', '_id', 'ID'];
    let propertyName = columnName;
    
    for (const suffix of suffixes) {
      if (propertyName.endsWith(suffix)) {
        propertyName = propertyName.slice(0, -suffix.length);
        break;
      }
    }
    
    return propertyName;
  }

  /**
   * Check if column is a system column
   */
  private isSystemColumn(columnName: string): boolean {
    const systemColumns = ['id', 'createdAt', 'updatedAt'];
    return systemColumns.includes(columnName);
  }
}
