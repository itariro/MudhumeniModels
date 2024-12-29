const { ValidationError } = require('../utils/errors');

const validateRequest = (requiredFields) => (req, res, next) => {
    try {
        for (const field of requiredFields) {
            if (!req.body[field]) {
                throw new ValidationError(`Missing required field: ${field}`);
            }

            if (field === 'historicalData' && !Array.isArray(req.body[field])) {
                throw new ValidationError('historicalData must be an array');
            }

            if (field === 'dailyData' && typeof req.body[field] !== 'object') {
                throw new ValidationError('dailyData must be an object');
            }
        }
        next();
    } catch (error) {
        next(error);
    }
};

module.exports = { validateRequest };