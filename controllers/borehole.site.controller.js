const BoreholeSiteService = require('../services/borehole.site.service');

class BoreholeSiteController {
    static async analyzeRegion(req, res) {
        try {
            const { polygon, source } = req.body;

            if (!polygon || !source) {
                return res.status(400).json({
                    error: 'Missing required parameters',
                    message: 'polygon and source are required'
                });
            }

            let result;
            switch (source.toLowerCase()) {
                case 'unspecified':
                    result = await BoreholeSiteService.identifyLocations(polygon);
                    break;
                default:
                    return res.status(400).json({
                        error: 'Invalid source',
                        message: 'Source must be "unspecified"'
                    });
            }

            return res.json(result);
        } catch (error) {
            console.error('Borehole Site Analysis Error:', error);
            return res.status(500).json({
                error: 'Failed to process Borehole Site analysis',
                message: error.message
            });
        }
    }
}

module.exports = BoreholeSiteController;