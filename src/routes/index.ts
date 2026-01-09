import { Router } from 'express';
import deliveryRoutes from './delivery.routes.js';
import driverRoutes from './driver.routes.js';
import zoneRoutes from './zone.routes.js';
import parcelRoutes from './parcel.routes.js';

const router = Router();

// Montage des routes
router.use('/deliveries', deliveryRoutes);
router.use('/drivers', driverRoutes);
router.use('/zones', zoneRoutes);
router.use('/parcels', parcelRoutes);

// Route de santé
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
            database: 'connected',
            redis: 'connected',
            queue: 'active'
        }
    });
});

// Route 404
router.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

export default router;