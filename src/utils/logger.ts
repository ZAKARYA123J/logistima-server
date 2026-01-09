import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

// Define colors for each level
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white',
};

// Add colors to winston
winston.addColors(colors);

// Define the format for console output
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(
        (info:any) => `${info.timestamp} ${info.level}: ${info.message} ${info.stack ? `\n${info.stack}` : ''}`
    )
);

// Define the format for file output
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');

// Create the logger
export const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    levels,
    format: fileFormat,
    defaultMeta: { service: 'logistima-backend' },
    transports: [
        // Console transport
        new winston.transports.Console({
            format: consoleFormat,
        }),

        // Daily rotate file for errors
        new DailyRotateFile({
            filename: path.join(logsDir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxSize: '20m',
            maxFiles: '30d',
            format: fileFormat,
        }),

        // Daily rotate file for all logs
        new DailyRotateFile({
            filename: path.join(logsDir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxSize: '20m',
            maxFiles: '30d',
            format: fileFormat,
        }),

        // HTTP request logs
        new DailyRotateFile({
            filename: path.join(logsDir, 'http-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'http',
            maxSize: '20m',
            maxFiles: '7d',
            format: fileFormat,
        }),
    ],

    // Handle exceptions
    exceptionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'exceptions.log'),
            format: fileFormat,
        }),
        new winston.transports.Console({
            format: consoleFormat,
        }),
    ],

    // Handle rejections
    rejectionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'rejections.log'),
            format: fileFormat,
        }),
        new winston.transports.Console({
            format: consoleFormat,
        }),
    ],

    // Exit on error set to false to prevent process exit
    exitOnError: false,
});

// Create a stream for Morgan HTTP logging
export const stream = {
    write: (message: string) => {
        logger.http(message.trim());
    },
};

// Request logging middleware
export const requestLogger = winston.format((info) => {
    if (info instanceof Error) {
        return {
            ...info,
            message: info.message,
            stack: info.stack,
        };
    }
    return info;
});

// Performance logging utility
export const performanceLogger = {
    start: (operation: string): () => void => {
        const startTime = Date.now();
        const operationId = `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        logger.debug(`Performance: ${operation} started`, {
            operation,
            operationId,
            startTime,
        });

        return () => {
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            logger.debug(`Performance: ${operation} completed`, {
                operation,
                operationId,
                startTime,
                endTime,
                duration: `${duration}ms`,
                durationMs: duration,
            });

            // Log warning if operation took too long
            if (duration > 1000) {
                logger.warn(`Performance: ${operation} took ${duration}ms`, {
                    operation,
                    operationId,
                    duration,
                    threshold: 1000,
                });
            }
        };
    },

    measure: async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
        const endMeasurement = performanceLogger.start(operation);
        try {
            const result = await fn();
            endMeasurement();
            return result;
        } catch (error) {
            endMeasurement();
            throw error;
        }
    },
};

// Audit logging utility
export const auditLogger = {
    delivery: {
        created: (deliveryId: string, userId: string, data: any) => {
            logger.info('Delivery created', {
                type: 'AUDIT',
                action: 'DELIVERY_CREATED',
                deliveryId,
                userId,
                data,
                timestamp: new Date().toISOString(),
            });
        },

        updated: (deliveryId: string, userId: string, changes: any) => {
            logger.info('Delivery updated', {
                type: 'AUDIT',
                action: 'DELIVERY_UPDATED',
                deliveryId,
                userId,
                changes,
                timestamp: new Date().toISOString(),
            });
        },

        deleted: (deliveryId: string, userId: string) => {
            logger.warn('Delivery deleted', {
                type: 'AUDIT',
                action: 'DELIVERY_DELETED',
                deliveryId,
                userId,
                timestamp: new Date().toISOString(),
            });
        },
    },

    driver: {
        assigned: (driverId: string, deliveryId: string, dispatcherId: string) => {
            logger.info('Driver assigned', {
                type: 'AUDIT',
                action: 'DRIVER_ASSIGNED',
                driverId,
                deliveryId,
                dispatcherId,
                timestamp: new Date().toISOString(),
            });
        },

        released: (driverId: string, deliveryId: string, reason: string) => {
            logger.info('Driver released', {
                type: 'AUDIT',
                action: 'DRIVER_RELEASED',
                driverId,
                deliveryId,
                reason,
                timestamp: new Date().toISOString(),
            });
        },
    },

    user: {
        login: (userId: string, ip: string, userAgent: string) => {
            logger.info('User logged in', {
                type: 'AUDIT',
                action: 'USER_LOGIN',
                userId,
                ip,
                userAgent,
                timestamp: new Date().toISOString(),
            });
        },

        logout: (userId: string) => {
            logger.info('User logged out', {
                type: 'AUDIT',
                action: 'USER_LOGOUT',
                userId,
                timestamp: new Date().toISOString(),
            });
        },

        unauthorized: (userId: string | null, action: string, ip: string) => {
            logger.warn('Unauthorized access attempt', {
                type: 'AUDIT',
                action: 'UNAUTHORIZED_ACCESS',
                userId,
                attemptedAction: action,
                ip,
                timestamp: new Date().toISOString(),
            });
        },
    },

    system: {
        startup: () => {
            logger.info('System starting up', {
                type: 'AUDIT',
                action: 'SYSTEM_STARTUP',
                nodeVersion: process.version,
                platform: process.platform,
                memory: process.memoryUsage(),
                timestamp: new Date().toISOString(),
            });
        },

        shutdown: (reason: string) => {
            logger.warn('System shutting down', {
                type: 'AUDIT',
                action: 'SYSTEM_SHUTDOWN',
                reason,
                timestamp: new Date().toISOString(),
            });
        },

        error: (error: Error, context: any = {}) => {
            logger.error('System error', {
                type: 'AUDIT',
                action: 'SYSTEM_ERROR',
                error: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                },
                context,
                timestamp: new Date().toISOString(),
            });
        },
    },
};

// Custom log levels for different environments
export const configureLogger = (environment: string = 'development') => {
    if (environment === 'test') {
        logger.level = 'error'; // Only log errors in tests
        logger.transports.forEach((transport) => {
            if (transport instanceof winston.transports.Console) {
                transport.silent = true;
            }
        });
    } else if (environment === 'production') {
        logger.level = 'info';
    } else {
        logger.level = 'debug';
    }

    logger.info(`Logger configured for ${environment} environment`, {
        environment,
        level: logger.level,
        timestamp: new Date().toISOString(),
    });
};

// Log memory usage periodically
export const logMemoryUsage = () => {
    const memoryUsage = process.memoryUsage();
    
    logger.debug('Memory usage', {
        type: 'SYSTEM',
        action: 'MEMORY_USAGE',
        heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
        external: `${Math.round(memoryUsage.external / 1024 / 1024)} MB`,
        arrayBuffers: `${Math.round(memoryUsage.arrayBuffers / 1024 / 1024)} MB`,
        rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
        timestamp: new Date().toISOString(),
    });
};

// Export default logger
export default logger;