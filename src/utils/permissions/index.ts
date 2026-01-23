/**
 * Permission helper functions for the flag-based access control system.
 *
 * This module provides utilities for:
 * - Converting between flags and legacy permission strings
 * - Checking if a user has required permissions
 * - Defining required permission levels for endpoints
 */

/**
 * Required permission level for endpoint access.
 * Used by auth middleware to determine minimum access requirements.
 */
export type RequiredPermission = 'read' | 'pay' | 'admin';

/**
 * Legacy permission string values for backward compatibility.
 * Maps to the old Permission enum values.
 */
export type LegacyPermission = 'Read' | 'ReadAndPay' | 'Admin';

/**
 * Permission flags structure used throughout the application.
 */
export interface PermissionFlags {
  canRead: boolean;
  canPay: boolean;
  canAdmin: boolean;
}

/**
 * Computes the legacy permission string from flags for backward compatibility.
 * This allows API responses to include both flags AND the computed permission string.
 *
 * Mapping:
 * - canAdmin=true -> 'Admin'
 * - canPay=true (and !canAdmin) -> 'ReadAndPay'
 * - otherwise -> 'Read'
 *
 * @param canRead - Whether the user can access read endpoints
 * @param canPay - Whether the user can access pay/purchase endpoints
 * @param canAdmin - Whether the user has admin access
 * @returns The legacy permission string
 */
export function computePermissionFromFlags(
  canRead: boolean,
  canPay: boolean,
  canAdmin: boolean,
): LegacyPermission {
  if (canAdmin) return 'Admin';
  if (canPay) return 'ReadAndPay';
  if (canRead) return 'Read';
  // All flags are false - this is an invalid state
  throw new Error(
    'Invalid permission flags: at least one permission must be enabled',
  );
}

/**
 * Converts a legacy permission string to flag values.
 * Useful for backward compatibility when accepting old permission input.
 *
 * @param permission - The legacy permission string
 * @returns The corresponding permission flags
 */
export function flagsFromLegacyPermission(
  permission: LegacyPermission,
): PermissionFlags {
  switch (permission) {
    case 'Admin':
      return { canRead: true, canPay: true, canAdmin: true };
    case 'ReadAndPay':
      return { canRead: true, canPay: true, canAdmin: false };
    case 'Read':
    default:
      return { canRead: true, canPay: false, canAdmin: false };
  }
}

/**
 * Checks if the given flags satisfy the required permission level.
 *
 * Permission hierarchy:
 * - 'admin': Only canAdmin=true grants access
 * - 'pay': canPay=true OR canAdmin=true grants access
 * - 'read': canRead=true OR canPay=true OR canAdmin=true grants access
 *
 * Note: canAdmin implicitly grants ALL permissions (admin > pay > read)
 *
 * @param required - The minimum permission level required
 * @param canRead - Whether the user can access read endpoints
 * @param canPay - Whether the user can access pay/purchase endpoints
 * @param canAdmin - Whether the user has admin access
 * @returns True if the user has sufficient permissions
 */
export function hasPermission(
  required: RequiredPermission,
  canRead: boolean,
  canPay: boolean,
  canAdmin: boolean,
): boolean {
  // Admin has all permissions
  if (canAdmin) return true;

  switch (required) {
    case 'admin':
      // Only canAdmin grants admin access (already checked above)
      return false;
    case 'pay':
      // canPay or canAdmin (canAdmin already returned true)
      return canPay;
    case 'read':
      // canRead, canPay, or canAdmin all grant read access
      // canAdmin already returned true, canPay implies read access
      return canRead || canPay;
    default:
      return false;
  }
}

/**
 * Returns a human-readable permission name for error messages.
 *
 * @param required - The required permission level
 * @returns Human-readable permission name
 */
export function getPermissionName(required: RequiredPermission): string {
  switch (required) {
    case 'admin':
      return 'admin';
    case 'pay':
      return 'payment';
    case 'read':
      return 'read';
    default:
      return 'unknown';
  }
}
