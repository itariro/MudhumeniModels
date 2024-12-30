const express = require('express');
const { boreholeSitesSchema } = require('../middleware/polygon.validator');
const boreholeSitesController = require('../controllers/borehole.site.controller');

const router = express.Router();

router.post('/analyze', async (req, res, next) => {
    try {
        const { error } = boreholeSitesSchema.validate(req.body);
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
}, boreholeSitesController.analyzeRegion);

module.exports = router;