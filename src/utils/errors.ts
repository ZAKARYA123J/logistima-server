import { logger } from './logger.js';

// Error codes mapping
export const ErrorCodes = {
    // Validation errors (400-499)
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    REQUIRED_FIELD: 'REQUIRED_FIELD',
    INVALID_INPUT: 'INVALID_INPUT',
    INVALID_FORMAT: 'INVALID_FORMAT',
    MISSING_PARAMETER: 'MISSING_PARAMETER',
    
    // Authentication & Authorization errors (401-403)
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    INVALID_TOKEN: 'INVALID_TOKEN',
    EXPIRED_TOKEN: 'EXPIRED_TOKEN',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
    
    // Resource errors (404)
    NOT_FOUND: 'NOT_FOUND',
    RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
    USER_NOT_FOUND: 'USER_NOT_FOUND',
    DELIVERY_NOT_FOUND: 'DELIVERY_NOT_FOUND',
    DRIVER_NOT_FOUND: 'DRIVER_NOT_FOUND',
    ZONE_NOT_FOUND: 'ZONE_NOT_FOUND',
    
    // Conflict errors (409)
    CONFLICT: 'CONFLICT',
    RESOURCE_EXISTS: 'RESOURCE_EXISTS',
    DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
    CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
    DRIVER_UNAVAILABLE: 'DRIVER_UNAVAILABLE',
    DELIVERY_ALREADY_ASSIGNED: 'DELIVERY_ALREADY_ASSIGNED',
    
    // Rate limiting errors (429)
    TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    
    // Internal errors (500-599)
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    DATABASE_ERROR: 'DATABASE_ERROR',
    REDIS_ERROR: 'REDIS_ERROR',
    QUEUE_ERROR: 'QUEUE_ERROR',
    EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
    UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    
    // Business logic errors
    INSUFFICIENT_CAPACITY: 'INSUFFICIENT_CAPACITY',
    INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
    OPERATION_NOT_ALLOWED: 'OPERATION_NOT_ALLOWED',
    MAINTENANCE_MODE: 'MAINTENANCE_MODE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// HTTP Status codes mapping
export const HttpStatus = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatusCode = typeof HttpStatus[keyof typeof HttpStatus];

// Error metadata interface
export interface ErrorMetadata {
    [key: string]: any;
    field?: string;
    value?: any;
    constraints?: string[];
    resource?: string;
    resourceId?: string;
    operation?: string;
    userId?: string;
    ip?: string;
    retryAfter?: number;
    timestamp?: string;
}

// Main AppError class
export class AppError extends Error {
    public readonly statusCode: HttpStatusCode;
    public readonly code: ErrorCode;
    public readonly metadata: ErrorMetadata;
    public readonly isOperational: boolean;
    public readonly timestamp: string;
    public readonly stack?: string;

    constructor(
        message: string,
        statusCode: HttpStatusCode = HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode = ErrorCodes.INTERNAL_ERROR,
        metadata: ErrorMetadata = {},
        isOperational: boolean = true
    ) {
        super(message);
        
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.metadata = {
            ...metadata,
            timestamp: new Date().toISOString(),
        };
        this.isOperational = isOperational;
        this.timestamp = new Date().toISOString();

        // Capture stack trace (excluding constructor call)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AppError);
        }

        // Log error based on severity
        this.logError();
    }

    private logError(): void {
        const logData = {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            code: this.code,
            metadata: this.metadata,
            isOperational: this.isOperational,
            stack: this.stack,
            timestamp: this.timestamp,
        };

        // Log based on status code
        if (this.statusCode >= 500) {
            logger.error('Server Error', logData);
        } else if (this.statusCode >= 400) {
            logger.warn('Client Error', logData);
        } else {
            logger.info('Application Error', logData);
        }
    }

    // Factory methods for common errors

    static validation(message: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            message,
            HttpStatus.BAD_REQUEST,
            ErrorCodes.VALIDATION_ERROR,
            metadata
        );
    }

    static requiredField(field: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Field '${field}' is required`,
            HttpStatus.BAD_REQUEST,
            ErrorCodes.REQUIRED_FIELD,
            { ...metadata, field }
        );
    }

    static unauthorized(message: string = 'Unauthorized access', metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            message,
            HttpStatus.UNAUTHORIZED,
            ErrorCodes.UNAUTHORIZED,
            metadata
        );
    }

    static forbidden(message: string = 'Access forbidden', metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            message,
            HttpStatus.FORBIDDEN,
            ErrorCodes.FORBIDDEN,
            metadata
        );
    }

    static notFound(resource: string, resourceId?: string, metadata: ErrorMetadata = {}): AppError {
        const message = resourceId 
            ? `${resource} with ID '${resourceId}' not found`
            : `${resource} not found`;
        
        return new AppError(
            message,
            HttpStatus.NOT_FOUND,
            ErrorCodes.NOT_FOUND,
            { ...metadata, resource, resourceId }
        );
    }

    static conflict(message: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            message,
            HttpStatus.CONFLICT,
            ErrorCodes.CONFLICT,
            metadata
        );
    }

    static driverUnavailable(driverId: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Driver ${driverId} is not available`,
            HttpStatus.CONFLICT,
            ErrorCodes.DRIVER_UNAVAILABLE,
            { ...metadata, driverId }
        );
    }

    static deliveryAlreadyExists(parcelId: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Delivery already exists for parcel ${parcelId}`,
            HttpStatus.CONFLICT,
            ErrorCodes.CONFLICT,
            { ...metadata, parcelId }
        );
    }

    static concurrentModification(resource: string, resourceId: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `${resource} ${resourceId} was modified concurrently`,
            HttpStatus.CONFLICT,
            ErrorCodes.CONCURRENT_MODIFICATION,
            { ...metadata, resource, resourceId }
        );
    }

    static rateLimitExceeded(retryAfter?: number, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            'Too many requests, please try again later',
            HttpStatus.TOO_MANY_REQUESTS,
            ErrorCodes.RATE_LIMIT_EXCEEDED,
            { ...metadata, retryAfter }
        );
    }

    static internal(message: string = 'Internal server error', metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            message,
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCodes.INTERNAL_ERROR,
            metadata,
            false // Not operational
        );
    }

    static database(message: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Database error: ${message}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCodes.DATABASE_ERROR,
            metadata,
            false
        );
    }

    static redis(message: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Redis error: ${message}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCodes.REDIS_ERROR,
            metadata,
            false
        );
    }

    static queue(message: string, metadata: ErrorMetadata = {}): AppError {
        return new AppError(
            `Queue error: ${message}`,
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCodes.QUEUE_ERROR,
            metadata,
            false
        );
    }

    // Method to convert to JSON response
    toJSON() {
        return {
            success: false,
            error: {
                name: this.name,
                message: this.message,
                code: this.code,
                statusCode: this.statusCode,
                timestamp: this.timestamp,
                ...(process.env.NODE_ENV !== 'production' && { stack: this.stack }),
                ...(process.env.NODE_ENV !== 'production' && { metadata: this.metadata }),
            }
        };
    }

    // Method to create from another error
    static fromError(error: Error, metadata: ErrorMetadata = {}): AppError {
        if (error instanceof AppError) {
            return error;
        }

        return new AppError(
            error.message,
            HttpStatus.INTERNAL_SERVER_ERROR,
            ErrorCodes.INTERNAL_ERROR,
            {
                ...metadata,
                originalError: error.name,
                originalMessage: error.message,
            },
            false
        );
    }
}

// Error handler middleware
export const errorHandler = {
    handle: (error: Error | AppError) => {
        if (error instanceof AppError) {
            return error;
        }

        // Handle specific error types
        if (error.name === 'SequelizeValidationError') {
            const validationErrors = (error as any).errors.map((err: any) => ({
                field: err.path,
                message: err.message,
                value: err.value,
            }));
            
            return AppError.validation('Validation failed', {
                errors: validationErrors,
                originalError: 'SequelizeValidationError',
            });
        }

        if (error.name === 'SequelizeUniqueConstraintError') {
            return AppError.conflict('Resource already exists', {
                originalError: 'SequelizeUniqueConstraintError',
            });
        }

        if (error.name === 'SequelizeForeignKeyConstraintError') {
            return AppError.validation('Foreign key constraint violation', {
                originalError: 'SequelizeForeignKeyConstraintError',
            });
        }

        if (error.name === 'JsonWebTokenError') {
            return AppError.unauthorized('Invalid token');
        }

        if (error.name === 'TokenExpiredError') {
            return AppError.unauthorized('Token expired');
        }

        // Default to internal error
        return AppError.fromError(error);
    },

    // Express error handling middleware
    middleware: (
        error: Error | AppError,
        req: any,
        res: any,
        next: any
    ) => {
        const appError = errorHandler.handle(error);
        
        // Log the error for debugging
        logger.error('Error handling request', {
            path: req.path,
            method: req.method,
            statusCode: appError.statusCode,
            error: appError.message,
            code: appError.code,
            userId: req.user?.id,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            timestamp: new Date().toISOString(),
        });

        // Send error response
        res.status(appError.statusCode).json(appError.toJSON());
    },
};

// Global error handlers
process.on('uncaughtException', (error: Error) => {
    const appError = AppError.fromError(error);
    logger.error('Uncaught Exception', {
        error: appError.message,
        stack: appError.stack,
        metadata: appError.metadata,
        timestamp: new Date().toISOString(),
    });
    
    // In production, we might want to gracefully shutdown
    if (process.env.NODE_ENV === 'production') {
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const appError = AppError.fromError(error);
    
    logger.error('Unhandled Rejection', {
        error: appError.message,
        stack: appError.stack,
        promise: promise.toString(),
        metadata: appError.metadata,
        timestamp: new Date().toISOString(),
    });
});

// Utility function to check if error is operational
export const isOperationalError = (error: Error): boolean => {
    if (error instanceof AppError) {
        return error.isOperational;
    }
    return false;
};

// Validation error utility
export class ValidationError extends AppError {
    constructor(errors: Array<{ field: string; message: string }>) {
        super(
            'Validation failed',
            HttpStatus.BAD_REQUEST,
            ErrorCodes.VALIDATION_ERROR,
            { errors }
        );
    }
}

// Rate limiting error
export class RateLimitError extends AppError {
    constructor(retryAfter?: number) {
        super(
            'Rate limit exceeded',
            HttpStatus.TOO_MANY_REQUESTS,
            ErrorCodes.RATE_LIMIT_EXCEEDED,
            { retryAfter }
        );
    }
}

// Export default
export default {
    AppError,
    ErrorCodes,
    HttpStatus,
    errorHandler,
    ValidationError,
    RateLimitError,
    isOperationalError,
};