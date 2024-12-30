const VegetationIndexServiceSentinet2A = require('../services/vegetation.index.sentinel.service');
const VegetationIndexServicePlanet = require('../services/vegetation.index.planet.service');
const VegetationIndexServiceLandsat9 = require('../services/vegetation.index.landsat.service');

class VegetationIndexController {
    static async analyzeRegion(req, res) {
        try {
            const { polygon, startDate, endDate, source } = req.body;

            if (!polygon || !startDate || !endDate || !source) {
                return res.status(400).json({
                    error: 'Missing required parameters',
                    message: 'polygon, start date, end date, and source are required'
                });
            }

            let result;
            switch (source.toLowerCase()) {
                case 'sentinel2a':
                    result = await VegetationIndexServiceSentinet2A.calculateIndices(polygon, startDate, endDate);
                    break;
                case 'planet':
                    result = await VegetationIndexServicePlanet.calculateIndices(polygon, startDate, endDate);
                    break;
                case 'landsat':
                        result = await VegetationIndexServiceLandsat9.calculateIndices(polygon, startDate, endDate);
                        break;    
                default:
                    return res.status(400).json({
                        error: 'Invalid source',
                        message: 'Source must be either "sentinel2a" or "planet"'
                    });
            }

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