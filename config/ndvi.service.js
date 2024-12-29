const ee = require('@google/earthengine');

class NDVIService {
    static async calculateNDVI(polygon, startDate, endDate) {
        const region = ee.Geometry.Polygon(polygon.geometry.coordinates);

        const planetCollection = ee.ImageCollection('PLANET/NICFI/VISUAL')
            .filterBounds(region)
            .filterDate(startDate, endDate)
            .sort('system:time_start', false);

        const image = planetCollection.first();

        // Calculate NDVI
        const nir = image.select('N');
        const red = image.select('R');
        const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
        const imageWithNDVI = image.addBands(ndvi);

        // Get statistics
        const stats = await imageWithNDVI.select(['N', 'R', 'NDVI'])
            .reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: region,
                scale: 4.77,
                maxPixels: 1e9
            })
            .evaluate();

        // Generate map URL (optional)
        const mapId = await imageWithNDVI.select('NDVI').getMap({
            min: -1,
            max: 1,
            palette: ['red', 'white', 'green']
        });

        return {
            statistics: {
                nir: stats.N,
                red: stats.R,
                ndvi: stats.NDVI
            },
            mapUrl: `https://earthengine.googleapis.com/map/${mapId.mapid}`,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = NDVIService;