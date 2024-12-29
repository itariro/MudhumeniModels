const VegetationIndexServiceSentinet2A = require('../services/vegetation.index.sentinel.service');
const VegetationIndexServicePlanet = require('../services/vegetation.index.planet.service');

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

            // const result = await VegetationIndexServiceSentinet2A.calculateIndices(polygon, startDate, endDate);
            const result = await VegetationIndexServicePlanet.calculateIndices(polygon, startDate, endDate);

            return res.json(result);
        } catch (error) {
            console.error('Vegetation Index Analysis Error:', error);
            return res.status(500).json({
                error: 'Failed to process Vegetation Index analysis',
                message: error.message
            });
        }
    }
}

module.exports = VegetationIndexController;