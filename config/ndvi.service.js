const ee = require('@google/earthengine');

class VegetationIndexService {
    static async calculateIndices(polygon, startDate, endDate) {
        try {
            const region = ee.Geometry.Polygon(polygon.geometry.coordinates);
            const s2Collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                .filterBounds(region)
                .filterDate(startDate, endDate)
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                .sort('system:time_start', true);

            const collectionSize = await s2Collection.size().getInfo();
            if (collectionSize === 0) {
                throw new Error('No suitable images found.');
            }

            const image = s2Collection.first();

            // Band Renaming based on provided image
            const blue = image.select('B2').rename('BLUE'); // 10m
            const green = image.select('B3').rename('GREEN'); // 10m
            const red = image.select('B4').rename('RED');   // 10m
            const redEdge1 = image.select('B5').rename('RED_EDGE1'); // 20m
            const redEdge2 = image.select('B6').rename('RED_EDGE2'); // 20m
            const redEdge3 = image.select('B7').rename('RED_EDGE3'); // 20m
            const nir = image.select('B8').rename('NIR');   // 10m
            const nir2 = image.select('B8A').rename('NIR2'); // 20m
            const swir1 = image.select('B11').rename('SWIR1'); // 20m
            const swir2 = image.select('B12').rename('SWIR2'); // 20m

            // Index Calculations (using appropriate bands)
            const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
            const gndvi = nir.subtract(green).divide(nir.add(green)).rename('GNDVI');
            const rgr = red.divide(green).rename('RGR');
            const ndre = nir.subtract(redEdge1).divide(nir.add(redEdge1)).rename('NDRE'); // Using Red Edge 1
            const ipvi = nir.divide(nir.add(red)).rename('IPVI');
            const savi = nir.subtract(red).multiply(1.5).divide(nir.add(red).add(0.5)).rename('SAVI');
            const osavi = nir.subtract(red).divide(nir.add(red).add(0.16)).rename('OSAVI');
            const cigreen = nir.divide(green).subtract(1).rename('CIgreen');
            const cirededge = nir.divide(redEdge1).subtract(1).rename('CIrededge'); // Using Red Edge 1

            // Add all indices to the image
            let imageWithIndices = image.addBands([ndvi, gndvi, rgr, ndre, ipvi, savi, osavi, cigreen, cirededge]);

            // Define the bands to extract statistics for. Important to include bands used in calculations
            const bandsForStats = ['BLUE', 'GREEN', 'RED', 'RED_EDGE1', 'NIR', 'SWIR1', 'SWIR2', 'NDVI', 'GNDVI', 'RGR', 'NDRE', 'IPVI', 'SAVI', 'OSAVI', 'CIgreen', 'CIrededge'];

            const stats = await imageWithIndices.select(bandsForStats).reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: region,
                scale: 10, //Keep scale at 10 to avoid issues with 20m bands, statistics will be approximate for 20m bands
                maxPixels: 1e9
            }).getInfo();

            const mapId = await imageWithIndices.select('NDVI').getMap({
                min: -1,
                max: 1,
                palette: ['red', 'white', 'green']
            });

            return {
                statistics: stats,
                mapUrl: `https://earthengine.googleapis.com/map/${mapId.mapid}`,
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            throw error;
        }
    }
}

module.exports = VegetationIndexService;