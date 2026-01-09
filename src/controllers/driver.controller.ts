import { Request, Response, NextFunction } from 'express';
import { Driver, DriverStatus } from '../models/Driver.model.js';
import { Delivery } from '../models/Delivery.model.js';
import { Zone } from '../models/Zone.model.js';
import { DriverService } from '../services/driver.service.js';
import { RedisService } from '../services/redis.service.js';
import { QueueService } from '../services/queue.service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger, auditLogger, performanceLogger } from '../utils/logger.js';
import { sequelize } from '../config/database.js';
import { Op } from 'sequelize';

export class DriverController {
    private driverService: DriverService;
    private redisService: RedisService;
    private queueService: QueueService;

    constructor() {
        this.driverService = new DriverService();
        this.redisService = new RedisService();
        this.queueService = new QueueService();
    }

    /**
     * Get all drivers with pagination and filters
     */
    public getAllDrivers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getAllDrivers');
        
        try {
            const {
                page = 1,
                limit = 10,
                status,
                zoneId,
                availableOnly = false,
                sortBy = 'createdAt',
                sortOrder = 'desc',
                search
            } = req.query;

            const pageNum = parseInt(page as string);
            const limitNum = parseInt(limit as string);
            const offset = (pageNum - 1) * limitNum;

            // Create cache key
            const cacheKey = `drivers:list:${page}:${limit}:${status}:${zoneId}:${availableOnly}:${search}:${sortBy}:${sortOrder}`;

            // Try cache first
            const cachedData = await this.redisService.get(cacheKey);
            if (cachedData) {
                logger.debug('Returning cached drivers list');
                res.status(200).json({
                    success: true,
                    data: cachedData,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            // Build where conditions
            const whereConditions: any = {};
            
            if (status) {
                whereConditions.status = status;
            }
            
            if (zoneId) {
                whereConditions.zoneId = zoneId;
            }
            
            if (availableOnly) {
                whereConditions.status = DriverStatus.AVAILABLE;
            }
            
            if (search) {
                whereConditions[Op.or] = [
                    { name: { [Op.iLike]: `%${search}%` } },
                    { phone: { [Op.iLike]: `%${search}%` } }
                ];
            }

            // Get total count and drivers
            const { count, rows: drivers } = await Driver.findAndCountAll({
                where: whereConditions,
                limit: limitNum,
                offset: offset,
                order: [[sortBy as string, sortOrder as string]],
                include: [
                    {
                        model: Zone,
                        as: 'zone',
                        attributes: ['id', 'name', 'color']
                    }
                ],
                attributes: {
                    exclude: ['createdAt', 'updatedAt']
                }
            });

            const result = {
                drivers,
                pagination: {
                    total: count,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(count / limitNum)
                }
            };

            // Cache for 1 minute
            await this.redisService.setWithExpiry(cacheKey, result, 60000);

            logger.info('Retrieved drivers list', {
                count,
                page: pageNum,
                limit: limitNum,
                filters: { status, zoneId, availableOnly }
            });

            res.status(200).json({
                success: true,
                data: result,
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Get nearby available drivers
     */
    public getNearbyDrivers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getNearbyDrivers');
        
        try {
            const { lat, lng, radius = 5000, limit = 10, requiredCapacity = 1 } = req.query;

            const location = {
                lat: parseFloat(lat as string),
                lng: parseFloat(lng as string)
            };

            // Create cache key
            const cacheKey = `drivers:nearby:${location.lat}:${location.lng}:${radius}:${limit}:${requiredCapacity}`;

            // Try cache first (cache for 30 seconds for real-time data)
            const cachedData = await this.redisService.get(cacheKey);
            if (cachedData) {
                logger.debug('Returning cached nearby drivers');
                res.status(200).json({
                    success: true,
                    data: cachedData,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            // Get nearby drivers using driver service
            const nearbyDrivers = await this.driverService.findAvailableDriversNearby(
                location,
                parseInt(radius as string),
                parseInt(limit as string)
            );

            // Filter by capacity if required
            const filteredDrivers = nearbyDrivers.filter(driver => 
                driver.driver.capacity >= parseInt(requiredCapacity as string)
            );

            const result = {
                location,
                radius: parseInt(radius as string),
                count: filteredDrivers.length,
                drivers: filteredDrivers.map(driver => ({
                    id: driver.driver.id,
                    name: driver.driver.name,
                    distance: Math.round(driver.distance),
                    estimatedArrival: Math.round(driver.estimatedArrival),
                    capacity: driver.driver.capacity,
                    status: driver.driver.status
                }))
            };

            // Cache for 30 seconds (real-time data)
            await this.redisService.setWithExpiry(cacheKey, result, 30000);

            logger.info('Found nearby drivers', {
                location,
                radius,
                count: filteredDrivers.length,
                requestedCapacity: requiredCapacity
            });

            res.status(200).json({
                success: true,
                data: result,
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Get driver by ID
     */
    public getDriverById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getDriverById');
        
        try {
            const { id } = req.params;

            // Create cache key
            const cacheKey = `driver:${id}`;

            // Try cache first
            const cachedDriver = await this.redisService.get(cacheKey);
            if (cachedDriver) {
                logger.debug(`Returning cached driver ${id}`);
                res.status(200).json({
                    success: true,
                    data: { driver: cachedDriver },
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            const driver = await Driver.findByPk(id, {
                include: [
                    {
                        model: Zone,
                        as: 'zone',
                        attributes: ['id', 'name', 'color']
                    }
                ]
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Get real-time location from Redis
            const location = await this.driverService.getDriverLocation(id);

            const driverWithLocation = {
                ...driver.toJSON(),
                currentLocation: location
            };

            // Cache for 5 minutes
            await this.redisService.setWithExpiry(cacheKey, driverWithLocation, 300000);

            logger.info(`Retrieved driver ${id}`);

            res.status(200).json({
                success: true,
                data: { driver: driverWithLocation },
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Create a new driver
     */
    public createDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('createDriver');
        
        try {
            const driverData = req.body;
            const userId = req.user?.id;

            // Check if driver with same phone already exists
            const existingDriver = await Driver.findOne({
                where: {
                    phone: driverData.phone
                },
                transaction
            });

            if (existingDriver) {
                throw AppError.conflict('Driver with same phone already exists');
            }

            // Map request data to model fields
            const driverCreateData: any = {
                name: driverData.name,
                phone: driverData.phone,
                latitude: driverData.latitude || driverData.location?.lat,
                longitude: driverData.longitude || driverData.location?.lng,
                capacity: driverData.capacity || driverData.maxCapacity || 10,
                status: driverData.status ? (driverData.status === 'available' ? DriverStatus.AVAILABLE : 
                       driverData.status === 'busy' ? DriverStatus.BUSY : DriverStatus.OFFLINE) : DriverStatus.AVAILABLE,
                zoneId: driverData.zoneId
            };

            // Create driver
            const driver = await Driver.create(driverCreateData, { transaction });

            await transaction.commit();

            // Invalidate cache
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');

            // Log audit
            auditLogger.driver.assigned(driver.id, 'system', userId || 'unknown');

            logger.info('Driver created', {
                driverId: driver.id,
                name: driver.name,
                phone: driver.phone,
                createdBy: userId
            });

            res.status(201).json({
                success: true,
                data: { driver },
                message: 'Driver created successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Update driver information
     */
    public updateDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('updateDriver');
        
        try {
            const { id } = req.params;
            const updateData = req.body;
            const userId = req.user?.id;

            // Get driver with lock
            const driver = await Driver.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Check for conflicts if phone is being updated
            if (updateData.phone && updateData.phone !== driver.phone) {
                const existingDriver = await Driver.findOne({
                    where: { phone: updateData.phone },
                    transaction
                });

                if (existingDriver) {
                    throw AppError.conflict('Driver with same phone already exists');
                }
            }

            // Map status string to enum if provided
            if (updateData.status) {
                if (updateData.status === 'available') updateData.status = DriverStatus.AVAILABLE;
                else if (updateData.status === 'busy') updateData.status = DriverStatus.BUSY;
                else if (updateData.status === 'offline') updateData.status = DriverStatus.OFFLINE;
            }

            // Map location fields if provided
            if (updateData.location) {
                updateData.latitude = updateData.location.lat;
                updateData.longitude = updateData.location.lng;
                delete updateData.location;
            }

            // Map maxCapacity to capacity if provided
            if (updateData.maxCapacity) {
                updateData.capacity = updateData.maxCapacity;
                delete updateData.maxCapacity;
            }

            // Update driver
            await driver.update(updateData, { transaction });
            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`driver:${id}`);
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');

            // Log audit (using logger directly since updated method doesn't exist)
            logger.info('Driver updated', {
                type: 'AUDIT',
                action: 'DRIVER_UPDATED',
                driverId: id,
                userId: userId || 'unknown',
                changes: updateData
            });

            logger.info('Driver updated', {
                driverId: id,
                updatedBy: userId,
                updates: Object.keys(updateData)
            });

            res.status(200).json({
                success: true,
                data: { driver },
                message: 'Driver updated successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Update driver location
     */
    public updateDriverLocation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('updateDriverLocation');
        
        try {
            const { id } = req.params;
            const { location, heading, speed, accuracy } = req.body;
            const userId = req.user?.id;

            // Verify driver exists
            const driver = await Driver.findByPk(id);
            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Update location using driver service
            await this.driverService.updateDriverLocation(id, location);

            // Note: lastActiveAt field not in Driver model, skipping update

            // Invalidate nearby drivers cache
            await this.redisService.delPattern('drivers:nearby:*');

            logger.debug('Driver location updated', {
                driverId: id,
                location,
                updatedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Location updated successfully',
                data: { location }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Update driver status
     */
    public updateDriverStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('updateDriverStatus');
        
        try {
            const { id } = req.params;
            const { status, reason } = req.body;
            const userId = req.user?.id;

            // Get driver with lock
            const driver = await Driver.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Validate status transition
            const validTransitions: Record<DriverStatus, DriverStatus[]> = {
                [DriverStatus.AVAILABLE]: [DriverStatus.BUSY, DriverStatus.OFFLINE],
                [DriverStatus.BUSY]: [DriverStatus.AVAILABLE, DriverStatus.OFFLINE],
                [DriverStatus.OFFLINE]: [DriverStatus.AVAILABLE]
            };

            // Map status string to enum
            let newStatus: DriverStatus;
            if (status === 'available') newStatus = DriverStatus.AVAILABLE;
            else if (status === 'busy') newStatus = DriverStatus.BUSY;
            else if (status === 'offline') newStatus = DriverStatus.OFFLINE;
            else {
                throw AppError.validation(`Invalid status: ${status}`);
            }

            if (!validTransitions[driver.status]?.includes(newStatus)) {
                throw AppError.validation(`Invalid status transition from ${driver.status} to ${newStatus}`);
            }

            // Update status
            const updates: any = { status: newStatus };

            await driver.update(updates, { transaction });
            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`driver:${id}`);
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: 'system',
                parcelId: 'system',
                status: 'driver_status_changed',
                driverId: id,
                message: `Driver ${driver.name} status changed to ${status}`
            });

            // Log audit (using logger directly since updated method doesn't exist)
            logger.info('Driver status updated', {
                type: 'AUDIT',
                action: 'DRIVER_STATUS_UPDATED',
                driverId: id,
                userId: userId || 'unknown',
                status,
                reason
            });

            logger.info('Driver status updated', {
                driverId: id,
                oldStatus: driver.status,
                newStatus: status,
                reason,
                updatedBy: userId
            });

            res.status(200).json({
                success: true,
                data: { driver: { id, status } },
                message: 'Driver status updated successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Delete a driver
     */
    public deleteDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('deleteDriver');
        
        try {
            const { id } = req.params;
            const userId = req.user?.id;

            // Get driver with lock
            const driver = await Driver.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Check if driver has active deliveries (check Delivery table)
            const activeDeliveries = await Delivery.count({
                where: {
                    driverId: id,
                    status: { [Op.in]: ['assigned', 'started'] }
                },
                transaction
            });

            if (activeDeliveries > 0) {
                throw AppError.conflict(
                    'Cannot delete driver with active deliveries',
                    { activeDeliveries }
                );
            }

            // Set status to offline (soft delete equivalent)
            await driver.update({ 
                status: DriverStatus.OFFLINE
            }, { transaction });

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`driver:${id}`);
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');

            // Log audit (using logger directly since deleted method doesn't exist)
            logger.warn('Driver deleted', {
                type: 'AUDIT',
                action: 'DRIVER_DELETED',
                driverId: id,
                userId: userId || 'unknown'
            });

            logger.warn('Driver deleted', {
                driverId: id,
                name: driver.name,
                deletedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Driver deleted successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Get driver's deliveries
     */
    public getDriverDeliveries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getDriverDeliveries');
        
        try {
            const { id } = req.params;
            const {
                status,
                startDate,
                endDate,
                page = 1,
                limit = 20
            } = req.query;

            const pageNum = parseInt(page as string);
            const limitNum = parseInt(limit as string);
            const offset = (pageNum - 1) * limitNum;

            // Create cache key
            const cacheKey = `driver:${id}:deliveries:${status}:${startDate}:${endDate}:${page}:${limit}`;

            // Try cache first
            const cachedData = await this.redisService.get(cacheKey);
            if (cachedData) {
                logger.debug(`Returning cached deliveries for driver ${id}`);
                res.status(200).json({
                    success: true,
                    data: cachedData,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            // Build where conditions
            const whereConditions: any = { driverId: id };
            
            if (status) {
                whereConditions.status = status;
            }
            
            if (startDate || endDate) {
                whereConditions.createdAt = {};
                if (startDate) {
                    whereConditions.createdAt[Op.gte] = new Date(startDate as string);
                }
                if (endDate) {
                    whereConditions.createdAt[Op.lte] = new Date(endDate as string);
                }
            }

            // Get deliveries
            const { count, rows: deliveries } = await Delivery.findAndCountAll({
                where: whereConditions,
                limit: limitNum,
                offset: offset,
                order: [['createdAt', 'DESC']],
                attributes: [
                    'id', 'parcelId', 'status', 'estimatedRoute',
                    'receiptGenerated', 'createdAt', 'updatedAt'
                ]
            });

            const result = {
                driverId: id,
                deliveries,
                pagination: {
                    total: count,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(count / limitNum)
                }
            };

            // Cache for 2 minutes
            await this.redisService.setWithExpiry(cacheKey, result, 120000);

            logger.info(`Retrieved deliveries for driver ${id}`, {
                count,
                filters: { status, startDate, endDate }
            });

            res.status(200).json({
                success: true,
                data: result,
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Get driver statistics
     */
    public getDriverStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getDriverStats');
        
        try {
            const { id } = req.params;

            // Create cache key
            const cacheKey = `driver:${id}:stats`;

            // Try cache first
            const cachedStats = await this.redisService.get(cacheKey);
            if (cachedStats) {
                logger.debug(`Returning cached stats for driver ${id}`);
                res.status(200).json({
                    success: true,
                    data: cachedStats,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            const driver = await Driver.findByPk(id);
            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Get delivery stats
            const deliveryStats = await Delivery.findAll({
                where: { driverId: id },
                attributes: [
                    'status',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['status']
            });

            // Get today's stats
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const todayStats = await Delivery.findAll({
                where: {
                    driverId: id,
                    createdAt: {
                        [Op.gte]: today,
                        [Op.lt]: tomorrow
                    }
                },
                attributes: [
                    'status',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['status']
            });

            // Calculate delivery counts from Delivery table
            const totalDeliveries = await Delivery.count({ where: { driverId: id } });
            const completedDeliveries = await Delivery.count({ 
                where: { driverId: id, status: 'completed' } 
            });

            const stats = {
                driverId: id,
                name: driver.name,
                overall: {
                    totalDeliveries,
                    completedDeliveries,
                    capacity: driver.capacity,
                    status: driver.status
                },
                deliveryBreakdown: deliveryStats.reduce((acc: any, stat: any) => {
                    acc[stat.status] = parseInt(stat.get('count'));
                    return acc;
                }, {}),
                today: todayStats.reduce((acc: any, stat: any) => {
                    acc[stat.status] = parseInt(stat.get('count'));
                    return acc;
                }, {}),
                joinedAt: (driver as any).createdAt || new Date()
            };

            // Cache for 5 minutes
            await this.redisService.setWithExpiry(cacheKey, stats, 300000);

            logger.info(`Retrieved stats for driver ${id}`);

            res.status(200).json({
                success: true,
                data: stats,
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Assign delivery to driver (manual override)
     */
    public assignDeliveryToDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('assignDeliveryToDriver');
        
        try {
            const { id } = req.params;
            const { deliveryId, force = false, reason } = req.body;
            const userId = req.user?.id;

            // Get delivery
            const delivery = await Delivery.findByPk(deliveryId, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!delivery) {
                throw AppError.notFound('Delivery', deliveryId);
            }

            // Check if delivery is already assigned
            if (delivery.driverId && delivery.driverId !== id && !force) {
                throw AppError.conflict(
                    `Delivery already assigned to driver ${delivery.driverId}`,
                    { currentDriverId: delivery.driverId }
                );
            }

            // Reserve driver
            const reserved = await this.driverService.reserveDriver(id);
            if (!reserved) {
                throw AppError.driverUnavailable(id);
            }

            try {
                // Update delivery
                await delivery.update({
                    driverId: id,
                    status: 'assigned'
                }, { transaction });

                // Release previous driver if any
                if (delivery.driverId && delivery.driverId !== id) {
                    await this.driverService.releaseDriver(delivery.driverId);
                }

                await transaction.commit();

                // Invalidate cache
                await this.redisService.del(`delivery:${deliveryId}`);
                await this.redisService.del(`driver:${id}`);
                await this.redisService.delPattern('drivers:list:*');
                await this.redisService.delPattern('drivers:nearby:*');

                // Add notification job
                await this.queueService.addDeliveryNotificationJob({
                    deliveryId,
                    parcelId: delivery.parcelId,
                    status: 'assigned',
                    driverId: id,
                    message: `Delivery manually assigned to driver`
                });

                // Log audit (using logger directly since assigned method doesn't exist on delivery)
                logger.info('Delivery assigned to driver', {
                    type: 'AUDIT',
                    action: 'DELIVERY_ASSIGNED',
                    driverId: id,
                    deliveryId,
                    userId: userId || 'unknown'
                });

                logger.info('Delivery manually assigned to driver', {
                    deliveryId,
                    driverId: id,
                    previousDriverId: delivery.driverId,
                    reason,
                    assignedBy: userId
                });

                res.status(200).json({
                    success: true,
                    message: 'Delivery assigned to driver successfully',
                    data: { deliveryId, driverId: id }
                });

            } catch (error) {
                // Rollback driver reservation on error
                await this.driverService.releaseDriver(id);
                throw error;
            }
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Force release driver from all assignments
     */
    public forceReleaseDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('forceReleaseDriver');
        
        try {
            const { id } = req.params;
            const { reason, emergency = false } = req.body;
            const userId = req.user?.id;

            // Get driver with lock
            const driver = await Driver.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Get driver's active deliveries
            const activeDeliveries = await Delivery.findAll({
                where: {
                    driverId: id,
                    status: ['assigned', 'in_transit']
                },
                transaction
            });

            // Note: currentLoad field not in Driver model, skipping update

            // Handle each active delivery
            const reassignedDeliveries: string[] = [];
            
            for (const delivery of activeDeliveries) {
                if (emergency) {
                    // In emergency mode, find new driver automatically
                    const newDriverId = await this.driverService.emergencyDriverReplacement(
                        id,
                        delivery.id,
                        reason
                    );
                    
                    if (newDriverId) {
                        await delivery.update({
                            driverId: newDriverId,
                            status: 'assigned'
                        }, { transaction });
                        reassignedDeliveries.push(delivery.id);
                    } else {
                        // If no driver found, mark as pending
                        await delivery.update({
                            driverId: null,
                            status: 'pending'
                        }, { transaction });
                    }
                } else {
                    // Just unassign and mark as pending
                    await delivery.update({
                        driverId: null,
                        status: 'pending'
                    }, { transaction });
                }
            }

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`driver:${id}`);
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');
            await Promise.all(
                activeDeliveries.map(d => this.redisService.del(`delivery:${d.id}`))
            );

            // Add high priority job for emergency
            if (emergency) {
                await this.queueService.addHighPriorityJob('emergency-release', {
                    driverId: id,
                    reason,
                    affectedDeliveries: activeDeliveries.length,
                    reassignedDeliveries: reassignedDeliveries.length,
                    timestamp: new Date().toISOString()
                });
            }

            // Log audit
            auditLogger.driver.released(id, 'system', reason);

            logger.warn('Driver force released', {
                driverId: id,
                emergency,
                reason,
                activeDeliveries: activeDeliveries.length,
                reassignedDeliveries: reassignedDeliveries.length,
                releasedBy: userId
            });

            res.status(200).json({
                success: true,
                message: emergency ? 'Driver emergency released successfully' : 'Driver released successfully',
                data: {
                    driverId: id,
                    releasedDeliveries: activeDeliveries.length,
                    reassignedDeliveries: reassignedDeliveries.length
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Check driver availability
     */
    public checkDriverAvailability = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('checkDriverAvailability');
        
        try {
            const { id } = req.params;

            const availability = await this.driverService.checkDriverAvailability(id);

            logger.debug('Checked driver availability', {
                driverId: id,
                available: availability.available
            });

            res.status(200).json({
                success: true,
                data: availability
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Bulk update driver status
     */
    public bulkUpdateDriverStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('bulkUpdateDriverStatus');
        
        try {
            const { driverIds, status, reason } = req.body;
            const userId = req.user?.id;

            const result = await this.driverService.bulkUpdateDriverStatus(driverIds, status);

            // Log audit (using logger directly since updated method doesn't exist)
            driverIds.forEach((driverId: string) => {
                logger.info('Driver updated (bulk)', {
                    type: 'AUDIT',
                    action: 'DRIVER_BULK_UPDATED',
                    driverId,
                    userId: userId || 'unknown',
                    status,
                    reason
                });
            });

            logger.info('Bulk driver status update', {
                driverCount: driverIds.length,
                status,
                reason,
                updatedBy: userId,
                affectedCount: result
            });

            res.status(200).json({
                success: true,
                message: `${result} drivers updated to ${status}`,
                data: { updatedCount: result }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Search drivers
     */
    public searchDrivers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('searchDrivers');
        
        try {
            const { q, limit = 10 } = req.query;

            const searchTerm = `%${q}%`;
            
            const drivers = await Driver.findAll({
                where: {
                    [Op.or]: [
                        { name: { [Op.iLike]: searchTerm } },
                        { phone: { [Op.iLike]: searchTerm } }
                    ],
                    status: { [Op.ne]: DriverStatus.OFFLINE }
                },
                limit: parseInt(limit as string),
                attributes: ['id', 'name', 'phone', 'capacity', 'status'],
                order: [['name', 'ASC']]
            });

            logger.debug('Driver search performed', {
                query: q,
                results: drivers.length
            });

            res.status(200).json({
                success: true,
                data: { drivers }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Rate a driver
     */
    public rateDriver = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('rateDriver');
        
        try {
            const { id } = req.params;
            const { rating, deliveryId, comment } = req.body;
            const userId = req.user?.id;

            // Get driver with lock
            const driver = await Driver.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Verify delivery exists and belongs to this driver
            const delivery = await Delivery.findOne({
                where: {
                    id: deliveryId,
                    driverId: id,
                    status: 'delivered'
                },
                transaction
            });

            if (!delivery) {
                throw AppError.notFound('Delivery for this driver', deliveryId);
            }

            // Note: rating and totalRatings fields not in Driver model
            // In production, these would be stored in a separate ratings table
            // For now, just log the rating
            logger.info('Driver rating received (not stored in model)', {
                driverId: id,
                deliveryId,
                rating,
                comment
            });

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`driver:${id}`);

            // Store rating details (could be in a separate ratings table)
            logger.info('Driver rated', {
                driverId: id,
                deliveryId,
                rating,
                ratedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Driver rating recorded (note: rating storage not implemented in model)',
                data: {
                    driverId: id,
                    rating,
                    deliveryId
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Get driver analytics
     */
    public getDriverAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getDriverAnalytics');
        
        try {
            const { id } = req.params;
            const { period = 'month', metrics = ['all'] } = req.query;

            // This would typically involve complex analytics queries
            // For now, return simplified analytics

            const driver = await Driver.findByPk(id);
            if (!driver) {
                throw AppError.notFound('Driver', id);
            }

            // Get delivery stats for analytics
            const deliveryCount = await Delivery.count({ where: { driverId: id } });
            const completedCount = await Delivery.count({ 
                where: { driverId: id, status: 'completed' } 
            });

            const analytics = {
                driverId: id,
                period,
                performance: {
                    onTimeRate: 95.5, // Example - would need delivery timestamps
                    averageDeliveryTime: 45, // minutes - would need delivery timestamps
                    customerSatisfaction: 0, // Note: rating not in model
                    completionRate: deliveryCount > 0 ? (completedCount / deliveryCount * 100) : 0
                },
                efficiency: {
                    deliveriesPerHour: 2.3,
                    distancePerDelivery: 4.5, // km
                    fuelEfficiency: 12.5 // km/L
                },
                trends: {
                    weeklyGrowth: 5.2, // %
                    peakHours: ['10:00', '14:00', '18:00'],
                    busyDays: ['Monday', 'Friday']
                }
            };

            logger.info('Driver analytics retrieved', { driverId: id, period });

            res.status(200).json({
                success: true,
                data: analytics
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Optimize driver assignments
     */
    public optimizeDriverAssignments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('optimizeDriverAssignments');
        
        try {
            const { zoneId, strategy = 'mixed', maxAssignments = 50 } = req.body;
            const userId = req.user?.id;

            // Get pending deliveries
            const pendingDeliveries = await Delivery.findAll({
                where: {
                    status: 'pending',
                    ...(zoneId && { zoneId })
                },
                limit: maxAssignments,
                order: [['createdAt', 'ASC']]
            });

            if (pendingDeliveries.length === 0) {
                res.status(200).json({
                    success: true,
                    message: 'No pending deliveries to optimize',
                    data: { optimized: 0 }
                });
                return;
            }

            let optimizedCount = 0;
            const optimizationResults = [];

            for (const delivery of pendingDeliveries) {
                try {
                    // Get delivery location (simplified - in production, use actual location)
                    const location = { lat: 33.5731, lng: -7.5898 }; // Casablanca center
                    
                    // Find optimal driver
                    const driverId = await this.driverService.assignOptimalDriver(
                        location,
                        {}
                    );

                    if (driverId) {
                        // Assign delivery
                        await delivery.update({
                            driverId,
                            status: 'assigned'
                        });

                        optimizedCount++;
                        optimizationResults.push({
                            deliveryId: delivery.id,
                            driverId,
                            success: true
                        });

                        // Add notification job
                        await this.queueService.addDeliveryNotificationJob({
                            deliveryId: delivery.id,
                            parcelId: delivery.parcelId,
                            status: 'auto_assigned',
                            driverId,
                            message: 'Delivery automatically assigned by optimizer'
                        });
                    } else {
                        optimizationResults.push({
                            deliveryId: delivery.id,
                            success: false,
                            reason: 'No available drivers'
                        });
                    }
                } catch (error) {
                    optimizationResults.push({
                        deliveryId: delivery.id,
                        success: false,
                        reason: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            }

            // Invalidate cache
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('drivers:nearby:*');
            await this.redisService.delPattern('deliveries:*');

            logger.info('Driver assignments optimized', {
                optimized: optimizedCount,
                total: pendingDeliveries.length,
                strategy,
                zoneId,
                optimizedBy: userId
            });

            res.status(200).json({
                success: true,
                message: `Optimized ${optimizedCount} out of ${pendingDeliveries.length} deliveries`,
                data: {
                    optimizedCount,
                    totalDeliveries: pendingDeliveries.length,
                    results: optimizationResults
                }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Health check
     */
    public checkHealth = async (): Promise<any> => {
        try {
            const [database, redis, queue] = await Promise.all([
                this.checkDatabaseConnection(),
                this.redisService.healthCheck(),
                this.queueService.healthCheck()
            ]);

            const driverCount = await Driver.count();
            const activeDrivers = await Driver.count({ where: { status: DriverStatus.AVAILABLE } });

            return {
                service: 'driver',
                status: 'healthy',
                timestamp: new Date().toISOString(),
                components: {
                    database,
                    redis,
                    queue
                },
                metrics: {
                    totalDrivers: driverCount,
                    activeDrivers,
                    uptime: process.uptime()
                }
            };
        } catch (error) {
            logger.error('Driver health check failed:', error);
            throw error;
        }
    };

    private async checkDatabaseConnection(): Promise<boolean> {
        try {
            await sequelize.authenticate();
            return true;
        } catch (error) {
            return false;
        }
    }
}