const config = require('../config');

const errorHandler = (err, req, res, next) => {
    const errorResponse = {
        error: err.message,
        requestId: req.id
    };

    // Add stack trace in development
    if (config.environment === 'development') {
        errorResponse.stack = err.stack;
    }

    // Log error details
    console.error(`[${new Date().toISOString()}] Error ${err.name}: ${err.message}`);
    console.error('RequestId:', req.id);
    console.error('Stack:', err.stack);

    switch (err.name) {
        case 'ValidationError':
            return res.status(400).json(errorResponse);
        case 'ModelError':
            return res.status(422).json(errorResponse);
        default:
            return res.status(500).json({
                error: 'Internal server error',
                requestId: req.id
            });
    }
};

module.exports = errorHandler;