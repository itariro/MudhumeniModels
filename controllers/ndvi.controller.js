const NDVIService = require('../config/ndvi.service');

class NDVIController {
    static async analyzeRegion(req, res) {
        try {
            const { polygon, startDate, endDate } = req.body;

            const result = await NDVIService.calculateNDVI(polygon, startDate, endDate);

            res.json(result);
        } catch (error) {
            console.error('NDVI Analysis Error:', error);
            res.status(500).json({
                error: 'Failed to process NDVI analysis',
                message: error.message
            });
        }
    }
}

module.exports = NDVIController;