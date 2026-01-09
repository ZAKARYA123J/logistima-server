import { Router, Request, Response, NextFunction } from 'express';
import { DeliveryController } from '../controllers/delivery.controller.js';
import { validateRequest } from '../middlewares/validation.middleware.js';
import { authMiddleware, verifyWebhookSignature } from '../middlewares/auth.middleware.js';
import { roleMiddleware, UserRole } from '../middlewares/role.middleware.js';
import { body, param, query } from 'express-validator';
import { Delivery, DeliveryStatus } from '../models/Delivery.model.js';
import { AppError } from '../utils/errors.js';
import { RedisService } from '../services/redis.service.js';

const router = Router();
const deliveryController = new DeliveryController();

// Middleware d'authentification pour toutes les routes
router.use(authMiddleware.authenticate);

// Validation schemas
const createDeliverySchema = [
    body('parcelId')
        .isUUID()
        .withMessage('Valid parcelId is required'),
    body('driverId')
        .isUUID()
        .withMessage('Valid driverId is required'),
    body('pickupLocation')
        .isObject()
        .withMessage('Pickup location is required'),
    body('deliveryLocation')
        .isObject()
        .withMessage('Delivery location is required'),
    body('priority')
        .optional()
        .isInt({ min: 1, max: 3 })
        .withMessage('Priority must be between 1 and 3')
];

const updateDeliverySchema = [
    param('id')
        .isUUID()
        .withMessage('Valid delivery ID is required'),
    body('status')
        .optional()
        .isIn(Object.values(DeliveryStatus))
        .withMessage(`Status must be one of: ${Object.values(DeliveryStatus).join(', ')}`),
    body('estimatedRoute')
        .optional()
        .isString()
        .withMessage('Estimated route must be a string')
];

const getDeliveriesSchema = [
    query('page')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Page must be a positive integer'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be between 1 and 100'),
    query('status')
        .optional()
        .isIn(Object.values(DeliveryStatus))
        .withMessage(`Status must be one of: ${Object.values(DeliveryStatus).join(', ')}`),
    query('driverId')
        .optional()
        .isUUID()
        .withMessage('Valid driverId is required'),
    query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Start date must be a valid ISO 8601 date'),
    query('endDate')
        .optional()
        .isISO8601()
        .withMessage('End date must be a valid ISO 8601 date')
];

// Routes
router.post(
    '/',
    roleMiddleware.hasRole([UserRole.DISPATCHER, UserRole.ADMIN]), // Seuls les dispatchers et admins peuvent créer
    validateRequest(createDeliverySchema),
    deliveryController.createDelivery
);

router.get(
    '/',
    roleMiddleware.hasRole([UserRole.DISPATCHER, UserRole.DRIVER, UserRole.ADMIN]),
    validateRequest(getDeliveriesSchema),
    deliveryController.getDeliveries
);

router.get(
    '/stats',
    roleMiddleware.hasRole([UserRole.DISPATCHER, UserRole.ADMIN]),
    deliveryController.getDeliveryStats
);

router.get(
    '/:id',
    roleMiddleware.hasRole([UserRole.DISPATCHER, UserRole.DRIVER, UserRole.ADMIN]),
    param('id').isUUID().withMessage('Valid delivery ID is required'),
    validateRequest([]),
    deliveryController.getDeliveryById
);

router.patch(
    '/:id/status',
    roleMiddleware.hasRole([UserRole.DISPATCHER, UserRole.DRIVER, UserRole.ADMIN]),
    validateRequest(updateDeliverySchema),
    deliveryController.updateDeliveryStatus
);

router.delete(
    '/:id',
    roleMiddleware.hasRole([UserRole.ADMIN]), // Seul l'admin peut supprimer
    param('id').isUUID().withMessage('Valid delivery ID is required'),
    validateRequest([]),
    deliveryController.deleteDelivery
);

// Routes spéciales pour les drivers
router.get(
    '/driver/:driverId',
    roleMiddleware.hasRole([UserRole.DRIVER, UserRole.DISPATCHER, UserRole.ADMIN]),
    param('driverId').isUUID().withMessage('Valid driver ID is required'),
    query('status')
        .optional()
        .isIn(Object.values(DeliveryStatus))
        .withMessage(`Status must be one of: ${Object.values(DeliveryStatus).join(', ')}`),
    validateRequest([]),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            // Implémentation spécifique pour les livraisons d'un driver
            const { driverId } = req.params;
            const { status } = req.query;
            
            const whereConditions: any = { driverId };
            if (status) whereConditions.status = status;
            
            const deliveries = await Delivery.findAll({
                where: whereConditions,
                order: [['createdAt', 'DESC']]
            });
            
            res.status(200).json({
                success: true,
                data: { deliveries }
            });
        } catch (error) {
            next(error);
        }
    }
);

// Webhook pour les mises à jour de statut (pour intégrations externes)
router.post(
    '/webhook/status',
    body('deliveryId').isUUID().withMessage('Valid deliveryId is required'),
    body('status').isIn(Object.values(DeliveryStatus)).withMessage('Valid status is required'),
    body('timestamp').isISO8601().withMessage('Valid timestamp is required'),
    validateRequest([]),
    verifyWebhookSignature,
    async (req: Request, res: Response, next: NextFunction) => {
        const redisService = new RedisService();
        try {
            // Traiter la mise à jour de statut
            const { deliveryId, status } = req.body;
            
            const lockKey = `lock:delivery:${deliveryId}`;
            const lockAcquired = await redisService.acquireLock(lockKey, 5000);
            
            if (!lockAcquired) {
                return res.status(202).json({
                    success: true,
                    message: 'Update queued, delivery is being processed'
                });
            }
            
            try {
                const delivery = await Delivery.findByPk(deliveryId);
                if (!delivery) {
                    throw new AppError('Delivery not found', 404);
                }
                
                await delivery.update({ status });
                
                // Invalider le cache
                await redisService.del(`delivery:${deliveryId}`);
                
                res.status(200).json({
                    success: true,
                    message: 'Delivery status updated via webhook'
                });
            } finally {
                await redisService.releaseLock(lockKey);
            }
        } catch (error) {
            next(error);
        }
    }
);

// Route pour simuler un pic de charge (stress test)
router.post(
    '/stress-test',
    roleMiddleware.hasRole([UserRole.ADMIN]),
    body('requests').isInt({ min: 1, max: 100 }).withMessage('Requests must be between 1 and 100'),
    validateRequest([]),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { requests } = req.body;
            
            // Simuler des requêtes concurrentes pour tester le Smart Dispatcher
            const promises = Array.from({ length: requests }, (_, i) => {
                return fetch(`${process.env.API_URL}/api/deliveries`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${req.headers.authorization}`
                    },
                    body: JSON.stringify({
                        parcelId: `STRESS-TEST-${Date.now()}-${i}`,
                        driverId: '550e8400-e29b-41d4-a716-446655440000', // Même driver pour tous
                        pickupLocation: { lat: 33.5731, lng: -7.5898 },
                        deliveryLocation: { lat: 33.5731, lng: -7.5898 }
                    })
                });
            });
            
            const responses = await Promise.all(promises);
            const results = await Promise.all(responses.map(r => r.json()));
            
            const successful = results.filter(r => r.success);
            const conflicts = results.filter(r => !r.success);
            
            res.status(200).json({
                success: true,
                data: {
                    totalRequests: requests,
                    successful: successful.length,
                    conflicts: conflicts.length,
                    results: results.map(r => ({ 
                        success: r.success, 
                        message: r.message || 'No message' 
                    }))
                }
            });
        } catch (error) {
            next(error);
        }
    }
);

export default router;