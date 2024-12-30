const express = require('express');
const { vegetationIndexSchema } = require('../middleware/polygon.validator');
const vegetationIndexController = require('../controllers/vegetation.index.controller');

const router = express.Router();

router.post('/analyze', async (req, res, next) => {
    try {
        const { error } = vegetationIndexSchema.validate(req.body);
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
}, vegetationIndexController.analyzeRegion);

module.exports = router;