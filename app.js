const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const uuid = require('uuid');
const dotenv = require('dotenv');
const YieldPredictionModel = require('./models/yield.predition.model');
const { validateRequest } = require('./middleware/request.validator');
const errorHandler = require('./middleware/error.handler');
const monitoring = require('./utils/monitoring');
const config = require('./config/config');

const { initializeEarthEngine } = require('./config/earth.engine');
const ndviRoutes = require('./routes/vegetation.index.routes');
dotenv.config();

const app = express();
const apiV1Router = express.Router();

// Security middleware configuration
app.use(helmet());
app.use(cors({
    origin: config.cors.origins,
    methods: config.cors.methods
}));

// Rate limiting configuration
const limiter = rateLimit(config.rateLimit);
app.use(limiter);

// Request parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Request ID middleware for tracking
app.use((req, res, next) => {
    req.id = uuid.v4();
    res.setHeader('X-Request-ID', req.id);
    next();
});

// Configure morgan logging with custom token
morgan.token('id', (req) => req.id);

// Request logging configuration with timestamp
app.use(morgan(':id :method :url :status :response-time ms', {
    stream: {
        write: (message) => {
            console.log(`[${new Date().toISOString()}] ${message.trim()}`);
        }
    }
}));

// Monitoring middleware for metrics
app.use((req, res, next) => {
    res.on('finish', () => {
        monitoring.recordRequest(req.method, req.path, res.statusCode);
    });
    next();
});

// Initialize prediction model
const model = new YieldPredictionModel(config.model);

// API Routes for v1
// Health check endpoint for monitoring
apiV1Router.get('/health', (req, res) => {
    res.json(monitoring.getStats());
});

// API documentation endpoint
apiV1Router.get('/api-docs', (req, res) => {
    res.json({
        version: '1.0.0',
        suffix: '/api/v1',
        endpoints: {
            '/health': {
                method: 'GET',
                description: 'Health check and monitoring statistics'
            },
            '/train': {
                method: 'POST',
                description: 'Train model for specific field and crop type',
                requiredFields: ['fieldId', 'cropType', 'historicalData'],
                optionalFields: ['modelType']
            },
            '/cross-validate': {
                method: 'POST',
                description: 'Perform cross-validation on historical data',
                requiredFields: ['fieldId', 'cropType', 'historicalData'],
                optionalFields: ['k']
            },
            '/predict': {
                method: 'POST',
                description: 'Predict yield for given daily data',
                requiredFields: ['fieldId', 'cropType', 'dailyData']
            },
            '/ndvi/analyze': {
                method: 'POST',
                description: 'Predict yield for given daily data',
                requiredFields: ['fieldId', 'cropType', 'dailyData']
            }
        }
    });
});

// Model training endpoint
apiV1Router.post('/train',
    validateRequest(['fieldId', 'cropType', 'historicalData']),
    async (req, res, next) => {
        try {
            const { fieldId, cropType, historicalData, modelType } = req.body;
            const trainResult = await model.trainModel(
                fieldId,
                historicalData,
                cropType,
                modelType || 'randomForest'
            );

            if (!trainResult.success) {
                throw new ModelError(trainResult.error);
            }

            res.json(trainResult);
        } catch (error) {
            next(error);
        }
    }
);

// Cross-validation endpoint for model evaluation
apiV1Router.post('/cross-validate',
    validateRequest(['fieldId', 'cropType', 'historicalData']),
    async (req, res, next) => {
        try {
            const { fieldId, cropType, historicalData, k } = req.body;
            const result = await model.crossValidate(
                fieldId,
                historicalData,
                cropType,
                k || 5
            );
            res.json(result);
        } catch (error) {
            next(error);
        }
    }
);

// Yield prediction endpoint
apiV1Router.post('/predict',
    validateRequest(['fieldId', 'cropType', 'dailyData']),
    async (req, res, next) => {
        try {
            const { fieldId, cropType, dailyData } = req.body;
            const prediction = await model.predictYieldEnsemble(
                fieldId,
                dailyData,
                cropType
            );
            res.json(prediction);
        } catch (error) {
            next(error);
        }
    }
);

// Mount v1 router
app.use('/api/v1', apiV1Router);

// Global error handling middleware
app.use(errorHandler);

// Main server initialization function
const startServer = async () => {
    try {
        // Initialize Earth Engine
        await initializeEarthEngine();
        console.log('Earth Engine initialized successfully');

        // Mount NDVI routes
        app.use('/api/v1/ndvi', ndviRoutes);

        // Additional error handling for Earth Engine routes
        app.use((err, req, res, next) => {
            console.error(err.stack);
            res.status(500).json({
                error: 'Internal Server Error',
                message: err.message
            });
        });

        // Start server with environment-specific port
        const PORT = config.port || process.env.PORT || 3000;
        const server = app.listen(PORT, () => {
            console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
            console.log(`Environment: ${config.environment}`);
        });

        // Graceful shutdown handler
        process.on('SIGTERM', () => {
            console.log('SIGTERM received. Starting graceful shutdown...');
            server.close(() => {
                console.log('Server closed. Process terminating...');
                process.exit(0);
            });
        });

    } catch (error) {
        console.error('Failed to initialize Earth Engine:', error);
        process.exit(1);
    }
};

// Start the server
startServer();