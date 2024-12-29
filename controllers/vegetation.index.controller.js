const VegetationIndexService = require('../services/vegetation.index.service');

class VegetationIndexController {
    static async analyzeRegion(req, res) {
        try {
            const { polygon, startDate, endDate } = req.body;

            if (!polygon || !startDate || !endDate) {
                return res.status(400).json({
                    error: 'Missing required parameters',
                    message: 'Polygon, start date, and end date are required'
                });
            }

            const result = await VegetationIndexService.calculateIndices(polygon, startDate, endDate);
            return res.json(result);
        } catch (error) {
            console.error('NDVI Analysis Error:', error);
            return res.status(500).json({
                error: 'Failed to process NDVI analysis',
                message: error.message
            });
        }
    }
}

module.exports = VegetationIndexController;