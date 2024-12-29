const ee = require('@google/earthengine');

class VegetationIndexService {
    static async calculateIndices(polygon, startDate, endDate) {
        try {
            // Input validation with detailed logging
            console.log('Input parameters:', {
                startDate,
                endDate,
                polygonCoordinates: polygon?.geometry?.coordinates
            });

            if (!polygon?.geometry?.coordinates) {
                throw new Error('Invalid polygon structure');
            }
            if (!startDate || !endDate) {
                throw new Error('Start and end dates are required');
            }

            const region = ee.Geometry.Polygon(polygon.geometry.coordinates);

            // Get initial collection size before filtering
            const initialCollection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                .filterBounds(region);
            const initialSize = await initialCollection.size().getInfo();
            console.log('Initial collection size:', initialSize);

            // Add filters one by one with size checks
            const dateFiltered = initialCollection.filterDate(startDate, endDate);
            const dateFilteredSize = await dateFiltered.size().getInfo();
            console.log('Collection size after date filter:', dateFilteredSize);

            const cloudFiltered = dateFiltered
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20));
            const cloudFilteredSize = await cloudFiltered.size().getInfo();
            console.log('Collection size after cloud filter:', cloudFilteredSize);

            // Remove processing baseline filter temporarily if no images found
            let s2Collection = cloudFiltered;
            let processingBaselineApplied = false;

            if (cloudFilteredSize > 0) {
                const withBaseline = cloudFiltered
                    .filter(ee.Filter.eq('PROCESSING_BASELINE', '04.00'));
                const baselineSize = await withBaseline.size().getInfo();
                console.log('Collection size after processing baseline filter:', baselineSize);

                if (baselineSize > 0) {
                    s2Collection = withBaseline;
                    processingBaselineApplied = true;
                }
            }

            // Sort by cloud coverage and date
            s2Collection = s2Collection
                .sort('CLOUDY_PIXEL_PERCENTAGE')
                .sort('system:time_start', true);

            const finalSize = await s2Collection.size().getInfo();
            console.log('Final collection size:', finalSize);

            if (finalSize === 0) {
                // Provide detailed error message based on filtering results
                let errorMessage = 'No suitable images found. ';
                if (initialSize === 0) {
                    errorMessage += 'No images found for the specified region. ';
                } else if (dateFilteredSize === 0) {
                    errorMessage += `No images found between ${startDate} and ${endDate}. `;
                } else if (cloudFilteredSize === 0) {
                    errorMessage += 'All images exceeded cloud coverage threshold of 20%. ';
                }
                errorMessage += 'Try adjusting your search criteria.';
                throw new Error(errorMessage);
            }

            // Get the first image details for logging
            const image = s2Collection.first();
            const imageProperties = await image.toDictionary().getInfo();
            console.log('Selected image properties:', {
                date: imageProperties['system:time_start'],
                cloudCover: imageProperties['CLOUDY_PIXEL_PERCENTAGE'],
                processingBaseline: imageProperties['PROCESSING_BASELINE']
            });

            // Band selection with resolution comments
            const bands = {
                blue: image.select('B2').rename('BLUE'),         // 10m
                green: image.select('B3').rename('GREEN'),       // 10m
                red: image.select('B4').rename('RED'),           // 10m
                redEdge1: image.select('B5').rename('RED_EDGE1'), // 20m
                redEdge2: image.select('B6').rename('RED_EDGE2'), // 20m
                redEdge3: image.select('B7').rename('RED_EDGE3'), // 20m
                nir: image.select('B8').rename('NIR'),           // 10m
                nir2: image.select('B8A').rename('NIR2'),        // 20m
                swir1: image.select('B11').rename('SWIR1'),      // 20m
                swir2: image.select('B12').rename('SWIR2')       // 20m
            };

            // Resample 20m bands to 10m for consistent calculations
            const resampledBands = ee.Image([
                bands.blue,
                bands.green,
                bands.red,
                bands.redEdge1.resample('bilinear'),
                bands.redEdge2.resample('bilinear'),
                bands.redEdge3.resample('bilinear'),
                bands.nir,
                bands.nir2.resample('bilinear'),
                bands.swir1.resample('bilinear'),
                bands.swir2.resample('bilinear')
            ]);

            // Index Calculations
            const indices = {
                NDVI: resampledBands.normalizedDifference(['NIR', 'RED']).rename('NDVI'),
                GNDVI: resampledBands.normalizedDifference(['NIR', 'GREEN']).rename('GNDVI'),
                RGR: resampledBands.select('RED').divide(resampledBands.select('GREEN')).rename('RGR'),
                NDRE: resampledBands.normalizedDifference(['NIR', 'RED_EDGE1']).rename('NDRE'),
                IPVI: resampledBands.select('NIR').divide(
                    resampledBands.select('NIR').add(resampledBands.select('RED'))
                ).rename('IPVI'),
                SAVI: resampledBands.expression(
                    '1.5 * (NIR - RED) / (NIR + RED + 0.5)',
                    {
                        'NIR': resampledBands.select('NIR'),
                        'RED': resampledBands.select('RED')
                    }
                ).rename('SAVI'),
                OSAVI: resampledBands.expression(
                    '(NIR - RED) / (NIR + RED + 0.16)',
                    {
                        'NIR': resampledBands.select('NIR'),
                        'RED': resampledBands.select('RED')
                    }
                ).rename('OSAVI'),
                CIgreen: resampledBands.select('NIR').divide(resampledBands.select('GREEN'))
                    .subtract(1).rename('CIgreen'),
                CIrededge: resampledBands.select('NIR').divide(resampledBands.select('RED_EDGE1'))
                    .subtract(1).rename('CIrededge')
            };

            // Combine all bands and indices
            const imageWithIndices = resampledBands.addBands(Object.values(indices));

            // Calculate statistics
            const stats = await imageWithIndices.reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: region,
                scale: 10,
                maxPixels: 1e9,
                tileScale: 4  // Added to handle larger regions
            }).getInfo();

            // Generate NDVI visualization
            const mapId = await imageWithIndices.select('NDVI').getMap({
                min: -1,
                max: 1,
                palette: ['red', 'white', 'green']
            });

            return {
                statistics: stats,
                mapUrl: `https://earthengine.googleapis.com/map/${mapId.mapid}`,
                timestamp: new Date().toISOString(),
                imageMetadata: {
                    acquisitionDate: image.get('system:time_start'),
                    cloudCover: image.get('CLOUDY_PIXEL_PERCENTAGE'),
                    processingBaseline: image.get('PROCESSING_BASELINE')
                }
            };
        } catch (error) {
            console.error('Error in calculateIndices:', error);
            throw new Error(`Vegetation index calculation failed: ${error.message}`);
        }
    }
}

module.exports = VegetationIndexService;