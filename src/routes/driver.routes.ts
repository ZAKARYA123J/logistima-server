import { Router } from 'express';
import { DriverController } from '../controllers/driver.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { roleMiddleware, UserRole, Permission, OwnershipCheck } from '../middlewares/role.middleware.js';
import { validateRequest, validateAtLeastOne } from '../middlewares/validation.middleware.js';
import { body, param, query } from 'express-validator';
import { logger } from '../utils/logger.js';

const router = Router();
const driverController = new DriverController();

// Common validation rules
const driverIdValidation = param('id')
    .isUUID()
    .withMessage('Valid driver ID is required');

const locationValidation = body('location')
    .isObject()
    .withMessage('Location must be an object')
    .custom(value => {
        if (!value.lat || !value.lng) {
            throw new Error('Location must contain lat and lng');
        }
        if (typeof value.lat !== 'number' || typeof value.lng !== 'number') {
            throw new Error('lat and lng must be numbers');
        }
        if (value.lat < -90 || value.lat > 90) {
            throw new Error('Latitude must be between -90 and 90');
        }
        if (value.lng < -180 || value.lng > 180) {
            throw new Error('Longitude must be between -180 and 180');
        }
        return true;
    });

// Apply authentication to all routes
router.use(authMiddleware.authenticate);

/**
 * @route   GET /api/drivers
 * @desc    Get all drivers with pagination and filters
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
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
            .isIn(['available', 'busy', 'offline', 'on_break'])
            .withMessage('Valid status is required'),
        query('zoneId')
            .optional()
            .isUUID()
            .withMessage('Valid zone ID is required'),
        query('availableOnly')
            .optional()
            .isBoolean()
            .withMessage('availableOnly must be a boolean')
            .toBoolean(),
        query('sortBy')
            .optional()
            .isIn(['name', 'rating', 'createdAt', 'currentLoad'])
            .withMessage('Invalid sort field'),
        query('sortOrder')
            .optional()
            .isIn(['asc', 'desc'])
            .withMessage('Sort order must be asc or desc'),
    ]),
    driverController.getAllDrivers
);

/**
 * @route   GET /api/drivers/nearby
 * @desc    Find nearby available drivers
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/nearby',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        query('lat')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid latitude is required')
            .toFloat(),
        query('lng')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid longitude is required')
            .toFloat(),
        query('radius')
            .optional()
            .isFloat({ min: 100, max: 10000 })
            .withMessage('Radius must be between 100 and 10000 meters')
            .toFloat(),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 20 })
            .withMessage('Limit must be between 1 and 20')
            .toInt(),
        query('requiredCapacity')
            .optional()
            .isInt({ min: 1 })
            .withMessage('Required capacity must be a positive integer')
            .toInt(),
    ]),
    driverController.getNearbyDrivers
);

/**
 * @route   GET /api/drivers/:id
 * @desc    Get driver by ID
 * @access  Private (Admin, Dispatcher, Driver - own profile only)
 */
router.get(
    '/:id',
    validateRequest([driverIdValidation]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_READ,
        'id'
    ),
    driverController.getDriverById
);

/**
 * @route   POST /api/drivers
 * @desc    Create a new driver
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('name')
            .trim()
            .isLength({ min: 2, max: 100 })
            .withMessage('Name must be 2-100 characters'),
        body('email')
            .isEmail()
            .normalizeEmail()
            .withMessage('Valid email is required'),
        body('phone')
            .matches(/^(\+212|0)([ \-_/]*)(\d[ \-_/]*){9}$/)
            .withMessage('Valid Moroccan phone number is required'),
        body('vehicleType')
            .isIn(['motorcycle', 'car', 'van', 'truck'])
            .withMessage('Valid vehicle type is required'),
        body('vehiclePlate')
            .matches(/^[A-Z0-9\- ]{6,12}$/)
            .withMessage('Valid vehicle plate is required'),
        body('maxCapacity')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Max capacity must be 1-100')
            .toInt(),
        body('zones')
            .optional()
            .isArray()
            .withMessage('Zones must be an array'),
        body('zones.*')
            .optional()
            .isUUID()
            .withMessage('Each zone must be a valid UUID'),
        body('status')
            .optional()
            .isIn(['available', 'offline'])
            .withMessage('Valid status is required'),
    ]),
    driverController.createDriver
);

/**
 * @route   PUT /api/drivers/:id
 * @desc    Update driver information
 * @access  Private (Admin, Driver - own profile only)
 */
router.put(
    '/:id',
    validateRequest([
        driverIdValidation,
        body('name')
            .optional()
            .trim()
            .isLength({ min: 2, max: 100 })
            .withMessage('Name must be 2-100 characters'),
        body('email')
            .optional()
            .isEmail()
            .normalizeEmail()
            .withMessage('Valid email is required'),
        body('phone')
            .optional()
            .matches(/^(\+212|0)([ \-_/]*)(\d[ \-_/]*){9}$/)
            .withMessage('Valid Moroccan phone number is required'),
        body('vehicleType')
            .optional()
            .isIn(['motorcycle', 'car', 'van', 'truck'])
            .withMessage('Valid vehicle type is required'),
        body('vehiclePlate')
            .optional()
            .matches(/^[A-Z0-9\- ]{6,12}$/)
            .withMessage('Valid vehicle plate is required'),
        body('maxCapacity')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Max capacity must be 1-100')
            .toInt(),
        body('zones')
            .optional()
            .isArray()
            .withMessage('Zones must be an array'),
        body('zones.*')
            .optional()
            .isUUID()
            .withMessage('Each zone must be a valid UUID'),
        body('status')
            .optional()
            .isIn(['available', 'busy', 'offline', 'on_break'])
            .withMessage('Valid status is required'),
    ]),
    validateAtLeastOne([
        'name', 'email', 'phone', 'vehicleType', 
        'vehiclePlate', 'maxCapacity', 'zones', 'status'
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_UPDATE,
        'id'
    ),
    driverController.updateDriver
);

/**
 * @route   PATCH /api/drivers/:id/location
 * @desc    Update driver location
 * @access  Private (Driver - own location only, Admin, Dispatcher)
 */
router.patch(
    '/:id/location',
    validateRequest([
        driverIdValidation,
        locationValidation,
        body('heading')
            .optional()
            .isFloat({ min: 0, max: 360 })
            .withMessage('Heading must be 0-360 degrees')
            .toFloat(),
        body('speed')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Speed must be positive')
            .toFloat(),
        body('accuracy')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Accuracy must be positive')
            .toFloat(),
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_UPDATE,
        'id'
    ),
    driverController.updateDriverLocation
);

/**
 * @route   PATCH /api/drivers/:id/status
 * @desc    Update driver status
 * @access  Private (Admin, Dispatcher, Driver - own status only)
 */
router.patch(
    '/:id/status',
    validateRequest([
        driverIdValidation,
        body('status')
            .isIn(['available', 'busy', 'offline', 'on_break'])
            .withMessage('Valid status is required'),
        body('reason')
            .optional()
            .isString()
            .withMessage('Reason must be a string'),
        body('estimatedReturn')
            .optional()
            .isISO8601()
            .withMessage('Valid ISO 8601 date is required'),
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_UPDATE,
        'id'
    ),
    driverController.updateDriverStatus
);

/**
 * @route   DELETE /api/drivers/:id
 * @desc    Delete a driver
 * @access  Private (Admin, Super Admin)
 */
router.delete(
    '/:id',
    validateRequest([driverIdValidation]),
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    driverController.deleteDriver
);

/**
 * @route   GET /api/drivers/:id/deliveries
 * @desc    Get driver's deliveries
 * @access  Private (Admin, Dispatcher, Driver - own deliveries only)
 */
router.get(
    '/:id/deliveries',
    validateRequest([
        driverIdValidation,
        query('status')
            .optional()
            .isIn(['pending', 'assigned', 'in_transit', 'delivered', 'cancelled'])
            .withMessage('Valid delivery status is required'),
        query('startDate')
            .optional()
            .isISO8601()
            .withMessage('Valid start date is required'),
        query('endDate')
            .optional()
            .isISO8601()
            .withMessage('Valid end date is required'),
        query('page')
            .optional()
            .isInt({ min: 1 })
            .withMessage('Page must be a positive integer')
            .toInt(),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 50 })
            .withMessage('Limit must be between 1 and 50')
            .toInt(),
    ]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_READ,
        'id'
    ),
    driverController.getDriverDeliveries
);

/**
 * @route   GET /api/drivers/:id/stats
 * @desc    Get driver statistics
 * @access  Private (Admin, Dispatcher, Driver - own stats only)
 */
router.get(
    '/:id/stats',
    validateRequest([driverIdValidation]),
    roleMiddleware.isOwnerOrHasPermission(
        OwnershipCheck.DRIVER,
        Permission.DRIVER_READ,
        'id'
    ),
    driverController.getDriverStats
);

/**
 * @route   POST /api/drivers/:id/assign-delivery
 * @desc    Manually assign a delivery to driver (Smart Dispatcher override)
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/assign-delivery',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        driverIdValidation,
        body('deliveryId')
            .isUUID()
            .withMessage('Valid delivery ID is required'),
        body('force')
            .optional()
            .isBoolean()
            .withMessage('Force must be a boolean')
            .toBoolean(),
        body('reason')
            .optional()
            .isString()
            .withMessage('Reason must be a string'),
    ]),
    driverController.assignDeliveryToDriver
);

/**
 * @route   POST /api/drivers/:id/release
 * @desc    Force release driver from all assignments
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/:id/release',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        driverIdValidation,
        body('reason')
            .isString()
            .notEmpty()
            .withMessage('Release reason is required'),
        body('emergency')
            .optional()
            .isBoolean()
            .withMessage('Emergency must be a boolean')
            .toBoolean(),
    ]),
    driverController.forceReleaseDriver
);

/**
 * @route   GET /api/drivers/:id/availability
 * @desc    Check driver availability and capacity
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/:id/availability',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([driverIdValidation]), 
    driverController.checkDriverAvailability
);

/**
 * @route   POST /api/drivers/:id/bulk-status
 * @desc    Bulk update driver status (for maintenance)
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/:id/bulk-status',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('driverIds')
            .isArray({ min: 1 })
            .withMessage('Driver IDs array is required'),
        body('driverIds.*')
            .isUUID()
            .withMessage('Each driver ID must be a valid UUID'),
        body('status')
            .isIn(['available', 'offline', 'maintenance'])
            .withMessage('Valid status is required'),
        body('reason')
            .isString()
            .notEmpty()
            .withMessage('Reason is required'),
    ]),
    driverController.bulkUpdateDriverStatus
);

/**
 * @route   GET /api/drivers/search/suggest
 * @desc    Search drivers by name or plate (autocomplete)
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/search/suggest',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        query('q')
            .isString()
            .isLength({ min: 2 })
            .withMessage('Search query must be at least 2 characters'),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 20 })
            .withMessage('Limit must be between 1 and 20')
            .toInt(),
    ]),
    driverController.searchDrivers
);

/**
 * @route   POST /api/drivers/:id/rating
 * @desc    Rate a driver after delivery
 * @access  Private (Admin, Dispatcher, Customer - for own deliveries)
 */
router.post(
    '/:id/rating',
    authMiddleware.authenticate,
    validateRequest([
        driverIdValidation,
        body('rating')
            .isFloat({ min: 1, max: 5 })
            .withMessage('Rating must be between 1 and 5')
            .toFloat(),
        body('deliveryId')
            .isUUID()
            .withMessage('Valid delivery ID is required'),
        body('comment')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Comment must be less than 500 characters'),
    ]),
    driverController.rateDriver
);

/**
 * @route   GET /api/drivers/:id/analytics
 * @desc    Get driver analytics and performance metrics
 * @access  Private (Admin, Super Admin)
 */
router.get(
    '/:id/analytics',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        driverIdValidation,
        query('period')
            .optional()
            .isIn(['today', 'week', 'month', 'quarter', 'year'])
            .withMessage('Valid period is required'),
        query('metrics')
            .optional()
            .isArray()
            .withMessage('Metrics must be an array'),
    ]),
    driverController.getDriverAnalytics
);

/**
 * @route   POST /api/drivers/optimize-assignments
 * @desc    Optimize driver assignments for pending deliveries
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/optimize-assignments',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('zoneId')
            .optional()
            .isUUID()
            .withMessage('Valid zone ID is required'),
        body('strategy')
            .optional()
            .isIn(['distance', 'load_balance', 'priority', 'mixed'])
            .withMessage('Valid strategy is required'),
        body('maxAssignments')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Max assignments must be 1-100')
            .toInt(),
    ]),
    driverController.optimizeDriverAssignments
);

/**
 * @route   GET /api/drivers/health/status
 * @desc    Health check for drivers service
 * @access  Public
 */
router.get(
    '/health/status',
    async (req, res) => {
        try {
            const health = await driverController.checkHealth();
            res.status(200).json({
                success: true,
                data: health,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Driver health check failed:', error);
            res.status(503).json({
                success: false,
                error: 'Driver service unavailable',
                timestamp: new Date().toISOString(),
            });
        }
    }
);

export default router;