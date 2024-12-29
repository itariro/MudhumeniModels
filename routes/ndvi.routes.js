const express = require('express');
const { polygonSchema } = require('../middleware/polygon.validator');
const NDVIController = require('../controllers/ndvi.controller');

const router = express.Router();

router.post('/analyze', async (req, res, next) => {
    try {
        const { error } = polygonSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                error: 'Validation Error',
                details: error.details
            });
        }
        next();
    } catch (error) {
        next(error);
    }
}, NDVIController.analyzeRegion);

module.exports = router;