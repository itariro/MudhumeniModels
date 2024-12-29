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

            // ... rest of the processing code remains the same ...

        } catch (error) {
            console.error('Detailed error in calculateIndices:', error);
            throw error;
        }
    }
}

module.exports = VegetationIndexService;