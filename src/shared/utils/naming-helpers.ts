/**
 * Naming convention helpers for Knex-based operations
 * These follow TypeORM conventions for compatibility
 */

import * as crypto from 'crypto';

/**
 * PostgreSQL identifier length limit (63 chars)
 */
const PG_IDENTIFIER_LIMIT = 63;

/**
 * Generate deterministic short hash for long identifiers
 * Uses first 8 chars of MD5 to ensure uniqueness
 */
function getShortHash(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').substring(0, 8);
}

/**
 * Get short primary key constraint name for junction tables
 * PostgreSQL has 63 char limit for identifiers
 *
 * @example
 * getShortPkName('method_definition_route_permissions_route_permission_definition')
 * // Returns: 'j_a1b2c3d4_pk' (deterministic hash-based name)
 */
export function getShortPkName(junctionTableName: string): string {
  if (junctionTableName.length <= PG_IDENTIFIER_LIMIT - 3) {
    return `${junctionTableName}_pk`;
  }
  const hash = getShortHash(junctionTableName);
  return `j_${hash}_pk`;
}

/**
 * Get short foreign key constraint name
 * PostgreSQL has 63 char limit for identifiers
 *
 * @example
 * getShortFkConstraintName('method_definition_route_permissions_route_permission_definition', 'methodDefinitionId')
 * // Returns: 'j_a1b2c3d4_src_fk' (deterministic hash-based name)
 */
export function getShortFkConstraintName(junctionTableName: string, columnName: string, direction: 'src' | 'tgt'): string {
  const fullName = `${junctionTableName}_${columnName}_foreign`;
  if (fullName.length <= PG_IDENTIFIER_LIMIT) {
    return fullName;
  }
  const hash = getShortHash(junctionTableName);
  return `j_${hash}_${direction}_fk`;
}

/**
 * Get junction table name following TypeORM convention
 * Format: {sourceTable}_{propertyName}_{targetTable}
 *
 * @example
 * getJunctionTableName('route_definition', 'targetTables', 'table_definition')
 * // Returns: 'route_definition_targetTables_table_definition'
 */
export function getJunctionTableName(
  sourceTable: string,
  propertyName: string,
  targetTable: string,
): string {
  // Junction table naming: source_property_target
  // Only created from original relation (not inverse) to avoid duplicates
  const fullName = `${sourceTable}_${propertyName}_${targetTable}`;

  // PostgreSQL limit is 63 characters (stricter than MySQL's 64)
  if (fullName.length <= PG_IDENTIFIER_LIMIT) {
    return fullName;
  }

  // If too long, use hash-based shortened name (deterministic!)
  const hash = getShortHash(fullName);

  const sourceAbbr = sourceTable.replace(/_definition/g, '').substring(0, 10);
  const propAbbr = propertyName.substring(0, 10);
  const targetAbbr = targetTable.replace(/_definition/g, '').substring(0, 10);

  return `j_${hash}_${sourceAbbr}_${propAbbr}_${targetAbbr}`;
}

/**
 * Get foreign key column name following TypeORM convention
 * Converts snake_case to camelCase and adds 'Id' suffix
 *
 * @example
 * getForeignKeyColumnName('table_definition')
 * // Returns: 'tableDefinitionId'
 *
 * getForeignKeyColumnName('role')
 * // Returns: 'roleId'
 */
export function getForeignKeyColumnName(tableNameOrProperty: string): string {
  // Convert snake_case to camelCase: table_definition → tableDefinition
  const camelCase = tableNameOrProperty.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
  return `${camelCase}Id`;
}

/**
 * Get junction column names for M2M relations
 * Handles self-referencing M2M by using propertyName to differentiate columns
 *
 * @param sourceTable Source table name
 * @param propertyName Relation property name (e.g., 'relatedProducts', 'children')
 * @param targetTable Target table name
 * @returns Object with sourceColumn and targetColumn names
 *
 * @example
 * // Regular M2M: products ↔ orders
 * getJunctionColumnNames('products', 'orders', 'orders')
 * // Returns: { sourceColumn: 'productsId', targetColumn: 'ordersId' }
 *
 * @example
 * // Self-referencing M2M: products.relatedProducts ↔ products
 * getJunctionColumnNames('products', 'relatedProducts', 'products')
 * // Returns: { sourceColumn: 'productsId', targetColumn: 'relatedProductsId' }
 *
 * @example
 * // Self-referencing M2M: users.followers ↔ users
 * getJunctionColumnNames('users', 'followers', 'users')
 * // Returns: { sourceColumn: 'usersId', targetColumn: 'followersId' }
 */
export function getJunctionColumnNames(
  sourceTable: string,
  propertyName: string,
  targetTable: string,
): { sourceColumn: string; targetColumn: string } {
  const sourceColumn = getForeignKeyColumnName(sourceTable);

  // Check if self-referencing M2M (same source and target table)
  if (sourceTable === targetTable) {
    // Use propertyName to create unique target column name
    // This prevents duplicate column names in junction table
    const targetColumn = getForeignKeyColumnName(propertyName);
    return { sourceColumn, targetColumn };
  }

  // Regular M2M: use target table name
  const targetColumn = getForeignKeyColumnName(targetTable);
  return { sourceColumn, targetColumn };
}

/**
 * Convert snake_case to camelCase
 * 
 * @example
 * snakeToCamel('table_definition')
 * // Returns: 'tableDefinition'
 */
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
}

/**
 * Convert camelCase to snake_case
 * 
 * @example
 * camelToSnake('tableDefinition')
 * // Returns: 'table_definition'
 */
export function camelToSnake(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Generate short FK constraint name to avoid MySQL 64 char limit
 * 
 * @example
 * getShortFkName('route_definition', 'targetTables', 'src')
 * // Returns: 'route_definition_targetTables_src_fk'
 */
export function getShortFkName(
  sourceTable: string,
  propertyName: string,
  direction: 'src' | 'tgt',
): string {
  return `${sourceTable}_${propertyName}_${direction}_fk`;
}

/**
 * Generate short index name to avoid MySQL 64 char limit
 * 
 * @example
 * getShortIndexName('route_definition', 'targetTables', 'src')
 * // Returns: 'route_definition_targetTables_src_idx'
 */
export function getShortIndexName(
  sourceTable: string,
  propertyName: string,
  direction: 'src' | 'tgt',
): string {
  return `${sourceTable}_${propertyName}_${direction}_idx`;
}

/**
 * Get table alias for query building
 * Useful for complex joins to avoid column name conflicts
 * 
 * @example
 * getTableAlias('user_definition', ['posts', 'comments'])
 * // Returns: 'user_definition_posts_comments'
 */
export function getTableAlias(tableName: string, path: string[] = []): string {
  if (path.length === 0) {
    return tableName;
  }
  return `${tableName}_${path.join('_')}`;
}

/**
 * Parse field path for nested queries
 * 
 * @example
 * parseFieldPath('user.role.name')
 * // Returns: ['user', 'role', 'name']
 */
export function parseFieldPath(fieldPath: string): string[] {
  return fieldPath.split('.');
}

/**
 * Build full column name with alias
 * 
 * @example
 * buildColumnName('users', 'email')
 * // Returns: 'users.email'
 */
export function buildColumnName(alias: string, column: string): string {
  return `${alias}.${column}`;
}

/**
 * Extract table name from entity class name (if needed for future TypeORM compat)
 * 
 * @example
 * getTableNameFromClass('UserDefinition')
 * // Returns: 'user_definition'
 */
export function getTableNameFromClass(className: string): string {
  // Convert PascalCase to snake_case
  return className
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

