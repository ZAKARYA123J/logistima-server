import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger, auditLogger } from '../utils/logger.js';

// Define user roles and their permissions
export enum UserRole {
    SUPER_ADMIN = 'super_admin',
    ADMIN = 'admin',
    DISPATCHER = 'dispatcher',
    DRIVER = 'driver',
    CUSTOMER = 'customer',
    API = 'api',
    SUPPORT = 'support',
}

// Define permission scopes
export enum Permission {
    // Delivery permissions
    DELIVERY_CREATE = 'delivery:create',
    DELIVERY_READ = 'delivery:read',
    DELIVERY_UPDATE = 'delivery:update',
    DELIVERY_DELETE = 'delivery:delete',
    DELIVERY_ASSIGN = 'delivery:assign',
    
    // Driver permissions
    DRIVER_CREATE = 'driver:create',
    DRIVER_READ = 'driver:read',
    DRIVER_UPDATE = 'driver:update',
    DRIVER_DELETE = 'driver:delete',
    DRIVER_MANAGE = 'driver:manage',
    
    // Zone permissions
    ZONE_CREATE = 'zone:create',
    ZONE_READ = 'zone:read',
    ZONE_UPDATE = 'zone:update',
    ZONE_DELETE = 'zone:delete',
    
    // User permissions
    USER_CREATE = 'user:create',
    USER_READ = 'user:read',
    USER_UPDATE = 'user:update',
    USER_DELETE = 'user:delete',
    
    // System permissions
    SYSTEM_MANAGE = 'system:manage',
    SYSTEM_MONITOR = 'system:monitor',
    
    // API permissions
    API_ACCESS = 'api:access',
    
    // Audit permissions
    AUDIT_READ = 'audit:read',
    
    // Report permissions
    REPORT_GENERATE = 'report:generate',
    REPORT_READ = 'report:read',
}

// Role to permissions mapping
export const RolePermissions: Record<UserRole, Permission[]> = {
    [UserRole.SUPER_ADMIN]: Object.values(Permission),
    
    [UserRole.ADMIN]: [
        Permission.DELIVERY_CREATE,
        Permission.DELIVERY_READ,
        Permission.DELIVERY_UPDATE,
        Permission.DELIVERY_DELETE,
        Permission.DELIVERY_ASSIGN,
        Permission.DRIVER_CREATE,
        Permission.DRIVER_READ,
        Permission.DRIVER_UPDATE,
        Permission.DRIVER_DELETE,
        Permission.DRIVER_MANAGE,
        Permission.ZONE_CREATE,
        Permission.ZONE_READ,
        Permission.ZONE_UPDATE,
        Permission.ZONE_DELETE,
        Permission.USER_CREATE,
        Permission.USER_READ,
        Permission.USER_UPDATE,
        Permission.SYSTEM_MONITOR,
        Permission.AUDIT_READ,
        Permission.REPORT_GENERATE,
        Permission.REPORT_READ,
    ],
    
    [UserRole.DISPATCHER]: [
        Permission.DELIVERY_CREATE,
        Permission.DELIVERY_READ,
        Permission.DELIVERY_UPDATE,
        Permission.DELIVERY_ASSIGN,
        Permission.DRIVER_READ,
        Permission.DRIVER_MANAGE,
        Permission.ZONE_READ,
        Permission.REPORT_READ,
    ],
    
    [UserRole.DRIVER]: [
        Permission.DELIVERY_READ, // Only their own deliveries
        Permission.DELIVERY_UPDATE, // Only status updates
        Permission.DRIVER_READ, // Only their own profile
        Permission.DRIVER_UPDATE, // Only their own profile
    ],
    
    [UserRole.CUSTOMER]: [
        Permission.DELIVERY_CREATE,
        Permission.DELIVERY_READ, // Only their own deliveries
    ],
    
    [UserRole.SUPPORT]: [
        Permission.DELIVERY_READ,
        Permission.DELIVERY_UPDATE,
        Permission.DRIVER_READ,
        Permission.USER_READ,
        Permission.AUDIT_READ,
    ],
    
    [UserRole.API]: [
        Permission.API_ACCESS,
        Permission.DELIVERY_CREATE,
        Permission.DELIVERY_READ,
        Permission.DELIVERY_UPDATE,
    ],
};

// Resource ownership check types
export enum OwnershipCheck {
    DELIVERY = 'delivery',
    DRIVER = 'driver',
    USER = 'user',
}

export class RoleMiddleware {
    /**
     * Check if user has required role(s)
     */
    public hasRole = (roles: UserRole | UserRole[]) => {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (!req.user) {
                throw AppError.unauthorized('Authentication required');
            }

            const requiredRoles = Array.isArray(roles) ? roles : [roles];
            const userRole = req.user.role as UserRole;

            if (!requiredRoles.includes(userRole)) {
                auditLogger.user.unauthorized(
                    req.user.id,
                    req.path,
                    req.ip,
                );

                throw AppError.forbidden(
                    `Required roles: ${requiredRoles.join(', ')}. Your role: ${userRole}`,
                    {
                        requiredRoles,
                        userRole,
                        path: req.path,
                        method: req.method,
                    }
                );
            }

            logger.debug('Role check passed', {
                userId: req.user.id,
                userRole,
                requiredRoles,
                path: req.path,
            });

            next();
        };
    };

    /**
     * Check if user has required permission(s)
     */
    public hasPermission = (permissions: Permission | Permission[]) => {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (!req.user) {
                throw AppError.unauthorized('Authentication required');
            }

            const requiredPermissions = Array.isArray(permissions) ? permissions : [permissions];
            const userRole = req.user.role as UserRole;
            const userPermissions = req.user.permissions || [];

            // Get permissions for user's role
            const rolePermissions = RolePermissions[userRole] || [];
            
            // Combine role permissions with user-specific permissions
            const allPermissions = [...rolePermissions, ...userPermissions];

            // Check if user has all required permissions
            const hasAllPermissions = requiredPermissions.every(permission =>
                allPermissions.includes(permission)
            );

            if (!hasAllPermissions) {
                const missingPermissions = requiredPermissions.filter(
                    permission => !allPermissions.includes(permission)
                );

                auditLogger.user.unauthorized(
                    req.user.id,
                    req.path,
                    req.ip,
                );

                throw AppError.forbidden(
                    `Missing permissions: ${missingPermissions.join(', ')}`,
                    {
                        requiredPermissions,
                        userPermissions: allPermissions,
                        missingPermissions,
                        userId: req.user.id,
                        path: req.path,
                        method: req.method,
                    }
                );
            }

            logger.debug('Permission check passed', {
                userId: req.user.id,
                userRole,
                requiredPermissions,
                path: req.path,
            });

            next();
        };
    };

    /**
     * Check resource ownership
     */
    public isOwner = (resourceType: OwnershipCheck, idParam: string = 'id') => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (!req.user) {
                throw AppError.unauthorized('Authentication required');
            }

            const resourceId = req.params[idParam];
            
            if (!resourceId) {
                throw AppError.validation('Resource ID is required');
            }

            try {
                const isOwner = await this.checkOwnership(
                    req.user.id,
                    resourceType,
                    resourceId,
                    req.user
                );

                if (!isOwner) {
                    auditLogger.user.unauthorized(
                        req.user.id,
                        `Access to ${resourceType} ${resourceId}`,
                        req.ip,
                    );

                    throw AppError.forbidden(
                        `You do not have access to this ${resourceType}`,
                        {
                            resourceType,
                            resourceId,
                            userId: req.user.id,
                        }
                    );
                }

                logger.debug('Ownership check passed', {
                    userId: req.user.id,
                    resourceType,
                    resourceId,
                    path: req.path,
                });

                next();
            } catch (error) {
                if (error instanceof AppError) {
                    throw error;
                }
                throw AppError.internal('Failed to verify resource ownership');
            }
        };
    };

    /**
     * Check if user is owner or has permission
     */
    public isOwnerOrHasPermission = (
        resourceType: OwnershipCheck,
        permission: Permission,
        idParam: string = 'id'
    ) => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            if (!req.user) {
                throw AppError.unauthorized('Authentication required');
            }

            const resourceId = req.params[idParam];
            
            if (!resourceId) {
                throw AppError.validation('Resource ID is required');
            }

            try {
                // Check ownership first
                const isOwner = await this.checkOwnership(
                    req.user.id,
                    resourceType,
                    resourceId,
                    req.user
                );

                if (isOwner) {
                    logger.debug('Ownership check passed', {
                        userId: req.user.id,
                        resourceType,
                        resourceId,
                        path: req.path,
                    });
                    return next();
                }

                // If not owner, check permission
                const userRole = req.user.role as UserRole;
                const userPermissions = req.user.permissions || [];
                const rolePermissions = RolePermissions[userRole] || [];
                const allPermissions = [...rolePermissions, ...userPermissions];

                if (allPermissions.includes(permission)) {
                    logger.debug('Permission check passed (fallback)', {
                        userId: req.user.id,
                        permission,
                        resourceType,
                        resourceId,
                        path: req.path,
                    });
                    return next();
                }

                // Neither owner nor has permission
                auditLogger.user.unauthorized(
                    req.user.id,
                    `Access to ${resourceType} ${resourceId}`,
                    req.ip,
                );

                throw AppError.forbidden(
                    `You do not have access to this ${resourceType}`,
                    {
                        resourceType,
                        resourceId,
                        userId: req.user.id,
                        requiredPermission: permission,
                    }
                );
            } catch (error) {
                if (error instanceof AppError) {
                    throw error;
                }
                throw AppError.internal('Failed to verify access');
            }
        };
    };

    /**
     * Check resource ownership (mock implementation)
     * In production, this would query the database
     */
    private async checkOwnership(
        userId: string,
        resourceType: OwnershipCheck,
        resourceId: string,
        user: any
    ): Promise<boolean> {
        // Mock implementations - in production, these would be database queries
        
        switch (resourceType) {
            case OwnershipCheck.DELIVERY:
                // Drivers can only access their own deliveries
                if (user.role === UserRole.DRIVER && user.driverId) {
                    // In production, query database to check if delivery belongs to driver
                    return true; // Simplified for example
                }
                // Dispatchers and admins can access all deliveries
                return [UserRole.DISPATCHER, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(user.role as UserRole);
            
            case OwnershipCheck.DRIVER:
                // Drivers can only access their own profile
                if (user.role === UserRole.DRIVER && user.driverId === resourceId) {
                    return true;
                }
                // Dispatchers and admins can access all drivers
                return [UserRole.DISPATCHER, UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(user.role as UserRole);
            
            case OwnershipCheck.USER:
                // Users can only access their own profile
                return userId === resourceId;
            
            default:
                return false;
        }
    }

    /**
     * Require specific role for driver operations
     */
    public requireDriverRole = this.hasRole([UserRole.DRIVER, UserRole.DISPATCHER, UserRole.ADMIN, UserRole.SUPER_ADMIN]);

    /**
     * Require specific role for dispatcher operations
     */
    public requireDispatcherRole = this.hasRole([UserRole.DISPATCHER, UserRole.ADMIN, UserRole.SUPER_ADMIN]);

    /**
     * Require specific role for admin operations
     */
    public requireAdminRole = this.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]);

    /**
     * Require super admin role
     */
    public requireSuperAdminRole = this.hasRole(UserRole.SUPER_ADMIN);

    /**
     * Middleware to restrict access during maintenance
     */
    public maintenanceMode = (enabled: boolean = false) => {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (!enabled) {
                return next();
            }

            // Allow super admins even during maintenance
            if (req.user && req.user.role === UserRole.SUPER_ADMIN) {
                return next();
            }

            // Allow health checks
            if (req.path === '/health' || req.path === '/api/health') {
                return next();
            }

            throw AppError.forbidden('System is under maintenance. Please try again later.', {
                code: ErrorCodes.MAINTENANCE_MODE,
                estimatedCompletion: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
            });
        };
    };

    /**
     * Time-based access control
     */
    public timeRestriction = (startHour: number, endHour: number) => {
        return (req: Request, res: Response, next: NextFunction): void => {
            const now = new Date();
            const currentHour = now.getHours();
            
            if (currentHour < startHour || currentHour >= endHour) {
                throw AppError.forbidden(
                    `Access allowed only between ${startHour}:00 and ${endHour}:00`,
                    {
                        currentHour,
                        startHour,
                        endHour,
                    }
                );
            }

            next();
        };
    };

    /**
     * IP-based access control
     */
    public ipRestriction = (allowedIPs: string[]) => {
        return (req: Request, res: Response, next: NextFunction): void => {
            const clientIP = req.ip || req.socket.remoteAddress;
            
            if (!clientIP || !allowedIPs.includes(clientIP)) {
                logger.warn('IP restriction violation', {
                    clientIP,
                    allowedIPs,
                    path: req.path,
                    method: req.method,
                });

                throw AppError.forbidden('Access denied from your IP address', {
                    clientIP,
                    allowedIPs,
                });
            }

            next();
        };
    };

    /**
     * Rate limiting per user role
     */
    public roleBasedRateLimit = (limits: Record<UserRole, { requests: number; windowMs: number }>) => {
        const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

        return (req: Request, res: Response, next: NextFunction): void => {
            if (!req.user) {
                return next(); // No rate limiting for unauthenticated
            }

            const userRole = req.user.role as UserRole;
            const limitConfig = limits[userRole];
            
            if (!limitConfig) {
                return next(); // No limit configured for this role
            }

            const key = `${userRole}:${req.user.id}:${req.path}`;
            const now = Date.now();

            // Clean up old entries
            for (const [cacheKey, data] of rateLimitMap.entries()) {
                if (data.resetTime < now) {
                    rateLimitMap.delete(cacheKey);
                }
            }

            const userData = rateLimitMap.get(key);

            if (!userData) {
                // First request
                rateLimitMap.set(key, {
                    count: 1,
                    resetTime: now + limitConfig.windowMs,
                });
                next();
            } else if (userData.count < limitConfig.requests) {
                // Increment count
                userData.count++;
                next();
            } else {
                // Rate limit exceeded
                const resetTime = new Date(userData.resetTime).toISOString();
                
                res.set('Retry-After', Math.ceil((userData.resetTime - now) / 1000).toString());
                res.set('X-RateLimit-Limit', limitConfig.requests.toString());
                res.set('X-RateLimit-Remaining', '0');
                res.set('X-RateLimit-Reset', resetTime);

                logger.warn('Role-based rate limit exceeded', {
                    userId: req.user.id,
                    userRole,
                    path: req.path,
                    limit: limitConfig.requests,
                    windowMs: limitConfig.windowMs,
                    resetTime,
                });

                throw AppError.rateLimitExceeded(userData.resetTime - now);
            }
        };
    };

    /**
     * Check if user can perform action based on delivery status
     */
    public deliveryStatusRestriction = (allowedStatuses: string[]) => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const deliveryId = req.params.id;
            
            if (!deliveryId) {
                return next();
            }

            try {
                // In production, fetch delivery status from database
                // For now, we'll simulate it
                const deliveryStatus = 'started'; // Mock status
                
                if (!allowedStatuses.includes(deliveryStatus)) {
                    throw AppError.forbidden(
                        `Action not allowed on deliveries with status: ${deliveryStatus}`,
                        {
                            deliveryId,
                            currentStatus: deliveryStatus,
                            allowedStatuses,
                        }
                    );
                }

                next();
            } catch (error) {
                if (error instanceof AppError) {
                    throw error;
                }
                throw AppError.internal('Failed to check delivery status');
            }
        };
    };

    /**
     * Geographic restriction middleware
     */
    public geoRestriction = (allowedCountries: string[]) => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            // In production, use a geo-IP service
            // For now, we'll allow all
            const country = 'MA'; // Mock: Morocco
            
            if (!allowedCountries.includes(country)) {
                throw AppError.forbidden('Service not available in your country', {
                    country,
                    allowedCountries,
                });
            }

            next();
        };
    };
}

// Create singleton instance
export const roleMiddleware = new RoleMiddleware();

// Export convenience functions
export const hasRole = roleMiddleware.hasRole;
export const hasPermission = roleMiddleware.hasPermission;
export const isOwner = roleMiddleware.isOwner;
export const isOwnerOrHasPermission = roleMiddleware.isOwnerOrHasPermission;
export const requireDriverRole = roleMiddleware.requireDriverRole;
export const requireDispatcherRole = roleMiddleware.requireDispatcherRole;
export const requireAdminRole = roleMiddleware.requireAdminRole;
export const requireSuperAdminRole = roleMiddleware.requireSuperAdminRole;
export const maintenanceMode = roleMiddleware.maintenanceMode;
export const timeRestriction = roleMiddleware.timeRestriction;
export const ipRestriction = roleMiddleware.ipRestriction;
export const roleBasedRateLimit = roleMiddleware.roleBasedRateLimit;
export const deliveryStatusRestriction = roleMiddleware.deliveryStatusRestriction;
export const geoRestriction = roleMiddleware.geoRestriction;

// Export enums
export { UserRole, Permission, OwnershipCheck };

export default roleMiddleware;