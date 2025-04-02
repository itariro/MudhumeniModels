class GeoConstants {
    static EARTH_ENGINE_DATASETS = {
        ELEVATION: 'USGS/SRTMGL1_003',
        LANDCOVER: 'MODIS/006/MCD12Q1',
        SOIL_MOISTURE: 'NASA/USDA/HSL/SMAP_soil_moisture',
        TEMPERATURE: 'MODIS/006/MOD11A1'
    };

    static DEPTH_RANGES = {
        MIN: 30,
        MAX: 200,
        AQUIFER_ADJUSTMENT: 20,
        PRECIPITATION_ADJUSTMENT: 10
    };
}