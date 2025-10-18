import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Knex, knex } from 'knex';
import {
  getJunctionTableName,
  getForeignKeyColumnName,
  getShortFkName,
  getShortIndexName,
  getShortPkName,
  getShortFkConstraintName,
} from '../src/shared/utils/naming-helpers';
import {
  ColumnDef,
  RelationDef,
  TableDef,
  JunctionTableDef,
  KnexTableSchema,
} from '../src/shared/types/database-init.types';

dotenv.config();

// ==================== NAMING CONVENTIONS ====================
// Now using helpers from ./utils/naming-helpers

// ==================== PARSE SNAPSHOT ====================

/**
 * Parse snapshot.json and detect junction tables for many-to-many relations
 * Also auto-generate inverse relations based on inversePropertyName
 */
function parseSnapshotToSchema(snapshot: Record<string, any>): KnexTableSchema[] {
  const schemas: KnexTableSchema[] = [];
  const inverseRelationsToAdd: Array<{ tableName: string; relation: any }> = [];

  // First pass: Parse tables and detect inverse relations
  for (const [tableName, def] of Object.entries(snapshot)) {
    const tableDef = def as TableDef;

    // Detect inverse relations that need to be added
    if (tableDef.relations) {
      for (const relation of tableDef.relations) {
        if (relation.inversePropertyName) {
          // Determine inverse relation type
          let inverseType = relation.type;
          if (relation.type === 'many-to-one') {
            inverseType = 'one-to-many';
          } else if (relation.type === 'one-to-many') {
            inverseType = 'many-to-one';
          }
          // one-to-one and many-to-many stay the same

          // Add inverse relation to target table
          inverseRelationsToAdd.push({
            tableName: relation.targetTable,
            relation: {
              propertyName: relation.inversePropertyName,
              type: inverseType,
              targetTable: tableName,
              inversePropertyName: relation.propertyName,
              isSystem: relation.isSystem,
              isNullable: relation.isNullable,
              _isInverseGenerated: true, // Mark as inverse to skip junction table creation
            },
          });
        }
      }
    }

    schemas.push({
      tableName,
      definition: { ...tableDef },
      junctionTables: [],
    });
  }

  // Add inverse relations to schemas
  for (const { tableName, relation } of inverseRelationsToAdd) {
    const schema = schemas.find((s) => s.tableName === tableName);
    if (schema) {
      if (!schema.definition.relations) {
        schema.definition.relations = [];
      }
      // Check if relation already exists (avoid duplicates)
      const exists = schema.definition.relations.some(
        (r) => r.propertyName === relation.propertyName,
      );
      if (!exists) {
        schema.definition.relations.push(relation);
      }
    }
  }

  // Second pass: Detect junction tables for many-to-many relations
  // Only create from original relation (not inverse) to avoid duplicates
  const createdJunctionNames = new Set<string>();
  
  for (const schema of schemas) {
    const { tableName, definition } = schema;
    const junctionTables: JunctionTableDef[] = [];

    if (definition.relations) {
      for (const relation of definition.relations) {
        // Skip auto-generated inverse relations (junction already created from original side)
        if ((relation as any)._isInverseGenerated) {
          continue;
        }

        if (relation.type === 'many-to-many') {
          const junctionTableName = getJunctionTableName(
            tableName,
            relation.propertyName,
            relation.targetTable,
          );

          // Also check reverse junction table name (in case inverse relation exists)
          const reverseJunctionName = getJunctionTableName(
            relation.targetTable,
            relation.inversePropertyName || 'inverse',
            tableName,
          );

          // Skip if this junction table was already added (either direction)
          if (createdJunctionNames.has(junctionTableName) || createdJunctionNames.has(reverseJunctionName)) {
            continue;
          }

          junctionTables.push({
            tableName: junctionTableName,
            sourceTable: tableName,
            targetTable: relation.targetTable,
            sourceColumn: getForeignKeyColumnName(tableName),
            targetColumn: getForeignKeyColumnName(relation.targetTable),
            sourcePropertyName: relation.propertyName,
          });

          // Add both directions to prevent duplicates
          createdJunctionNames.add(junctionTableName);
          createdJunctionNames.add(reverseJunctionName);
        }
      }
    }

    schema.junctionTables = junctionTables;
  }

  return schemas;
}

// ==================== TYPE MAPPING ====================

/**
 * Map snapshot column types to Knex column types
 */
function getKnexColumnType(columnDef: ColumnDef): string {
  const typeMap: Record<string, string> = {
    int: 'integer',
    integer: 'integer',
    bigint: 'bigInteger',
    smallint: 'smallint',
    uuid: 'uuid',
    varchar: 'string',
    text: 'text',
    boolean: 'boolean',
    bool: 'boolean',
    date: 'timestamp',
    datetime: 'datetime',
    timestamp: 'timestamp',
    'simple-json': 'json',
    richtext: 'text',
    code: 'text',
    'array-select': 'json',
    enum: 'enum',
  };

  return typeMap[columnDef.type] || 'text';
}

// ==================== TABLE CREATION ====================

/**
 * Get primary key type for a table
 */
function getPrimaryKeyType(schemas: KnexTableSchema[], tableName: string): 'uuid' | 'integer' {
  const schema = schemas.find(s => s.tableName === tableName);
  if (!schema) return 'integer';
  
  const pkColumn = schema.definition.columns.find(c => c.isPrimary);
  if (!pkColumn) return 'integer';
  
  return pkColumn.type === 'uuid' ? 'uuid' : 'integer';
}

/**
 * Create a single table with Knex
 */
async function createTable(
  knex: Knex,
  schema: KnexTableSchema,
  dbType: string,
  schemas: KnexTableSchema[],
): Promise<void> {
  const { tableName, definition } = schema;

  console.log(`📝 Creating table: ${tableName}`);

  await knex.schema.createTable(tableName, (table) => {
    // Create columns
    for (const col of definition.columns) {
      let column: Knex.ColumnBuilder;

      const knexType = getKnexColumnType(col);

      // Primary key
      if (col.isPrimary && col.isGenerated) {
        if (col.type === 'uuid') {
          // PostgreSQL can use gen_random_uuid() as default
          // MySQL doesn't support UUID default - will be generated by app
          if (dbType === 'postgres') {
            column = table.uuid(col.name).primary().defaultTo(knex.raw('gen_random_uuid()'));
          } else {
            // MySQL: just create UUID column, app will generate
            column = table.uuid(col.name).primary();
          }
        } else {
          column = table.increments(col.name).primary();
        }
      }
      // Enum type
      else if (col.type === 'enum' && Array.isArray(col.options)) {
        column = table.enum(col.name, col.options);
      }
      // Regular columns
      else {
        switch (knexType) {
          case 'integer':
            column = table.integer(col.name);
            break;
          case 'bigInteger':
            column = table.bigInteger(col.name);
            break;
          case 'smallint':
            column = table.integer(col.name); // Knex uses integer for smallint
            break;
          case 'string':
            column = table.string(col.name, 255);
            break;
          case 'text':
            column = table.text(col.name);
            break;
          case 'boolean':
            column = table.boolean(col.name);
            break;
          case 'uuid':
            column = table.uuid(col.name);
            break;
          case 'timestamp':
            column = table.timestamp(col.name);
            break;
          case 'datetime':
            column = table.datetime(col.name);
            break;
          case 'json':
            column = table.json(col.name);
            break;
          default:
            column = table.text(col.name);
        }
      }

      // Nullable
      if (col.isNullable === false) {
        column.notNullable();
      } else {
        column.nullable();
      }

      // Default value
      if (col.defaultValue !== undefined && col.defaultValue !== null) {
        if (typeof col.defaultValue === 'string' && col.defaultValue.toLowerCase() === 'now') {
          column.defaultTo(knex.fn.now());
        } else {
          column.defaultTo(col.defaultValue);
        }
      }

      // Unique
      if (col.isUnique) {
        column.unique();
      }

      // Comment
      if (col.description) {
        column.comment(col.description);
      }
    }

    // Add foreign key columns from relations
    if (definition.relations) {
      for (const relation of definition.relations) {
        // Skip many-to-many (handled by junction tables)
        // Skip one-to-many (no FK on parent table)
        if (relation.type === 'many-to-many' || relation.type === 'one-to-many') {
          continue;
        }

        // Add FK column for many-to-one and one-to-one
        // Use propertyName to avoid conflicts when multiple FKs to same table
        const foreignKeyColumn = getForeignKeyColumnName(relation.propertyName);
        
        // Detect PK type of target table
        const targetPkType = getPrimaryKeyType(schemas, relation.targetTable);
        
        let col;
        if (targetPkType === 'uuid') {
          col = table.string(foreignKeyColumn, 36);
        } else {
          col = table.integer(foreignKeyColumn).unsigned();
        }
        
        if (relation.isNullable === false) {
          col.notNullable();
        } else {
          col.nullable();
        }

        // Note: Foreign key constraints will be added later in addForeignKeys()
        // This just creates the column
      }
    }

    // Add createdAt and updatedAt timestamps
    // MySQL and PostgreSQL both support CURRENT_TIMESTAMP
    if (dbType === 'postgres') {
      table.timestamp('createdAt', { useTz: true }).defaultTo(knex.fn.now());
      table.timestamp('updatedAt', { useTz: true }).defaultTo(knex.fn.now());
    } else {
      table.timestamp('createdAt').defaultTo(knex.fn.now());
      table.timestamp('updatedAt').defaultTo(knex.fn.now());
    }

    // Create composite unique constraints
    if (definition.uniques && definition.uniques.length > 0) {
      for (const uniqueGroup of definition.uniques) {
        if (Array.isArray(uniqueGroup) && uniqueGroup.length > 0) {
          // Convert relation names to foreign key column names
          const columnNames = uniqueGroup.map((fieldName) => {
            // Check if it's a relation
            const relation = definition.relations?.find(r => r.propertyName === fieldName);
            if (relation) {
              // It's a relation - use FK column name based on propertyName
              return getForeignKeyColumnName(relation.propertyName);
            }
            // It's a regular column
            return fieldName;
          });
          table.unique(columnNames);
        }
      }
    }

    // Create indexes
    if (definition.indexes && definition.indexes.length > 0) {
      for (const indexGroup of definition.indexes) {
        if (Array.isArray(indexGroup) && indexGroup.length > 0) {
          // Convert relation names to foreign key column names
          const columnNames = indexGroup.map((fieldName) => {
            // Check if it's a relation
            const relation = definition.relations?.find(r => r.propertyName === fieldName);
            if (relation) {
              // It's a relation - use FK column name based on propertyName
              return getForeignKeyColumnName(relation.propertyName);
            }
            // It's a regular column
            return fieldName;
          });
          table.index(columnNames);
        }
      }
    }
  });

  console.log(`✅ Created table: ${tableName}`);
}

/**
 * Add foreign key constraints for relations
 */
async function addForeignKeys(
  knex: Knex,
  schemas: KnexTableSchema[],
): Promise<void> {
  console.log('🔗 Adding foreign key constraints...');

  for (const schema of schemas) {
    const { tableName, definition } = schema;

    if (!definition.relations || definition.relations.length === 0) {
      continue;
    }

    for (const relation of definition.relations) {
      // Skip many-to-many (handled by junction tables)
      // Skip one-to-many (no FK on parent table)
      if (relation.type === 'many-to-many' || relation.type === 'one-to-many') {
        continue;
      }

      // Add FK for many-to-one and one-to-one
      // Use propertyName to match the column name we created
      const foreignKeyColumn = getForeignKeyColumnName(relation.propertyName);
      const targetTable = relation.targetTable;

      console.log(
        `  Adding FK: ${tableName}.${foreignKeyColumn} → ${targetTable}.id`,
      );

      try {
        await knex.schema.alterTable(tableName, (table) => {
          // Add foreign key constraint (column already exists from createTable)
          const fk = table
            .foreign(foreignKeyColumn)
            .references('id')
            .inTable(targetTable);

          // Set cascade behavior
          if (relation.isNullable === false) {
            fk.onDelete('RESTRICT').onUpdate('CASCADE');
          } else {
            fk.onDelete('SET NULL').onUpdate('CASCADE');
          }

          // Add index on foreign key
          table.index([foreignKeyColumn]);
        });
      } catch (error) {
        // FK constraint might already exist, skip
        console.log(`  ⚠️ FK constraint already exists: ${tableName}.${foreignKeyColumn}`);
      }
    }
  }

  console.log('✅ Foreign keys added');
}

/**
 * Create junction tables for many-to-many relations
 */
async function createJunctionTables(
  knex: Knex,
  schemas: KnexTableSchema[],
  dbType: string,
): Promise<void> {
  console.log('🔗 Creating junction tables...');

  const createdJunctions = new Set<string>();

  for (const schema of schemas) {
    for (const junction of schema.junctionTables) {
      // Avoid duplicate junction tables
      if (createdJunctions.has(junction.tableName)) {
        continue;
      }

      // Check if junction table already exists
      const exists = await knex.schema.hasTable(junction.tableName);
      if (exists) {
        console.log(`⏩ Junction table already exists: ${junction.tableName}`);
        createdJunctions.add(junction.tableName);
        continue;
      }

      console.log(`📝 Creating junction table: ${junction.tableName}`);

      // Detect PK types for both source and target tables
      const sourcePkType = getPrimaryKeyType(schemas, junction.sourceTable);
      const targetPkType = getPrimaryKeyType(schemas, junction.targetTable);

      await knex.schema.createTable(junction.tableName, (table) => {
        // Add source FK with correct type
        let sourceCol;
        if (sourcePkType === 'uuid') {
          sourceCol = table.uuid(junction.sourceColumn).notNullable();
        } else {
          sourceCol = table.integer(junction.sourceColumn).unsigned().notNullable();
        }

        const sourceFk = sourceCol
          .references('id')
          .inTable(junction.sourceTable)
          .onDelete('CASCADE')
          .onUpdate('CASCADE');

        // Set FK constraint name (use short name for PostgreSQL due to 63 char limit)
        if (dbType === 'postgres') {
          const sourceFkName = getShortFkConstraintName(junction.tableName, junction.sourceColumn, 'src');
          sourceFk.withKeyName(sourceFkName);
        } else {
          const sourceFkName = getShortFkName(junction.sourceTable, junction.sourcePropertyName, 'src');
          sourceFk.withKeyName(sourceFkName);
        }

        // Add target FK with correct type
        let targetCol;
        if (targetPkType === 'uuid') {
          targetCol = table.uuid(junction.targetColumn).notNullable();
        } else {
          targetCol = table.integer(junction.targetColumn).unsigned().notNullable();
        }

        const targetFk = targetCol
          .references('id')
          .inTable(junction.targetTable)
          .onDelete('CASCADE')
          .onUpdate('CASCADE');

        // Set FK constraint name (use short name for PostgreSQL due to 63 char limit)
        if (dbType === 'postgres') {
          const targetFkName = getShortFkConstraintName(junction.tableName, junction.targetColumn, 'tgt');
          targetFk.withKeyName(targetFkName);
        } else {
          const targetFkName = getShortFkName(junction.sourceTable, junction.sourcePropertyName, 'tgt');
          targetFk.withKeyName(targetFkName);
        }

        // Composite primary key
        // Use deterministic short name for constraint (especially for PostgreSQL 63 char limit)
        const pkName = getShortPkName(junction.tableName);
        table.primary([junction.sourceColumn, junction.targetColumn], pkName);

        // Auto-index both FK columns with short names
        // PostgreSQL automatically creates indexes for PRIMARY KEY columns, so skip for postgres
        if (dbType !== 'postgres') {
          const sourceIndexName = getShortIndexName(junction.sourceTable, junction.sourcePropertyName, 'src');
          const targetIndexName = getShortIndexName(junction.sourceTable, junction.sourcePropertyName, 'tgt');
          table.index([junction.sourceColumn], sourceIndexName);
          table.index([junction.targetColumn], targetIndexName);
        }
      });

      console.log(`✅ Created junction table: ${junction.tableName}`);
      createdJunctions.add(junction.tableName);
    }
  }

  console.log('✅ Junction tables created');
}

/**
 * Create all tables in correct dependency order
 */
async function createAllTables(
  knex: Knex,
  schemas: KnexTableSchema[],
  dbType: string,
): Promise<void> {
  console.log('🚀 Creating all tables...');

  // Phase 1: Create all tables (without FKs)
  for (const schema of schemas) {
    const exists = await knex.schema.hasTable(schema.tableName);
    if (!exists) {
      await createTable(knex, schema, dbType, schemas);
    } else {
      console.log(`⏩ Table already exists: ${schema.tableName}`);
    }
  }

  // Phase 2: Add foreign key constraints
  await addForeignKeys(knex, schemas);

  // Phase 3: Create junction tables
  await createJunctionTables(knex, schemas, dbType);

  console.log('✅ All tables created successfully!');
}

// ==================== MAIN INIT FUNCTION ====================

async function ensureDatabaseExists(): Promise<void> {
  const DB_TYPE = process.env.DB_TYPE || 'mysql';
  const DB_HOST = process.env.DB_HOST || 'localhost';
  const DB_PORT =
    Number(process.env.DB_PORT) || (DB_TYPE === 'postgres' ? 5432 : 3306);
  const DB_USERNAME = process.env.DB_USERNAME || 'root';
  const DB_PASSWORD = process.env.DB_PASSWORD || '';
  const DB_NAME = process.env.DB_NAME || 'enfyra';

  // Connect without database to create it
  // For PostgreSQL, connect to 'postgres' database (always exists)
  // For MySQL, can connect without specifying database
  const tempKnex = knex({
    client: DB_TYPE === 'postgres' ? 'pg' : 'mysql2',
    connection: {
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USERNAME,
      password: DB_PASSWORD,
      ...(DB_TYPE === 'postgres' && { database: 'postgres' }),
    },
  });

  try {
    if (DB_TYPE === 'mysql') {
      const result = await tempKnex.raw(
        `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
        [DB_NAME],
      );
      if (result[0].length === 0) {
        await tempKnex.raw(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
        console.log(`✅ MySQL: Created database ${DB_NAME}`);
      } else {
        console.log(`✅ MySQL: Database ${DB_NAME} already exists`);
      }
    } else if (DB_TYPE === 'postgres') {
      const result = await tempKnex.raw(
        `SELECT 1 FROM pg_database WHERE datname = ?`,
        [DB_NAME],
      );
      if (result.rows.length === 0) {
        await tempKnex.raw(`CREATE DATABASE "${DB_NAME}" WITH ENCODING 'UTF8'`);
        console.log(`✅ Postgres: Created database ${DB_NAME}`);
      } else {
        console.log(`✅ Postgres: Database ${DB_NAME} already exists`);
      }
    }
  } finally {
    await tempKnex.destroy();
  }
}

export async function initializeDatabaseSql(): Promise<void> {
  const DB_TYPE = process.env.DB_TYPE || 'mysql';
  const DB_HOST = process.env.DB_HOST || 'localhost';
  const DB_PORT =
    Number(process.env.DB_PORT) || (DB_TYPE === 'postgres' ? 5432 : 3306);
  const DB_USERNAME = process.env.DB_USERNAME || 'root';
  const DB_PASSWORD = process.env.DB_PASSWORD || '';
  const DB_NAME = process.env.DB_NAME || 'enfyra';

  // Ensure database exists
  await ensureDatabaseExists();

  // Connect to database
  const knexInstance = knex({
    client: DB_TYPE === 'postgres' ? 'pg' : 'mysql2',
    connection: {
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USERNAME,
      password: DB_PASSWORD,
      database: DB_NAME,
    },
  });

  try {
    // Check if already initialized
    const hasSettingTable = await knexInstance.schema.hasTable(
      'setting_definition',
    );

    if (hasSettingTable) {
      const result = await knexInstance('setting_definition')
        .select('isInit')
        .first();

      if (result?.isInit === true || result?.isInit === 1) {
        console.log('⚠️ Database already initialized, skipping init.');
        return;
      }
    }

    // Load snapshot.json
    const snapshotPath = path.resolve(process.cwd(), 'data/snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

    console.log('📖 Loaded snapshot.json');

    // Parse snapshot to schema
    const schemas = parseSnapshotToSchema(snapshot);

    console.log(`📊 Found ${schemas.length} tables to create`);

    // Create all tables
    await createAllTables(knexInstance, schemas, DB_TYPE);

    console.log('🎉 Database initialization completed!');
  } catch (error) {
    console.error('❌ Error during database initialization:', error);
    throw error;
  } finally {
    await knexInstance.destroy();
  }
}

// For direct execution
if (require.main === module) {
  initializeDatabaseSql()
    .then(() => {
      console.log('✅ Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Failed:', error);
      process.exit(1);
    });
}

