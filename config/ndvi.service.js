const ee = require('@google/earthengine');

class NDVIService {
  static calculateNDVI(polygon, startDate, endDate) {
    return new Promise((resolve, reject) => {
      const region = ee.Geometry.Polygon(polygon.geometry.coordinates);
      const planetCollection = ee.ImageCollection('PLANET/NICFI/VISUAL')
        .filterBounds(region)
        .filterDate(startDate, endDate)
        .sort('system:time_start', false);

      // Add check for empty collection
      planetCollection.size().evaluate((error, size) => {
        if (error) {
          reject(error);
          return;
        }
        if (size === 0) {
          reject(new Error('No images found for the specified date range and region'));
          return;
        }

        const image = planetCollection.first();
        
        // Verify bands exist before calculation
        image.bandNames().evaluate((error, bandNames) => {
          if (error) {
            reject(error);
            return;
          }
          if (!bandNames.includes('N') || !bandNames.includes('R')) {
            reject(new Error('Required bands (N, R) not found in the image'));
            return;
          }

          // Calculate NDVI
          const nir = image.select('N');
          const red = image.select('R');
          const ndvi = nir.subtract(red).divide(nir.add(red)).rename('NDVI');
          const imageWithNDVI = image.addBands(ndvi);

          // Get statistics using callback
          imageWithNDVI.select(['N', 'R', 'NDVI'])
            .reduceRegion({
              reducer: ee.Reducer.mean(),
              geometry: region,
              scale: 4.77,
              maxPixels: 1e9
            })
            .evaluate((error, stats) => {
              if (error) {
                reject(error);
                return;
              }

              if (!stats || !stats.N || !stats.R || !stats.NDVI) {
                reject(new Error('Failed to calculate statistics for the region'));
                return;
              }

              // Generate map URL
              imageWithNDVI.select('NDVI').getMap({
                min: -1,
                max: 1,
                palette: ['red', 'white', 'green']
              }, (error, mapId) => {
                if (error) {
                  reject(error);
                  return;
                }

                resolve({
                  statistics: {
                    nir: stats.N,
                    red: stats.R,
                    ndvi: stats.NDVI
                  },
                  mapUrl: `https://earthengine.googleapis.com/map/${mapId.mapid}`,
                  timestamp: new Date().toISOString()
                });
              });
            });
        });
      });
    });
  }
}

module.exports = NDVIService;