import { Router } from 'express';
import { ParcelController } from '../controllers/parcel.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { roleMiddleware } from '../middlewares/role.middleware.js';
import { validateRequest, validateAtLeastOne, validateFile } from '../middlewares/validation.middleware.js';
import { body, param, query } from 'express-validator';
import { logger } from '../utils/logger.js';

const router = Router();
const parcelController = new ParcelController();

// Common validation rules
const parcelIdValidation = param('id')
    .isUUID()
    .withMessage('Valid parcel ID is required');

const trackingNumberValidation = param('trackingNumber')
    .matches(/^[A-Z0-9]{8,16}$/)
    .withMessage('Valid tracking number is required');

// Apply authentication to all routes except public tracking
router.use(authMiddleware.authenticate);

/**
 * @route   GET /api/parcels
 * @desc    Get all parcels with pagination and filters
 * @access  Private (Admin, Dispatcher, Support)
 */
router.get(
    '/',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'support', 'super_admin']),
    validateRequest([
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
        query('status')
            .optional()
            .isIn(['pending', 'in_transit', 'delivered', 'cancelled', 'returned', 'lost'])
            .withMessage('Valid status is required'),
        query('customerId')
            .optional()
            .isUUID()
            .withMessage('Valid customer ID is required'),
        query('driverId')
            .optional()
            .isUUID()
            .withMessage('Valid driver ID is required'),
        query('zoneId')
            .optional()
            .isUUID()
            .withMessage('Valid zone ID is required'),
        query('startDate')
            .optional()
            .isISO8601()
            .withMessage('Valid start date is required'),
        query('endDate')
            .optional()
            .isISO8601()
            .withMessage('Valid end date is required'),
        query('priority')
            .optional()
            .isIn(['high', 'medium', 'low'])
            .withMessage('Valid priority is required'),
        query('sortBy')
            .optional()
            .isIn(['createdAt', 'updatedAt', 'priority', 'weight', 'estimatedDelivery'])
            .withMessage('Invalid sort field'),
        query('sortOrder')
            .optional()
            .isIn(['asc', 'desc'])
            .withMessage('Sort order must be asc or desc'),
    ]),
    parcelController.getAllParcels
);

/**
 * @route   GET /api/parcels/:id
 * @desc    Get parcel by ID
 * @access  Private (Admin, Dispatcher, Support, Customer - own parcels only)
 */
router.get(
    '/:id',
    validateRequest([parcelIdValidation]),
    roleMiddleware.isOwnerOrHasPermission(
        'parcel',
        'parcel:read',
        'id'
    ),
    parcelController.getParcelById
);

/**
 * @route   GET /api/parcels/tracking/:trackingNumber
 * @desc    Track parcel by tracking number (public)
 * @access  Public (with optional authentication)
 */
router.get(
    '/tracking/:trackingNumber',
    authMiddleware.optionalAuth,
    validateRequest([trackingNumberValidation]),
    parcelController.trackParcel
);

/**
 * @route   POST /api/parcels
 * @desc    Create a new parcel/delivery request
 * @access  Private (Admin, Dispatcher, Customer)
 */
router.post(
    '/',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'customer', 'super_admin']),
    validateRequest([
        body('customerId')
            .isUUID()
            .withMessage('Valid customer ID is required'),
        body('sender')
            .isObject()
            .withMessage('Sender information is required')
            .custom(value => {
                if (!value.name || !value.phone || !value.address) {
                    throw new Error('Sender must have name, phone, and address');
                }
                return true;
            }),
        body('receiver')
            .isObject()
            .withMessage('Receiver information is required')
            .custom(value => {
                if (!value.name || !value.phone || !value.address) {
                    throw new Error('Receiver must have name, phone, and address');
                }
                return true;
            }),
        body('dimensions')
            .isObject()
            .withMessage('Dimensions are required')
            .custom(value => {
                if (!value.length || !value.width || !value.height || !value.weight) {
                    throw new Error('Dimensions must have length, width, height, and weight');
                }
                return true;
            }),
        body('contents')
            .isArray({ min: 1 })
            .withMessage('At least one content item is required'),
        body('contents.*.description')
            .isString()
            .notEmpty()
            .withMessage('Content description is required'),
        body('contents.*.quantity')
            .isInt({ min: 1 })
            .withMessage('Content quantity must be at least 1')
            .toInt(),
        body('contents.*.value')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Content value must be positive')
            .toFloat(),
        body('priority')
            .optional()
            .isIn(['high', 'medium', 'low'])
            .withMessage('Valid priority is required'),
        body('specialInstructions')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Special instructions must be less than 500 characters'),
        body('insuranceRequired')
            .optional()
            .isBoolean()
            .withMessage('Insurance required must be a boolean')
            .toBoolean(),
        body('estimatedValue')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Estimated value must be positive')
            .toFloat(),
        body('pickupWindow')
            .optional()
            .isObject()
            .withMessage('Pickup window must be an object'),
        body('pickupWindow.start')
            .optional()
            .isISO8601()
            .withMessage('Valid pickup start time is required'),
        body('pickupWindow.end')
            .optional()
            .isISO8601()
            .withMessage('Valid pickup end time is required'),
        body('deliveryWindow')
            .optional()
            .isObject()
            .withMessage('Delivery window must be an object'),
        body('deliveryWindow.start')
            .optional()
            .isISO8601()
            .withMessage('Valid delivery start time is required'),
        body('deliveryWindow.end')
            .optional()
            .isISO8601()
            .withMessage('Valid delivery end time is required'),
    ]),
    parcelController.createParcel
);

/**
 * @route   PUT /api/parcels/:id
 * @desc    Update parcel information
 * @access  Private (Admin, Dispatcher, Support)
 */
router.put(
    '/:id',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'support', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('sender')
            .optional()
            .isObject()
            .withMessage('Sender must be an object'),
        body('receiver')
            .optional()
            .isObject()
            .withMessage('Receiver must be an object'),
        body('dimensions')
            .optional()
            .isObject()
            .withMessage('Dimensions must be an object'),
        body('contents')
            .optional()
            .isArray()
            .withMessage('Contents must be an array'),
        body('priority')
            .optional()
            .isIn(['high', 'medium', 'low'])
            .withMessage('Valid priority is required'),
        body('specialInstructions')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Special instructions must be less than 500 characters'),
        body('status')
            .optional()
            .isIn(['pending', 'in_transit', 'delivered', 'cancelled', 'returned', 'lost'])
            .withMessage('Valid status is required'),
    ]),
    validateAtLeastOne([
        'sender', 'receiver', 'dimensions', 'contents',
        'priority', 'specialInstructions', 'status'
    ]),
    parcelController.updateParcel
);

/**
 * @route   PATCH /api/parcels/:id/status
 * @desc    Update parcel status
 * @access  Private (Admin, Dispatcher, Driver - for assigned parcels)
 */
router.patch(
    '/:id/status',
    validateRequest([
        parcelIdValidation,
        body('status')
            .isIn(['pending', 'in_transit', 'delivered', 'cancelled', 'returned', 'lost'])
            .withMessage('Valid status is required'),
        body('notes')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Notes must be less than 500 characters'),
        body('location')
            .optional()
            .isObject()
            .withMessage('Location must be an object'),
        body('proofOfDelivery')
            .optional()
            .isObject()
            .withMessage('Proof of delivery must be an object'),
        body('proofOfDelivery.type')
            .optional()
            .isIn(['signature', 'photo', 'code'])
            .withMessage('Valid proof type is required'),
        body('proofOfDelivery.data')
            .optional()
            .isString()
            .withMessage('Proof data must be a string'),
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        'parcel',
        'parcel:update',
        'id'
    ),
    parcelController.updateParcelStatus
);

/**
 * @route   DELETE /api/parcels/:id
 * @desc    Delete a parcel (soft delete)
 * @access  Private (Admin, Super Admin)
 */
router.delete(
    '/:id',
    validateRequest([parcelIdValidation]),
    roleMiddleware.hasRole(['admin', 'super_admin']),
    parcelController.deleteParcel
);

/**
 * @route   POST /api/parcels/:id/assign
 * @desc    Assign parcel to driver
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/assign',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('driverId')
            .isUUID()
            .withMessage('Valid driver ID is required'),
        body('estimatedPickup')
            .optional()
            .isISO8601()
            .withMessage('Valid estimated pickup time is required'),
        body('estimatedDelivery')
            .optional()
            .isISO8601()
            .withMessage('Valid estimated delivery time is required'),
        body('notes')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Notes must be less than 500 characters'),
    ]),
    parcelController.assignParcel
);

/**
 * @route   POST /api/parcels/:id/unassign
 * @desc    Unassign parcel from driver
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/unassign',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('reason')
            .isString()
            .notEmpty()
            .withMessage('Unassign reason is required'),
    ]),
    parcelController.unassignParcel
);

/**
 * @route   GET /api/parcels/:id/history
 * @desc    Get parcel status history
 * @access  Private (Admin, Dispatcher, Support, Customer - own parcels only)
 */
router.get(
    '/:id/history',
    validateRequest([parcelIdValidation]),
    roleMiddleware.isOwnerOrHasPermission(
        'parcel',
        'parcel:read',
        'id'
    ),
    parcelController.getParcelHistory
);

/**
 * @route   GET /api/parcels/:id/timeline
 * @desc    Get parcel timeline with estimated times
 * @access  Private (Admin, Dispatcher, Support, Customer - own parcels only)
 */
router.get(
    '/:id/timeline',
    validateRequest([parcelIdValidation]),
    roleMiddleware.isOwnerOrHasPermission(
        'parcel',
        'parcel:read',
        'id'
    ),
    parcelController.getParcelTimeline
);

/**
 * @route   POST /api/parcels/:id/cancel
 * @desc    Cancel a parcel
 * @access  Private (Admin, Dispatcher, Customer - own parcels only)
 */
router.post(
    '/:id/cancel',
    validateRequest([
        parcelIdValidation,
        body('reason')
            .isString()
            .notEmpty()
            .withMessage('Cancellation reason is required'),
        body('refundAmount')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Refund amount must be positive')
            .toFloat(),
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        'parcel',
        'parcel:update',
        'id'
    ),
    parcelController.cancelParcel
);

/**
 * @route   POST /api/parcels/:id/return
 * @desc    Mark parcel for return
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/return',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('reason')
            .isString()
            .notEmpty()
            .withMessage('Return reason is required'),
        body('returnAddress')
            .optional()
            .isObject()
            .withMessage('Return address must be an object'),
        body('instructions')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Instructions must be less than 500 characters'),
    ]),
    parcelController.returnParcel
);

/**
 * @route   POST /api/parcels/bulk-create
 * @desc    Create multiple parcels in bulk
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/bulk-create',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        body('parcels')
            .isArray({ min: 1, max: 100 })
            .withMessage('Parcels must be an array with 1-100 items'),
        body('template')
            .optional()
            .isObject()
            .withMessage('Template must be an object'),
    ]),
    parcelController.bulkCreateParcels
);

/**
 * @route   POST /api/parcels/bulk-update
 * @desc    Update multiple parcels in bulk
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/bulk-update',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        body('parcelIds')
            .isArray({ min: 1, max: 100 })
            .withMessage('Parcel IDs must be an array with 1-100 items'),
        body('parcelIds.*')
            .isUUID()
            .withMessage('Each parcel ID must be a valid UUID'),
        body('updates')
            .isObject()
            .withMessage('Updates object is required'),
        body('updates.status')
            .optional()
            .isIn(['pending', 'in_transit', 'delivered', 'cancelled', 'returned', 'lost'])
            .withMessage('Valid status is required'),
        body('updates.priority')
            .optional()
            .isIn(['high', 'medium', 'low'])
            .withMessage('Valid priority is required'),
        body('updates.driverId')
            .optional()
            .isUUID()
            .withMessage('Valid driver ID is required'),
    ]),
    validateAtLeastOne([
        'updates.status', 'updates.priority', 'updates.driverId'
    ]),
    parcelController.bulkUpdateParcels
);

/**
 * @route   GET /api/parcels/search/suggest
 * @desc    Search parcels by tracking number or customer (autocomplete)
 * @access  Private (Admin, Dispatcher, Support)
 */
router.get(
    '/search/suggest',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'support', 'super_admin']),
    validateRequest([
        query('q')
            .isString()
            .isLength({ min: 2 })
            .withMessage('Search query must be at least 2 characters'),
        query('field')
            .optional()
            .isIn(['tracking', 'customer', 'phone', 'address'])
            .withMessage('Valid search field is required'),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 20 })
            .withMessage('Limit must be between 1 and 20')
            .toInt(),
    ]),
    parcelController.searchParcels
);

/**
 * @route   GET /api/parcels/stats/overview
 * @desc    Get parcels statistics overview
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/stats/overview',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'super_admin']),
    validateRequest([
        query('period')
            .optional()
            .isIn(['today', 'week', 'month', 'quarter', 'year', 'custom'])
            .withMessage('Valid period is required'),
        query('startDate')
            .optional()
            .isISO8601()
            .withMessage('Valid start date is required'),
        query('endDate')
            .optional()
            .isISO8601()
            .withMessage('Valid end date is required'),
        query('zoneId')
            .optional()
            .isUUID()
            .withMessage('Valid zone ID is required'),
    ]),
    parcelController.getParcelsStats
);

/**
 * @route   GET /api/parcels/metrics/performance
 * @desc    Get delivery performance metrics
 * @access  Private (Admin, Super Admin)
 */
router.get(
    '/metrics/performance',
    roleMiddleware.hasRole(['admin', 'super_admin']),
    validateRequest([
        query('metric')
            .isIn(['on_time', 'delivery_time', 'success_rate', 'customer_satisfaction'])
            .withMessage('Valid metric is required'),
        query('groupBy')
            .optional()
            .isIn(['driver', 'zone', 'day', 'hour'])
            .withMessage('Valid group by is required'),
        query('startDate')
            .isISO8601()
            .withMessage('Valid start date is required'),
        query('endDate')
            .isISO8601()
            .withMessage('Valid end date is required'),
    ]),
    parcelController.getDeliveryPerformance
);

/**
 * @route   POST /api/parcels/:id/scan
 * @desc    Scan parcel (for pickup/delivery verification)
 * @access  Private (Driver - for assigned parcels)
 */
router.post(
    '/:id/scan',
    roleMiddleware.hasRole(['driver', 'admin', 'dispatcher', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('scanType')
            .isIn(['pickup', 'delivery', 'checkpoint', 'return'])
            .withMessage('Valid scan type is required'),
        body('location')
            .isObject()
            .withMessage('Location is required'),
        body('notes')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Notes must be less than 500 characters'),
        body('photoUrl')
            .optional()
            .isURL()
            .withMessage('Valid photo URL is required'),
    ]),
    parcelController.scanParcel
);

/**
 * @route   POST /api/parcels/:id/notify
 * @desc    Send notification to customer about parcel
 * @access  Private (Admin, Dispatcher, Support)
 */
router.post(
    '/:id/notify',
    roleMiddleware.hasRole(['admin', 'dispatcher', 'support', 'super_admin']),
    validateRequest([
        parcelIdValidation,
        body('notificationType')
            .isIn(['status_update', 'delay', 'pickup_reminder', 'delivery_reminder', 'custom'])
            .withMessage('Valid notification type is required'),
        body('message')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Message must be less than 500 characters'),
        body('channel')
            .optional()
            .isIn(['sms', 'email', 'push', 'all'])
            .withMessage('Valid channel is required'),
    ]),
    parcelController.notifyCustomer
);

/**
 * @route   GET /api/parcels/health/status
 * @desc    Health check for parcels service
 * @access  Public
 */
router.get(
    '/health/status',
    async (req, res) => {
        try {
            const health = await parcelController.checkHealth();
            res.status(200).json({
                success: true,
                data: health,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Parcel health check failed:', error);
            res.status(503).json({
                success: false,
                error: 'Parcel service unavailable',
                timestamp: new Date().toISOString(),
            });
        }
    }
);

export default router;