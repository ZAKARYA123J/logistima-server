import { Request, Response, NextFunction } from 'express';
import { Delivery, DeliveryStatus } from '../models/Delivery.model.js';
import { RedisService } from '../services/redis.service.js';
import { QueueService } from '../services/queue.service.js';
import { DriverService } from '../services/driver.service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { validationResult } from 'express-validator';
import {sequelize} from "../config/database.js"
import { Op } from 'sequelize';
export class DeliveryController {
    private redisService: RedisService;
    private queueService: QueueService;
    private driverService: DriverService;

    constructor() {
        this.redisService = new RedisService();
        this.queueService = new QueueService();
        this.driverService = new DriverService();
    }

    /**
     * Créer une nouvelle livraison avec Smart Dispatching
     */
    public createDelivery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Validation des données d'entrée
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                throw AppError.validation('Validation error', { errors: errors.array() });
            }

            const { parcelId, driverId, pickupLocation, deliveryLocation, priority } = req.body;

            // 1. Vérifier si le colis existe déjà
            const existingDelivery = await Delivery.findOne({ where: { parcelId } });
            if (existingDelivery) {
                throw new AppError('Delivery already exists for this parcel', 409);
            }

            // 2. Vérifier et réserver le livreur (Smart Dispatcher avec lock)
            const isDriverAvailable = await this.driverService.reserveDriver(driverId);
            if (!isDriverAvailable) {
                throw new AppError('Driver is not available or already assigned', 409);
            }

            // 3. Créer la livraison dans la base de données
            const delivery = await Delivery.create({
                parcelId,
                driverId,
                status: DeliveryStatus.STARTED,
                receiptGenerated: false
            });

            // 4. Mettre en cache les données de livraison
            await this.redisService.setWithExpiry(
                `delivery:${delivery.id}`,
                JSON.stringify(delivery.toJSON()),
                3600 // 1 heure
            );

            // 5. Ajouter aux files d'attente pour traitement asynchrone
            await this.queueService.addRouteCalculationJob({
                deliveryId: delivery.id,
                pickupLocation,
                deliveryLocation
            });

            await this.queueService.addReceiptGenerationJob({
                deliveryId: delivery.id,
                parcelId
            });

            // 6. Invalider le cache des statistiques
            await this.redisService.del('stats:deliveries:today');
            await this.redisService.del(`driver:${driverId}:deliveries`);

            res.status(201).json({
                success: true,
                data: {
                    delivery,
                    message: 'Delivery created successfully. Processing in background.'
                }
            });
        } catch (error) {
            next(error);
        }
    };

    /**
     * Récupérer une livraison par ID
     */
    public getDeliveryById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { id } = req.params;

            // 1. Vérifier le cache Redis en premier
            const cachedDelivery = await this.redisService.get(`delivery:${id}`);
            if (cachedDelivery) {
                res.status(200).json({
                    success: true,
                    data: {
                        delivery: JSON.parse(cachedDelivery),
                        fromCache: true
                    }
                });
                return;
            }

            // 2. Si non en cache, chercher en base de données
            const delivery = await Delivery.findByPk(id);
            if (!delivery) {
                throw new AppError('Delivery not found', 404);
            }

            // 3. Mettre en cache pour les requêtes futures
            await this.redisService.setWithExpiry(
                `delivery:${id}`,
                JSON.stringify(delivery.toJSON()),
                1800 // 30 minutes
            );

            res.status(200).json({
                success: true,
                data: {
                    delivery,
                    fromCache: false
                }
            });
        } catch (error) {
            next(error);
        }
    };

    /**
     * Mettre à jour le statut d'une livraison
     */
    public updateDeliveryStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        
        try {
            const { id } = req.params;
            const { status, estimatedRoute } = req.body;

            // 1. Acquérir un lock distribué pour éviter les conflits
            const lockKey = `lock:delivery:${id}`;
            const lockAcquired = await this.redisService.acquireLock(lockKey, 5000); // 5 secondes
            
            if (!lockAcquired) {
                throw new AppError('Delivery is being processed by another request', 429);
            }

            try {
                // 2. Récupérer la livraison avec lock en base de données
                const delivery = await Delivery.findByPk(id, {
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });

                if (!delivery) {
                    throw new AppError('Delivery not found', 404);
                }

                // 3. Validation des transitions de statut
                this.validateStatusTransition(delivery.status, status);

                // 4. Mettre à jour la livraison
                const updates: any = { status };
                if (estimatedRoute) {
                    updates.estimatedRoute = estimatedRoute;
                }

                // Si la livraison est terminée, générer le reçu
                if (status === DeliveryStatus.COMPLETED) {
                    updates.receiptGenerated = true;
                    
                    // Libérer le livreur
                    await this.driverService.releaseDriver(delivery.driverId);
                    
                    // Ajouter un job pour la génération finale du reçu
                    await this.queueService.addFinalReceiptJob({
                        deliveryId: delivery.id,
                        parcelId: delivery.parcelId,
                        driverId: delivery.driverId
                    });
                }

                // Si la livraison est annulée, libérer le livreur
                if (status === DeliveryStatus.CANCELLED) {
                    await this.driverService.releaseDriver(delivery.driverId);
                }

                await delivery.update(updates, { transaction });

                // 5. Valider la transaction
                await transaction.commit();

                // 6. Mettre à jour le cache
                await this.redisService.setWithExpiry(
                    `delivery:${id}`,
                    JSON.stringify(delivery.toJSON()),
                    1800
                );

                // 7. Invalider les caches liés
                await this.invalidateRelatedCaches(delivery);

                res.status(200).json({
                    success: true,
                    data: {
                        delivery,
                        message: 'Delivery status updated successfully'
                    }
                });
            } finally {
                // 8. Toujours libérer le lock
                await this.redisService.releaseLock(lockKey);
            }
        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Lister les livraisons avec pagination et filtres
     */
    public getDeliveries = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { 
                page = 1, 
                limit = 10, 
                status, 
                driverId, 
                startDate, 
                endDate 
            } = req.query;

            const pageNum = parseInt(page as string);
            const limitNum = parseInt(limit as string);
            const offset = (pageNum - 1) * limitNum;

            // Créer une clé de cache basée sur les paramètres
            const cacheKey = `deliveries:${page}:${limit}:${status}:${driverId}:${startDate}:${endDate}`;
            
            // Vérifier le cache
            const cachedResult = await this.redisService.get(cacheKey);
            if (cachedResult) {
                res.status(200).json({
                    success: true,
                    data: JSON.parse(cachedResult),
                    fromCache: true
                });
                return;
            }

            // Construire les conditions de filtre
            const whereConditions: any = {};
            if (status) whereConditions.status = status;
            if (driverId) whereConditions.driverId = driverId;
            
            // Filtre par date
            if (startDate || endDate) {
                whereConditions.createdAt = {};
                if (startDate) whereConditions.createdAt[Op.gte] = new Date(startDate as string);
                if (endDate) whereConditions.createdAt[Op.lte] = new Date(endDate as string);
            }

            // Récupérer les livraisons avec pagination
            const { count, rows: deliveries } = await Delivery.findAndCountAll({
                where: whereConditions,
                limit: limitNum,
                offset: offset,
                order: [['createdAt', 'DESC']]
            });

            const result = {
                deliveries,
                pagination: {
                    total: count,
                    page: pageNum,
                    limit: limitNum,
                    totalPages: Math.ceil(count / limitNum)
                }
            };

            // Mettre en cache
            await this.redisService.setWithExpiry(cacheKey, JSON.stringify(result), 300); // 5 minutes

            res.status(200).json({
                success: true,
                data: result,
                fromCache: false
            });
        } catch (error) {
            next(error);
        }
    };

    /**
     * Supprimer une livraison
     */
    public deleteDelivery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const transaction = await sequelize.transaction();
        
        try {
            const { id } = req.params;

            const lockKey = `lock:delivery:${id}`;
            const lockAcquired = await this.redisService.acquireLock(lockKey, 5000);
            
            if (!lockAcquired) {
                throw new AppError('Delivery is being processed by another request', 429);
            }

            try {
                const delivery = await Delivery.findByPk(id, { transaction });
                if (!delivery) {
                    throw new AppError('Delivery not found', 404);
                }

                // Si la livraison est en cours, libérer le livreur
                if (delivery.status === DeliveryStatus.STARTED) {
                    await this.driverService.releaseDriver(delivery.driverId);
                }

                await delivery.destroy({ transaction });
                await transaction.commit();

                // Invalider les caches
                await this.redisService.del(`delivery:${id}`);
                await this.redisService.delPattern('deliveries:*');
                await this.redisService.del('stats:deliveries:today');
                await this.redisService.del(`driver:${delivery.driverId}:deliveries`);

                res.status(200).json({
                    success: true,
                    message: 'Delivery deleted successfully'
                });
            } finally {
                await this.redisService.releaseLock(lockKey);
            }
        } catch (error) {
            await transaction.rollback();
            next(error);
        }
    };

    /**
     * Récupérer les statistiques des livraisons
     */
    public getDeliveryStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const cacheKey = 'stats:deliveries:today';
            
            const cachedStats = await this.redisService.get(cacheKey);
            if (cachedStats) {
                res.status(200).json({
                    success: true,
                    data: JSON.parse(cachedStats),
                    fromCache: true
                });
                return;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const stats = await Delivery.findAll({
                attributes: [
                    'status',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'count']
                ],
                where: {
                    createdAt: {
                        [Op.gte]: today,
                        [Op.lt]: tomorrow
                    }
                },
                group: ['status']
            });

            const result = {
                date: today.toISOString().split('T')[0],
                stats: stats.reduce((acc: any, item: any) => {
                    acc[item.status] = parseInt(item.get('count'));
                    return acc;
                }, {}),
                total: stats.reduce((sum: number, item: any) => 
                    sum + parseInt(item.get('count')), 0
                )
            };

            await this.redisService.setWithExpiry(cacheKey, JSON.stringify(result), 600); // 10 minutes

            res.status(200).json({
                success: true,
                data: result,
                fromCache: false
            });
        } catch (error) {
            next(error);
        }
    };

    /**
     * Valider la transition de statut
     */
    private validateStatusTransition(currentStatus: DeliveryStatus, newStatus: DeliveryStatus): void {
        const validTransitions: Record<DeliveryStatus, DeliveryStatus[]> = {
            [DeliveryStatus.STARTED]: [DeliveryStatus.COMPLETED, DeliveryStatus.CANCELLED],
            [DeliveryStatus.COMPLETED]: [],
            [DeliveryStatus.CANCELLED]: []
        };

        if (!validTransitions[currentStatus].includes(newStatus)) {
            throw new AppError(
                `Invalid status transition from ${currentStatus} to ${newStatus}`,
                400
            );
        }
    }

    /**
     * Invalider les caches liés à une livraison
     */
    private async invalidateRelatedCaches(delivery: Delivery): Promise<void> {
        const keysToDelete = [
            `driver:${delivery.driverId}:deliveries`,
            'stats:deliveries:today',
            'deliveries:*' // Pattern matching pour toutes les requêtes paginées
        ];

        await Promise.all(
            keysToDelete.map(key => this.redisService.delPattern(key))
        );
    }
}