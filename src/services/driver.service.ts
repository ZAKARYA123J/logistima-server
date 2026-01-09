import { sequelize } from '../config/database.js';
import { Driver } from '../models/Driver.model.js';
import { Delivery } from '../models/Delivery.model.js';
import { RedisService } from './redis.service.js';
import { QueueService } from './queue.service.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export interface DriverLocation {
    lat: number;
    lng: number;
}

export interface DriverAvailability {
    driverId: string;
    available: boolean;
    reason?: string;
    capacity: number;
    currentLoad: number;
}

export interface NearbyDriver {
    driver: Driver;
    distance: number; // in meters
    estimatedArrival: number; // in minutes
}

export class DriverService {
    private redisService: RedisService;
    private queueService: QueueService;
    private readonly MAX_DRIVER_CAPACITY = 10;
    private readonly NEARBY_RADIUS = 5000; // 5km in meters
    private readonly LOCATION_UPDATE_TTL = 300; // 5 minutes in seconds

    constructor() {
        this.redisService = new RedisService();
        this.queueService = new QueueService();
    }

    /**
     * Reserve a driver for a delivery (Smart Dispatcher)
     */
    public async reserveDriver(driverId: string): Promise<boolean> {
        const lockKey = `driver:reserve:${driverId}`;
        const cacheKey = `driver:${driverId}:availability`;
        
        // Acquire distributed lock
        const lockAcquired = await this.redisService.acquireLock(lockKey, 5000);
        
        if (!lockAcquired) {
            logger.warn(`Could not acquire lock for driver ${driverId}`);
            return false;
        }

        const transaction = await sequelize.transaction();
        
        try {
            // Get driver with lock for update
            const driver = await Driver.findByPk(driverId, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw new AppError(`Driver ${driverId} not found`, 404);
            }

            // Check capacity
            if (driver.currentLoad >= driver.maxCapacity) {
                logger.warn(`Driver ${driverId} at full capacity: ${driver.currentLoad}/${driver.maxCapacity}`);
                await transaction.rollback();
                return false;
            }

            // Check if driver is available
            if (driver.status !== 'available') {
                logger.warn(`Driver ${driverId} is not available, status: ${driver.status}`);
                await transaction.rollback();
                return false;
            }

            // Reserve driver by incrementing current load
            await driver.update({
                currentLoad: driver.currentLoad + 1,
                status: driver.currentLoad + 1 >= driver.maxCapacity ? 'busy' : 'available'
            }, { transaction });

            // Update cache
            await this.redisService.setWithExpiry(
                cacheKey,
                {
                    available: driver.currentLoad < driver.maxCapacity,
                    capacity: driver.maxCapacity,
                    currentLoad: driver.currentLoad,
                    lastUpdated: new Date().toISOString()
                },
                60000 // 1 minute
            );

            // Invalidate nearby drivers cache
            await this.redisService.delPattern('drivers:nearby:*');

            await transaction.commit();
            logger.info(`Driver ${driverId} reserved successfully. Load: ${driver.currentLoad}/${driver.maxCapacity}`);

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`Error reserving driver ${driverId}:`, error);
            throw error;
        } finally {
            // Always release the lock
            await this.redisService.releaseLock(lockKey);
        }
    }

    /**
     * Release a driver (after delivery completion/cancellation)
     */
    public async releaseDriver(driverId: string): Promise<boolean> {
        const lockKey = `driver:release:${driverId}`;
        const cacheKey = `driver:${driverId}:availability`;
        
        const lockAcquired = await this.redisService.acquireLock(lockKey, 5000);
        
        if (!lockAcquired) {
            logger.warn(`Could not acquire lock for releasing driver ${driverId}`);
            return false;
        }

        const transaction = await sequelize.transaction();
        
        try {
            const driver = await Driver.findByPk(driverId, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw new AppError(`Driver ${driverId} not found`, 404);
            }

            if (driver.currentLoad <= 0) {
                logger.warn(`Driver ${driverId} current load is already 0`);
                await transaction.rollback();
                return false;
            }

            // Decrement current load
            const newLoad = driver.currentLoad - 1;
            
            await driver.update({
                currentLoad: newLoad,
                status: newLoad > 0 ? 'available' : driver.status
            }, { transaction });

            // Update cache
            await this.redisService.setWithExpiry(
                cacheKey,
                {
                    available: newLoad < driver.maxCapacity,
                    capacity: driver.maxCapacity,
                    currentLoad: newLoad,
                    lastUpdated: new Date().toISOString()
                },
                60000
            );

            // Invalidate nearby drivers cache
            await this.redisService.delPattern('drivers:nearby:*');

            await transaction.commit();
            logger.info(`Driver ${driverId} released. New load: ${newLoad}/${driver.maxCapacity}`);

            return true;

        } catch (error) {
            await transaction.rollback();
            logger.error(`Error releasing driver ${driverId}:`, error);
            throw error;
        } finally {
            await this.redisService.releaseLock(lockKey);
        }
    }

    /**
     * Find available drivers near a location
     */
    public async findAvailableDriversNearby(
        location: DriverLocation,
        radius: number = this.NEARBY_RADIUS,
        limit: number = 10
    ): Promise<NearbyDriver[]> {
        const cacheKey = `drivers:nearby:${location.lat}:${location.lng}:${radius}:${limit}`;
        
        // Try cache first
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
            logger.debug(`Returning cached nearby drivers for location: ${JSON.stringify(location)}`);
            return cached;
        }

        try {
            // Using Sequelize with PostGIS extension for spatial queries
            // Note: This requires PostGIS extension in PostgreSQL
            const drivers = await Driver.findAll({
                where: {
                    status: 'available',
                    currentLoad: { [sequelize.Op.lt]: sequelize.col('maxCapacity') },
                    // Spatial query would go here in production
                    // Using bounding box approximation for simplicity
                },
                limit: limit,
                order: [
                    // Order by some heuristic (could be distance if using PostGIS)
                    ['currentLoad', 'ASC'], // Less loaded drivers first
                    ['updatedAt', 'DESC'] // Recently active drivers
                ]
            });

            // Calculate distances (simplified - in production use PostGIS)
            const nearbyDrivers: NearbyDriver[] = drivers.map(driver => {
                // Simplified distance calculation (Haversine formula in production)
                const distance = this.calculateDistance(
                    location.lat,
                    location.lng,
                    driver.location?.lat || location.lat,
                    driver.location?.lng || location.lng
                );

                const estimatedArrival = this.calculateEstimatedArrival(
                    distance,
                    driver.currentLoad
                );

                return {
                    driver,
                    distance,
                    estimatedArrival
                };
            }).filter(driver => driver.distance <= radius)
              .sort((a, b) => a.distance - b.distance);

            // Cache for 30 seconds
            await this.redisService.setWithExpiry(cacheKey, nearbyDrivers, 30000);

            return nearbyDrivers;

        } catch (error) {
            logger.error('Error finding nearby drivers:', error);
            throw error;
        }
    }

    /**
     * Update driver location
     */
    public async updateDriverLocation(
        driverId: string,
        location: DriverLocation
    ): Promise<void> {
        const lockKey = `driver:location:${driverId}`;
        const locationKey = `driver:${driverId}:location`;
        
        const lockAcquired = await this.redisService.acquireLock(lockKey, 3000);
        
        if (!lockAcquired) {
            throw new AppError(`Could not update location for driver ${driverId}`, 429);
        }

        try {
            // Update in Redis cache (real-time)
            await this.redisService.setWithExpiry(
                locationKey,
                {
                    ...location,
                    timestamp: new Date().toISOString()
                },
                this.LOCATION_UPDATE_TTL * 1000
            );

            // Batch update in database (every 5 minutes or on important events)
            // This reduces database load
            const shouldUpdateDB = await this.shouldUpdateDatabaseLocation(driverId);
            
            if (shouldUpdateDB) {
                await Driver.update(
                    { location },
                    { where: { id: driverId } }
                );
                logger.debug(`Updated location in DB for driver ${driverId}`);
            }

            // Invalidate nearby drivers cache
            await this.redisService.delPattern('drivers:nearby:*');

            logger.debug(`Updated location for driver ${driverId}: ${JSON.stringify(location)}`);

        } finally {
            await this.redisService.releaseLock(lockKey);
        }
    }

    /**
     * Get driver current location
     */
    public async getDriverLocation(driverId: string): Promise<DriverLocation | null> {
        const locationKey = `driver:${driverId}:location`;
        
        // Try Redis cache first
        const cachedLocation = await this.redisService.get(locationKey);
        if (cachedLocation) {
            return cachedLocation;
        }

        // Fallback to database
        const driver = await Driver.findByPk(driverId, {
            attributes: ['location']
        });

        return driver?.location || null;
    }

    /**
     * Check driver availability
     */
    public async checkDriverAvailability(driverId: string): Promise<DriverAvailability> {
        const cacheKey = `driver:${driverId}:availability`;
        
        // Try cache first
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
            return cached;
        }

        const driver = await Driver.findByPk(driverId, {
            attributes: ['id', 'status', 'maxCapacity', 'currentLoad']
        });

        if (!driver) {
            throw new AppError(`Driver ${driverId} not found`, 404);
        }

        const availability: DriverAvailability = {
            driverId: driver.id,
            available: driver.status === 'available' && driver.currentLoad < driver.maxCapacity,
            capacity: driver.maxCapacity,
            currentLoad: driver.currentLoad
        };

        if (!availability.available) {
            availability.reason = driver.status !== 'available' 
                ? `Driver status is ${driver.status}`
                : `Driver at full capacity (${driver.currentLoad}/${driver.maxCapacity})`;
        }

        // Cache for 1 minute
        await this.redisService.setWithExpiry(cacheKey, availability, 60000);

        return availability;
    }

    /**
     * Get driver statistics
     */
    public async getDriverStats(driverId: string): Promise<any> {
        const cacheKey = `driver:${driverId}:stats`;
        
        const cached = await this.redisService.get(cacheKey);
        if (cached) {
            return cached;
        }

        const [driver, deliveries] = await Promise.all([
            Driver.findByPk(driverId),
            Delivery.findAll({
                where: { driverId },
                attributes: [
                    'status',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['status']
            })
        ]);

        if (!driver) {
            throw new AppError(`Driver ${driverId} not found`, 404);
        }

        const stats = {
            driverId: driver.id,
            name: driver.name,
            email: driver.email,
            status: driver.status,
            capacity: {
                max: driver.maxCapacity,
                current: driver.currentLoad,
                available: driver.maxCapacity - driver.currentLoad
            },
            deliveries: deliveries.reduce((acc: any, item: any) => {
                acc[item.status] = parseInt(item.get('count'));
                return acc;
            }, {}),
            rating: driver.rating || 0,
            totalDistance: driver.totalDistance || 0,
            totalDeliveries: deliveries.reduce((sum: number, item: any) => 
                sum + parseInt(item.get('count')), 0
            ),
            lastActive: driver.updatedAt
        };

        // Cache for 5 minutes
        await this.redisService.setWithExpiry(cacheKey, stats, 300000);

        return stats;
    }

    /**
     * Assign optimal driver for a delivery
     */
    public async assignOptimalDriver(
        pickupLocation: DriverLocation,
        deliveryData: any
    ): Promise<string | null> {
        // Find nearby available drivers
        const nearbyDrivers = await this.findAvailableDriversNearby(
            pickupLocation,
            this.NEARBY_RADIUS,
            5 // Consider top 5 nearest drivers
        );

        if (nearbyDrivers.length === 0) {
            logger.warn(`No available drivers near location: ${JSON.stringify(pickupLocation)}`);
            return null;
        }

        // Apply Smart Dispatching algorithm
        const scoredDrivers = nearbyDrivers.map(driverInfo => {
            const score = this.calculateDriverScore(driverInfo, deliveryData);
            return { ...driverInfo, score };
        }).sort((a, b) => b.score - a.score);

        logger.info(`Driver scores for delivery:`, scoredDrivers.map(d => ({
            driverId: d.driver.driverId,
            distance: d.distance,
            score: d.score
        })));

        // Try to reserve the best driver
        for (const driverInfo of scoredDrivers) {
            try {
                const reserved = await this.reserveDriver(driverInfo.driver.id);
                if (reserved) {
                    logger.info(`Assigned driver ${driverInfo.driver.id} with score ${driverInfo.score}`);
                    return driverInfo.driver.id;
                }
            } catch (error) {
                logger.error(`Failed to reserve driver ${driverInfo.driver.id}:`, error);
                continue;
            }
        }

        logger.warn('Could not reserve any of the optimal drivers');
        return null;
    }

    /**
     * Bulk update driver statuses (for maintenance)
     */
    public async bulkUpdateDriverStatus(
        driverIds: string[],
        status: string
    ): Promise<number> {
        const transaction = await sequelize.transaction();
        
        try {
            const [affectedCount] = await Driver.update(
                { status },
                {
                    where: { id: driverIds },
                    transaction
                }
            );

            await transaction.commit();

            // Invalidate all related caches
            const cacheKeys = driverIds.map(id => `driver:${id}:availability`);
            cacheKeys.push('drivers:nearby:*');
            
            await Promise.all(
                cacheKeys.map(key => this.redisService.delPattern(key))
            );

            logger.info(`Updated status to ${status} for ${affectedCount} drivers`);
            return affectedCount;

        } catch (error) {
            await transaction.rollback();
            logger.error('Error in bulk driver status update:', error);
            throw error;
        }
    }

    /**
     * Emergency driver replacement
     */
    public async emergencyDriverReplacement(
        oldDriverId: string,
        deliveryId: string,
        reason: string
    ): Promise<string | null> {
        logger.warn(`Emergency replacement for driver ${oldDriverId} on delivery ${deliveryId}: ${reason}`);

        // Release the old driver
        await this.releaseDriver(oldDriverId);

        // Get delivery details to find new driver near delivery location
        const delivery = await Delivery.findByPk(deliveryId);
        if (!delivery) {
            throw new AppError(`Delivery ${deliveryId} not found`, 404);
        }

        // In production, we would get the current delivery location
        // For now, use a default location
        const currentLocation: DriverLocation = {
            lat: 33.5731, // Casablanca coordinates
            lng: -7.5898
        };

        // Find and assign new driver
        const newDriverId = await this.assignOptimalDriver(currentLocation, {
            priority: 1, // High priority for emergency
            requiresExperience: true
        });

        if (newDriverId) {
            // Update delivery with new driver
            await delivery.update({ driverId: newDriverId });
            
            // Add high priority notification
            await this.queueService.addHighPriorityJob('emergency-replacement', {
                oldDriverId,
                newDriverId,
                deliveryId,
                reason,
                timestamp: new Date().toISOString()
            });

            logger.info(`Emergency replacement: Driver ${oldDriverId} replaced by ${newDriverId}`);
        }

        return newDriverId;
    }

    /**
     * Health check for driver service
     */
    public async healthCheck(): Promise<{
        database: boolean;
        redis: boolean;
        queue: boolean;
    }> {
        const [database, redis, queue] = await Promise.all([
            this.checkDatabaseConnection(),
            this.redisService.healthCheck(),
            this.queueService.healthCheck()
        ]);

        return { database, redis, queue };
    }

    // Private helper methods

    private async checkDatabaseConnection(): Promise<boolean> {
        try {
            await sequelize.authenticate();
            return true;
        } catch (error) {
            logger.error('Database connection check failed:', error);
            return false;
        }
    }

    private async shouldUpdateDatabaseLocation(driverId: string): Promise<boolean> {
        const key = `driver:${driverId}:location:db:lastUpdate`;
        const lastUpdate = await this.redisService.get(key, false);
        
        const now = Date.now();
        const fiveMinutesAgo = now - (5 * 60 * 1000);
        
        if (!lastUpdate || parseInt(lastUpdate) < fiveMinutesAgo) {
            await this.redisService.set(key, now.toString(), 300000); // 5 minutes
            return true;
        }
        
        return false;
    }

    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        // Simplified calculation - in production use Haversine formula
        const R = 6371000; // Earth's radius in meters
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    private toRad(degrees: number): number {
        return degrees * (Math.PI / 180);
    }

    private calculateEstimatedArrival(distance: number, currentLoad: number): number {
        // Base speed: 30 km/h in city traffic ≈ 500 m/min
        const baseSpeed = 500; // meters per minute
        
        // Each additional delivery adds 2 minutes
        const loadPenalty = currentLoad * 2;
        
        // Traffic factor (simplified)
        const trafficFactor = 1.2; // 20% slower in traffic
        
        const travelTime = (distance / baseSpeed) * trafficFactor;
        return Math.ceil(travelTime + loadPenalty);
    }

    private calculateDriverScore(driverInfo: NearbyDriver, deliveryData: any): number {
        let score = 100;
        
        // Distance factor (closer is better)
        const maxDistance = 10000; // 10km
        const distanceScore = 100 - (driverInfo.distance / maxDistance) * 50;
        score *= (distanceScore / 100);
        
        // Load factor (less loaded is better)
        const loadRatio = driverInfo.driver.currentLoad / driverInfo.driver.maxCapacity;
        const loadScore = 100 - (loadRatio * 40);
        score *= (loadScore / 100);
        
        // Rating factor (higher rating is better)
        const rating = driverInfo.driver.rating || 4.0;
        const ratingScore = 80 + (rating * 5); // 4.0 = 100, 5.0 = 105
        score *= (ratingScore / 100);
        
        // Priority matching (if delivery is high priority, prefer experienced drivers)
        if (deliveryData.priority === 1 && driverInfo.driver.experienceLevel === 'senior') {
            score *= 1.2;
        }
        
        return Math.round(score * 100) / 100;
    }
}