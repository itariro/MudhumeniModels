const ee = require('@google/earthengine');

class VegetationIndexServicePlanet {
    static async calculateIndices(polygon, startDate, endDate) {
        try {
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
            
            // Check polygon area
            const area = region.area(1);
            const areaInHa = ee.Number(area).divide(10000); // Convert to hectares

            // Force computation of area before comparison
            const actualArea = await areaInHa.getInfo();
            if (actualArea > 20) { // Simple JavaScript comparison
                throw new Error(`Polygon area exceeds the allowed limit. ${actualArea} ha provided, 20 ha allowed.`);
            }

            const initialCollection = ee.ImageCollection('SKYSAT/GEN-A/PUBLIC/ORTHO/MULTISPECTRAL')
                .filterBounds(region);
            const initialSize = await initialCollection.size().getInfo();
            console.log('Initial collection size:', initialSize);

            const dateFiltered = initialCollection.filterDate(startDate, endDate);
            const dateFilteredSize = await dateFiltered.size().getInfo();
            console.log('Collection size after date filter:', dateFilteredSize);

            // Add cloud masking and quality scoring
            const processedCollection = dateFiltered
                .map(function (image) {
                    const masked = image.updateMask(image.select('quality').lt(2));
                    return masked.addBands(
                        ee.Image.constant(image.get('quality')).rename('score')
                    );
                })
                .sort('system:time_start', false);

            const finalSize = await processedCollection.size().getInfo();
            console.log('Final collection size:', finalSize);

            if (finalSize === 0) {
                let errorMessage = 'No suitable images found. ';
                if (initialSize === 0) {
                    errorMessage += 'No images found for the specified region. ';
                } else if (dateFilteredSize === 0) {
                    errorMessage += `No images found between ${startDate} and ${endDate}. `;
                }
                errorMessage += 'Try adjusting your search criteria.';
                throw new Error(errorMessage);
            }

            // Select best image based on quality score
            const image = processedCollection.first();
            const imageProperties = await image.toDictionary().getInfo();
            console.log('Selected image properties:', {
                date: imageProperties['system:time_start'],
                quality: imageProperties['quality']
            });

            // Optimized band selection
            const requiredBands = ['B', 'G', 'R', 'N', 'P'];
            const selectedImage = image.select(requiredBands);

            const bands = {
                blue: selectedImage.select('B').rename('BLUE'),
                green: selectedImage.select('G').rename('GREEN'),
                red: selectedImage.select('R').rename('RED'),
                nir: selectedImage.select('N').rename('NIR'),
                pan: selectedImage.select('P').rename('PAN')
            };

            const compositeBands = ee.Image([
                bands.blue,
                bands.green,
                bands.red,
                bands.nir,
                bands.pan
            ]);

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

            const imageWithIndices = compositeBands.addBands(Object.values(indices));

            // CRUCIAL CHANGE: Use sampleRegion()
            const samples = imageWithIndices.sampleRegion({
                collection: ee.FeatureCollection([ee.Feature(region)]), // Important: create a FeatureCollection
                scale: 3, // 3m resolution
                geometries: true, // Include geometry with samples
                projection: image.projection() // Use the image's projection for accuracy
            });

            const sampledData = await samples.getInfo();

            // Process the sampled data client-side
            const stats = {};
            const bandNames = imageWithIndices.bandNames().getInfo();
            bandNames.forEach(band => {
                const values = sampledData.features.map(feature => feature.properties[band]);
                stats[band] = {
                    mean: values.reduce((sum, val) => sum + val, 0) / values.length,
                    // Add other stats like min, max, stdDev if needed
                };
            });
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
                    resolution: '2m multispectral, 0.8m panchromatic',
                    cloudCover: image.get('cloud_cover'),
                    sunAzimuth: image.get('sun_azimuth'),
                    sunElevation: image.get('sun_elevation'),
                    qualityScore: image.get('quality'),
                    processingLevel: image.get('processing_level'),
                    spacecraft: image.get('spacecraft'),
                    orbitNumber: image.get('orbit_number')
                }
            };

        } catch (error) {
            console.error('Error in calculateIndices:', error);
            throw new Error(`Vegetation index calculation failed: ${error.message}`);
        }
    }
}

module.exports = VegetationIndexServicePlanet;