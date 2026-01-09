import { Queue, Worker, QueueEvents, Job, FlowProducer } from 'bullmq';
import Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export interface RouteCalculationJobData {
    deliveryId: string;
    pickupLocation: {
        lat: number;
        lng: number;
        address?: string;
    };
    deliveryLocation: {
        lat: number;
        lng: number;
        address?: string;
    };
    priority?: number;
    zoneId?: string;
}

export interface ReceiptGenerationJobData {
    deliveryId: string;
    parcelId: string;
    driverId?: string;
    customerEmail?: string;
    amount?: number;
}

export interface DeliveryNotificationJobData {
    deliveryId: string;
    parcelId: string;
    status: string;
    driverId: string;
    customerEmail?: string;
    message?: string;
}

export interface ZoneUpdateJobData {
    zoneId: string;
    action: 'create' | 'update' | 'delete';
    data?: any;
}

export class QueueService {
    private redisConnection: Redis;
    private queues: Map<string, Queue>;
    private workers: Map<string, Worker>;
    private queueEvents: Map<string, QueueEvents>;
    private flowProducer: FlowProducer;
    private isInitialized: boolean = false;

    constructor() {
        this.redisConnection = this.createRedisConnection();
        this.queues = new Map();
        this.workers = new Map();
        this.queueEvents = new Map();
        this.flowProducer = new FlowProducer({ connection: this.redisConnection });
        
        this.setupEventListeners();
    }

    private createRedisConnection(): Redis {
        return new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
            db: parseInt(process.env.REDIS_QUEUE_DB || '1'),
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            connectTimeout: 10000,
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 100, 5000);
                logger.warn(`Queue Redis reconnecting attempt ${times}, delay: ${delay}ms`);
                return delay;
            }
        });
    }

    private setupEventListeners(): void {
        this.redisConnection.on('connect', () => {
            logger.info('Queue Redis connected');
        });

        this.redisConnection.on('ready', () => {
            logger.info('Queue Redis ready');
            this.isInitialized = true;
        });

        this.redisConnection.on('error', (error) => {
            logger.error('Queue Redis error:', error);
            this.isInitialized = false;
        });

        this.redisConnection.on('close', () => {
            logger.warn('Queue Redis connection closed');
            this.isInitialized = false;
        });

        this.redisConnection.on('reconnecting', () => {
            logger.info('Queue Redis reconnecting...');
        });
    }

    /**
     * Initialize all queues
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        logger.info('Initializing queues...');

        // Main delivery processing queue
        const deliveryQueue = new Queue('delivery-processing', {
            connection: this.redisConnection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
                },
                removeOnComplete: 100,
                removeOnFail: 500,
            },
        });
        this.queues.set('delivery-processing', deliveryQueue);

        // Route calculation queue (CPU intensive)
        const routeQueue = new Queue('route-calculation', {
            connection: this.redisConnection,
            defaultJobOptions: {
                attempts: 2,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                },
                removeOnComplete: 50,
                removeOnFail: 100,
                timeout: 30000, // 30 seconds timeout
            },
        });
        this.queues.set('route-calculation', routeQueue);

        // Receipt generation queue
        const receiptQueue = new Queue('receipt-generation', {
            connection: this.redisConnection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'fixed',
                    delay: 3000,
                },
                removeOnComplete: 200,
                removeOnFail: 1000,
            },
        });
        this.queues.set('receipt-generation', receiptQueue);

        // Notification queue
        const notificationQueue = new Queue('delivery-notification', {
            connection: this.redisConnection,
            defaultJobOptions: {
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
                removeOnComplete: 1000,
                removeOnFail: 5000,
            },
        });
        this.queues.set('delivery-notification', notificationQueue);

        // High priority queue
        const priorityQueue = new Queue('high-priority', {
            connection: this.redisConnection,
            defaultJobOptions: {
                priority: 1,
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
                removeOnComplete: 1000,
            },
        });
        this.queues.set('high-priority', priorityQueue);

        // Zone management queue
        const zoneQueue = new Queue('zone-management', {
            connection: this.redisConnection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'fixed',
                    delay: 2000,
                },
                removeOnComplete: 100,
                removeOnFail: 300,
            },
        });
        this.queues.set('zone-management', zoneQueue);

        // Setup queue events for monitoring
        for (const [queueName, queue] of this.queues) {
            const queueEvents = new QueueEvents(queueName, {
                connection: this.redisConnection,
            });

            this.setupQueueEventListeners(queueEvents, queueName);
            this.queueEvents.set(queueName, queueEvents);
        }

        logger.info('All queues initialized');
    }

    private setupQueueEventListeners(queueEvents: QueueEvents, queueName: string): void {
        queueEvents.on('completed', ({ jobId, returnvalue }) => {
            logger.info(`Job ${jobId} completed in queue ${queueName}`, {
                queue: queueName,
                jobId,
                returnValue: returnvalue
            });
        });

        queueEvents.on('failed', ({ jobId, failedReason }) => {
            logger.error(`Job ${jobId} failed in queue ${queueName}: ${failedReason}`, {
                queue: queueName,
                jobId,
                error: failedReason
            });
        });

        queueEvents.on('stalled', ({ jobId }) => {
            logger.warn(`Job ${jobId} stalled in queue ${queueName}`, {
                queue: queueName,
                jobId
            });
        });

        queueEvents.on('progress', ({ jobId, data }) => {
            logger.debug(`Job ${jobId} progress in queue ${queueName}:`, {
                queue: queueName,
                jobId,
                progress: data
            });
        });

        queueEvents.on('waiting', ({ jobId }) => {
            logger.debug(`Job ${jobId} added to queue ${queueName}`, {
                queue: queueName,
                jobId
            });
        });

        queueEvents.on('active', ({ jobId, prev }) => {
            logger.debug(`Job ${jobId} is now active in queue ${queueName}`, {
                queue: queueName,
                jobId,
                previous: prev
            });
        });
    }

    /**
     * Add a route calculation job
     */
    public async addRouteCalculationJob(data: RouteCalculationJobData): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('route-calculation');
        if (!queue) {
            throw new AppError('Route calculation queue not found', 500);
        }

        const job = await queue.add('calculate-route', data, {
            jobId: `route-${data.deliveryId}-${Date.now()}`,
            priority: data.priority || 3,
            timeout: 30000, // 30 seconds
        });

        logger.info(`Route calculation job added for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            jobId: job.id,
            priority: data.priority
        });

        return job;
    }

    /**
     * Add a receipt generation job
     */
    public async addReceiptGenerationJob(data: ReceiptGenerationJobData): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('receipt-generation');
        if (!queue) {
            throw new AppError('Receipt generation queue not found', 500);
        }

        const job = await queue.add('generate-receipt', data, {
            jobId: `receipt-${data.deliveryId}-${Date.now()}`,
        });

        logger.info(`Receipt generation job added for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            jobId: job.id
        });

        return job;
    }

    /**
     * Add a final receipt job
     */
    public async addFinalReceiptJob(data: ReceiptGenerationJobData): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('receipt-generation');
        if (!queue) {
            throw new AppError('Receipt generation queue not found', 500);
        }

        const job = await queue.add('final-receipt', data, {
            jobId: `final-receipt-${data.deliveryId}-${Date.now()}`,
            priority: 2,
            delay: 2000, // Delay 2 seconds to ensure delivery is marked completed
        });

        logger.info(`Final receipt job added for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            jobId: job.id
        });

        return job;
    }

    /**
     * Add a delivery notification job
     */
    public async addDeliveryNotificationJob(data: DeliveryNotificationJobData): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('delivery-notification');
        if (!queue) {
            throw new AppError('Delivery notification queue not found', 500);
        }

        const job = await queue.add('send-notification', data, {
            jobId: `notification-${data.deliveryId}-${Date.now()}`,
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 1000,
            },
        });

        logger.debug(`Notification job added for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            status: data.status,
            jobId: job.id
        });

        return job;
    }

    /**
     * Add a zone update job (for cache invalidation)
     */
    public async addZoneUpdateJob(data: ZoneUpdateJobData): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('zone-management');
        if (!queue) {
            throw new AppError('Zone management queue not found', 500);
        }

        const job = await queue.add('update-zone-cache', data, {
            jobId: `zone-${data.action}-${data.zoneId}-${Date.now()}`,
            priority: 2,
        });

        logger.info(`Zone update job added for zone ${data.zoneId}`, {
            zoneId: data.zoneId,
            action: data.action,
            jobId: job.id
        });

        return job;
    }

    /**
     * Add a high priority job
     */
    public async addHighPriorityJob(name: string, data: any): Promise<Job> {
        await this.ensureInitialized();
        
        const queue = this.queues.get('high-priority');
        if (!queue) {
            throw new AppError('High priority queue not found', 500);
        }

        const job = await queue.add(name, data, {
            jobId: `high-${name}-${Date.now()}`,
            priority: 1,
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 500,
            },
        });

        logger.warn(`High priority job added: ${name}`, {
            jobName: name,
            jobId: job.id,
            data
        });

        return job;
    }

    /**
     * Create a worker for a queue
     */
    public createWorker(
        queueName: string,
        processor: (job: Job) => Promise<any>,
        options: any = {}
    ): Worker {
        const worker = new Worker(queueName, processor, {
            connection: this.redisConnection,
            concurrency: options.concurrency || 3,
            limiter: options.limiter || {
                max: 20,
                duration: 1000,
            },
            ...options,
        });

        this.setupWorkerEventListeners(worker, queueName);
        this.workers.set(`${queueName}-worker`, worker);

        logger.info(`Worker created for queue ${queueName}`, {
            queue: queueName,
            concurrency: worker.opts.concurrency
        });

        return worker;
    }

    private setupWorkerEventListeners(worker: Worker, queueName: string): void {
        worker.on('completed', (job, result) => {
            logger.info(`Worker completed job ${job.id} in queue ${queueName}`, {
                queue: queueName,
                jobId: job.id,
                result
            });
        });

        worker.on('failed', (job, err) => {
            logger.error(`Worker failed job ${job?.id} in queue ${queueName}: ${err.message}`, {
                queue: queueName,
                jobId: job?.id,
                error: err.message,
                stack: err.stack,
                attemptsMade: job?.attemptsMade,
                data: job?.data
            });
        });

        worker.on('stalled', (jobId) => {
            logger.warn(`Worker stalled job ${jobId} in queue ${queueName}`, {
                queue: queueName,
                jobId
            });
        });

        worker.on('error', (err) => {
            logger.error(`Worker error in queue ${queueName}: ${err.message}`, {
                queue: queueName,
                error: err.message,
                stack: err.stack
            });
        });

        worker.on('closed', () => {
            logger.info(`Worker for queue ${queueName} closed`);
        });

        worker.on('ioredis:close', () => {
            logger.warn(`Redis connection closed for worker in queue ${queueName}`);
        });
    }

    /**
     * Create all default workers
     */
    public createAllWorkers(): void {
        // Route calculation worker
        this.createWorker('route-calculation', this.routeCalculationProcessor.bind(this), {
            concurrency: 2, // Low concurrency for CPU-intensive tasks
            limiter: {
                max: 5,
                duration: 1000,
            },
        });

        // Receipt generation worker
        this.createWorker('receipt-generation', this.receiptGenerationProcessor.bind(this), {
            concurrency: 5,
            limiter: {
                max: 10,
                duration: 1000,
            },
        });

        // Notification worker
        this.createWorker('delivery-notification', this.notificationProcessor.bind(this), {
            concurrency: 10,
            limiter: {
                max: 50,
                duration: 1000,
            },
        });

        // Zone management worker
        this.createWorker('zone-management', this.zoneManagementProcessor.bind(this), {
            concurrency: 3,
        });

        // High priority worker
        this.createWorker('high-priority', this.highPriorityProcessor.bind(this), {
            concurrency: 2,
            limiter: {
                max: 100,
                duration: 1000,
            },
        });

        logger.info('All workers created');
    }

    /**
     * Route calculation processor
     */
    private async routeCalculationProcessor(job: Job): Promise<any> {
        const data = job.data as RouteCalculationJobData;
        
        logger.info(`Starting route calculation for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            jobId: job.id
        });

        // Simulate heavy calculation (2 seconds as specified)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Simulate route calculation logic
        const pickup = data.pickupLocation;
        const delivery = data.deliveryLocation;
        
        const distance = this.calculateDistance(
            pickup.lat,
            pickup.lng,
            delivery.lat,
            delivery.lng
        );

        const estimatedRoute = {
            distance: parseFloat(distance.toFixed(2)), // km
            duration: Math.ceil(distance * 3), // minutes (simplified)
            polyline: 'simulated_polyline_data',
            steps: [
                { instruction: `Start at ${pickup.address || 'pickup location'}`, distance: 0 },
                { instruction: 'Take optimal route through Casablanca', distance: distance * 0.7 },
                { instruction: `Arrive at ${delivery.address || 'delivery location'}`, distance: distance * 0.3 },
            ],
            waypoints: [
                { lat: pickup.lat, lng: pickup.lng },
                { lat: delivery.lat, lng: delivery.lng }
            ],
            calculatedAt: new Date().toISOString(),
            trafficConditions: 'moderate'
        };

        logger.info(`Route calculated for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            distance: estimatedRoute.distance,
            duration: estimatedRoute.duration
        });

        // Log to console as specified
        console.log(`🗺️ Route calculated for delivery ${data.deliveryId}: ${estimatedRoute.distance}km, ${estimatedRoute.duration}min`);

        return {
            success: true,
            deliveryId: data.deliveryId,
            estimatedRoute,
            jobId: job.id,
            processedAt: new Date().toISOString()
        };
    }

    /**
     * Receipt generation processor
     */
    private async receiptGenerationProcessor(job: Job): Promise<any> {
        const data = job.data as ReceiptGenerationJobData;
        
        logger.info(`Generating receipt for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            jobId: job.id
        });

        // Simulate receipt generation
        await new Promise(resolve => setTimeout(resolve, 1000));

        const receiptId = `RCP-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
        const amount = data.amount || (Math.random() * 100 + 20); // Random amount between 20-120 MAD
        
        const receipt = {
            id: receiptId,
            deliveryId: data.deliveryId,
            parcelId: data.parcelId,
            driverId: data.driverId,
            generatedAt: new Date().toISOString(),
            url: `${process.env.RECEIPT_BASE_URL || 'https://receipts.logistima.ma'}/${receiptId}`,
            amount: parseFloat(amount.toFixed(2)),
            tax: parseFloat((amount * 0.2).toFixed(2)), // 20% VAT
            total: parseFloat((amount * 1.2).toFixed(2)),
            currency: 'MAD',
            items: [
                { description: 'Express Delivery Service', quantity: 1, price: amount },
                { description: 'Value Added Tax (20%)', quantity: 1, price: amount * 0.2 }
            ],
            qrCode: `data:image/svg+xml;base64,${Buffer.from(`QR for ${receiptId}`).toString('base64')}`
        };

        logger.info(`Receipt generated for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            receiptId: receipt.id,
            amount: receipt.total
        });

        // Log to console as specified
        console.log(`🧾 Receipt generated for delivery ${data.deliveryId}: ${receipt.url}`);

        // Send notification if email provided
        if (data.customerEmail) {
            await this.addDeliveryNotificationJob({
                deliveryId: data.deliveryId,
                parcelId: data.parcelId,
                status: 'receipt_generated',
                driverId: data.driverId || 'system',
                customerEmail: data.customerEmail,
                message: `Your receipt is available at: ${receipt.url}`
            });
        }

        return {
            success: true,
            receipt,
            jobId: job.id,
            processedAt: new Date().toISOString()
        };
    }

    /**
     * Notification processor
     */
    private async notificationProcessor(job: Job): Promise<any> {
        const data = job.data as DeliveryNotificationJobData;
        
        logger.debug(`Sending notification for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            status: data.status,
            jobId: job.id
        });

        // Simulate notification sending
        await new Promise(resolve => setTimeout(resolve, 500));

        // Log to console as specified in requirements
        const emoji = this.getStatusEmoji(data.status);
        console.log(`${emoji} Notification: Delivery ${data.deliveryId} status changed to ${data.status}`);

        // In production, you would:
        // 1. Send push notification
        // 2. Send SMS
        // 3. Send email
        // 4. Update dashboard via WebSocket

        const notificationResult = {
            sent: true,
            deliveryId: data.deliveryId,
            status: data.status,
            timestamp: new Date().toISOString(),
            channels: ['console'], // In production: ['push', 'email', 'sms']
            message: data.message || `Delivery ${data.deliveryId} is now ${data.status}`
        };

        logger.debug(`Notification sent for delivery ${data.deliveryId}`, {
            deliveryId: data.deliveryId,
            status: data.status,
            result: notificationResult
        });

        return notificationResult;
    }

    /**
     * Zone management processor
     */
    private async zoneManagementProcessor(job: Job): Promise<any> {
        const data = job.data as ZoneUpdateJobData;
        
        logger.info(`Processing zone update for zone ${data.zoneId}`, {
            zoneId: data.zoneId,
            action: data.action,
            jobId: job.id
        });

        // In production, this would interact with Redis cache
        // For now, simulate cache operations
        await new Promise(resolve => setTimeout(resolve, 300));

        let result;
        switch (data.action) {
            case 'create':
                result = { action: 'cache_created', zoneId: data.zoneId };
                break;
            case 'update':
                result = { action: 'cache_updated', zoneId: data.zoneId };
                break;
            case 'delete':
                result = { action: 'cache_deleted', zoneId: data.zoneId };
                break;
            default:
                result = { action: 'unknown', zoneId: data.zoneId };
        }

        // Log cache operation
        console.log(`🗺️ Zone cache ${data.action}d for zone ${data.zoneId}`);

        return {
            success: true,
            ...result,
            jobId: job.id,
            processedAt: new Date().toISOString()
        };
    }

    /**
     * High priority processor
     */
    private async highPriorityProcessor(job: Job): Promise<any> {
        const data = job.data;
        
        logger.warn(`Processing high priority job: ${job.name}`, {
            jobName: job.name,
            jobId: job.id,
            data
        });

        // Process based on job name
        let result;
        switch (job.name) {
            case 'emergency-replacement':
                result = await this.handleEmergencyReplacement(data);
                break;
            case 'system-alert':
                result = await this.handleSystemAlert(data);
                break;
            default:
                result = { action: 'processed', data };
        }

        return {
            success: true,
            jobName: job.name,
            jobId: job.id,
            result,
            processedAt: new Date().toISOString()
        };
    }

    private async handleEmergencyReplacement(data: any): Promise<any> {
        logger.error(`Emergency driver replacement: ${JSON.stringify(data)}`);
        // In production, implement emergency logic
        return { emergencyHandled: true, ...data };
    }

    private async handleSystemAlert(data: any): Promise<any> {
        logger.error(`System alert: ${JSON.stringify(data)}`);
        // In production, send alerts to monitoring system
        return { alertSent: true, ...data };
    }

    /**
     * Get queue metrics
     */
    public async getQueueMetrics(queueName: string): Promise<any> {
        await this.ensureInitialized();
        
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new AppError(`Queue ${queueName} not found`, 404);
        }

        const [
            waiting,
            active,
            completed,
            failed,
            delayed,
            paused,
        ] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
            queue.getPausedCount(),
        ]);

        const metrics = {
            queue: queueName,
            metrics: {
                waiting,
                active,
                completed,
                failed,
                delayed,
                paused,
                total: waiting + active + completed + failed + delayed,
            },
            isPaused: paused > 0,
            timestamp: new Date().toISOString(),
            workers: this.workers.has(`${queueName}-worker`) ? 'active' : 'inactive'
        };

        logger.debug(`Queue metrics for ${queueName}`, metrics);

        return metrics;
    }

    /**
     * Get all queue metrics
     */
    public async getAllQueueMetrics(): Promise<any[]> {
        await this.ensureInitialized();
        
        const metricsPromises = Array.from(this.queues.keys()).map(queueName =>
            this.getQueueMetrics(queueName).catch(error => ({
                queue: queueName,
                error: error.message,
                timestamp: new Date().toISOString()
            }))
        );

        return await Promise.all(metricsPromises);
    }

    /**
     * Pause a queue
     */
    public async pauseQueue(queueName: string): Promise<void> {
        await this.ensureInitialized();
        
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new AppError(`Queue ${queueName} not found`, 404);
        }

        await queue.pause();
        logger.warn(`Queue ${queueName} paused`);
    }

    /**
     * Resume a queue
     */
    public async resumeQueue(queueName: string): Promise<void> {
        await this.ensureInitialized();
        
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new AppError(`Queue ${queueName} not found`, 404);
        }

        await queue.resume();
        logger.info(`Queue ${queueName} resumed`);
    }

    /**
     * Clean old jobs from queue
     */
    public async cleanQueue(
        queueName: string,
        grace: number = 1000 * 60 * 60 // 1 hour
    ): Promise<number> {
        await this.ensureInitialized();
        
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new AppError(`Queue ${queueName} not found`, 404);
        }

        const [completedCount, failedCount] = await Promise.all([
            queue.clean(grace, 1000, 'completed'),
            queue.clean(grace, 1000, 'failed'),
        ]);

        const totalCleaned = completedCount.length + failedCount.length;
        
        logger.info(`Cleaned ${totalCleaned} old jobs from queue ${queueName}`, {
            queue: queueName,
            completed: completedCount.length,
            failed: failedCount.length,
            total: totalCleaned
        });

        return totalCleaned;
    }

    /**
     * Retry all failed jobs in a queue
     */
    public async retryFailedJobs(queueName: string): Promise<number> {
        await this.ensureInitialized();
        
        const queue = this.queues.get(queueName);
        if (!queue) {
            throw new AppError(`Queue ${queueName} not found`, 404);
        }

        const failedJobs = await queue.getFailed();
        let retriedCount = 0;

        for (const job of failedJobs) {
            try {
                await job.retry();
                retriedCount++;
                logger.info(`Retried failed job ${job.id} in queue ${queueName}`);
            } catch (error) {
                logger.error(`Failed to retry job ${job.id}:`, error);
            }
        }

        logger.info(`Retried ${retriedCount} failed jobs in queue ${queueName}`);
        return retriedCount;
    }

    /**
     * Health check
     */
    public async healthCheck(): Promise<{
        redis: boolean;
        queues: Array<{ name: string; status: string }>;
        workers: number;
        isInitialized: boolean;
    }> {
        const redisHealth = await this.checkRedisConnection();
        
        const queueStatuses = Array.from(this.queues.entries()).map(([name]) => ({
            name,
            status: 'active'
        }));

        return {
            redis: redisHealth,
            queues: queueStatuses,
            workers: this.workers.size,
            isInitialized: this.isInitialized
        };
    }

    private async checkRedisConnection(): Promise<boolean> {
        try {
            await this.redisConnection.ping();
            return true;
        } catch (error) {
            return false;
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }
    }

    /**
     * Calculate distance between two coordinates (Haversine formula)
     */
    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371; // Earth's radius in km
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

    /**
     * Get emoji for delivery status
     */
    private getStatusEmoji(status: string): string {
        const emojis: Record<string, string> = {
            'pending': '⏳',
            'assigned': '📋',
            'in_transit': '🚚',
            'delivered': '✅',
            'cancelled': '❌',
            'route_calculated': '🗺️',
            'receipt_generated': '🧾',
            'emergency': '🚨',
            'completed': '🎉',
            'started': '🚀'
        };
        
        return emojis[status] || '📱';
    }

    /**
     * Close all connections
     */
    public async close(): Promise<void> {
        logger.info('Closing queue service connections...');

        // Close all workers
        for (const [name, worker] of this.workers) {
            try {
                await worker.close();
                logger.info(`Worker ${name} closed`);
            } catch (error) {
                logger.error(`Error closing worker ${name}:`, error);
            }
        }

        // Close all queue events
        for (const [name, queueEvents] of this.queueEvents) {
            try {
                await queueEvents.close();
                logger.info(`Queue events for ${name} closed`);
            } catch (error) {
                logger.error(`Error closing queue events for ${name}:`, error);
            }
        }

        // Close flow producer
        try {
            await this.flowProducer.close();
            logger.info('Flow producer closed');
        } catch (error) {
            logger.error('Error closing flow producer:', error);
        }

        // Close Redis connection
        try {
            await this.redisConnection.quit();
            logger.info('Queue Redis connection closed');
        } catch (error) {
            logger.error('Error closing Queue Redis connection:', error);
        }

        this.isInitialized = false;
        logger.info('Queue service connections closed');
    }
}