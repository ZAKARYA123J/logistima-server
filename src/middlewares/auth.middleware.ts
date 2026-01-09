import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { RedisService } from '../services/redis.service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger, auditLogger } from '../utils/logger.js';

// Extend Express Request type to include user
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string;
                role: string;
                permissions: string[];
                driverId?: string; // For driver users
                dispatcherId?: string; // For dispatcher users
            };
            token?: string;
        }
    }
}

export interface TokenPayload {
    userId: string;
    email: string;
    role: string;
    permissions: string[];
    driverId?: string;
    dispatcherId?: string;
    iat?: number;
    exp?: number;
}

export class AuthMiddleware {
    private redisService: RedisService;
    private readonly JWT_SECRET: string;
    private readonly JWT_EXPIRY: string;
    private readonly REFRESH_TOKEN_EXPIRY: string;
    private readonly TOKEN_BLACKLIST_PREFIX = 'token:blacklist:';

    constructor() {
        this.redisService = new RedisService();
        this.JWT_SECRET = process.env.JWT_SECRET || 'logistima-super-secret-key-change-in-production';
        this.JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';
        this.REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
        
        if (!process.env.JWT_SECRET) {
            logger.warn('JWT_SECRET not set, using default key. This is insecure for production!');
        }
    }

    /**
     * Main authentication middleware
     */
    public authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Get token from Authorization header
            const authHeader = req.headers.authorization;
            
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw AppError.unauthorized('No token provided');
            }

            const token = authHeader.split(' ')[1];
            
            if (!token) {
                throw AppError.unauthorized('Invalid token format');
            }

            // Check if token is blacklisted
            const isBlacklisted = await this.isTokenBlacklisted(token);
            if (isBlacklisted) {
                throw AppError.unauthorized('Token has been revoked');
            }

            // Verify token
            const decoded = this.verifyToken(token) as TokenPayload;
            
            // Set user and token on request object
            req.user = {
                id: decoded.userId,
                email: decoded.email,
                role: decoded.role,
                permissions: decoded.permissions,
                driverId: decoded.driverId,
                dispatcherId: decoded.dispatcherId,
            };
            req.token = token;

            // Log authentication success
            logger.debug('Authentication successful', {
                userId: decoded.userId,
                role: decoded.role,
                path: req.path,
                method: req.method,
                ip: req.ip,
            });

            next();
        } catch (error) {
            // Log authentication failure
            auditLogger.user.unauthorized(
                (error as AppError).metadata?.userId || null,
                req.path,
                req.ip
            );

            next(error);
        }
    };

    /**
     * Generate JWT token
     */
    public generateToken(user: {
        id: string;
        email: string;
        role: string;
        permissions: string[];
        driverId?: string;
        dispatcherId?: string;
    }): { accessToken: string; refreshToken: string; expiresIn: number } {
        const payload: TokenPayload = {
            userId: user.id,
            email: user.email,
            role: user.role,
            permissions: user.permissions,
            driverId: user.driverId,
            dispatcherId: user.dispatcherId,
        };

        // Generate access token
        const accessToken = jwt.sign(payload, this.JWT_SECRET, {
            expiresIn: this.JWT_EXPIRY,
        });

        // Generate refresh token (stored in Redis)
        const refreshToken = jwt.sign(
            { userId: user.id, type: 'refresh' },
            this.JWT_SECRET + '_refresh',
            { expiresIn: this.REFRESH_TOKEN_EXPIRY }
        );

        // Calculate expiry time in seconds
        const expiresIn = this.parseJwtExpiry(this.JWT_EXPIRY);

        // Store refresh token in Redis
        this.storeRefreshToken(user.id, refreshToken).catch(error => {
            logger.error('Failed to store refresh token:', error);
        });

        // Log token generation
        logger.info('Token generated', {
            userId: user.id,
            role: user.role,
            tokenType: 'access',
            expiresIn,
        });

        return { accessToken, refreshToken, expiresIn };
    }

    /**
     * Refresh access token using refresh token
     */
    public async refreshToken(refreshToken: string): Promise<{
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
    }> {
        try {
            // Verify refresh token
            const decoded = jwt.verify(
                refreshToken,
                this.JWT_SECRET + '_refresh'
            ) as { userId: string; type: string };

            if (decoded.type !== 'refresh') {
                throw AppError.unauthorized('Invalid refresh token');
            }

            // Check if refresh token exists in Redis
            const storedToken = await this.redisService.get(`refresh:${decoded.userId}`);
            if (storedToken !== refreshToken) {
                throw AppError.unauthorized('Refresh token not found or expired');
            }

            // In production, you would fetch user data from database
            // For now, return a mock user
            const mockUser = {
                id: decoded.userId,
                email: 'user@example.com',
                role: 'user',
                permissions: ['read:deliveries'],
            };

            // Generate new tokens
            const newTokens = this.generateToken(mockUser);

            // Invalidate old refresh token
            await this.redisService.del(`refresh:${decoded.userId}`);

            logger.info('Token refreshed', {
                userId: decoded.userId,
            });

            return newTokens;
        } catch (error) {
            if (error instanceof jwt.JsonWebTokenError) {
                throw AppError.unauthorized('Invalid refresh token');
            }
            if (error instanceof jwt.TokenExpiredError) {
                throw AppError.unauthorized('Refresh token expired');
            }
            throw error;
        }
    }

    /**
     * Revoke (blacklist) token
     */
    public async revokeToken(token: string, userId: string): Promise<void> {
        try {
            // Decode token to get expiry
            const decoded = jwt.decode(token) as { exp?: number };
            
            if (!decoded || !decoded.exp) {
                throw AppError.validation('Invalid token');
            }

            // Calculate remaining time until expiry
            const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);
            
            if (expiresIn > 0) {
                // Add to blacklist until it expires
                await this.redisService.setWithExpiry(
                    `${this.TOKEN_BLACKLIST_PREFIX}${token}`,
                    userId,
                    expiresIn * 1000
                );

                // Remove refresh token
                await this.redisService.del(`refresh:${userId}`);

                logger.info('Token revoked', {
                    userId,
                    expiresIn,
                });

                auditLogger.user.logout(userId);
            }
        } catch (error) {
            logger.error('Failed to revoke token:', error);
            throw AppError.internal('Failed to revoke token');
        }
    }

    /**
     * Verify JWT token
     */
    private verifyToken(token: string): TokenPayload {
        try {
            return jwt.verify(token, this.JWT_SECRET) as TokenPayload;
        } catch (error) {
            if (error instanceof jwt.JsonWebTokenError) {
                throw AppError.unauthorized('Invalid token');
            }
            if (error instanceof jwt.TokenExpiredError) {
                throw AppError.unauthorized('Token expired');
            }
            throw AppError.internal('Token verification failed');
        }
    }

    /**
     * Check if token is blacklisted
     */
    private async isTokenBlacklisted(token: string): Promise<boolean> {
        const blacklisted = await this.redisService.exists(
            `${this.TOKEN_BLACKLIST_PREFIX}${token}`
        );
        return blacklisted;
    }

    /**
     * Store refresh token in Redis
     */
    private async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
        const expiresIn = this.parseJwtExpiry(this.REFRESH_TOKEN_EXPIRY);
        
        await this.redisService.setWithExpiry(
            `refresh:${userId}`,
            refreshToken,
            expiresIn * 1000
        );
    }

    /**
     * Parse JWT expiry string to seconds
     */
    private parseJwtExpiry(expiry: string): number {
        const match = expiry.match(/^(\d+)([smhd])$/);
        if (!match) return 3600; // Default 1 hour

        const [, value, unit] = match;
        const numValue = parseInt(value);

        switch (unit) {
            case 's': return numValue; // seconds
            case 'm': return numValue * 60; // minutes
            case 'h': return numValue * 3600; // hours
            case 'd': return numValue * 86400; // days
            default: return 3600;
        }
    }

    /**
     * Extract user ID from token (without verification)
     */
    public extractUserId(token: string): string | null {
        try {
            const decoded = jwt.decode(token) as TokenPayload;
            return decoded?.userId || null;
        } catch {
            return null;
        }
    }

    /**
     * Optional authentication (user may or may not be authenticated)
     */
    public optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next(); // Continue without authentication
        }

        try {
            const token = authHeader.split(' ')[1];
            
            if (!token) {
                return next();
            }

            // Check blacklist
            const isBlacklisted = await this.isTokenBlacklisted(token);
            if (isBlacklisted) {
                return next();
            }

            // Verify token
            const decoded = this.verifyToken(token) as TokenPayload;
            
            req.user = {
                id: decoded.userId,
                email: decoded.email,
                role: decoded.role,
                permissions: decoded.permissions,
                driverId: decoded.driverId,
                dispatcherId: decoded.dispatcherId,
            };
            req.token = token;

            next();
        } catch (error) {
            // Silently fail for optional auth
            next();
        }
    };

    /**
     * API Key authentication middleware
     */
    public apiKeyAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const apiKey = req.headers['x-api-key'] || req.query.api_key;
        
        if (!apiKey) {
            throw AppError.unauthorized('API key required');
        }

        // In production, validate API key against database
        const isValidApiKey = await this.validateApiKey(apiKey as string);
        
        if (!isValidApiKey) {
            throw AppError.unauthorized('Invalid API key');
        }

        // Set minimal user info for API key access
        req.user = {
            id: 'api-client',
            email: 'api@logistima.ma',
            role: 'api',
            permissions: ['api:access'],
        };

        logger.info('API key authentication successful', {
            apiKey: this.maskApiKey(apiKey as string),
            path: req.path,
            method: req.method,
            ip: req.ip,
        });

        next();
    };

    /**
     * Validate API key (mock implementation)
     */
    private async validateApiKey(apiKey: string): Promise<boolean> {
        // In production, this would check against a database of API keys
        // For now, we'll accept a specific key from environment
        const validApiKey = process.env.API_KEY || 'logistima-api-key-2024';
        return apiKey === validApiKey;
    }

    /**
     * Mask API key for logging
     */
    private maskApiKey(apiKey: string): string {
        if (apiKey.length <= 8) return '***';
        return `${apiKey.substring(0, 4)}***${apiKey.substring(apiKey.length - 4)}`;
    }

    /**
     * Webhook signature verification
     */
    public verifyWebhookSignature = async (
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> => {
        const signature = req.headers['x-webhook-signature'];
        const webhookSecret = process.env.WEBHOOK_SECRET;
        
        if (!webhookSecret) {
            throw AppError.internal('Webhook secret not configured');
        }

        if (!signature) {
            throw AppError.unauthorized('Webhook signature required');
        }

        // In production, verify the signature
        // For now, we'll do a simple comparison
        const expectedSignature = this.generateWebhookSignature(
            JSON.stringify(req.body),
            webhookSecret
        );

        if (signature !== expectedSignature) {
            throw AppError.unauthorized('Invalid webhook signature');
        }

        logger.info('Webhook signature verified', {
            path: req.path,
            ip: req.ip,
        });

        next();
    };

    /**
     * Generate webhook signature (mock implementation)
     */
    private generateWebhookSignature(payload: string, secret: string): string {
        // In production, use HMAC-SHA256
        const crypto = require('crypto');
        return crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
    }

    /**
     * Two-factor authentication middleware
     */
    public require2FA = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            throw AppError.unauthorized('Authentication required');
        }

        // Check if 2FA is enabled for this user
        const is2FAEnabled = await this.check2FAStatus(req.user.id);
        
        if (!is2FAEnabled) {
            return next(); // 2FA not required
        }

        // Check for 2FA token
        const twoFactorToken = req.headers['x-2fa-token'] || req.body.twoFactorToken;
        
        if (!twoFactorToken) {
            throw AppError.unauthorized('Two-factor authentication required');
        }

        // Verify 2FA token
        const isValid2FA = await this.verify2FAToken(req.user.id, twoFactorToken as string);
        
        if (!isValid2FA) {
            throw AppError.unauthorized('Invalid two-factor authentication token');
        }

        logger.info('Two-factor authentication successful', {
            userId: req.user.id,
            path: req.path,
        });

        next();
    };

    /**
     * Check 2FA status (mock implementation)
     */
    private async check2FAStatus(userId: string): Promise<boolean> {
        // In production, check from database
        return false; // For now, 2FA is disabled
    }

    /**
     * Verify 2FA token (mock implementation)
     */
    private async verify2FAToken(userId: string, token: string): Promise<boolean> {
        // In production, verify TOTP token
        return true;
    }

    /**
     * Session validation middleware
     */
    public validateSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            throw AppError.unauthorized('Authentication required');
        }

        const sessionKey = `session:${req.user.id}`;
        const sessionData = await this.redisService.get(sessionKey);

        if (!sessionData) {
            // Session expired or not found
            throw AppError.unauthorized('Session expired');
        }

        // Update session expiry
        await this.redisService.setWithExpiry(
            sessionKey,
            { ...sessionData, lastActive: new Date().toISOString() },
            30 * 60 * 1000 // 30 minutes
        );

        next();
    };
}

// Create singleton instance
export const authMiddleware = new AuthMiddleware();

// Export middleware functions
export const authenticate = authMiddleware.authenticate;
export const optionalAuth = authMiddleware.optionalAuth;
export const apiKeyAuth = authMiddleware.apiKeyAuth;
export const verifyWebhookSignature = authMiddleware.verifyWebhookSignature;
export const require2FA = authMiddleware.require2FA;
export const validateSession = authMiddleware.validateSession;

export default authMiddleware;