const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const uuid = require('uuid');
const YieldPredictionModel = require('./yield-predition-model');
const { validateRequest } = require('./middleware/validation');
const errorHandler = require('./middleware/error-handler');
const monitoring = require('./utils/monitoring');
const config = require('./config');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
    origin: config.cors.origins,
    methods: config.cors.methods
}));

// Rate limiting
const limiter = rateLimit(config.rateLimit);
app.use(limiter);

// Request parsing
app.use(express.json({ limit: '1mb' }));

// Add request ID and logging
app.use((req, res, next) => {
    req.id = uuid.v4();
    res.setHeader('X-Request-ID', req.id);
    next();
});

// Custom morgan token for request ID
morgan.token('id', (req) => req.id);

// Request logging
app.use(morgan(':id :method :url :status :response-time ms', {
    stream: {
        write: (message) => {
            console.log(`[${new Date().toISOString()}] ${message.trim()}`);
        }
    }
}));

// Record request metrics
app.use((req, res, next) => {
    res.on('finish', () => {
        monitoring.recordRequest(req.method, req.path, res.statusCode);
    });
    next();
});

// Initialize model
const model = new YieldPredictionModel(config.model);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json(monitoring.getStats());
});

// API documentation endpoint
app.get('/api-docs', (req, res) => {
    res.json({
        version: '1.0.0',
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
            }
        }
    });
});

// Training endpoint
app.post('/train',
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

// Cross-validation endpoint
app.post('/cross-validate',
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

// Prediction endpoint
app.post('/predict',
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

// Error handling middleware (should be last)
app.use(errorHandler);

// Start server
app.listen(config.port, () => {
    console.log(`[${new Date().toISOString()}] Server started on port ${config.port}`);
    console.log(`Environment: ${config.environment}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Starting graceful shutdown...');
    server.close(() => {
        console.log('Server closed. Process terminating...');
        process.exit(0);
    });
});