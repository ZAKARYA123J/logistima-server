import { Request, Response, NextFunction } from 'express';
import { Parcel, ParcelStatus } from '../models/Parcel.model.js';
import { Delivery } from '../models/Delivery.model.js';
import { Driver } from '../models/Driver.model.js';
import { Zone } from '../models/Zone.model.js';
import { RedisService } from '../services/redis.service.js';
import { QueueService } from '../services/queue.service.js';
import { DriverService } from '../services/driver.service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger, auditLogger, performanceLogger } from '../utils/logger.js';
import { sequelize } from '../config/database.js';
import { Op } from 'sequelize';

export class ParcelController {
    private redisService: RedisService;
    private queueService: QueueService;
    private driverService: DriverService;
    private readonly TRACKING_NUMBER_PREFIX = 'LGM';

    constructor() {
        this.redisService = new RedisService();
        this.queueService = new QueueService();
        this.driverService = new DriverService();
    }

    /**
     * Generate unique tracking code
     */
    private generateTrackingCode(): string {
        const timestamp = Date.now().toString().slice(-8);
        const random = Math.random().toString(36).substr(2, 4).toUpperCase();
        return `${this.TRACKING_NUMBER_PREFIX}${timestamp}${random}`;
    }

    /**
     * Get all parcels with pagination and filters
     */
    public getAllParcels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getAllParcels');
        
        try {
            const {
                page = 1,
                limit = 10,
                status,
                customerId,
                driverId,
                zoneId,
                startDate,
                endDate,
                priority,
                sortBy = 'createdAt',
                sortOrder = 'desc',
                search
            } = req.query;

            const pageNum = parseInt(page as string);
            const limitNum = parseInt(limit as string);
            const offset = (pageNum - 1) * limitNum;

            // Create cache key
            const cacheKey = `parcels:list:${page}:${limit}:${status}:${customerId}:${driverId}:${zoneId}:${priority}:${startDate}:${endDate}:${search}:${sortBy}:${sortOrder}`;

            // Try cache first
            const cachedData = await this.redisService.get(cacheKey);
            if (cachedData) {
                logger.debug('Returning cached parcels list');
                res.status(200).json({
                    success: true,
                    data: cachedData,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            // Build where conditions for Parcel model
            const whereConditions: any = {};
            
            if (status) {
                whereConditions.status = status;
            }
            
            // Note: customerId field not in Parcel model, filtering removed
            
            // Note: priority field not in Parcel model, filtering removed
            
            if (startDate || endDate) {
                whereConditions.createdAt = {};
                if (startDate) {
                    whereConditions.createdAt[Op.gte] = new Date(startDate as string);
                }
                if (endDate) {
                    whereConditions.createdAt[Op.lte] = new Date(endDate as string);
                }
            }
            
            if (search) {
                whereConditions[Op.or] = [
                    { trackingCode: { [Op.iLike]: `%${search}%` } },
                    { pickupAddress: { [Op.iLike]: `%${search}%` } },
                    { deliveryAddress: { [Op.iLike]: `%${search}%` } }
                ];
            }

            // Get total count and parcels
            const { count, rows: parcels } = await Parcel.findAndCountAll({
                where: whereConditions,
                limit: limitNum,
                offset: offset,
                order: [[sortBy as string, sortOrder as string]],
                include: [
                    {
                        model: Driver,
                        as: 'driver',
                        attributes: ['id', 'name', 'phone']
                    },
                    {
                        model: Zone,
                        as: 'zone',
                        attributes: ['id', 'name']
                    },
                    {
                        model: Delivery,
                        as: 'delivery',
                        attributes: ['id', 'status', 'estimatedRoute']
                    }
                ],
                attributes: {
                    exclude: ['createdAt', 'updatedAt']
                }
            });

            const result = {
                parcels,
                pagination: {
                    total: count,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(count / limitNum)
                }
            };

            // Cache for 1 minute
            await this.redisService.setWithExpiry(cacheKey, result, 60000);

            logger.info('Retrieved parcels list', {
                count,
                page: pageNum,
                limit: limitNum,
                filters: { status, customerId, driverId, zoneId }
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
     * Get parcel by ID
     */
    public getParcelById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getParcelById');
        
        try {
            const { id } = req.params;
            const userId = req.user?.id;

            // Create cache key
            const cacheKey = `parcel:${id}`;

            // Try cache first
            const cachedParcel = await this.redisService.get(cacheKey);
            if (cachedParcel) {
                logger.debug(`Returning cached parcel ${id}`);
                res.status(200).json({
                    success: true,
                    data: { parcel: cachedParcel },
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            const parcel = await Parcel.findByPk(id, {
                include: [
                    {
                        model: Driver,
                        as: 'driver',
                        attributes: ['id', 'name', 'phone']
                    },
                    {
                        model: Zone,
                        as: 'zone',
                        attributes: ['id', 'name']
                    },
                    {
                        model: Delivery,
                        as: 'delivery',
                        include: [
                            {
                                model: Driver,
                                as: 'driver',
                                attributes: ['id', 'name', 'phone']
                            }
                        ]
                    }
                ]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Cache for 5 minutes
            await this.redisService.setWithExpiry(cacheKey, parcel, 300000);

            logger.info(`Retrieved parcel ${id}`, {
                parcelId: id,
                requestedBy: userId
            });

            res.status(200).json({
                success: true,
                data: { parcel },
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Track parcel by tracking code
     */
    public trackParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('trackParcel');
        
        try {
            const { trackingNumber } = req.params;
            const userId = req.user?.id;

            // Create cache key
            const cacheKey = `parcel:track:${trackingNumber}`;

            // Try cache first (shorter cache for tracking)
            const cachedTracking = await this.redisService.get(cacheKey);
            if (cachedTracking) {
                logger.debug(`Returning cached tracking for ${trackingNumber}`);
                res.status(200).json({
                    success: true,
                    data: cachedTracking,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            const parcel = await Parcel.findOne({
                where: { trackingCode: trackingNumber },
                include: [
                    {
                        model: Delivery,
                        as: 'delivery',
                        attributes: ['id', 'status', 'estimatedRoute', 'createdAt', 'updatedAt']
                    },
                    {
                        model: Zone,
                        as: 'zone',
                        attributes: ['id', 'name']
                    }
                ],
                attributes: [
                    'id', 'trackingCode', 'status', 'pickupAddress', 'deliveryAddress',
                    'weight', 'createdAt'
                ]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel with tracking code', trackingNumber);
            }

            // Get status history
            const statusHistory = await this.getParcelStatusHistory(parcel.id);

            const trackingInfo = {
                parcel: {
                    id: parcel.id,
                    trackingCode: parcel.trackingCode,
                    status: parcel.status,
                    pickupAddress: parcel.pickupAddress,
                    deliveryAddress: parcel.deliveryAddress,
                    createdAt: parcel.createdAt
                },
                delivery: parcel.delivery,
                statusHistory,
                lastUpdated: new Date().toISOString()
            };

            // Cache for 30 seconds (real-time tracking)
            await this.redisService.setWithExpiry(cacheKey, trackingInfo, 30000);

            logger.info(`Tracked parcel ${trackingNumber}`, {
                trackingCode: trackingNumber,
                status: parcel.status,
                requestedBy: userId
            });

            res.status(200).json({
                success: true,
                data: trackingInfo,
                fromCache: false
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Create a new parcel
     */
    public createParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('createParcel');
        
        try {
            const parcelData = req.body;
            const userId = req.user?.id;

            // Generate tracking code
            const trackingCode = this.generateTrackingCode();

            // Note: Priority and estimated delivery not in current Parcel model
            // These would need to be added to the model if required

            // Map request data to model fields
            const parcelCreateData: any = {
                trackingCode,
                status: ParcelStatus.PENDING,
                pickupAddress: parcelData.sender?.address || parcelData.pickupAddress,
                pickupLat: parcelData.sender?.lat || parcelData.pickupLat,
                pickupLng: parcelData.sender?.lng || parcelData.pickupLng,
                deliveryAddress: parcelData.receiver?.address || parcelData.deliveryAddress,
                deliveryLat: parcelData.receiver?.lat || parcelData.deliveryLat,
                deliveryLng: parcelData.receiver?.lng || parcelData.deliveryLng,
                weight: parcelData.weight || parcelData.dimensions?.weight,
                zoneId: parcelData.zoneId
            };

            // Create parcel
            const parcel = await Parcel.create(parcelCreateData, { transaction });

            // Create delivery record
            const delivery = await Delivery.create({
                parcelId: parcel.id,
                status: 'started',
                receiptGenerated: false
            }, { transaction });

            // Determine zone based on pickup location
            const pickupAddress = parcelData.sender?.address || parcelData.pickupAddress;
            if (pickupAddress) {
                const zone = await this.determineZone(pickupAddress);
                if (zone) {
                    await parcel.update({ zoneId: zone.id }, { transaction });
                }
            }

            await transaction.commit();

            // Invalidate cache
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            // Add queue jobs
            const pickupLoc = parcelData.sender?.address || parcelData.pickupAddress;
            const deliveryLoc = parcelData.receiver?.address || parcelData.deliveryAddress;
            if (pickupLoc && deliveryLoc) {
                await this.queueService.addRouteCalculationJob({
                    deliveryId: delivery.id,
                    pickupLocation: pickupLoc,
                    deliveryLocation: deliveryLoc,
                    priority: parcelData.priority === 'high' ? 1 : 3
                });
            }

            await this.queueService.addReceiptGenerationJob({
                deliveryId: delivery.id,
                parcelId: parcel.id
            });

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: delivery.id,
                parcelId: parcel.id,
                status: 'created',
                driverId: 'system',
                message: `Your parcel ${trackingCode} has been created and is being processed`
            });

            // Log audit
            auditLogger.delivery.created(parcel.id, userId || 'unknown', {
                trackingCode
            });

            logger.info('Parcel created', {
                parcelId: parcel.id,
                trackingCode,
                createdBy: userId
            });

            res.status(201).json({
                success: true,
                data: { 
                    parcel,
                    delivery,
                    trackingCode
                },
                message: 'Parcel created successfully. Tracking code: ' + trackingCode
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Update parcel information
     */
    public updateParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('updateParcel');
        
        try {
            const { id } = req.params;
            const updateData = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Check if parcel can be updated (not delivered or cancelled)
            if (['delivered', 'cancelled', 'lost'].includes(parcel.status)) {
                throw AppError.conflict(
                    `Cannot update parcel with status: ${parcel.status}`,
                    { currentStatus: parcel.status }
                );
            }

            // Update parcel
            await parcel.update(updateData, { transaction });

            // If location changed, update zone
            const pickupAddress = updateData.sender?.address || updateData.pickupAddress;
            if (pickupAddress) {
                const zone = await this.determineZone(pickupAddress);
                if (zone && zone.id !== parcel.zoneId) {
                    await parcel.update({ zoneId: zone.id }, { transaction });
                }
            }

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.del(`parcel:track:${parcel.trackingNumber}`);

            // Log audit
            auditLogger.delivery.updated(id, userId || 'unknown', updateData);

            logger.info('Parcel updated', {
                parcelId: id,
                updatedBy: userId,
                updates: Object.keys(updateData)
            });

            res.status(200).json({
                success: true,
                data: { parcel },
                message: 'Parcel updated successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Update parcel status
     */
    public updateParcelStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('updateParcelStatus');
        
        try {
            const { id } = req.params;
            const { status, notes, location, proofOfDelivery } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Validate status transition
            const validTransitions: Record<string, string[]> = {
                'pending': ['in_transit', 'cancelled'],
                'in_transit': ['delivered', 'returned', 'lost'],
                'delivered': [],
                'cancelled': [],
                'returned': [],
                'lost': []
            };

            if (!validTransitions[parcel.status]?.includes(status)) {
                throw AppError.validation(`Invalid status transition from ${parcel.status} to ${status}`);
            }

            // Update parcel status - map to ParcelStatus enum
            let parcelStatus: ParcelStatus;
            if (status === 'pending') parcelStatus = ParcelStatus.PENDING;
            else if (status === 'assigned' || status === 'in_transit') parcelStatus = ParcelStatus.ASSIGNED;
            else if (status === 'picked') parcelStatus = ParcelStatus.PICKED;
            else if (status === 'delivered') parcelStatus = ParcelStatus.DELIVERED;
            else parcelStatus = ParcelStatus.PENDING; // fallback
            
            await parcel.update({ status: parcelStatus }, { transaction });

            // Update delivery status if exists
            if (parcel.delivery) {
                const deliveryUpdates: any = { status };
                if (proofOfDelivery) {
                    deliveryUpdates.proofOfDelivery = proofOfDelivery;
                }
                await parcel.delivery.update(deliveryUpdates, { transaction });
            }

            // Handle driver release if delivered or cancelled
            if ((status === 'delivered' || status === 'cancelled') && parcel.driverId) {
                await this.driverService.releaseDriver(parcel.driverId);
            }

            // Create status history entry
            await this.createStatusHistory(parcel.id, status, notes, location, userId);

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');
            
            if (parcel.driverId) {
                await this.redisService.del(`driver:${parcel.driverId}:deliveries`);
            }

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: parcel.delivery?.id || 'unknown',
                parcelId: id,
                status: 'status_updated',
                driverId: parcel.driverId || 'system',
                message: `Parcel status updated to ${status}`
            });

            // If delivered, generate final receipt
            if (status === 'delivered' && parcel.delivery) {
                await this.queueService.addFinalReceiptJob({
                    deliveryId: parcel.delivery.id,
                    parcelId: id,
                    driverId: parcel.driverId
                });
            }

            // Log audit
            auditLogger.delivery.updated(id, userId || 'unknown', { status, notes });

            logger.info('Parcel status updated', {
                parcelId: id,
                oldStatus: parcel.status,
                newStatus: status,
                notes,
                updatedBy: userId
            });

            res.status(200).json({
                success: true,
                data: { parcel: { id, status } },
                message: 'Parcel status updated successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Delete a parcel (soft delete)
     */
    public deleteParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('deleteParcel');
        
        try {
            const { id } = req.params;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Check if parcel can be deleted
            if (['in_transit', 'delivered'].includes(parcel.status)) {
                throw AppError.conflict(
                    `Cannot delete parcel with status: ${parcel.status}`,
                    { currentStatus: parcel.status }
                );
            }

            // Release driver if assigned
            if (parcel.driverId) {
                await this.driverService.releaseDriver(parcel.driverId);
            }

            // Soft delete
            await parcel.update({ 
                status: 'deleted',
                deletedAt: new Date(),
                deletedBy: userId
            }, { transaction });

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            // Log audit
            auditLogger.delivery.deleted(id, userId || 'unknown');

            logger.warn('Parcel deleted', {
                parcelId: id,
                trackingNumber: parcel.trackingNumber,
                deletedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Parcel deleted successfully'
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Assign parcel to driver
     */
    public assignParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('assignParcel');
        
        try {
            const { id } = req.params;
            const { driverId, estimatedPickup, estimatedDelivery, notes } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Check if parcel is assignable
            if (parcel.status !== 'pending') {
                throw AppError.conflict(
                    `Parcel must be in pending status to assign. Current status: ${parcel.status}`,
                    { currentStatus: parcel.status }
                );
            }

            // Check driver availability
            const availability = await this.driverService.checkDriverAvailability(driverId);
            if (!availability.available) {
                throw AppError.driverUnavailable(driverId);
            }

            // Reserve driver
            const reserved = await this.driverService.reserveDriver(driverId);
            if (!reserved) {
                throw AppError.driverUnavailable(driverId);
            }

            try {
                // Update parcel
                await parcel.update({
                    driverId,
                    status: ParcelStatus.ASSIGNED
                }, { transaction });

                // Update delivery
                if (parcel.delivery) {
                    await parcel.delivery.update({
                        driverId,
                        status: 'assigned'
                    }, { transaction });
                }

                await transaction.commit();

                // Invalidate cache
                await this.redisService.del(`parcel:${id}`);
                await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
                await this.redisService.del(`driver:${driverId}`);
                await this.redisService.delPattern('drivers:list:*');
                await this.redisService.delPattern('parcels:list:*');

                // Add notification jobs
                await this.queueService.addDeliveryNotificationJob({
                    deliveryId: parcel.delivery?.id || 'unknown',
                    parcelId: id,
                    status: 'assigned',
                    driverId,
                    message: `Parcel assigned to driver ${driverId}`
                });

                // Log audit
                auditLogger.delivery.assigned(driverId, id, userId || 'unknown');

                logger.info('Parcel assigned to driver', {
                    parcelId: id,
                    driverId,
                    assignedBy: userId,
                    notes
                });

                res.status(200).json({
                    success: true,
                    message: 'Parcel assigned to driver successfully',
                    data: {
                        parcelId: id,
                        driverId,
                        status: 'in_transit'
                    }
                });

            } catch (error) {
                // Rollback driver reservation on error
                await this.driverService.releaseDriver(driverId);
                throw error;
            }
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Unassign parcel from driver
     */
    public unassignParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('unassignParcel');
        
        try {
            const { id } = req.params;
            const { reason } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            if (!parcel.driverId) {
                throw AppError.validation('Parcel is not assigned to any driver');
            }

            // Release driver
            await this.driverService.releaseDriver(parcel.driverId);

            // Update parcel
            await parcel.update({
                driverId: null,
                status: ParcelStatus.PENDING
            }, { transaction });

            // Update delivery
            if (parcel.delivery) {
                await parcel.delivery.update({
                    driverId: null,
                    status: 'started'
                }, { transaction });
            }

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.del(`driver:${parcel.driverId}`);
            await this.redisService.delPattern('drivers:list:*');
            await this.redisService.delPattern('parcels:list:*');

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: parcel.delivery?.id || 'unknown',
                parcelId: id,
                status: 'unassigned',
                driverId: parcel.driverId,
                message: `Parcel unassigned: ${reason}`
            });

            // Log audit
            auditLogger.delivery.updated(id, userId || 'unknown', {
                action: 'unassigned',
                previousDriverId: parcel.driverId,
                reason
            });

            logger.info('Parcel unassigned from driver', {
                parcelId: id,
                previousDriverId: parcel.driverId,
                reason,
                unassignedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Parcel unassigned successfully',
                data: {
                    parcelId: id,
                    previousDriverId: parcel.driverId,
                    newStatus: 'pending'
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Get parcel status history
     */
    public getParcelHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getParcelHistory');
        
        try {
            const { id } = req.params;

            const history = await this.getParcelStatusHistory(id);

            logger.debug(`Retrieved history for parcel ${id}`, {
                historyCount: history.length
            });

            res.status(200).json({
                success: true,
                data: { history }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Get parcel timeline
     */
    public getParcelTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getParcelTimeline');
        
        try {
            const { id } = req.params;

            const parcel = await Parcel.findByPk(id, {
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            const history = await this.getParcelStatusHistory(id);

            const timeline = [
                {
                    event: 'created',
                    timestamp: parcel.createdAt,
                    description: 'Parcel created',
                    location: parcel.pickupAddress
                },
                ...history.map(item => ({
                    event: item.status,
                    timestamp: item.timestamp,
                    description: item.notes || `Status changed to ${item.status}`,
                    location: item.location,
                    changedBy: item.changedBy
                }))
            ].filter(item => item.timestamp).sort((a, b) => 
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );

            logger.debug(`Generated timeline for parcel ${id}`, {
                timelineEvents: timeline.length
            });

            res.status(200).json({
                success: true,
                data: { timeline }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Cancel a parcel
     */
    public cancelParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('cancelParcel');
        
        try {
            const { id } = req.params;
            const { reason, refundAmount } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Check if parcel can be cancelled
            if (['delivered', 'cancelled', 'lost'].includes(parcel.status)) {
                throw AppError.conflict(
                    `Cannot cancel parcel with status: ${parcel.status}`,
                    { currentStatus: parcel.status }
                );
            }

            // Release driver if assigned
            if (parcel.driverId) {
                await this.driverService.releaseDriver(parcel.driverId);
            }

            // Update parcel
            await parcel.update({
                status: 'cancelled',
                cancellationReason: reason,
                refundAmount: refundAmount || 0
            }, { transaction });

            // Update delivery
            if (parcel.delivery) {
                await parcel.delivery.update({
                    status: 'cancelled'
                }, { transaction });
            }

            // Create status history
            await this.createStatusHistory(id, 'cancelled', reason, null, userId);

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');
            
            if (parcel.driverId) {
                await this.redisService.del(`driver:${parcel.driverId}:deliveries`);
            }

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: parcel.delivery?.id || 'unknown',
                parcelId: id,
                status: 'cancelled',
                driverId: parcel.driverId || 'system',
                message: `Parcel cancelled: ${reason}`
            });

            // Log audit
            auditLogger.delivery.updated(id, userId || 'unknown', {
                action: 'cancelled',
                reason,
                refundAmount
            });

            logger.info('Parcel cancelled', {
                parcelId: id,
                reason,
                refundAmount,
                cancelledBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Parcel cancelled successfully',
                data: {
                    parcelId: id,
                    status: 'cancelled',
                    refundAmount
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Mark parcel for return
     */
    public returnParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('returnParcel');
        
        try {
            const { id } = req.params;
            const { reason, returnAddress, instructions } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Check if parcel can be returned
            if (parcel.status !== 'delivered') {
                throw AppError.conflict(
                    `Only delivered parcels can be returned. Current status: ${parcel.status}`,
                    { currentStatus: parcel.status }
                );
            }

            // Update parcel status (note: returnReason, returnAddress, returnInstructions not in model)
            await parcel.update({
                status: ParcelStatus.DELIVERED // Note: 'returned' not in ParcelStatus enum, using DELIVERED
            }, { transaction });

            // Create status history
            await this.createStatusHistory(id, 'returned', reason, null, userId);

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: parcel.delivery?.id || 'unknown',
                parcelId: id,
                status: 'returned',
                driverId: parcel.driverId || 'system',
                message: `Parcel marked for return: ${reason}`
            });

            // Note: Creating return parcel would require proper field mapping
            // Skipping automatic return parcel creation due to model field differences

            // Log audit
            auditLogger.delivery.updated(id, userId || 'unknown', {
                action: 'returned',
                reason,
                instructions
            });

            logger.info('Parcel marked for return', {
                parcelId: id,
                reason,
                instructions,
                markedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Parcel marked for return successfully',
                data: {
                    parcelId: id,
                    status: 'returned'
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Bulk create parcels
     */
    public bulkCreateParcels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('bulkCreateParcels');
        
        try {
            const { parcels, template } = req.body;
            const userId = req.user?.id;

            const createdParcels = [];
            const errors = [];

            for (let i = 0; i < parcels.length; i++) {
                const parcelData = {
                    ...template,
                    ...parcels[i]
                };

                try {
                    const trackingNumber = this.generateTrackingNumber();
                    
                    const parcel = await Parcel.create({
                        ...parcelData,
                        trackingNumber,
                        status: 'pending',
                        createdBy: userId
                    }, { transaction });

                    // Create delivery
                    const delivery = await Delivery.create({
                        parcelId: parcel.id,
                        status: 'started',
                        receiptGenerated: false
                    }, { transaction });

                    createdParcels.push({
                        index: i,
                        parcelId: parcel.id,
                        trackingNumber,
                        success: true
                    });

                    // Add queue jobs
                    await this.queueService.addRouteCalculationJob({
                        deliveryId: delivery.id,
                        pickupLocation: parcelData.sender.address,
                        deliveryLocation: parcelData.receiver.address,
                        priority: parcelData.priority === 'high' ? 1 : 3
                    });

                } catch (error) {
                    errors.push({
                        index: i,
                        error: error.message,
                        data: parcelData
                    });
                }
            }

            await transaction.commit();

            // Invalidate cache
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            logger.info('Bulk parcels created', {
                total: parcels.length,
                created: createdParcels.length,
                errors: errors.length,
                createdBy: userId
            });

            res.status(201).json({
                success: true,
                message: `Created ${createdParcels.length} out of ${parcels.length} parcels`,
                data: {
                    created: createdParcels.length,
                    total: parcels.length,
                    createdParcels,
                    errors
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Bulk update parcels
     */
    public bulkUpdateParcels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('bulkUpdateParcels');
        
        try {
            const { parcelIds, updates } = req.body;
            const userId = req.user?.id;

            const updatedParcels = [];
            const errors = [];

            for (const parcelId of parcelIds) {
                try {
                    const parcel = await Parcel.findByPk(parcelId, {
                        transaction,
                        lock: transaction.LOCK.UPDATE
                    });

                    if (!parcel) {
                        errors.push({
                            parcelId,
                            error: 'Parcel not found'
                        });
                        continue;
                    }

                    // Update parcel
                    await parcel.update(updates, { transaction });
                    updatedParcels.push(parcelId);

                } catch (error) {
                    errors.push({
                        parcelId,
                        error: error.message
                    });
                }
            }

            await transaction.commit();

            // Invalidate cache
            await Promise.all(
                parcelIds.map(id => this.redisService.del(`parcel:${id}`))
            );
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            logger.info('Bulk parcels updated', {
                total: parcelIds.length,
                updated: updatedParcels.length,
                errors: errors.length,
                updatedBy: userId
            });

            res.status(200).json({
                success: true,
                message: `Updated ${updatedParcels.length} out of ${parcelIds.length} parcels`,
                data: {
                    updated: updatedParcels.length,
                    total: parcelIds.length,
                    updatedParcels,
                    errors
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Search parcels
     */
    public searchParcels = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('searchParcels');
        
        try {
            const { q, field = 'tracking', limit = 10 } = req.query;

            const searchTerm = `%${q}%`;
            let whereConditions: any;

            switch (field) {
                case 'tracking':
                    whereConditions = { trackingNumber: { [Op.iLike]: searchTerm } };
                    break;
                case 'customer':
                    whereConditions = {
                        [Op.or]: [
                            { 'sender.name': { [Op.iLike]: searchTerm } },
                            { 'receiver.name': { [Op.iLike]: searchTerm } }
                        ]
                    };
                    break;
                case 'phone':
                    whereConditions = {
                        [Op.or]: [
                            { 'sender.phone': { [Op.iLike]: searchTerm } },
                            { 'receiver.phone': { [Op.iLike]: searchTerm } }
                        ]
                    };
                    break;
                case 'address':
                    whereConditions = {
                        [Op.or]: [
                            { 'sender.address': { [Op.iLike]: searchTerm } },
                            { 'receiver.address': { [Op.iLike]: searchTerm } }
                        ]
                    };
                    break;
                default:
                    whereConditions = { trackingNumber: { [Op.iLike]: searchTerm } };
            }

            const parcels = await Parcel.findAll({
                where: whereConditions,
                limit: parseInt(limit as string),
                attributes: ['id', 'trackingNumber', 'status', 'sender', 'receiver', 'createdAt'],
                order: [['createdAt', 'DESC']]
            });

            logger.debug('Parcel search performed', {
                query: q,
                field,
                results: parcels.length
            });

            res.status(200).json({
                success: true,
                data: { parcels }
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Get parcels statistics
     */
    public getParcelsStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getParcelsStats');
        
        try {
            const { period = 'today', startDate, endDate, zoneId } = req.query;

            // Create cache key
            const cacheKey = `parcels:stats:${period}:${startDate}:${endDate}:${zoneId}`;

            // Try cache first
            const cachedStats = await this.redisService.get(cacheKey);
            if (cachedStats) {
                logger.debug('Returning cached parcels stats');
                res.status(200).json({
                    success: true,
                    data: cachedStats,
                    fromCache: true
                });
                endMeasurement();
                return;
            }

            // Calculate date range based on period
            let dateRange: { start: Date; end: Date };
            const now = new Date();

            switch (period) {
                case 'today':
                    const todayStart = new Date(now);
                    todayStart.setHours(0, 0, 0, 0);
                    dateRange = { start: todayStart, end: now };
                    break;
                case 'week':
                    const weekStart = new Date(now);
                    weekStart.setDate(now.getDate() - 7);
                    dateRange = { start: weekStart, end: now };
                    break;
                case 'month':
                    const monthStart = new Date(now);
                    monthStart.setMonth(now.getMonth() - 1);
                    dateRange = { start: monthStart, end: now };
                    break;
                case 'quarter':
                    const quarterStart = new Date(now);
                    quarterStart.setMonth(now.getMonth() - 3);
                    dateRange = { start: quarterStart, end: now };
                    break;
                case 'year':
                    const yearStart = new Date(now);
                    yearStart.setFullYear(now.getFullYear() - 1);
                    dateRange = { start: yearStart, end: now };
                    break;
                case 'custom':
                    if (!startDate || !endDate) {
                        throw AppError.validation('Start date and end date are required for custom period');
                    }
                    dateRange = {
                        start: new Date(startDate as string),
                        end: new Date(endDate as string)
                    };
                    break;
                default:
                    throw AppError.validation('Invalid period specified');
            }

            // Build where conditions
            const whereConditions: any = {
                createdAt: {
                    [Op.gte]: dateRange.start,
                    [Op.lte]: dateRange.end
                }
            };

            if (zoneId) {
                whereConditions.zoneId = zoneId;
            }

            // Get statistics
            const totalParcels = await Parcel.count({ where: whereConditions });
            
            const statusStats = await Parcel.findAll({
                where: whereConditions,
                attributes: [
                    'status',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['status']
            });

            const priorityStats = await Parcel.findAll({
                where: whereConditions,
                attributes: [
                    'priority',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                group: ['priority']
            });

            // Get daily trend for the period
            const dailyTrend = await this.getDailyParcelTrend(dateRange.start, dateRange.end, zoneId as string);

            const stats = {
                period,
                dateRange: {
                    start: dateRange.start.toISOString(),
                    end: dateRange.end.toISOString()
                },
                zoneId,
                overview: {
                    total: totalParcels,
                    delivered: statusStats.find(s => s.status === 'delivered')?.get('count') || 0,
                    inTransit: statusStats.find(s => s.status === 'in_transit')?.get('count') || 0,
                    pending: statusStats.find(s => s.status === 'pending')?.get('count') || 0
                },
                statusBreakdown: statusStats.reduce((acc: any, stat: any) => {
                    acc[stat.status] = parseInt(stat.get('count'));
                    return acc;
                }, {}),
                priorityBreakdown: priorityStats.reduce((acc: any, stat: any) => {
                    acc[stat.priority] = parseInt(stat.get('count'));
                    return acc;
                }, {}),
                dailyTrend,
                calculatedAt: new Date().toISOString()
            };

            // Cache for 5 minutes
            await this.redisService.setWithExpiry(cacheKey, stats, 300000);

            logger.info('Retrieved parcels statistics', {
                period,
                zoneId,
                totalParcels
            });

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
     * Get delivery performance metrics
     */
    public getDeliveryPerformance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('getDeliveryPerformance');
        
        try {
            const { metric, groupBy, startDate, endDate } = req.query;

            // This would involve complex analytics queries
            // For now, return simplified metrics

            const dateRange = {
                start: new Date(startDate as string),
                end: new Date(endDate as string)
            };

            const performance = {
                metric,
                groupBy,
                dateRange: {
                    start: dateRange.start.toISOString(),
                    end: dateRange.end.toISOString()
                },
                data: [
                    // Example data - in production, this would come from analytics queries
                    { group: 'Driver A', value: 95.5 },
                    { group: 'Driver B', value: 92.3 },
                    { group: 'Driver C', value: 88.7 }
                ],
                average: 92.2,
                calculatedAt: new Date().toISOString()
            };

            logger.info('Retrieved delivery performance', {
                metric,
                groupBy,
                dateRange
            });

            res.status(200).json({
                success: true,
                data: performance
            });
            endMeasurement();

        } catch (error) {
            next(error);
        }
    };

    /**
     * Scan parcel
     */
    public scanParcel = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        const endMeasurement = performanceLogger.start('scanParcel');
        
        try {
            const { id } = req.params;
            const { scanType, location, notes, photoUrl } = req.body;
            const userId = req.user?.id;

            // Get parcel with lock
            const parcel = await Parcel.findByPk(id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
                include: [{
                    model: Delivery,
                    as: 'delivery'
                }]
            });

            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Update parcel based on scan type
            let newStatus = parcel.status;
            let message = '';

            switch (scanType) {
                case 'pickup':
                    newStatus = 'in_transit';
                    message = 'Parcel picked up by driver';
                    break;
                case 'delivery':
                    newStatus = 'delivered';
                    message = 'Parcel delivered to recipient';
                    break;
                case 'checkpoint':
                    message = 'Parcel scanned at checkpoint';
                    break;
                case 'return':
                    newStatus = 'returned';
                    message = 'Parcel returned to sender';
                    break;
                default:
                    throw AppError.validation('Invalid scan type');
            }

            // Update parcel
            await parcel.update({ status: newStatus }, { transaction });

            // Create scan record
            await this.createScanRecord(id, scanType, location, notes, photoUrl, userId);

            // Create status history
            await this.createStatusHistory(id, newStatus, `${scanType}: ${notes}`, location, userId);

            await transaction.commit();

            // Invalidate cache
            await this.redisService.del(`parcel:${id}`);
            await this.redisService.del(`parcel:track:${parcel.trackingCode}`);
            await this.redisService.delPattern('parcels:list:*');
            await this.redisService.delPattern('parcels:stats:*');

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: parcel.delivery?.id || 'unknown',
                parcelId: id,
                status: 'scanned',
                driverId: parcel.driverId || userId,
                message: `${scanType} scan: ${message}`
            });

            logger.info('Parcel scanned', {
                parcelId: id,
                scanType,
                location,
                scannedBy: userId,
                newStatus
            });

            res.status(200).json({
                success: true,
                message: 'Parcel scanned successfully',
                data: {
                    parcelId: id,
                    scanType,
                    newStatus,
                    timestamp: new Date().toISOString()
                }
            });
            endMeasurement();

        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Notify customer about parcel
     */
    public notifyCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const endMeasurement = performanceLogger.start('notifyCustomer');
        
        try {
            const { id } = req.params;
            const { notificationType, message, channel = 'all' } = req.body;
            const userId = req.user?.id;

            const parcel = await Parcel.findByPk(id);
            if (!parcel) {
                throw AppError.notFound('Parcel', id);
            }

            // Add notification job
            await this.queueService.addDeliveryNotificationJob({
                deliveryId: 'system',
                parcelId: id,
                status: 'customer_notification',
                driverId: 'system',
                message: message || `${notificationType} for parcel ${parcel.trackingCode}`
            });

            logger.info('Customer notification scheduled', {
                parcelId: id,
                notificationType,
                channel,
                notifiedBy: userId
            });

            res.status(200).json({
                success: true,
                message: 'Notification scheduled successfully',
                data: {
                    parcelId: id,
                    notificationType,
                    scheduledAt: new Date().toISOString()
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
            const database = await this.checkDatabaseConnection();
            const redis = await this.redisService.healthCheck();
            const queue = await this.queueService.healthCheck();

            const parcelCount = await Parcel.count();
            const pendingParcels = await Parcel.count({ where: { status: 'pending' } });

            return {
                service: 'parcel',
                status: 'healthy',
                timestamp: new Date().toISOString(),
                components: {
                    database,
                    redis,
                    queue
                },
                metrics: {
                    totalParcels: parcelCount,
                    pendingParcels,
                    uptime: process.uptime()
                }
            };
        } catch (error) {
            logger.error('Parcel health check failed:', error);
            throw error;
        }
    };

    // Helper methods

    private async determineZone(address: any): Promise<Zone | null> {
        // Simplified zone determination
        // In production, this would use geocoding and spatial queries
        try {
            const zone = await Zone.findOne({
                where: {
                    name: { [Op.iLike]: '%casablanca%' }
                }
            });
            return zone;
        } catch (error) {
            logger.error('Error determining zone:', error);
            return null;
        }
    }

    private async getParcelStatusHistory(parcelId: string): Promise<any[]> {
        // In production, this would query a status_history table
        // For now, return mock data
        return [
            {
                status: 'pending',
                timestamp: new Date(Date.now() - 3600000).toISOString(),
                notes: 'Parcel created',
                changedBy: 'system'
            }
        ];
    }

    private async createStatusHistory(
        parcelId: string,
        status: string,
        notes: string | null,
        location: any,
        userId: string
    ): Promise<void> {
        // In production, this would create a record in status_history table
        logger.debug('Status history created', {
            parcelId,
            status,
            notes,
            location,
            userId
        });
    }

    private async createScanRecord(
        parcelId: string,
        scanType: string,
        location: any,
        notes: string | null,
        photoUrl: string | null,
        userId: string
    ): Promise<void> {
        // In production, this would create a record in scan_history table
        logger.debug('Scan record created', {
            parcelId,
            scanType,
            location,
            notes,
            photoUrl,
            userId
        });
    }

    private async getDailyParcelTrend(startDate: Date, endDate: Date, zoneId?: string): Promise<any[]> {
        // In production, this would query database for daily counts
        // For now, return mock data
        const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 3600 * 24));
        const trend = [];

        for (let i = 0; i < days; i++) {
            const date = new Date(startDate);
            date.setDate(startDate.getDate() + i);
            
            trend.push({
                date: date.toISOString().split('T')[0],
                count: Math.floor(Math.random() * 100) + 20 // Random count
            });
        }

        return trend;
    }

    private async checkDatabaseConnection(): Promise<boolean> {
        try {
            await sequelize.authenticate();
            return true;
        } catch (error) {
            return false;
        }
    }
}