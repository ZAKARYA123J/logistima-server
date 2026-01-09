import { Router } from 'express';
import { ZoneController } from '../controllers/zone.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { roleMiddleware, UserRole, Permission } from '../middlewares/role.middleware.js';
import { validateRequest, validateAtLeastOne, validateFile } from '../middlewares/validation.middleware.js';
import { body, param, query } from 'express-validator';
import { logger } from '../utils/logger.js';

const router = Router();
const zoneController = new ZoneController();

// Common validation rules
const zoneIdValidation = param('id')
    .isUUID()
    .withMessage('Valid zone ID is required');

// Polygon validation for GeoJSON
const polygonValidation = body('polygon')
    .isObject()
    .withMessage('Polygon must be a GeoJSON object')
    .custom(value => {
        if (!value.type || value.type !== 'Polygon') {
            throw new Error('Polygon must be GeoJSON Polygon type');
        }
        if (!value.coordinates || !Array.isArray(value.coordinates)) {
            throw new Error('Polygon must have coordinates array');
        }
        // Validate coordinates structure
        const coords = value.coordinates[0];
        if (!Array.isArray(coords) || coords.length < 4) {
            throw new Error('Polygon must have at least 4 points');
        }
        // Check if polygon is closed
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            throw new Error('Polygon must be closed (first and last points must be equal)');
        }
        return true;
    });

// Apply authentication to all routes
router.use(authMiddleware.authenticate);

/**
 * @route   GET /api/zones
 * @desc    Get all zones with pagination and filters
 * @access  Private (Admin, Dispatcher, Driver)
 */
router.get(
    '/',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.DRIVER, UserRole.SUPER_ADMIN]),
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
        query('isActive')
            .optional()
            .isBoolean()
            .withMessage('isActive must be a boolean')
            .toBoolean(),
        query('search')
            .optional()
            .isString()
            .withMessage('Search must be a string'),
        query('sortBy')
            .optional()
            .isIn(['name', 'createdAt', 'deliveryCount', 'priority'])
            .withMessage('Invalid sort field'),
        query('sortOrder')
            .optional()
            .isIn(['asc', 'desc'])
            .withMessage('Sort order must be asc or desc'),
    ]),
    zoneController.getAllZones
);

/**
 * @route   GET /api/zones/:id
 * @desc    Get zone by ID
 * @access  Private (Admin, Dispatcher, Driver)
 */
router.get(
    '/:id',
    validateRequest([zoneIdValidation]),
    roleMiddleware.hasPermission(Permission.ZONE_READ),
    zoneController.getZoneById
);

/**
 * @route   POST /api/zones
 * @desc    Create a new delivery zone
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('name')
            .trim()
            .isLength({ min: 2, max: 50 })
            .withMessage('Name must be 2-50 characters'),
        polygonValidation,
        body('description')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Description must be less than 500 characters'),
        body('color')
            .optional()
            .matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
            .withMessage('Valid hex color is required'),
        body('priority')
            .optional()
            .isInt({ min: 1, max: 10 })
            .withMessage('Priority must be between 1 and 10')
            .toInt(),
        body('deliveryHours')
            .optional()
            .isObject()
            .withMessage('Delivery hours must be an object'),
        body('deliveryHours.*.start')
            .optional()
            .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
            .withMessage('Valid time format (HH:MM) is required'),
        body('deliveryHours.*.end')
            .optional()
            .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
            .withMessage('Valid time format (HH:MM) is required'),
        body('deliveryFee')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Delivery fee must be positive')
            .toFloat(),
        body('minDeliveryTime')
            .optional()
            .isInt({ min: 0 })
            .withMessage('Minimum delivery time must be positive')
            .toInt(),
        body('maxDeliveryTime')
            .optional()
            .isInt({ min: 0 })
            .withMessage('Maximum delivery time must be positive')
            .toInt(),
        body('isActive')
            .optional()
            .isBoolean()
            .withMessage('isActive must be a boolean')
            .toBoolean(),
    ]),
    zoneController.createZone
);

/**
 * @route   PUT /api/zones/:id
 * @desc    Update zone information
 * @access  Private (Admin, Super Admin)
 */
router.put(
    '/:id',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('name')
            .optional()
            .trim()
            .isLength({ min: 2, max: 50 })
            .withMessage('Name must be 2-50 characters'),
        body('polygon')
            .optional()
            .isObject()
            .withMessage('Polygon must be an object'),
        body('description')
            .optional()
            .isString()
            .isLength({ max: 500 })
            .withMessage('Description must be less than 500 characters'),
        body('color')
            .optional()
            .matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/)
            .withMessage('Valid hex color is required'),
        body('priority')
            .optional()
            .isInt({ min: 1, max: 10 })
            .withMessage('Priority must be between 1 and 10')
            .toInt(),
        body('deliveryHours')
            .optional()
            .isObject()
            .withMessage('Delivery hours must be an object'),
        body('deliveryFee')
            .optional()
            .isFloat({ min: 0 })
            .withMessage('Delivery fee must be positive')
            .toFloat(),
        body('minDeliveryTime')
            .optional()
            .isInt({ min: 0 })
            .withMessage('Minimum delivery time must be positive')
            .toInt(),
        body('maxDeliveryTime')
            .optional()
            .isInt({ min: 0 })
            .withMessage('Maximum delivery time must be positive')
            .toInt(),
        body('isActive')
            .optional()
            .isBoolean()
            .withMessage('isActive must be a boolean')
            .toBoolean(),
    ]),
    validateAtLeastOne([
        'name', 'polygon', 'description', 'color', 'priority',
        'deliveryHours', 'deliveryFee', 'minDeliveryTime', 
        'maxDeliveryTime', 'isActive'
    ]),
    zoneController.updateZone
);

/**
 * @route   DELETE /api/zones/:id
 * @desc    Delete a zone (soft delete)
 * @access  Private (Admin, Super Admin)
 */
router.delete(
    '/:id',
    validateRequest([zoneIdValidation]),
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    zoneController.deleteZone
);

/**
 * @route   GET /api/zones/locate
 * @desc    Find zone for given coordinates
 * @access  Private (Admin, Dispatcher, Driver)
 */
router.get(
    '/locate',
    roleMiddleware.hasPermission(Permission.ZONE_READ),
    validateRequest([
        query('lat')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid latitude is required')
            .toFloat(),
        query('lng')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid longitude is required')
            .toFloat(),
        query('includeInactive')
            .optional()
            .isBoolean()
            .withMessage('includeInactive must be a boolean')
            .toBoolean(),
    ]),
    zoneController.locateZone
);

/**
 * @route   POST /api/zones/bulk-locate
 * @desc    Find zones for multiple coordinates
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/bulk-locate',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('coordinates')
            .isArray({ min: 1, max: 100 })
            .withMessage('Coordinates must be an array with 1-100 items'),
        body('coordinates.*.lat')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid latitude is required')
            .toFloat(),
        body('coordinates.*.lng')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid longitude is required')
            .toFloat(),
    ]),
    zoneController.bulkLocateZones
);

/**
 * @route   GET /api/zones/:id/overlap
 * @desc    Check if zone overlaps with others
 * @access  Private (Admin, Super Admin)
 */
router.get(
    '/:id/overlap',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([zoneIdValidation]),
    zoneController.checkZoneOverlap
);

/**
 * @route   GET /api/zones/:id/drivers
 * @desc    Get drivers assigned to zone
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/:id/drivers',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([zoneIdValidation]),
    zoneController.getZoneDrivers
);

/**
 * @route   GET /api/zones/:id/deliveries
 * @desc    Get deliveries in zone
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/:id/deliveries',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
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
            .isInt({ min: 1, max: 100 })
            .withMessage('Limit must be between 1 and 100')
            .toInt(),
    ]),
    zoneController.getZoneDeliveries
);

/**
 * @route   GET /api/zones/:id/stats
 * @desc    Get zone statistics
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/:id/stats',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        query('period')
            .optional()
            .isIn(['today', 'week', 'month', 'quarter', 'year'])
            .withMessage('Valid period is required'),
    ]),
    zoneController.getZoneStats
);

/**
 * @route   POST /api/zones/:id/assign-driver
 * @desc    Assign driver to zone
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/assign-driver',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('driverId')
            .isUUID()
            .withMessage('Valid driver ID is required'),
        body('isPrimary')
            .optional()
            .isBoolean()
            .withMessage('isPrimary must be a boolean')
            .toBoolean(),
    ]),
    zoneController.assignDriverToZone
);

/**
 * @route   POST /api/zones/:id/remove-driver
 * @desc    Remove driver from zone
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/remove-driver',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('driverId')
            .isUUID()
            .withMessage('Valid driver ID is required'),
    ]),
    zoneController.removeDriverFromZone
);

/**
 * @route   POST /api/zones/:id/optimize-drivers
 * @desc    Optimize driver assignments for zone
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/optimize-drivers',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('strategy')
            .optional()
            .isIn(['load_balance', 'proximity', 'experience', 'mixed'])
            .withMessage('Valid strategy is required'),
        body('maxDrivers')
            .optional()
            .isInt({ min: 1, max: 50 })
            .withMessage('Max drivers must be between 1 and 50')
            .toInt(),
    ]),
    zoneController.optimizeZoneDrivers
);

/**
 * @route   GET /api/zones/search/geofence
 * @desc    Search zones by geofencing
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/search/geofence',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        body('boundingBox')
            .isObject()
            .withMessage('Bounding box is required'),
        body('boundingBox.north')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid north latitude is required')
            .toFloat(),
        body('boundingBox.south')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid south latitude is required')
            .toFloat(),
        body('boundingBox.east')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid east longitude is required')
            .toFloat(),
        body('boundingBox.west')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid west longitude is required')
            .toFloat(),
        body('isActive')
            .optional()
            .isBoolean()
            .withMessage('isActive must be a boolean')
            .toBoolean(),
    ]),
    zoneController.searchZonesByGeofence
);

/**
 * @route   GET /api/zones/search/suggest
 * @desc    Search zones by name (autocomplete)
 * @access  Private (Admin, Dispatcher, Driver)
 */
router.get(
    '/search/suggest',
    roleMiddleware.hasPermission(Permission.ZONE_READ),
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
    zoneController.searchZones
);

/**
 * @route   GET /api/zones/stats/overview
 * @desc    Get zones statistics overview
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/stats/overview',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        query('period')
            .optional()
            .isIn(['today', 'week', 'month', 'quarter', 'year'])
            .withMessage('Valid period is required'),
        query('includeInactive')
            .optional()
            .isBoolean()
            .withMessage('includeInactive must be a boolean')
            .toBoolean(),
    ]),
    zoneController.getZonesOverview
);

/**
 * @route   POST /api/zones/import
 * @desc    Import zones from GeoJSON file
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/import',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateFile(
        'zonesFile',
        ['application/json', 'text/json', 'application/geo+json'],
        10 * 1024 * 1024 // 10MB
    ),
    validateRequest([
        body('overwrite')
            .optional()
            .isBoolean()
            .withMessage('overwrite must be a boolean')
            .toBoolean(),
        body('validateOnly')
            .optional()
            .isBoolean()
            .withMessage('validateOnly must be a boolean')
            .toBoolean(),
    ]),
    zoneController.importZones
);

/**
 * @route   GET /api/zones/export
 * @desc    Export zones to GeoJSON file
 * @access  Private (Admin, Super Admin)
 */
router.get(
    '/export',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        query('format')
            .optional()
            .isIn(['geojson', 'csv', 'kml'])
            .withMessage('Valid export format is required'),
        query('includeInactive')
            .optional()
            .isBoolean()
            .withMessage('includeInactive must be a boolean')
            .toBoolean(),
    ]),
    zoneController.exportZones
);

/**
 * @route   POST /api/zones/:id/merge
 * @desc    Merge zone with another zone
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/:id/merge',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('targetZoneId')
            .isUUID()
            .withMessage('Valid target zone ID is required'),
        body('newName')
            .optional()
            .isString()
            .isLength({ min: 2, max: 50 })
            .withMessage('New name must be 2-50 characters'),
        body('mergeDrivers')
            .optional()
            .isBoolean()
            .withMessage('mergeDrivers must be a boolean')
            .toBoolean(),
    ]),
    zoneController.mergeZones
);

/**
 * @route   POST /api/zones/:id/split
 * @desc    Split zone into multiple zones
 * @access  Private (Admin, Super Admin)
 */
router.post(
    '/:id/split',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('splitPoints')
            .isArray({ min: 2, max: 10 })
            .withMessage('Split points must be an array with 2-10 items'),
        body('splitPoints.*.lat')
            .isFloat({ min: -90, max: 90 })
            .withMessage('Valid latitude is required')
            .toFloat(),
        body('splitPoints.*.lng')
            .isFloat({ min: -180, max: 180 })
            .withMessage('Valid longitude is required')
            .toFloat(),
        body('newZoneNames')
            .optional()
            .isArray()
            .withMessage('New zone names must be an array'),
    ]),
    zoneController.splitZone
);

/**
 * @route   GET /api/zones/:id/heatmap
 * @desc    Get delivery heatmap for zone
 * @access  Private (Admin, Dispatcher)
 */
router.get(
    '/:id/heatmap',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        query('period')
            .optional()
            .isIn(['day', 'week', 'month'])
            .withMessage('Valid period is required'),
        query('resolution')
            .optional()
            .isIn(['high', 'medium', 'low'])
            .withMessage('Valid resolution is required'),
    ]),
    zoneController.getZoneHeatmap
);

/**
 * @route   POST /api/zones/:id/simulate-load
 * @desc    Simulate delivery load for zone
 * @access  Private (Admin, Dispatcher)
 */
router.post(
    '/:id/simulate-load',
    roleMiddleware.hasRole([UserRole.ADMIN, UserRole.DISPATCHER, UserRole.SUPER_ADMIN]),
    validateRequest([
        zoneIdValidation,
        body('scenario')
            .isIn(['ramadan', 'black_friday', 'weekend', 'holiday', 'custom'])
            .withMessage('Valid scenario is required'),
        body('parameters')
            .optional()
            .isObject()
            .withMessage('Parameters must be an object'),
        body('simulationDuration')
            .optional()
            .isInt({ min: 1, max: 24 })
            .withMessage('Simulation duration must be 1-24 hours')
            .toInt(),
    ]),
    zoneController.simulateZoneLoad
);

/**
 * @route   GET /api/zones/health/status
 * @desc    Health check for zones service
 * @access  Public
 */
router.get(
    '/health/status',
    async (req, res) => {
        try {
            const health = await zoneController.checkHealth();
            res.status(200).json({
                success: true,
                data: health,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Zone health check failed:', error);
            res.status(503).json({
                success: false,
                error: 'Zone service unavailable',
                timestamp: new Date().toISOString(),
            });
        }
    }
);

export default router;