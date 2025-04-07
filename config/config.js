require('dotenv').config();

const config = {
    port: process.env.PORT || 3000,
    environment: process.env.NODE_ENV || 'development',
    model: {
        rfEstimators: parseInt(process.env.RF_ESTIMATORS) || 100,
        rfMaxDepth: parseInt(process.env.RF_MAX_DEPTH) || 12,
        rfMinSamplesSplit: parseInt(process.env.RF_MIN_SAMPLES_SPLIT) || 5,
        gbLearningRate: parseFloat(process.env.GB_LEARNING_RATE) || 0.1,
        gbEstimators: parseInt(process.env.GB_ESTIMATORS) || 100,
        gbMaxDepth: parseInt(process.env.GB_MAX_DEPTH) || 6,
        seed: parseInt(process.env.SEED) || 42,
        rollingWindowSize: parseInt(process.env.ROLLING_WINDOW_SIZE) || 7
    },
    rateLimit: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: parseInt(process.env.RATE_LIMIT) || 100
    },
    cors: {
        origins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
        methods: ['GET', 'POST']
    },
    gmrtApiUrl: process.env.GMRT_API_URL || 'https://www.gmrt.org:443/services/PointServer',
    meteoApiUrl: process.env.METEO_API_URL || 'https://api.open-meteo.com/v1/elevation',
};

module.exports = config;