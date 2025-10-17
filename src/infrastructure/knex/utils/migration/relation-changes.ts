import { Knex } from 'knex';
import { Logger } from '@nestjs/common';
import {
  getForeignKeyColumnName,
  getJunctionTableName,
  getJunctionColumnNames,
} from '../../../../shared/utils/naming-helpers';

const logger = new Logger('RelationChanges');

export async function analyzeRelationChanges(
  knex: Knex,
  oldRelations: any[],
  newRelations: any[],
  diff: any,
  tableName: string,
): Promise<void> {
  logger.log('🔍 Relation Analysis (FK Column Generation):');
  logger.log(`🔍 DEBUG: oldRelations count: ${oldRelations.length}, newRelations count: ${newRelations.length}`);

  const targetTableIds = [...oldRelations, ...newRelations]
    .map(rel => typeof rel.targetTable === 'object' ? rel.targetTable.id : null)
    .filter(id => id != null);

  const targetTablesMap = new Map<number, string>();
  if (targetTableIds.length > 0) {
    const targetTables = await knex('table_definition')
      .select('id', 'name')
      .whereIn('id', targetTableIds);

    for (const table of targetTables) {
      targetTablesMap.set(table.id, table.name);
    }
  }

  oldRelations = oldRelations.map(rel => {
    const targetTableId = typeof rel.targetTable === 'object' ? rel.targetTable.id : null;
    return {
      ...rel,
      sourceTableName: rel.sourceTableName || tableName,
      targetTableName: rel.targetTableName || (targetTableId ? targetTablesMap.get(targetTableId) : rel.targetTable)
    };
  });

  newRelations = newRelations.map(rel => {
    const targetTableId = typeof rel.targetTable === 'object' ? rel.targetTable.id : null;
    return {
      ...rel,
      sourceTableName: rel.sourceTableName || tableName,
      targetTableName: rel.targetTableName || (targetTableId ? targetTablesMap.get(targetTableId) : rel.targetTable)
    };
  });

  const oldRelMap = new Map(oldRelations.map(r => [r.id, r]));
  const newRelMap = new Map(newRelations.map(r => [r.id, r]));

  logger.log('🔍 Relation Analysis (FK Column Generation):');
  logger.log('  Old relations:', oldRelations.map(r => `${r.id}:${r.propertyName}`));
  logger.log('  New relations:', newRelations.map(r => `${r.id}:${r.propertyName}`));

  const deletedRelIds = oldRelations
    .filter(r => !newRelMap.has(r.id))
    .map(r => r.id);

  const createdRelIds = newRelations
    .filter(r => !oldRelMap.has(r.id))
    .map(r => r.id);

  logger.log(`📊 Deleted relation IDs: [${deletedRelIds.join(', ')}]`);
  logger.log(`📊 Created relation IDs: [${createdRelIds.join(', ')}]`);

  await handleDeletedRelations(knex, oldRelations, deletedRelIds, diff, tableName);
  await handleCreatedRelations(knex, newRelations, createdRelIds, diff, tableName);
  await handleUpdatedRelations(knex, oldRelMap, newRelMap, diff, tableName);
}

async function handleDeletedRelations(
  knex: Knex,
  oldRelations: any[],
  deletedRelIds: number[],
  diff: any,
  tableName: string,
): Promise<void> {
  for (const relId of deletedRelIds) {
    const rel = oldRelations.find(r => r.id === relId);
    if (!rel) continue;

    logger.log(`🗑️  Deleted relation: ${rel.propertyName} (${rel.type})`);

    if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
      const fkColumn = rel.foreignKeyColumn || getForeignKeyColumnName(rel.propertyName);
      logger.log(`  Will drop FK column: ${fkColumn}`);
      diff.columns.delete.push({
        name: fkColumn,
        isForeignKey: true,
      });
    } else if (rel.type === 'one-to-many') {
      const targetTableName = rel.targetTableName;
      // O2M: FK column in target table = {inversePropertyName}Id
      if (!rel.inversePropertyName) {
        logger.warn(`  ⚠️  O2M relation '${rel.propertyName}' missing inversePropertyName, cannot determine FK column name`);
        continue;
      }
      const fkColumn = rel.foreignKeyColumn || getForeignKeyColumnName(rel.inversePropertyName);
      logger.log(`  O2M: Will drop FK column ${fkColumn} from target table ${targetTableName}`);

      if (!diff.crossTableOperations) {
        diff.crossTableOperations = [];
      }

      diff.crossTableOperations.push({
        operation: 'dropColumn',
        targetTable: targetTableName,
        columnName: fkColumn,
        isForeignKey: true,
      });
    } else if (rel.type === 'many-to-many') {
      const junctionTableName = rel.junctionTableName;
      logger.log(`  M2M: Will drop junction table ${junctionTableName}`);

      if (!diff.junctionTables) {
        diff.junctionTables = { create: [], drop: [], update: [] };
      }

      diff.junctionTables.drop.push({
        tableName: junctionTableName,
        reason: 'Relation deleted',
      });
    }
  }
}

async function handleCreatedRelations(
  knex: Knex,
  newRelations: any[],
  createdRelIds: number[],
  diff: any,
  tableName: string,
): Promise<void> {
  for (const relId of createdRelIds) {
    const rel = newRelations.find(r => r.id === relId);
    if (!rel) continue;

    logger.log(`✨ Created relation: ${rel.propertyName} (${rel.type}) → ${rel.targetTableName}`);

    if (rel.type === 'many-to-one' || rel.type === 'one-to-one') {
      const fkColumn = rel.foreignKeyColumn || getForeignKeyColumnName(rel.propertyName);
      logger.log(`  Will create FK column: ${fkColumn} → ${rel.targetTableName}.id`);

      diff.columns.create.push({
        name: fkColumn,
        type: 'int',
        isNullable: rel.isNullable ?? true,
        isForeignKey: true,
        foreignKeyTarget: rel.targetTableName,
        foreignKeyColumn: 'id',
      });
    } else if (rel.type === 'one-to-many') {
      const targetTableName = rel.targetTableName;
      // O2M: FK column in target table = {inversePropertyName}Id
      if (!rel.inversePropertyName) {
        logger.warn(`  ⚠️  O2M relation '${rel.propertyName}' missing inversePropertyName, cannot determine FK column name`);
        continue;
      }
      const fkColumn = rel.foreignKeyColumn || getForeignKeyColumnName(rel.inversePropertyName);
      logger.log(`  O2M: Will create FK column ${fkColumn} in target table ${targetTableName}`);

      if (!diff.crossTableOperations) {
        diff.crossTableOperations = [];
      }

      diff.crossTableOperations.push({
        operation: 'createColumn',
        targetTable: targetTableName,
        column: {
          name: fkColumn,
          type: 'int',
          isNullable: true,
          isForeignKey: true,
          foreignKeyTarget: tableName,
          foreignKeyColumn: 'id',
        },
      });
    } else if (rel.type === 'many-to-many') {
      const junctionTableName = getJunctionTableName(tableName, rel.propertyName, rel.targetTableName);
      const { sourceColumn, targetColumn } = getJunctionColumnNames(tableName, rel.propertyName, rel.targetTableName);

      logger.log(`  M2M: Will create junction table ${junctionTableName}`);
      logger.log(`      Columns: ${sourceColumn}, ${targetColumn}`);

      if (!diff.junctionTables) {
        diff.junctionTables = { create: [], drop: [], update: [] };
      }

      diff.junctionTables.create.push({
        tableName: junctionTableName,
        sourceTable: tableName,
        targetTable: rel.targetTableName,
        sourceColumn: sourceColumn,
        targetColumn: targetColumn,
      });
    }
  }
}

async function handleUpdatedRelations(
  knex: Knex,
  oldRelMap: Map<number, any>,
  newRelMap: Map<number, any>,
  diff: any,
  tableName: string,
): Promise<void> {
  for (const [relId, newRel] of newRelMap) {
    const oldRel = oldRelMap.get(relId);
    if (!oldRel) continue;

    const changes: string[] = [];
    if (oldRel.propertyName !== newRel.propertyName) changes.push(`propertyName: ${oldRel.propertyName} → ${newRel.propertyName}`);
    if (oldRel.type !== newRel.type) changes.push(`type: ${oldRel.type} → ${newRel.type}`);
    if (oldRel.targetTableName !== newRel.targetTableName) changes.push(`target: ${oldRel.targetTableName} → ${newRel.targetTableName}`);
    if (oldRel.isNullable !== newRel.isNullable) changes.push(`nullable: ${oldRel.isNullable} → ${newRel.isNullable}`);

    if (changes.length > 0) {
      logger.log(`🔄 Updated relation ${relId}: ${changes.join(', ')}`);

      // Handle TYPE CHANGE - most critical
      if (oldRel.type !== newRel.type) {
        await handleRelationTypeChange(knex, oldRel, newRel, diff, tableName);
      }
      // Handle other changes (propertyName, targetTable, isNullable) - TODO later
    }
  }
}

async function handleRelationTypeChange(
  knex: Knex,
  oldRel: any,
  newRel: any,
  diff: any,
  tableName: string,
): Promise<void> {
  logger.log(`🔄 Handling relation type change: ${oldRel.type} → ${newRel.type} for ${newRel.propertyName}`);

  // Initialize diff structures if needed
  if (!diff.crossTableOperations) {
    diff.crossTableOperations = [];
  }
  if (!diff.junctionTables) {
    diff.junctionTables = { create: [], drop: [], update: [] };
  }

  const oldType = oldRel.type;
  const newType = newRel.type;

  // Case 1: FROM M2O/O2O → TO M2M
  if ((oldType === 'many-to-one' || oldType === 'one-to-one') && newType === 'many-to-many') {
    logger.log(`  🔄 M2O/O2O → M2M: Drop FK column, Create junction table`);

    // 1. Drop old FK column
    const oldFkColumn = oldRel.foreignKeyColumn || getForeignKeyColumnName(oldRel.propertyName);
    logger.log(`    ➖ Drop FK column: ${oldFkColumn}`);
    diff.columns.delete.push({
      name: oldFkColumn,
      isForeignKey: true,
    });

    // 2. Create new junction table
    const junctionTableName = getJunctionTableName(tableName, newRel.propertyName, newRel.targetTableName);
    const { sourceColumn, targetColumn } = getJunctionColumnNames(tableName, newRel.propertyName, newRel.targetTableName);
    logger.log(`    ➕ Create junction table: ${junctionTableName}`);
    diff.junctionTables.create.push({
      tableName: junctionTableName,
      sourceTable: tableName,
      targetTable: newRel.targetTableName,
      sourceColumn: sourceColumn,
      targetColumn: targetColumn,
    });
  }

  // Case 2: FROM M2M → TO M2O/O2O
  else if (oldType === 'many-to-many' && (newType === 'many-to-one' || newType === 'one-to-one')) {
    logger.log(`  🔄 M2M → M2O/O2O: Drop junction table, Create FK column`);

    // 1. Drop old junction table
    const oldJunctionTableName = oldRel.junctionTableName;
    logger.log(`    ➖ Drop junction table: ${oldJunctionTableName}`);
    diff.junctionTables.drop.push({
      tableName: oldJunctionTableName,
      reason: 'Relation type changed from M2M to M2O/O2O',
    });

    // 2. Create new FK column
    const newFkColumn = newRel.foreignKeyColumn || getForeignKeyColumnName(newRel.propertyName);
    logger.log(`    ➕ Create FK column: ${newFkColumn} → ${newRel.targetTableName}.id`);
    diff.columns.create.push({
      name: newFkColumn,
      type: 'int',
      isNullable: newRel.isNullable ?? true,
      isForeignKey: true,
      foreignKeyTarget: newRel.targetTableName,
      foreignKeyColumn: 'id',
    });
  }

  // Case 3: FROM O2M → TO M2M
  else if (oldType === 'one-to-many' && newType === 'many-to-many') {
    logger.log(`  🔄 O2M → M2M: Drop FK column in target table, Create junction table`);

    // 1. Drop old FK column in target table
    // O2M: FK column in target table = {inversePropertyName}Id
    if (!oldRel.inversePropertyName) {
      throw new Error(`O2M relation '${oldRel.propertyName}' must have inversePropertyName to determine FK column name`);
    }
    const oldFkColumn = oldRel.foreignKeyColumn || getForeignKeyColumnName(oldRel.inversePropertyName);
    logger.log(`    ➖ Drop FK column ${oldFkColumn} from target table ${oldRel.targetTableName}`);
    diff.crossTableOperations.push({
      operation: 'dropColumn',
      targetTable: oldRel.targetTableName,
      columnName: oldFkColumn,
      isForeignKey: true,
    });

    // 2. Create new junction table
    const junctionTableName = getJunctionTableName(tableName, newRel.propertyName, newRel.targetTableName);
    const { sourceColumn, targetColumn } = getJunctionColumnNames(tableName, newRel.propertyName, newRel.targetTableName);
    logger.log(`    ➕ Create junction table: ${junctionTableName}`);
    diff.junctionTables.create.push({
      tableName: junctionTableName,
      sourceTable: tableName,
      targetTable: newRel.targetTableName,
      sourceColumn: sourceColumn,
      targetColumn: targetColumn,
    });
  }

  // Case 4: FROM M2M → TO O2M
  else if (oldType === 'many-to-many' && newType === 'one-to-many') {
    logger.log(`  🔄 M2M → O2M: Drop junction table, Create FK column in target table`);

    // 1. Drop old junction table
    const oldJunctionTableName = oldRel.junctionTableName;
    logger.log(`    ➖ Drop junction table: ${oldJunctionTableName}`);
    diff.junctionTables.drop.push({
      tableName: oldJunctionTableName,
      reason: 'Relation type changed from M2M to O2M',
    });

    // 2. Create new FK column in target table
    // O2M: FK column in target table = {inversePropertyName}Id
    if (!newRel.inversePropertyName) {
      throw new Error(`O2M relation '${newRel.propertyName}' must have inversePropertyName to determine FK column name`);
    }
    const newFkColumn = newRel.foreignKeyColumn || getForeignKeyColumnName(newRel.inversePropertyName);
    logger.log(`    ➕ Create FK column ${newFkColumn} in target table ${newRel.targetTableName}`);
    diff.crossTableOperations.push({
      operation: 'createColumn',
      targetTable: newRel.targetTableName,
      column: {
        name: newFkColumn,
        type: 'int',
        isNullable: true,
        isForeignKey: true,
        foreignKeyTarget: tableName,
        foreignKeyColumn: 'id',
      },
    });
  }

  // Case 5: FROM M2O/O2O → TO O2M
  else if ((oldType === 'many-to-one' || oldType === 'one-to-one') && newType === 'one-to-many') {
    logger.log(`  🔄 M2O/O2O → O2M: Drop FK column, Create FK column in target table`);

    // 1. Drop old FK column in current table
    // M2O/O2O: FK column = {propertyName}Id
    const oldFkColumn = oldRel.foreignKeyColumn || getForeignKeyColumnName(oldRel.propertyName);
    logger.log(`    ➖ Drop FK column: ${oldFkColumn}`);
    diff.columns.delete.push({
      name: oldFkColumn,
      isForeignKey: true,
    });

    // 2. Create new FK column in target table
    // O2M: FK column in target table = {inversePropertyName}Id
    if (!newRel.inversePropertyName) {
      throw new Error(`O2M relation '${newRel.propertyName}' must have inversePropertyName to determine FK column name`);
    }
    const newFkColumn = newRel.foreignKeyColumn || getForeignKeyColumnName(newRel.inversePropertyName);
    logger.log(`    ➕ Create FK column ${newFkColumn} in target table ${newRel.targetTableName}`);
    diff.crossTableOperations.push({
      operation: 'createColumn',
      targetTable: newRel.targetTableName,
      column: {
        name: newFkColumn,
        type: 'int',
        isNullable: true,
        isForeignKey: true,
        foreignKeyTarget: tableName,
        foreignKeyColumn: 'id',
      },
    });
  }

  // Case 6: FROM O2M → TO M2O/O2O
  else if (oldType === 'one-to-many' && (newType === 'many-to-one' || newType === 'one-to-one')) {
    logger.log(`  🔄 O2M → M2O/O2O: Drop FK column in target table, Create FK column`);

    // 1. Drop old FK column in target table
    // O2M: FK column in target table = {inversePropertyName}Id
    if (!oldRel.inversePropertyName) {
      throw new Error(`O2M relation '${oldRel.propertyName}' must have inversePropertyName to determine FK column name`);
    }
    const oldFkColumn = oldRel.foreignKeyColumn || getForeignKeyColumnName(oldRel.inversePropertyName);
    logger.log(`    ➖ Drop FK column ${oldFkColumn} from target table ${oldRel.targetTableName}`);
    diff.crossTableOperations.push({
      operation: 'dropColumn',
      targetTable: oldRel.targetTableName,
      columnName: oldFkColumn,
      isForeignKey: true,
    });

    // 2. Create new FK column in current table
    // M2O/O2O: FK column = {propertyName}Id
    const newFkColumn = newRel.foreignKeyColumn || getForeignKeyColumnName(newRel.propertyName);
    logger.log(`    ➕ Create FK column: ${newFkColumn} → ${newRel.targetTableName}.id`);
    diff.columns.create.push({
      name: newFkColumn,
      type: 'int',
      isNullable: newRel.isNullable ?? true,
      isForeignKey: true,
      foreignKeyTarget: newRel.targetTableName,
      foreignKeyColumn: 'id',
    });
  }

  // Case 7: M2O ↔ O2O (same FK column, just constraint change)
  else if ((oldType === 'many-to-one' && newType === 'one-to-one') || (oldType === 'one-to-one' && newType === 'many-to-one')) {
    logger.log(`  🔄 M2O ↔ O2O: FK column stays, constraint changes`);
    // Note: O2O should have UNIQUE constraint, M2O should not
    // For now, just log - constraint change can be handled later
    logger.log(`    ⚠️  TODO: Handle unique constraint change for ${newRel.propertyName}`);
  }

  else {
    logger.warn(`  ⚠️  Unhandled relation type change: ${oldType} → ${newType}`);
  }
}
