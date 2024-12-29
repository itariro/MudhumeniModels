const ee = require('@google/earthengine');

class VegetationIndexServicePlanet {
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

            // Get initial collection using SKYSAT
            const initialCollection = ee.ImageCollection('SKYSAT/GEN-A/PUBLIC/ORTHO/MULTISPECTRAL')
                .filterBounds(region);
            const initialSize = await initialCollection.size().getInfo();
            console.log('Initial collection size:', initialSize);

            // Add date filter
            const dateFiltered = initialCollection.filterDate(startDate, endDate);
            const dateFilteredSize = await dateFiltered.size().getInfo();
            console.log('Collection size after date filter:', dateFilteredSize);

            // Sort by date to get the most recent image
            const planetCollection = dateFiltered.sort('system:time_start', false);

            const finalSize = await planetCollection.size().getInfo();
            console.log('Final collection size:', finalSize);

            if (finalSize === 0) {
                // Provide detailed error message based on filtering results
                let errorMessage = 'No suitable images found. ';
                if (initialSize === 0) {
                    errorMessage += 'No images found for the specified region. ';
                } else if (dateFilteredSize === 0) {
                    errorMessage += `No images found between ${startDate} and ${endDate}. `;
                }
                errorMessage += 'Try adjusting your search criteria.';
                throw new Error(errorMessage);
            }

            // Get the first image details for logging
            const image = planetCollection.first();
            const imageProperties = await image.toDictionary().getInfo();
            console.log('Selected image properties:', {
                date: imageProperties['system:time_start']
            });

            // Band selection based on SKYSAT specifications
            // All bands are at 2m resolution except panchromatic at 0.8m
            const bands = {
                blue: image.select('B').rename('BLUE'),       // 450-515nm
                green: image.select('G').rename('GREEN'),     // 515-595nm
                red: image.select('R').rename('RED'),         // 605-695nm
                nir: image.select('N').rename('NIR'),         // 740-900nm
                pan: image.select('P').rename('PAN')          // 450-900nm
            };

            // Create composite image with all bands
            const compositeBands = ee.Image([
                bands.blue,
                bands.green,
                bands.red,
                bands.nir,
                bands.pan
            ]);

            // Index Calculations
            // Note: Some indices from the original code are removed as they required bands not available in SKYSAT
            const indices = {
                NDVI: compositeBands.normalizedDifference(['NIR', 'RED']).rename('NDVI'),
                GNDVI: compositeBands.normalizedDifference(['NIR', 'GREEN']).rename('GNDVI'),
                RGR: compositeBands.select('RED').divide(compositeBands.select('GREEN')).rename('RGR'),
                IPVI: compositeBands.select('NIR').divide(
                    compositeBands.select('NIR').add(compositeBands.select('RED'))
                ).rename('IPVI'),
                SAVI: compositeBands.expression(
                    '1.5 * (NIR - RED) / (NIR + RED + 0.5)',
                    {
                        'NIR': compositeBands.select('NIR'),
                        'RED': compositeBands.select('RED')
                    }
                ).rename('SAVI'),
                OSAVI: compositeBands.expression(
                    '(NIR - RED) / (NIR + RED + 0.16)',
                    {
                        'NIR': compositeBands.select('NIR'),
                        'RED': compositeBands.select('RED')
                    }
                ).rename('OSAVI'),
                CIgreen: compositeBands.select('NIR').divide(compositeBands.select('GREEN'))
                    .subtract(1).rename('CIgreen')
            };

            // Combine all bands and indices
            const imageWithIndices = compositeBands.addBands(Object.values(indices));

            // Calculate statistics at 2m resolution
            const stats = await imageWithIndices.reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: region,
                scale: 2, // Using native 2m resolution
                maxPixels: 1e9,
                tileScale: 4
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
                    resolution: '2m multispectral, 0.8m panchromatic'
                }
            };
        } catch (error) {
            console.error('Error in calculateIndices:', error);
            throw new Error(`Vegetation index calculation failed: ${error.message}`);
        }
    }
}

module.exports = VegetationIndexServicePlanet;