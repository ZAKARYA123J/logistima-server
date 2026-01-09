import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain, body, param, query } from 'express-validator';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Validation rules for common fields
 */
export const validationRules = {
    // UUID validation
    uuid: (field: string = 'id') => param(field)
        .isUUID()
        .withMessage(`Valid ${field} is required`),

    // Email validation
    email: (field: string = 'email') => body(field)
        .isEmail()
        .normalizeEmail()
        .withMessage('Valid email is required'),

    // Password validation
    password: (field: string = 'password') => body(field)
        .isLength({ min: 8, max: 32 })
        .withMessage('Password must be 8-32 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase, one lowercase, and one number'),

    // Location validation
    location: (field: string = 'location') => body(field)
        .custom((value) => {
            if (!value || typeof value !== 'object') {
                throw new Error('Location must be an object');
            }
            if (typeof value.lat !== 'number' || typeof value.lng !== 'number') {
                throw new Error('Location must contain lat and lng numbers');
            }
            if (value.lat < -90 || value.lat > 90) {
                throw new Error('Latitude must be between -90 and 90');
            }
            if (value.lng < -180 || value.lng > 180) {
                throw new Error('Longitude must be between -180 and 180');
            }
            return true;
        }),

    // Phone number validation (Moroccan format)
    phone: (field: string = 'phone') => body(field)
        .matches(/^(\+212|0)([ \-_/]*)(\d[ \-_/]*){9}$/)
        .withMessage('Valid Moroccan phone number is required (+212 or 0 followed by 9 digits)'),

    // Date validation
    date: (field: string = 'date') => body(field)
        .isISO8601()
        .withMessage('Valid ISO 8601 date is required'),

    // Positive integer validation
    positiveInt: (field: string = 'number') => body(field)
        .isInt({ min: 1 })
        .withMessage('Positive integer is required'),

    // Status validation for deliveries
    deliveryStatus: (field: string = 'status') => body(field)
        .isIn(['pending', 'assigned', 'in_transit', 'delivered', 'cancelled', 'started', 'completed'])
        .withMessage('Valid delivery status is required'),

    // Priority validation
    priority: (field: string = 'priority') => body(field)
        .optional()
        .isInt({ min: 1, max: 3 })
        .withMessage('Priority must be between 1 (high) and 3 (low)'),

    // Pagination validation
    pagination: () => [
        query('page')
            .optional()
            .isInt({ min: 1 })
            .withMessage('Page must be a positive integer')
            .toInt(),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Limit must be between 1 and 100')
            .toInt(),
        query('sort')
            .optional()
            .isString()
            .withMessage('Sort must be a string'),
        query('order')
            .optional()
            .isIn(['asc', 'desc'])
            .withMessage('Order must be either asc or desc')
    ],
};

/**
 * Custom validation middleware
 */
export const validateRequest = (validations: ValidationChain[]) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        // Log validation attempt
        logger.debug('Validating request', {
            path: req.path,
            method: req.method,
            body: req.body,
            params: req.params,
            query: req.query,
            userId: (req as any).user?.id,
            ip: req.ip,
        });

        // Run all validations
        await Promise.all(validations.map(validation => validation.run(req)));

        const errors = validationResult(req);
        
        if (!errors.isEmpty()) {
            const formattedErrors = errors.array().map(error => ({
                field: error.type === 'field' ? error.path : error.type,
                message: error.msg,
                value: error.value,
                location: error.location,
            }));

            logger.warn('Validation failed', {
                path: req.path,
                method: req.method,
                errors: formattedErrors,
                userId: (req as any).user?.id,
                ip: req.ip,
            });

            throw AppError.validation('Validation failed', {
                errors: formattedErrors,
                path: req.path,
                method: req.method,
            });
        }

        logger.debug('Validation successful', {
            path: req.path,
            method: req.method,
            userId: (req as any).user?.id,
        });

        next();
    };
};

/**
 * Sanitize input data
 */
export const sanitizeInput = (req: Request, res: Response, next: NextFunction): void => {
    // Sanitize strings in body
    if (req.body) {
        sanitizeObject(req.body);
    }

    // Sanitize strings in query
    if (req.query) {
        sanitizeObject(req.query);
    }

    next();
};

/**
 * Recursively sanitize object properties
 */
const sanitizeObject = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;

    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            // Trim and escape HTML
            obj[key] = obj[key].trim().replace(/[<>]/g, '');
        } else if (typeof obj[key] === 'object') {
            sanitizeObject(obj[key]);
        }
    }
};

/**
 * Validate file uploads
 */
export const validateFile = (
    fieldName: string,
    allowedTypes: string[],
    maxSize: number // in bytes
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const file = (req as any).files?.[fieldName] || req.file;
        
        if (!file) {
            return next();
        }

        // Check file type
        if (!allowedTypes.includes(file.mimetype)) {
            throw AppError.validation(
                `Invalid file type. Allowed types: ${allowedTypes.join(', ')}`,
                { field: fieldName, type: file.mimetype }
            );
        }

        // Check file size
        if (file.size > maxSize) {
            throw AppError.validation(
                `File too large. Maximum size: ${maxSize / 1024 / 1024}MB`,
                { field: fieldName, size: file.size, maxSize }
            );
        }

        next();
    };
};

/**
 * Validate request body against schema
 */
export const validateSchema = (schema: any) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const { error } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true,
        });

        if (error) {
            const formattedErrors = error.details.map((detail: any) => ({
                field: detail.path.join('.'),
                message: detail.message,
                type: detail.type,
            }));

            logger.warn('Schema validation failed', {
                path: req.path,
                method: req.method,
                errors: formattedErrors,
            });

            throw AppError.validation('Schema validation failed', {
                errors: formattedErrors,
            });
        }

        next();
    };
};

/**
 * Validate that at least one field is present
 */
export const validateAtLeastOne = (fields: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const hasAtLeastOne = fields.some(field => {
            const value = getNestedValue(req.body, field);
            return value !== undefined && value !== null && value !== '';
        });

        if (!hasAtLeastOne) {
            throw AppError.validation(
                `At least one of the following fields must be provided: ${fields.join(', ')}`,
                { fields }
            );
        }

        next();
    };
};

/**
 * Validate that fields are not empty if present
 */
export const validateNotEmpty = (fields: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const errors: Array<{ field: string; message: string }> = [];

        fields.forEach(field => {
            const value = getNestedValue(req.body, field);
            if (value !== undefined && (value === null || value === '')) {
                errors.push({
                    field,
                    message: `${field} cannot be empty if provided`
                });
            }
        });

        if (errors.length > 0) {
            throw AppError.validation('Validation failed', { errors });
        }

        next();
    };
};

/**
 * Helper to get nested value from object
 */
const getNestedValue = (obj: any, path: string): any => {
    return path.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
};

/**
 * Rate limiting middleware for specific endpoints
 */
export const rateLimitMiddleware = (
    requestsPerWindow: number = 100,
    windowMs: number = 15 * 60 * 1000 // 15 minutes
) => {
    const requests = new Map<string, { count: number; resetTime: number }>();

    return (req: Request, res: Response, next: NextFunction) => {
        const key = req.ip || 'unknown';
        const now = Date.now();

        // Clean up old entries
        for (const [ip, data] of requests.entries()) {
            if (data.resetTime < now) {
                requests.delete(ip);
            }
        }

        const userData = requests.get(key);

        if (!userData) {
            // First request
            requests.set(key, {
                count: 1,
                resetTime: now + windowMs
            });
            next();
        } else if (userData.count < requestsPerWindow) {
            // Increment count
            userData.count++;
            next();
        } else {
            // Rate limit exceeded
            const resetTime = new Date(userData.resetTime).toISOString();
            
            res.set('Retry-After', Math.ceil((userData.resetTime - now) / 1000).toString());
            
            logger.warn('Rate limit exceeded', {
                ip: key,
                path: req.path,
                method: req.method,
                limit: requestsPerWindow,
                resetTime,
            });

            throw AppError.rateLimitExceeded(userData.resetTime - now);
        }
    };
};

/**
 * CORS validation middleware
 */
export const corsValidation = (allowedOrigins: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        
        if (origin && allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        }

        // Handle preflight requests
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        next();
    };
};

/**
 * Content type validation
 */
export const validateContentType = (allowedTypes: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const contentType = req.headers['content-type'];
        
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            if (!contentType || !allowedTypes.some(type => contentType.includes(type))) {
                throw AppError.validation(
                    `Content-Type must be one of: ${allowedTypes.join(', ')}`,
                    { contentType }
                );
            }
        }

        next();
    };
};

/**
 * Request size limiter
 */
export const requestSizeLimiter = (maxSize: string) => {
    const bytes = parseSizeString(maxSize);
    
    return (req: Request, res: Response, next: NextFunction) => {
        const contentLength = parseInt(req.headers['content-length'] || '0');
        
        if (contentLength > bytes) {
            throw AppError.validation(
                `Request body too large. Maximum size: ${maxSize}`,
                { size: contentLength, maxSize: bytes }
            );
        }

        next();
    };
};

/**
 * Parse size string to bytes
 */
const parseSizeString = (size: string): number => {
    const match = size.match(/^(\d+)([KMGT]?B)$/i);
    if (!match) return 0;

    const [, value, unit] = match;
    const numValue = parseInt(value);

    switch (unit.toUpperCase()) {
        case 'KB': return numValue * 1024;
        case 'MB': return numValue * 1024 * 1024;
        case 'GB': return numValue * 1024 * 1024 * 1024;
        case 'TB': return numValue * 1024 * 1024 * 1024 * 1024;
        default: return numValue;
    }
};

export default {
    validationRules,
    validateRequest,
    sanitizeInput,
    validateFile,
    validateSchema,
    validateAtLeastOne,
    validateNotEmpty,
    rateLimitMiddleware,
    corsValidation,
    validateContentType,
    requestSizeLimiter,
};