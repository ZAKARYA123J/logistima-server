import Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export class RedisService {
    private client: Redis;
    private subscriber: Redis;
    private isConnected: boolean = false;
    private readonly LOCK_TIMEOUT = 10000; // 10 seconds
    private readonly RETRY_DELAY = 100; // 100ms

    constructor() {
        const redisConfig = {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            db: parseInt(process.env.REDIS_DB || '0'),
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                logger.warn(`Redis reconnecting attempt ${times}, delay: ${delay}ms`);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 10000,
        };

        this.client = new Redis(redisConfig);
        this.subscriber = new Redis(redisConfig);

        this.setupEventListeners();
        this.testConnection();
    }

    private setupEventListeners(): void {
        this.client.on('connect', () => {
            logger.info('Redis client connected');
        });

        this.client.on('ready', () => {
            logger.info('Redis client ready');
            this.isConnected = true;
        });

        this.client.on('error', (error) => {
            logger.error('Redis client error:', error);
            this.isConnected = false;
        });

        this.client.on('close', () => {
            logger.warn('Redis client connection closed');
            this.isConnected = false;
        });

        this.client.on('reconnecting', () => {
            logger.info('Redis client reconnecting...');
        });
    }

    private async testConnection(): Promise<void> {
        try {
            await this.client.ping();
            logger.info('Redis connection test successful');
            this.isConnected = true;
        } catch (error) {
            logger.error('Redis connection test failed:', error);
            this.isConnected = false;
        }
    }

    /**
     * Acquire a distributed lock
     */
    public async acquireLock(key: string, ttl: number = 5000): Promise<boolean> {
        const lockKey = `lock:${key}`;
        const lockValue = Date.now() + ttl + 1; // Add 1ms buffer
        
        try {
            // Try to set the lock with NX (only if not exists) and EX (expiry)
            const result = await this.client.set(
                lockKey,
                lockValue.toString(),
                'NX',
                'PX',
                ttl
            );
            
            return result === 'OK';
        } catch (error) {
            logger.error(`Error acquiring lock for key ${key}:`, error);
            return false;
        }
    }

    /**
     * Release a distributed lock
     */
    public async releaseLock(key: string): Promise<void> {
        const lockKey = `lock:${key}`;
        
        try {
            await this.client.del(lockKey);
        } catch (error) {
            logger.error(`Error releasing lock for key ${key}:`, error);
        }
    }

    /**
     * Get value by key with optional JSON parsing
     */
    public async get(key: string, parseJson: boolean = true): Promise<any> {
        try {
            const value = await this.client.get(key);
            
            if (!value) {
                return null;
            }
            
            return parseJson ? JSON.parse(value) : value;
        } catch (error) {
            logger.error(`Error getting key ${key}:`, error);
            return null;
        }
    }

    /**
     * Set value with expiry
     */
    public async set(key: string, value: any, ttl?: number): Promise<boolean> {
        try {
            const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
            
            if (ttl) {
                await this.client.setex(key, ttl / 1000, stringValue);
            } else {
                await this.client.set(key, stringValue);
            }
            
            return true;
        } catch (error) {
            logger.error(`Error setting key ${key}:`, error);
            return false;
        }
    }

    /**
     * Set value with expiry in milliseconds
     */
    public async setWithExpiry(key: string, value: any, ttlMs: number): Promise<boolean> {
        return this.set(key, value, ttlMs);
    }

    /**
     * Delete key(s)
     */
    public async del(key: string | string[]): Promise<number> {
        try {
            const keys = Array.isArray(key) ? key : [key];
            return await this.client.del(...keys);
        } catch (error) {
            logger.error(`Error deleting key(s) ${key}:`, error);
            return 0;
        }
    }

    /**
     * Delete keys by pattern
     */
    public async delPattern(pattern: string): Promise<number> {
        try {
            const keys = await this.client.keys(pattern);
            
            if (keys.length === 0) {
                return 0;
            }
            
            // Delete in batches to avoid blocking Redis
            const batchSize = 100;
            let deletedCount = 0;
            
            for (let i = 0; i < keys.length; i += batchSize) {
                const batch = keys.slice(i, i + batchSize);
                const count = await this.client.del(...batch);
                deletedCount += count;
            }
            
            logger.debug(`Deleted ${deletedCount} keys matching pattern: ${pattern}`);
            return deletedCount;
        } catch (error) {
            logger.error(`Error deleting pattern ${pattern}:`, error);
            return 0;
        }
    }

    /**
     * Check if key exists
     */
    public async exists(key: string): Promise<boolean> {
        try {
            const count = await this.client.exists(key);
            return count > 0;
        } catch (error) {
            logger.error(`Error checking existence for key ${key}:`, error);
            return false;
        }
    }

    /**
     * Increment value
     */
    public async incr(key: string): Promise<number> {
        try {
            return await this.client.incr(key);
        } catch (error) {
            logger.error(`Error incrementing key ${key}:`, error);
            throw error;
        }
    }

    /**
     * Decrement value
     */
    public async decr(key: string): Promise<number> {
        try {
            return await this.client.decr(key);
        } catch (error) {
            logger.error(`Error decrementing key ${key}:`, error);
            throw error;
        }
    }

    /**
     * Set hash field
     */
    public async hset(key: string, field: string, value: any): Promise<number> {
        try {
            const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
            return await this.client.hset(key, field, stringValue);
        } catch (error) {
            logger.error(`Error setting hash field ${field} for key ${key}:`, error);
            throw error;
        }
    }

    /**
     * Get hash field
     */
    public async hget(key: string, field: string, parseJson: boolean = true): Promise<any> {
        try {
            const value = await this.client.hget(key, field);
            
            if (!value) {
                return null;
            }
            
            return parseJson ? JSON.parse(value) : value;
        } catch (error) {
            logger.error(`Error getting hash field ${field} for key ${key}:`, error);
            return null;
        }
    }

    /**
     * Get all hash fields
     */
    public async hgetall(key: string): Promise<Record<string, any>> {
        try {
            const result = await this.client.hgetall(key);
            
            // Parse JSON values
            const parsedResult: Record<string, any> = {};
            for (const [field, value] of Object.entries(result)) {
                try {
                    parsedResult[field] = JSON.parse(value);
                } catch {
                    parsedResult[field] = value;
                }
            }
            
            return parsedResult;
        } catch (error) {
            logger.error(`Error getting all hash fields for key ${key}:`, error);
            return {};
        }
    }

    /**
     * Publish to channel
     */
    public async publish(channel: string, message: any): Promise<number> {
        try {
            const stringMessage = typeof message === 'string' ? message : JSON.stringify(message);
            return await this.client.publish(channel, stringMessage);
        } catch (error) {
            logger.error(`Error publishing to channel ${channel}:`, error);
            throw error;
        }
    }

    /**
     * Subscribe to channel
     */
    public async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
        try {
            await this.subscriber.subscribe(channel);
            
            this.subscriber.on('message', (ch, message) => {
                if (ch === channel) {
                    try {
                        const parsedMessage = JSON.parse(message);
                        callback(parsedMessage);
                    } catch {
                        callback(message);
                    }
                }
            });
            
            logger.info(`Subscribed to Redis channel: ${channel}`);
        } catch (error) {
            logger.error(`Error subscribing to channel ${channel}:`, error);
            throw error;
        }
    }

    /**
     * Get connection status
     */
    public getStatus(): { connected: boolean; ready: boolean } {
        return {
            connected: this.isConnected,
            ready: this.client.status === 'ready'
        };
    }

    /**
     * Health check
     */
    public async healthCheck(): Promise<boolean> {
        try {
            await this.client.ping();
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Close connections
     */
    public async disconnect(): Promise<void> {
        try {
            await this.client.quit();
            await this.subscriber.quit();
            logger.info('Redis connections closed');
        } catch (error) {
            logger.error('Error closing Redis connections:', error);
        }
    }

    /**
     * Atomic operations with optimistic locking
     */
    public async atomicOperation<T>(
        key: string,
        operation: (currentValue: T | null) => Promise<T>,
        maxRetries: number = 3
    ): Promise<T> {
        let retries = 0;
        
        while (retries < maxRetries) {
            try {
                // Watch the key for changes
                await this.client.watch(key);
                
                // Get current value
                const currentValue = await this.get(key);
                
                // Perform operation (outside of transaction)
                const newValue = await operation(currentValue);
                
                // Start transaction
                const multi = this.client.multi();
                multi.set(key, JSON.stringify(newValue));
                
                // Execute transaction
                const results = await multi.exec();
                
                // Check if transaction was successful (not null)
                if (results !== null) {
                    return newValue;
                }
                
                // Transaction failed, retry
                retries++;
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                
            } catch (error) {
                await this.client.unwatch();
                throw error;
            }
        }
        
        throw new AppError(`Failed to perform atomic operation after ${maxRetries} retries`, 500);
    }

    /**
     * Rate limiting using sliding window
     */
    public async rateLimit(
        key: string,
        windowMs: number,
        maxRequests: number
    ): Promise<{ allowed: boolean; remaining: number; reset: number }> {
        const now = Date.now();
        const windowStart = now - windowMs;
        
        try {
            // Remove old requests
            await this.client.zremrangebyscore(key, 0, windowStart);
            
            // Count requests in window
            const requestCount = await this.client.zcard(key);
            
            if (requestCount >= maxRequests) {
                // Get oldest request to calculate reset time
                const oldest = await this.client.zrange(key, 0, 0, 'WITHSCORES');
                const resetTime = parseInt(oldest[1]) + windowMs;
                
                return {
                    allowed: false,
                    remaining: 0,
                    reset: resetTime
                };
            }
            
            // Add current request
            await this.client.zadd(key, now.toString(), now.toString());
            await this.client.expire(key, Math.ceil(windowMs / 1000));
            
            return {
                allowed: true,
                remaining: maxRequests - requestCount - 1,
                reset: now + windowMs
            };
        } catch (error) {
            logger.error(`Error in rate limiting for key ${key}:`, error);
            // Fail open - allow request if Redis fails
            return {
                allowed: true,
                remaining: maxRequests,
                reset: now + windowMs
            };
        }
    }
}