/**
 * Permission helper functions for the flag-based access control system.
 *
 * This module provides utilities for:
 * - Converting between flags and legacy permission strings
 * - Checking if a user has required permissions
 * - Defining required permission flags for endpoints
 */

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
 * Required permission flags for endpoint access.
 * Used by auth middleware to specify which flags must be set.
 * Set a flag to true to require it. Admin always bypasses all checks.
 *
 * Examples:
 *   { canRead: true }  - requires read access
 *   { canPay: true }   - requires payment access
 *   { canAdmin: true } - requires admin access
 */
export type RequiredPermissionFlags = Partial<PermissionFlags>;

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
export function computePermissionFromFlags(_canRead: boolean, canPay: boolean, canAdmin: boolean): LegacyPermission {
	if (canAdmin) return 'Admin';
	if (canPay) return 'ReadAndPay';
	return 'Read';
}

/**
 * Converts a legacy permission string to flag values.
 * Useful for backward compatibility when accepting old permission input.
 *
 * @param permission - The legacy permission string
 * @returns The corresponding permission flags
 */
export function flagsFromLegacyPermission(permission: LegacyPermission): PermissionFlags {
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
 * Checks if the given flags satisfy the required permission flags.
 *
 * Permission hierarchy:
 * - canAdmin=true bypasses all checks (admin has full access)
 * - canPay=true also satisfies canRead requirements
 *
 * @param required - The permission flags that must be satisfied
 * @param canRead - Whether the user can access read endpoints
 * @param canPay - Whether the user can access pay/purchase endpoints
 * @param canAdmin - Whether the user has admin access
 * @returns True if the user has sufficient permissions
 */
export function hasPermission(
	required: RequiredPermissionFlags,
	canRead: boolean,
	canPay: boolean,
	canAdmin: boolean,
): boolean {
	// Admin bypasses all permission checks
	if (canAdmin) return true;

	// If admin is explicitly required but user is not admin
	if (required.canAdmin) return false;

	// If pay is required but user doesn't have pay (and isn't admin, checked above)
	if (required.canPay && !canPay) return false;

	// If read is required but user doesn't have read or pay
	if (required.canRead && !(canRead || canPay)) return false;

	return true;
}

/**
 * Returns a human-readable permission name for error messages,
 * based on the highest required flag.
 *
 * @param required - The required permission flags
 * @returns Human-readable permission name
 */
export function getPermissionName(required: RequiredPermissionFlags): string {
	if (required.canAdmin) return 'admin';
	if (required.canPay) return 'payment';
	if (required.canRead) return 'read';
	return 'unknown';
}
