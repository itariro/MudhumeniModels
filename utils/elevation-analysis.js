const axios = require('axios');
const turf = require('@turf/turf');
const booleanValid = require('@turf/boolean-valid');
const winston = require('winston');
const { valid } = require('geojson-validation');
const config = require('../config/config');
const { default: PQueue } = require('p-queue');

/**
 * Configures a Winston logger for recording elevation analysis logs
 * Logs are written to a file in JSON format at the 'info' log level
 */
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        //new winston.transports.Console(),
        new winston.transports.File({ filename: 'elevation-analysis.log' })
    ]
});

/**
 * Utility class for performing statistical calculations on numeric arrays
 * Provides methods for computing basic and advanced statistical metrics
 */
class StatisticsUtils {
    /**
     * Calculate the mean of an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Mean value
     */
    static mean(values) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
            sum += values[i];
        }
        return sum / values.length; // Single-pass instead of reduce
    }

    /**
     * Calculate the median of an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Median value
     */
    static median(values) {
        if (!values.length) throw new Error('Input array cannot be empty');
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    }

    /**
     * Calculate the maximum value in an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Maximum value
     */
    static max(values) {
        if (!values.length) throw new Error('Input array cannot be empty');
        return Math.max(...values);
    }

    /**
     * Calculate the minimum value in an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Minimum value
     */
    static min(values) {
        if (!values.length) throw new Error('Input array cannot be empty');
        return Math.min(...values);
    }

    /**
     * Calculate the standard deviation of an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Standard deviation
     */
    static stdDev(values) {
        if (!values.length) throw new Error('Input array cannot be empty');
        const mean = StatisticsUtils.mean(values);
        const squareDiffs = values.map(value => Math.pow(value - mean, 2));
        return Math.sqrt(StatisticsUtils.mean(squareDiffs));
    }

    /**
     * Calculate confidence interval for an array of values
     * @param {number[]} values - Array of numbers
     * @param {number} confidence - Confidence level (default 0.95)
     * @returns {Object} - Object containing lower and upper bounds
     */
    static confidenceInterval(values, confidence = 0.95) {
        if (values.length < 2) {
            throw new Error('Need at least 2 values for confidence interval');
        }

        // Expanded t-table with linear approximation for missing values
        const tTable = {
            0.95: [
                12.706, 4.303, 3.182, 2.776, 2.571, // df 1-5
                2.447, 2.365, 2.306, 2.262, 2.228,  // df 6-10
                2.201, 2.179, 2.160, 2.145, 2.131,  // df 11-15
                2.120, 2.110, 2.101, 2.093, 2.086   // df 16-20
            ],
            0.99: [
                63.657, 9.925, 5.841, 4.604, 4.032,
                3.707, 3.499, 3.355, 3.250, 3.169,
                3.106, 3.055, 3.012, 2.977, 2.947,
                2.921, 2.898, 2.878, 2.861, 2.845
            ]
        };

        const { mean, variance, count } = this.onePassStats(values);
        const df = count - 1;

        // Calculate t-value
        let tValue;
        if (df >= 30) {
            // Use normal approximation for large samples
            tValue = confidence === 0.95 ? 1.96 : 2.576;
        } else if (df <= 20) {
            tValue = tTable[confidence][df - 1] || 1.96;
        } else {
            // Linear interpolation between 20-30 df
            const base = tTable[confidence][19];
            tValue = base - (base - 1.96) * ((df - 20) / 10);
        }

        const stdErr = Math.sqrt(variance / count);

        return {
            mean: mean,
            lower: mean - tValue * stdErr,
            upper: mean + tValue * stdErr,
            confidence: confidence,
            marginOfError: tValue * stdErr
        };
    }

    /**
     * Calculate mean and variance in single pass
     * @param {number[]} values 
     * @returns {Object} {mean, variance, count}
     */
    static onePassStats(values) {
        if (!values.length) throw new Error('Input array cannot be empty');

        let mean = 0;
        let M2 = 0;
        let count = 0;

        for (const x of values) {
            count++;
            const delta = x - mean;
            mean += delta / count;
            const delta2 = x - mean;
            M2 += delta * delta2;
        }

        return {
            mean: mean,
            variance: M2 / (count - 1),
            count: count
        };
    }
}

/**
 * Agricultural Land Analysis System
 * Analyzes terrain characteristics for agricultural viability
 */
class AgriculturalLandAnalyzer {
    // Configuration constants
    static GMRT_API_URL = config.gmrtApiUrl || 'https://www.gmrt.org:443/services/PointServer';
    static METEO_API_URL = config.meteoApiUrl || 'https://api.open-meteo.com/v1/elevation';
    static EARTH_RADIUS = 6371000; // meters
    static MAX_BATCH_SIZE = 20; // Maximum points per API batch
    static REQUEST_DELAY_MS = 500; // Delay between API batches

    // Agricultural slope classifications (in degrees, based on FAO guidelines)
    static SLOPE_CLASSES = {
        OPTIMAL: { max: 5, description: 'Ideal for most crops' },
        MODERATE: { max: 8, description: 'Suitable with minor conservation' },
        STEEP: { max: 16, description: 'Requires significant conservation' },
        VERY_STEEP: { max: 30, description: 'Limited to specific crops' },
        EXTREME: { max: Infinity, description: 'Not recommended for cultivation' }
    };

    // Crop suitability factors
    static CROP_FACTORS = {
        SLOPE_WEIGHTS: {
            GRAINS: { optimal: 5, max: 8 },
            VEGETABLES: { optimal: 3, max: 5 },
            ORCHARDS: { optimal: 15, max: 30 },
            ROOT_CROPS: { optimal: 2, max: 5 }
        },
        ELEVATION_RANGES: {
            GRAINS: { min: 0, max: 2500 },
            VEGETABLES: { min: 0, max: 2000 },
            ORCHARDS: { min: 0, max: 1800 },
            ROOT_CROPS: { min: 0, max: 1500 }
        }
    };

    static POLYGON_AREA = 0;
    static MIN_SUITABILITY = 0.0;
    static MAX_SUITABILITY = 1.0;
    static FIELD_ELEVATION = {
        MEAN: 0,
        MEDIAN: 0,
        MIN: 0,
        MAX: 0
    };

    static #circuitState = {
        failures: 0,
        lastFailure: 0,
        state: 'CLOSED', // CLOSED, OPEN, HALF-OPEN
        cooldownPeriod: 30000 // 30 seconds
    };

    static async circuitBreaker() {
        const now = Date.now();

        if (this.#circuitState.state === 'OPEN') {
            if (now - this.#circuitState.lastFailure > this.#circuitState.cooldownPeriod) {
                this.#circuitState.state = 'HALF-OPEN';
                logger.info('Circuit breaker entering HALF-OPEN state');
            } else {
                throw new Error('API unavailable (circuit breaker open)');
            }
        }

        this.#circuitState.failures++;

        if (this.#circuitState.failures >= 5) {
            this.#circuitState.state = 'OPEN';
            this.#circuitState.lastFailure = Date.now();
            logger.error('Circuit breaker triggered - OPEN state');
            throw new Error('API unavailable due to consecutive failures');
        }
    }

    static #workerCache = new Map();

    static getOrCreatePersistentWorker() {
        const { Worker } = require('worker_threads');
        const path = require('path');

        if (!this.#workerCache.has('persistent')) {
            const worker = new Worker(path.join(__dirname, '../workers/analysisWorker.js'));
            this.#workerCache.set('persistent', worker);
        }

        return this.#workerCache.get('persistent');
    }

    static async cleanupPersistentWorker() {
        const worker = this.#workerCache.get('persistent');
        if (worker) {
            await worker.terminate();
            this.#workerCache.delete('persistent');
        }
    }

    /**
     * Optimize data structures for memory efficiency
     * @param {Object} data - Data to optimize
     * @returns {Object} Optimized data
     */
    static optimizeForMemory(data) {
        if (!data) return data;

        // Use TypedArrays for coordinate data
        if (data.coordinates) {
            const flattened = data.coordinates.flat();
            data.coordinates = new Float64Array(flattened);
        }

        // Remove unnecessary properties
        const propsToDelete = ['metadata', 'cache', '_cache', 'tempData'];
        propsToDelete.forEach(prop => {
            if (data[prop]) delete data[prop];
        });

        // Optimize nested structures
        if (data.features) {
            data.features = data.features.map(feature => this.optimizeForMemory(feature));
        }

        return data;
    }

    /**
     * Analyze an area defined by a GeoJSON polygon
     * Analyze an area defined by a GeoJSON polygon
     * @param {Object} geoJson - GeoJSON polygon defining the area
     * @returns {Promise<Object>} - Comprehensive analysis results
     */
    static async analyzeArea(geoJson) {
        try {
            logger.info('Starting analysis for GeoJSON area...');

            // Validate GeoJSON input
            if (!this.validateGeoJSON(geoJson)) {
                throw new Error('Invalid GeoJSON polygon input');
            }

            // Generate sampling points within the polygon
            console.log('Generating sampling points...');
            const samplingPoints = this.generateSamplingPoints(geoJson);

            // Fetch elevation data for all points
            console.log('Fetching elevation data...');
            const elevationData = await this.fetchElevationData(samplingPoints);

            const transformedElevationData = this.transformElevationData(elevationData);
            console.log('Transformed elevation data...');

            const elevations = elevationData
                .filter(item => item.status === "fulfilled")
                .flatMap(item => item.value.elevation);
            console.log('Elevations:', elevations);

            const { mean, median, min, max } = StatisticsUtils;

            this.FIELD_ELEVATION = {
                MEAN: parseFloat(mean(elevations)),
                MEDIAN: parseFloat(median(elevations)),
                MIN: parseFloat(min(elevations)),
                MAX: parseFloat(max(elevations))
            };

            console.log('Field elevation data:', this.FIELD_ELEVATION);

            // Perform comprehensive analysis
            const analysis = await this.performAnalysis(geoJson, transformedElevationData);
            console.log('Analysis:', analysis);

            logger.info('Analysis completed successfully...');
            return analysis;
        } catch (error) {
            logger.error('Error in area analysis:', error);
            throw new Error(`Agricultural land analysis failed: ${error.message}`);
        }
    }

    /**
     * Transforms raw elevation data into a structured array of elevation points
     * @param {Array} data - Raw elevation data from API response
     * @returns {Array} An array of objects with elevation and coordinate information
     */
    static transformElevationData(data) {
        if (data[0].status === "fulfilled") {
            const { elevation, coordinates } = data[0].value;

            // Split the single string in lon and lat into actual arrays
            const lonArray = coordinates.lon[0].split(',').map(parseFloat);
            const latArray = coordinates.lat[0].split(',').map(parseFloat);

            return elevation.map((ele, index) => ({
                elevation: ele,
                coordinates: {
                    lon: lonArray[index],
                    lat: latArray[index]
                }
            }));
        }
        return [];
    }

    /**
     * Validate GeoJSON input
     * @param {Object} geoJson - GeoJSON object to validate
     * @returns {boolean} - True if valid, false otherwise
     */
    static validateGeoJSON(geoJson) {
        try {
            if (!geoJson || !geoJson.type || !geoJson.coordinates) {
                logger.warn('Invalid GeoJSON: Missing type or coordinates');
                return false;
            }
            if (geoJson.type !== 'Polygon' && geoJson.type !== 'MultiPolygon') {
                logger.warn(`Invalid GeoJSON type: ${geoJson.type}`);
                return false;
            }
            if (!valid(geoJson)) {
                logger.warn('Invalid GeoJSON structure');
                return false;
            }
            return turf.booleanValid(geoJson);
        } catch (error) {
            logger.error('GeoJSON validation error:', error);
            return false;
        }
    }

    /**
     * Generate sampling points within the polygon
     * @param {Object} geoJson - GeoJSON polygon
     * @returns {Object} - GeoJSON FeatureCollection of points
     */
    static generateSamplingPoints(geoJson) {
        const area = turf.area(geoJson);
        const MAX_POINTS = 5000;

        // Calculate adaptive spacing with floor at 10 meters
        const spacing = Math.max(10, Math.sqrt(area / MAX_POINTS));

        // Generate hex grid with calculated spacing
        const grid = turf.pointGrid(
            turf.bbox(geoJson),
            spacing,
            { units: 'meters', gridType: 'hex' }
        );

        // Filter to points actually inside the polygon
        const filtered = turf.pointsWithinPolygon(grid, geoJson);

        // Enforce maximum point count with stratified sampling
        if (filtered.features.length > MAX_POINTS) {
            return turf.sample(
                filtered,
                MAX_POINTS,
                { propertyName: 'sampleWeight' }
            );
        }

        return filtered;
    }

    static generateGridPoints(polygon, spacing, maxPoints) {
        const bbox = turf.bbox(polygon);
        const grid = turf.pointGrid(bbox, spacing, { units: 'meters' });

        // Filter points to ensure they are within the polygon
        const pointsWithinPolygon = turf.pointsWithinPolygon(grid, polygon);

        // Limit the number of points to avoid overwhelming the system
        if (pointsWithinPolygon.features.length > maxPoints) {
            return turf.featureCollection(pointsWithinPolygon.features.slice(0, maxPoints));
        }

        return pointsWithinPolygon;
    }

    static divideIntoChunks(polygon) {
        const bbox = turf.bbox(polygon);
        const [minX, minY, maxX, maxY] = bbox;

        // Divide the bounding box into 4 smaller chunks
        const midX = (minX + maxX) / 2;
        const midY = (minY + maxY) / 2;

        const chunks = [
            turf.bboxPolygon([minX, minY, midX, midY]),
            turf.bboxPolygon([midX, minY, maxX, midY]),
            turf.bboxPolygon([minX, midY, midX, maxY]),
            turf.bboxPolygon([midX, midY, maxX, maxY]),
        ];

        // Filter chunks to ensure they intersect with the original polygon
        return chunks.filter(chunk => turf.booleanIntersects(chunk, polygon));
    }

    /**
     * Calculate sampling density based on area size
     * @param {number} area - Area in square meters
     * @returns {number} - Distance between sampling points in meters
     */
    static calculateSamplingDensity(area) {
        const baseDistance = Math.sqrt(area) / 20; // Aim for ~400 points
        return Math.max(50, Math.min(200, baseDistance)); // Min 50m, max 200m
    }

    /**
     * Fetch elevation data for multiple points with rate limiting
     * @param {Object} points - GeoJSON FeatureCollection of points
     * @returns {Promise<Object[]>} - Array of elevation data objects
     */
    static async fetchElevationData(points) {
        const queue = new PQueue({
            concurrency: 8,
            interval: 1000,
            intervalCap: 50
        });

        const coordinates_list_lat = [];
        const coordinates_list_lon = [];
        points.features.forEach(f => {
            coordinates_list_lon.push(f.geometry.coordinates[0]);
            coordinates_list_lat.push(f.geometry.coordinates[1]);
        });

        const coordinates_list_ = [{ lat: JSON.stringify(coordinates_list_lat).slice(1, -1), long: JSON.stringify(coordinates_list_lon).slice(1, -1) }];
        return Promise.allSettled(
            coordinates_list_.map(f => queue.add(() =>
                this.fetchSinglePointElevation(f.long, f.lat)
            ))
        );
    }

    // Helper method for dynamic batch size calculation
    static getBatchSize(total) {
        const API_CAPACITY = 100; // Requests/second
        const TARGET_TIME = total / API_CAPACITY;
        return Math.min(100, Math.ceil(total / TARGET_TIME));
    }

    /**
     * Fetch elevation for a single point
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {Promise<Object>} - Elevation data object
     */
    static async fetchSinglePointElevation(lon, lat) {
        let lastError = null;
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                const response = await axios.get(`${this.METEO_API_URL}?longitude=${lon}&latitude=${lat}&format=json`, {
                    timeout: 3000,
                    headers: { 'Retry-After': attempt * 1000 }
                });

                if (!response.data?.elevation) {
                    throw new Error('Invalid elevation data');
                }

                return {
                    coordinates: { lon: [lon], lat: [lat] },
                    elevation: response.data.elevation
                };
            } catch (error) {
                lastError = error;
                if (error.response?.status === 429) {
                    await this.circuitBreaker();
                }
                // Continue to next retry attempt
                continue;
            }
        }
        // If all retries failed, throw the last error
        throw new Error(`Failed to fetch elevation data after 5 attempts: ${lastError?.message || 'Unknown error'}`);
    }

    static validateElevation(data, lon, lat) {
        if (!data?.elevation || data.elevation < -11000 || data.elevation > 9000) {
            throw new Error(`Invalid elevation: ${data.elevation}`);
        }
        return {
            coordinates: [lon, lat],
            elevation: parseFloat(data.elevation)
        };
    }

    /**
 * Validates geographic coordinates
 * @param {number} lat - Latitude value
 * @param {number} lon - Longitude value
 * @returns {boolean} - True if coordinates are valid
 */
    static isValidCoordinate(lat, lon) {
        // Check if inputs are numbers and not NaN
        if (typeof lat !== 'number' || typeof lon !== 'number' ||
            Number.isNaN(lat) || Number.isNaN(lon)) {
            logger.warn(`Invalid coordinate types: lat=${lat}, lon=${lon}`);
            return false;
        }

        // Validate latitude range (-90 to 90)
        if (lat < -90 || lat > 90) {
            logger.warn(`Invalid latitude value: ${lat}`);
            return false;
        }

        // Validate longitude range (-180 to 180)
        if (lon < -180 || lon > 180) {
            logger.warn(`Invalid longitude value: ${lon}`);
            return false;
        }

        // Check for zero coordinates (often indicates bad data)
        if (lat === 0 && lon === 0) {
            logger.warn('Suspicious coordinates: both latitude and longitude are 0');
            return false;
        }

        return true;
    }


    /**
     * Performs comprehensive geospatial and terrain analysis for a given geographic area
     * @param {Object} geoJson - GeoJSON representation of the area to analyze
     * @param {Array} elevationData - Collection of elevation data points
     * @returns {Object} Detailed analysis including area characteristics, terrain analysis, crop suitability, ROI factors, and recommendations
     */
    // static async performAnalysis(geoJson, elevationData) {
    //     console.log('elevationData:', elevationData);
    //     const area = turf.area(geoJson);
    //     this.POLYGON_AREA = area;
    //     const points = elevationData.map(d => ({
    //         type: 'Feature',
    //         geometry: {
    //             type: 'Point',
    //             coordinates: d.value.coordinates
    //         },
    //         properties: {
    //             elevation: d.value.elevation
    //         }
    //     }));

    //     elevationData.forEach(d => {
    //         const { coordinates, elevation } = d.value;
    //         console.log('Coordinates:', coordinates);
    //         console.log('Elevation:', elevation);
    //     });

    //     // Create elevation surface for analysis
    //     const elevationSurface = turf.tin(turf.featureCollection(points), 'elevation');
    //     console.log('Elevation surface:',  elevationSurface);

    //     // Calculate slope statistics
    //     const slopeStats = this.calculateSlopeStatistics(elevationSurface);
    //     console.log('Slope stats:', slopeStats);
    //     // Analyze terrain characteristics
    //     const terrainAnalysis = this.analyzeTerrainCharacteristics(elevationSurface, slopeStats);
    //     console.log('Terrain analysis:', terrainAnalysis);
    //     // Assess crop suitability
    //     const cropSuitability = this.assessCropSuitability(slopeStats, terrainAnalysis);
    //     console.log('Crop suitability:', cropSuitability);
    //     // Calculate ROI factors
    //     const roiAnalysis = this.calculateROIFactors(area, slopeStats, terrainAnalysis);
    //     console.log('ROI analysis:', roiAnalysis);
    //     return {
    //         areaCharacteristics: {
    //             totalArea: area,
    //             elevationRange: {
    //                 min: Math.min(...elevationData.map(d => d.value.elevation)),
    //                 max: Math.max(...elevationData.map(d => d.value.elevation)),
    //                 mean: StatisticsUtils.mean(elevationData.map(d => d.value.elevation))
    //             },
    //             slope: slopeStats
    //         },
    //         terrainAnalysis,
    //         cropSuitability,
    //         roiAnalysis,
    //         recommendations: this.generateRecommendations(cropSuitability, roiAnalysis)
    //     };
    // }

    /**
     * Performs comprehensive geospatial and terrain analysis using worker threads
     * @param {Object} geoJson - GeoJSON representation of the area to analyze
     * @param {Array} elevationData - Collection of elevation data points
     * @returns {Promise<Object>} Detailed analysis results
     */
    static async performAnalysis(geoJson, elevationData) {
        const { performance } = require('perf_hooks');

        // Start performance monitoring
        const startTime = performance.now();
        const logger = this.logger || console;

        try {
            logger.info('Starting parallel analysis processing...');

            const area = turf.area(geoJson);
            this.POLYGON_AREA = area;

            // 1. Prepare elevation data points
            const points = elevationData.map(d => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [d.coordinates.lon, d.coordinates.lat]
                },
                properties: {
                    elevation: d.elevation
                }
            }));

            // 2. Create elevation surface (lightweight operation in main thread)
            const elevationSurface = turf.tin(turf.featureCollection(points), 'elevation');

            // 3. Prepare worker data with proper serialization
            const workerData = {
                elevationSurface: this.serializeForWorker(elevationSurface),
                POLYGON_AREA: this.POLYGON_AREA,
                FIELD_ELEVATION: this.FIELD_ELEVATION,
                config: {
                    SLOPE_CLASSES: this.SLOPE_CLASSES,
                    CROP_FACTORS: this.CROP_FACTORS
                }
            };

            // 4. Execute parallel analysis
            const [slopeStats, terrainAnalysis] = await this.executeParallelAnalysis(workerData);

            // 5. Parallelize remaining calculations
            const [cropSuitability, roiAnalysis] = await Promise.all([
                this.assessCropSuitability(slopeStats, terrainAnalysis),
                this.calculateROIFactors(this.POLYGON_AREA, slopeStats, terrainAnalysis)
            ]);

            // 6. Compile final results
            const results = {
                areaCharacteristics: {
                    totalArea: this.POLYGON_AREA,
                    elevationRange: {
                        min: Math.min(...elevationData.map(d => d.value.elevation)),
                        max: Math.max(...elevationData.map(d => d.value.elevation)),
                        mean: StatisticsUtils.mean(elevationData.map(d => d.value.elevation))
                    },
                    slope: slopeStats
                },
                terrainAnalysis,
                cropSuitability,
                roiAnalysis,
                recommendations: this.generateRecommendations(cropSuitability, roiAnalysis),
                performance: {
                    processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
                    parallelOperations: 3 // slope, terrain, and combined analyses
                }
            };

            logger.info(`Analysis completed in ${results.performance.processingTime}`);
            return results;

        } catch (error) {
            logger.error('Analysis failed:', error);
            throw new Error(`Parallel analysis failed: ${error.message}`);
        }
    }

    /**
     * Helper method to execute parallel analysis in worker threads
     * @param {Object} workerData - Prepared data for worker
     * @returns {Promise<Array>} [slopeStats, terrainAnalysis]
     */
    static async executeParallelAnalysis(workerData) {
        const { Worker } = require('worker_threads');
        const path = require('path');
        const os = require('os');

        if (!workerData?.elevationSurface?.features?.length) {
            return Promise.resolve({
                slopeStats: null,
                terrainAnalysis: null,
                performance: { chunkTimes: [], totalTime: 0, memory: null }
            });
        }

        // Determine optimal number of workers
        const MAX_WORKERS = Math.max(1, Math.min(os.cpus().length - 1, 4));
        const features = workerData.elevationSurface.features;
        const CHUNK_SIZE = Math.ceil(features.length / MAX_WORKERS);

        return new Promise((resolve, reject) => {
            const workers = new Map();
            const results = [];
            let completedWorkers = 0;
            let hasError = false;

            // Create and track timeouts
            const timeouts = new Map();

            // Cleanup function
            const cleanup = async () => {
                for (const worker of workers.keys()) {
                    try {
                        await worker.terminate();
                    } catch (err) {
                        console.warn(`Failed to terminate worker: ${err.message}`);
                    }
                }
                for (const timeout of timeouts.values()) {
                    clearTimeout(timeout);
                }
            };

            // Process chunks with workers
            for (let i = 0; i < MAX_WORKERS; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, features.length);

                if (start >= features.length) break;

                const chunkData = {
                    ...workerData,
                    elevationSurface: {
                        ...workerData.elevationSurface,
                        features: features.slice(start, end)
                    }
                };

                const worker = new Worker(path.join(__dirname, '../workers/analysisWorker.js'));
                workers.set(worker, { busy: true, index: i });

                const safelyReject = async (reason) => {
                    if (hasError) return;
                    hasError = true;
                    await cleanup();
                    reject(reason);
                };

                // Set timeout for this worker
                const timeout = setTimeout(async () => {
                    worker.terminate();
                    await safelyReject(new Error(`Worker ${i} timeout exceeded (300s)`));
                }, 300000);

                timeouts.set(worker, timeout);

                worker.on('message', async (result) => {
                    clearTimeout(timeouts.get(worker));

                    if (result.success) {
                        results[i] = result;
                        completedWorkers++;
                        if (completedWorkers === Math.min(MAX_WORKERS, Math.ceil(features.length / CHUNK_SIZE))) {
                            await cleanup();
                            resolve(this.mergeWorkerResults(results));
                        }
                    } else {
                        await safelyReject(new Error(`Worker ${i} error: ${result.error.message}`));
                    }
                });

                worker.on('error', async (error) => await safelyReject(error));
                worker.on('exit', async (code) => {
                    if (code !== 0) {
                        await safelyReject(new Error(`Worker ${i} exited with code ${code}`));
                    }
                });

                worker.on('error', async (error) => {
                    await safelyReject(new Error(`Worker ${i} error: ${error.message}`));
                });

                worker.on('exit', async (code) => {
                    if (code !== 0) {
                        hasError = true;
                        cleanup();
                        await safelyReject(new Error(`Worker ${i} stopped with exit code ${code}`));
                    }
                });

                worker.postMessage(chunkData);
            }
        });
    }

    // Helper function to merge worker results
    static mergeWorkerResults(results) {
        return results.reduce((acc, result) => {
            if (!acc) return result;
            return {
                slopeStats: this.combineStats(acc.slopeStats, result.slopeStats),
                terrainAnalysis: this.combineTerrainAnalysis(acc.terrainAnalysis, result.terrainAnalysis),
                performance: {
                    chunkTimes: [...acc.performance.chunkTimes, ...result.performance.chunkTimes],
                    totalTime: acc.performance.totalTime + result.performance.totalTime
                }
            };
        });
    }

    /**
     * Optimized serialization for worker thread communication
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} Serialized data
     */
    static serializeForWorker(elevationSurface) {
        // Custom serialization to maintain GeoJSON structure while minimizing transfer size
        return {
            type: 'FeatureCollection',
            features: elevationSurface.features.map(f => ({
                type: 'Feature',
                properties: { ...f.properties },
                geometry: {
                    type: 'Polygon',
                    coordinates: f.geometry.coordinates[0] // Flatten coordinates
                }
            }))
        };
    }

    /**
     * Static initialization block for graceful worker cleanup
     * Handles process exit and interrupt signals to ensure proper worker termination
     */
    static {
        // Update the process handlers
        process.on('exit', () => {
            try {
                this.cleanupPersistentWorker();
            } catch (err) {
                console.error('Error during cleanup:', err);
            }
        });

        process.on('SIGINT', () => {
            console.log('Received SIGINT. Cleaning up...');
            try {
                this.cleanupPersistentWorker();
            } catch (err) {
                console.error('Error during SIGINT cleanup:', err);
            }
            process.exit(0);
        });
    }

    /**
     * Calculate detailed slope statistics
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Slope statistics
     */
    static calculateSlopeStatistics(elevationSurface) {
        // Use pre-allocated arrays for better performance
        console.log('Calculating slope statistics...');
        console.log(elevationSurface);
        const slopes = new Float32Array(elevationSurface.features.length * 3);
        let slopeIndex = 0;

        // Optimized loop with pre-calculated values
        const toRadians = Math.PI / 180;
        const toDegrees = 180 / Math.PI;

        elevationSurface.features.forEach(triangle => {
            const coords = triangle.geometry.coordinates[0];
            const props = triangle.properties;

            for (let i = 0; i < 3; i++) {
                const p1 = coords[i];
                const p2 = coords[(i + 1) % 3];

                // Calculate distance once
                const distance = turf.distance(
                    turf.point(p1),
                    turf.point(p2),
                    { units: 'meters' }
                ) * 1.02; // vertical adjustment factor

                // Calculate elevation difference
                const elevDiff = Math.abs(props.a - props.b);

                // Calculate slope and store
                slopes[slopeIndex++] = Math.max(
                    0.1, // min slope threshold
                    Math.atan2(elevDiff, distance) * toDegrees
                );
            }
        });

        // Create a view of only the used portion of the array
        const validSlopes = slopes.slice(0, slopeIndex);

        // Calculate statistics using optimized methods
        const slopeConfidence = StatisticsUtils.confidenceInterval(validSlopes);
        return {
            mean: StatisticsUtils.mean(validSlopes),
            median: StatisticsUtils.median(validSlopes),
            stdDev: StatisticsUtils.stdDev(validSlopes),
            confidence: slopeConfidence,
            distribution: this.calculateSlopeDistribution(validSlopes),
            aspectAnalysis: this.analyzeAspects(elevationSurface)
        };
    }

    /**
     * Analyze terrain characteristics
     * @param {Object} elevationSurface - TIN elevation surface
     * @param {Object} slopeStats - Slope statistics
     * @returns {Object} - Terrain analysis results
     */
    static analyzeTerrainCharacteristics(elevationSurface, slopeStats) {
        // Run analyses in parallel where possible
        const [drainage, solarExposure] = [
            this.analyzeDrainage(elevationSurface),
            this.analyzeSolarExposure(elevationSurface)
        ];

        return {
            drainage,
            erosionRisk: this.calculateErosionRisk(slopeStats),
            waterRetention: this.calculateWaterRetention(slopeStats),
            solarExposure,
            terrainComplexity: this.calculateTerrainComplexity(elevationSurface)
        };
    }

    // Optimized drainage analysis
    static analyzeDrainage(elevationSurface) {
        // Use memoization to avoid recalculating flow accumulation
        if (!this._flowAccumulationCache) {
            this._flowAccumulationCache = this.calculateFlowAccumulation(elevationSurface);
        }

        const flowAccumulation = this._flowAccumulationCache;
        return {
            drainagePattern: this.classifyDrainagePattern(flowAccumulation),
            drainageDensity: this.calculateDrainageDensity(flowAccumulation),
            waterloggingRisk: this.assessWaterloggingRisk(flowAccumulation)
        };
    }

    /**
     * Assess crop suitability for different agricultural uses
     * @param {Object} slopeStats - Slope statistics
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - Crop suitability analysis
     */
    static assessCropSuitability(slopeStats, terrainAnalysis) {
        const suitability = {};
        const cropTypes = Object.keys(this.CROP_FACTORS.SLOPE_WEIGHTS);

        // Pre-calculate common factors
        const commonFactors = {
            drainageAdjustment: 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.5),
            erosionAdjustment: 1 - (terrainAnalysis.erosionRisk.score * 0.3)
        };

        // Process crops in parallel (simulated with Promise.all)
        const results = cropTypes.map(cropType => {
            const weights = this.CROP_FACTORS.SLOPE_WEIGHTS[cropType];
            const elevRange = this.CROP_FACTORS.ELEVATION_RANGES[cropType];

            const slopeSuitability = this.calculateSlopeSuitability(slopeStats.mean, weights);
            const elevationSuitability = this.calculateElevationSuitability(
                this.FIELD_ELEVATION.MEAN,
                elevRange
            );

            const score = slopeSuitability *
                elevationSuitability *
                commonFactors.drainageAdjustment *
                commonFactors.erosionAdjustment;

            return {
                cropType,
                result: {
                    score,
                    category: this.classifySuitability(score),
                    factors: {
                        slopeSuitability,
                        elevationSuitability,
                        drainageAdjustment: commonFactors.drainageAdjustment,
                        erosionAdjustment: commonFactors.erosionAdjustment
                    }
                }
            };
        });

        // Convert results to object
        results.forEach(({ cropType, result }) => {
            suitability[cropType] = result;
        });

        return {
            scores: suitability,
            zonation: this.generateSuitabilityZones(suitability),
            limitations: this.identifyCropLimitations(slopeStats, terrainAnalysis)
        };
    }

    /**
     * Calculate ROI factors
     * @param {number} area - Area in square meters
     * @param {Object} slopeStats - Slope statistics
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - ROI analysis results
     */
    static calculateROIFactors(area, slopeStats, terrainAnalysis) {
        return {
            developmentCosts: this.estimateDevelopmentCosts(area, slopeStats),
            maintenanceFactors: this.assessMaintenanceRequirements(terrainAnalysis),
            productivityPotential: this.estimateProductivityPotential(terrainAnalysis),
            riskFactors: this.assessRiskFactors(slopeStats, terrainAnalysis),
            sustainabilityScore: this.calculateSustainabilityScore(terrainAnalysis)
        };
    }

    /**
     * Get neighboring cells for a given cell index
     * @param {number} cellIndex - Index of the current cell
     * @param {number} rows - Number of rows in the grid
     * @param {number[]} cells - Array of cell elevation values
     * @returns {Array<{index: number, elevation: number}>} Array of neighbor objects
     */
    static getNeighbors(cellIndex, rows, cells) {
        const row = Math.floor(cellIndex / rows);
        const col = cellIndex % rows;
        const neighbors = [];

        // Check all 8 adjacent cells
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;

                const newRow = row + dr;
                const newCol = col + dc;

                if (newRow >= 0 && newRow < rows && newCol >= 0 && newCol < rows) {
                    const neighborIndex = newRow * rows + newCol;
                    neighbors.push({
                        index: neighborIndex,
                        elevation: cells[neighborIndex],
                        distance: Math.sqrt(dr * dr + dc * dc)
                    });
                }
            }
        }

        return neighbors;
    }

    /**
     * Identify a flat area around a given cell
     * @param {number} cellIndex - Index of the current cell
     * @param {Array<{index: number, elevation: number}>} neighbors - Array of neighbor objects
     * @param {number[]} cells - Array of cell elevation values
     * @returns {number[]} Array of cell indices in the flat area
     */
    static identifyFlatArea(cellIndex, neighbors, cells) {
        const flatArea = new Set([cellIndex]);
        const elevation = cells[cellIndex];
        const queue = [cellIndex];

        while (queue.length > 0) {
            const current = queue.shift();
            const currentNeighbors = this.getNeighbors(current, Math.sqrt(cells.length), cells);

            for (const neighbor of currentNeighbors) {
                if (Math.abs(cells[neighbor.index] - elevation) < 1e-6 && !flatArea.has(neighbor.index)) {
                    flatArea.add(neighbor.index);
                    queue.push(neighbor.index);
                }
            }
        }

        return Array.from(flatArea);
    }

    /**
     * Find the steepest descent direction
     * @param {number} cellIndex - Index of the current cell
     * @param {Array<{index: number, elevation: number, distance: number}>} neighbors - Array of neighbor objects
     * @returns {number} Index of the steepest descent neighbor or -1 if none found
     */
    static findSteepestDescent(cellIndex, neighbors) {
        let maxSlope = 0;
        let steepestNeighbor = -1;

        for (const neighbor of neighbors) {
            const elevationDiff = neighbor.elevation - cellIndex;
            const slope = -elevationDiff / neighbor.distance; // Negative because we want descent

            if (slope > maxSlope) {
                maxSlope = slope;
                steepestNeighbor = neighbor.index;
            }
        }

        return steepestNeighbor;
    }

    /**
     * Divide a large GeoJSON polygon into smaller chunks
     * @param {Object} geoJson - Input GeoJSON polygon
     * @returns {Array<Object>} Array of smaller GeoJSON polygons
     */
    static divideIntoChunks(polygon) {
        return turf.hexGrid(turf.bbox(polygon), 0.1, { units: 'degrees' })
            .features.filter(c => turf.booleanIntersects(c, polygon));
    }

    /**
     * Generate sampling points for a chunk of the area
     * @param {Object} geoJson - GeoJSON polygon chunk
     * @param {number} maxPoints - Maximum number of points to generate
     * @returns {Object} FeatureCollection of sampling points
     */
    static generatePointsForChunk(geoJson, maxPoints) {
        const area = turf.area(geoJson);
        const bbox = turf.bbox(geoJson);

        // Calculate optimal spacing based on area and max points
        const spacing = Math.sqrt(area / maxPoints);

        // Generate initial grid
        const options = {
            units: 'meters',
            mask: geoJson
        };

        const grid = turf.pointGrid(bbox, spacing, options);

        // If we have too many points, randomly sample them
        if (grid.features.length > maxPoints) {
            const indices = new Set();
            while (indices.size < maxPoints) {
                indices.add(Math.floor(Math.random() * grid.features.length));
            }

            return turf.featureCollection(
                Array.from(indices).map(i => grid.features[i])
            );
        }

        return grid;
    }

    /**
     * Calculate slope between two points with elevation
     * @param {number[]} point1 - First point coordinates [lon, lat]
     * @param {number[]} point2 - Second point coordinates [lon, lat]
     * @param {Object} properties - Elevation properties
     * @returns {number} - Slope in degrees
     */
    static calculateSlopeBetweenPoints(point1, point2, properties) {
        if (!point1 || !point2 || !properties) {
            throw new Error('Invalid input: points and properties are required');
        }

        const [x1, y1] = point1;
        const [x2, y2] = point2;

        // Add vertical adjustment factor
        const verticalFactor = 1.02; // Compensates for Earth's curvature
        const distance = turf.distance(
            turf.point([x1, y1]),
            turf.point([x2, y2]),
            { units: 'meters' }
        ) * verticalFactor;

        // Use more precise elevation difference calculation
        const elevDiff = Math.abs(properties.a - properties.b);

        // Add minimum slope threshold
        const minSlope = 0.1; // degrees
        return Math.max(Math.atan2(elevDiff, distance) * (180 / Math.PI), minSlope);
    }

    /**
     * Calculate slope distribution across classes
     * @param {number[]} slopes - Array of slope values in degrees
     * @returns {Object.<string, {percentage: number, area: number, description: string}>} 
     * @throws {Error} If slopes input is invalid
     */
    static #slopeDistributionCache = new WeakMap();

    static calculateSlopeDistribution(slopes) {
        // Input validation
        if (!Array.isArray(slopes) || slopes.length === 0) {
            throw new Error('Invalid slopes input: Must be non-empty array');
        }

        // Check cache
        const cacheKey = slopes;
        if (this.#slopeDistributionCache.has(cacheKey)) {
            return this.#slopeDistributionCache.get(cacheKey);
        }

        const total = slopes.length;

        // Single-pass counting
        const counts = new Map();
        const sortedSlopes = [...slopes].sort((a, b) => a - b);

        sortedSlopes.forEach(slope => {
            for (const [className, limits] of Object.entries(this.SLOPE_CLASSES)) {
                if (slope <= limits.max) {
                    counts.set(className, (counts.get(className) || 0) + 1);
                    break;
                }
            }
        });

        // Calculate distribution
        const distribution = Object.entries(this.SLOPE_CLASSES).reduce((acc, [className, limits]) => {
            const count = counts.get(className) || 0;
            acc[className] = {
                percentage: (count / total) * 100,
                area: this.POLYGON_AREA * (count / total),
                description: limits.description
            };
            return acc;
        }, {});

        // Cache results
        this.#slopeDistributionCache.set(cacheKey, Object.freeze(distribution));

        logger.info('Slope distribution calculated...');

        return distribution;
    }


    /**
     * Analyze aspects (slope direction) of the terrain
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Aspect analysis results
     */
    static analyzeAspects(elevationSurface) {
        const aspects = [];

        elevationSurface.features.forEach(triangle => {
            const aspect = this.calculateTriangleAspect(triangle);
            aspects.push(aspect);
        });

        return {
            northFacing: aspects.filter(a => a >= 315 || a < 45).length / aspects.length,
            eastFacing: aspects.filter(a => a >= 45 && a < 135).length / aspects.length,
            southFacing: aspects.filter(a => a >= 135 && a < 225).length / aspects.length,
            westFacing: aspects.filter(a => a >= 225 && a < 315).length / aspects.length
        };
    }

    /**
     * Calculate aspect of a triangle
     * @param {Object} triangle - Triangle feature
     * @returns {number} - Aspect in degrees
     */
    static calculateTriangleAspect(triangle) {
        const [p1, p2, p3] = triangle.geometry.coordinates[0];
        const [dx, dy] = [
            (p2[0] - p1[0]) + (p3[0] - p1[0]),
            (p2[1] - p1[1]) + (p3[1] - p1[1])
        ];
        return (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    }

    /**
     * Calculate flow accumulation
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Flow accumulation grid
     */
    static calculateFlowAccumulation(elevationSurface) {
        // Simplified D8 flow algorithm
        console.log('Calculating flow accumulation...');
        const cells = this.convertToGrid(elevationSurface);
        console.log('Converted to grid');
        logger.info(cells);
        return this.d8FlowAccumulation(cells);
    }

    /**
     * Classify the drainage pattern based on flow accumulation
     * @param {Object} flowAccumulation - Flow accumulation grid
     * @returns {string} - Drainage pattern classification
     */
    static classifyDrainagePattern(flowAccumulation) {
        const features = flowAccumulation.features;
        const totalCells = features.length;
        const highFlowCells = features.filter(f => f.properties.accumulation > 100).length;
        const mediumFlowCells = features.filter(f => f.properties.accumulation > 50 && f.properties.accumulation <= 100).length;
        const lowFlowCells = features.filter(f => f.properties.accumulation <= 50).length;

        const highFlowPercentage = (highFlowCells / totalCells) * 100;
        const mediumFlowPercentage = (mediumFlowCells / totalCells) * 100;
        const lowFlowPercentage = (lowFlowCells / totalCells) * 100;

        if (highFlowPercentage > 30) {
            return 'Dendritic';
        } else if (mediumFlowPercentage > 50) {
            return 'Trellis';
        } else if (lowFlowPercentage > 70) {
            return 'Parallel';
        } else {
            return 'Rectangular';
        }
    }

    /**
     * Calculate drainage density
     * @param {Object} flowAccumulation - Flow accumulation grid
     * @returns {number} - Drainage density (km/km²)
     */
    static calculateDrainageDensity(flowAccumulation) {
        const features = flowAccumulation.features;
        const totalArea = this.POLYGON_AREA / 1e6; // Convert to square kilometers
        const totalDrainageLength = features.reduce((sum, f) => {
            return sum + (f.properties.accumulation > 10 ? 1 : 0); // Assuming each cell with accumulation > 10 represents a drainage channel
        }, 0);

        const cellSize = Math.sqrt(this.POLYGON_AREA / features.length); // Average cell size in meters
        const drainageDensity = (totalDrainageLength * cellSize) / 1000 / totalArea; // Convert to km/km²

        return drainageDensity;
    }

    /**
     * Assess waterlogging risk based on flow accumulation
     * @param {Object} flowAccumulation - Flow accumulation grid
     * @returns {number} - Waterlogging risk score (0 to 1)
     */
    static assessWaterloggingRisk(flowAccumulation) {
        const features = flowAccumulation.features;
        const totalCells = features.length;
        const highAccumulationCells = features.filter(f => f.properties.accumulation > 100).length;
        const mediumAccumulationCells = features.filter(f => f.properties.accumulation > 50 && f.properties.accumulation <= 100).length;

        const highRiskPercentage = (highAccumulationCells / totalCells) * 100;
        const mediumRiskPercentage = (mediumAccumulationCells / totalCells) * 100;

        const riskScore = (highRiskPercentage * 0.7) + (mediumRiskPercentage * 0.3);

        return Math.min(1, riskScore / 100); // Normalize to 0-1 range
    }

    /**
     * Convert TIN to regular grid
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Regular grid
     */
    static convertToGrid(elevationSurface) {
        const bbox = turf.bbox(elevationSurface);
        const cellSize = (bbox[2] - bbox[0]) / 5; // 5x5 grid
        return turf.pointGrid(bbox, cellSize, {
            properties: { elevation: 0 }
        });
    }

    /**
     * Calculates D8 flow accumulation for a grid
     * 
     * The D8 algorithm determines flow direction from each cell to its steepest downslope neighbor.
     * Flow accumulation is then calculated by counting how many cells flow into each cell.
     * 
     * Steps:
     * 1. Fill depressions to ensure continuous flow
     * 2. Calculate flow direction for each cell
     * 3. Accumulate flow by tracing paths downslope
     * 
     * @param {Object} grid - Regular grid FeatureCollection with elevation properties
     * @returns {Object} - Grid with flow accumulation and direction properties
     * @see https://pro.arcgis.com/en/pro-app/latest/tool-reference/spatial-analyst/how-flow-accumulation-works.htm
     */
    static d8FlowAccumulation(grid) {
        // Early validation
        if (!grid?.features?.length) {
            throw new Error('Invalid grid input');
        }

        const featuresLength = grid.features.length;
        const rows = Math.round(Math.sqrt(featuresLength));

        // Use TypedArrays for better performance
        const cells = new Float32Array(featuresLength);
        const flowAccumulation = new Uint32Array(featuresLength).fill(1);
        const flowDirections = new Int8Array(featuresLength).fill(-1);
        const visited = new Uint8Array(featuresLength);

        // Initialize cells
        grid.features.forEach((f, i) => {
            cells[i] = f.properties.elevation;
        });

        // Process in chunks for better memory management
        const CHUNK_SIZE = 1000;
        const chunkCount = Math.ceil(featuresLength / CHUNK_SIZE);

        for (let chunk = 0; chunk < chunkCount; chunk++) {
            const start = chunk * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, featuresLength);

            // Fill depressions in chunk
            this.fillDepressionsChunk(cells, rows, start, end);

            // Calculate flow directions in chunk
            for (let i = start; i < end; i++) {
                const neighbors = this.getNeighbors(i, rows, cells);
                const flatArea = this.identifyFlatArea(i, neighbors, cells);

                if (flatArea.length > 0) {
                    this.resolveFlatArea(flatArea, flowDirections, rows, cells);
                } else {
                    flowDirections[i] = this.findSteepestDescent(i, neighbors);
                }
            }
        }

        // Calculate flow accumulation
        for (let i = 0; i < featuresLength; i++) {
            if (visited[i]) continue;

            let current = i;
            const path = [];

            while (flowDirections[current] !== -1 && !visited[current]) {
                visited[current] = 1;
                path.push(current);
                current = flowDirections[current];
            }

            // Propagate flow downstream
            for (let j = 0; j < path.length - 1; j++) {
                flowAccumulation[path[j + 1]] += flowAccumulation[path[j]];
            }
        }

        // Convert back to feature collection
        return {
            type: "FeatureCollection",
            features: grid.features.map((cell, index) => ({
                ...cell,
                properties: {
                    ...cell.properties,
                    accumulation: flowAccumulation[index],
                    flowDirection: flowDirections[index]
                }
            }))
        };
    }

    // Optimized helper methods
    static fillDepressionsChunk(cells, rows, start, end) {
        let changed;
        do {
            changed = false;
            for (let i = start; i < end; i++) {
                const neighbors = this.getNeighbors(i, rows, cells);
                const lowestNeighbor = Math.min(...neighbors.map(n => n.elevation));

                if (cells[i] < lowestNeighbor) {
                    cells[i] = lowestNeighbor;
                    changed = true;
                }
            }
        } while (changed);
    }

    // Helper method for chunked processing
    static splitIntoChunks(array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, Math.min(i + chunkSize, array.length)));
        }
        return chunks;
    }

    // Optimized depression filling with chunking
    static fillDepressionsInChunks(cells, rows, chunkSize) {
        const filled = new Float32Array(cells);
        const chunks = this.splitIntoChunks(filled, chunkSize);

        let changed;
        do {
            changed = false;
            chunks.forEach((chunk, startIndex) => {
                const chunkChanged = this.processDepressionChunk(chunk, startIndex, rows, filled);
                changed = changed || chunkChanged;
            });
        } while (changed);

        return filled;
    }

    static processDepressionChunk(chunk, startIndex, rows, filled) {
        let chunkChanged = false;
        const chunkSize = chunk.length;

        for (let i = 0; i < chunkSize; i++) {
            const absoluteIndex = startIndex + i;
            const neighbors = this.getNeighbors(absoluteIndex, rows, filled);
            const lowestNeighbor = Math.min(...neighbors.map(n => n.elevation));

            if (filled[absoluteIndex] < lowestNeighbor) {
                filled[absoluteIndex] = lowestNeighbor;
                chunkChanged = true;
            }
        }

        return chunkChanged;
    }

    static fillDepressions(cells, rows) {
        const filled = [...cells];
        let changed;

        do {
            changed = false;
            for (let i = 0; i < cells.length; i++) {
                const neighbors = this.getNeighbors(i, rows, filled);
                const lowestNeighbor = Math.min(...neighbors.map(n => n.elevation));

                if (filled[i] < lowestNeighbor) {
                    filled[i] = lowestNeighbor;
                    changed = true;
                }
            }
        } while (changed);

        return filled;
    }

    static resolveFlatArea(flatArea, flowDirections, rows, cells) {
        const queue = [...flatArea];
        const distance = new Array(cells.length).fill(Infinity);

        // Find edges of flat area
        flatArea.forEach(cell => {
            const neighbors = this.getNeighbors(cell, rows, cells);
            if (neighbors.some(n => cells[n.index] < cells[cell])) {
                distance[cell] = 0;
            }
        });

        // Propagate flow directions from edges
        while (queue.length > 0) {
            const current = queue.shift();
            const neighbors = this.getNeighbors(current, rows, cells);

            for (const neighbor of neighbors) {
                if (flatArea.includes(neighbor.index) && distance[neighbor.index] > distance[current] + 1) {
                    distance[neighbor.index] = distance[current] + 1;
                    flowDirections[neighbor.index] = current;
                    queue.push(neighbor.index);
                }
            }
        }
    }

    /**
     * Calculate erosion risk
     * @param {Object} slopeStats - Slope statistics
     * @returns {Object} - Erosion risk analysis
     */
    static calculateErosionRisk(slopeStats) {
        const { mean: meanSlope, stdDev: slopeStdDev } = slopeStats;

        // RUSLE-inspired calculation (Revised Universal Soil Loss Equation)
        const slopeFactor = Math.pow(Math.sin(meanSlope * Math.PI / 180), 1.3);
        const variabilityFactor = 1 + (slopeStdDev / 45);

        const riskScore = slopeFactor * variabilityFactor;

        return {
            score: riskScore,
            category: this.classifyErosionRisk(riskScore),
            factors: {
                slopeFactor,
                variabilityFactor
            }
        };
    }

    /**
 * Classify erosion risk based on a risk score
 * @param {number} riskScore - Erosion risk score (0 to 1)
 * @returns {string} - Erosion risk classification
 * @throws {Error} If riskScore is invalid
 */
    static classifyErosionRisk(riskScore) {
        // Input validation
        if (typeof riskScore !== 'number' || riskScore < 0 || riskScore > 1 || isNaN(riskScore)) {
            throw new Error('Invalid riskScore: Must be a number between 0 and 1');
        }

        // Classification thresholds (based on FAO and USDA guidelines)
        const RISK_CLASSES = [
            { threshold: 0.2, classification: 'Very Low' },
            { threshold: 0.4, classification: 'Low' },
            { threshold: 0.6, classification: 'Moderate' },
            { threshold: 0.8, classification: 'High' },
            { threshold: 1.0, classification: 'Very High' }
        ];

        // Find the appropriate classification
        for (const { threshold, classification } of RISK_CLASSES) {
            if (riskScore <= threshold) {
                return classification;
            }
        }

        // Default to 'Very High' if score exceeds all thresholds
        return 'Very High';
    }

    /**
     * Calculate water retention capacity
     * @param {Object} slopeStats - Slope statistics
     * @returns {Object} - Water retention analysis
     */
    static calculateWaterRetention(slopeStats) {
        const { mean: meanSlope, distribution } = slopeStats;

        // Based on SCS curve number method
        const baseRetention = 100; // mm
        const slopeFactor = Math.exp(-0.04 * meanSlope);
        const distributionFactor = distribution.OPTIMAL.percentage / 100;

        return {
            capacity: baseRetention * slopeFactor * distributionFactor,
            efficiency: slopeFactor * 100,
            factors: {
                slopeFactor,
                distributionFactor
            }
        };
    }

    /**
     * Analyze solar exposure
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Solar exposure analysis
     */
    static analyzeSolarExposure(elevationSurface) {
        const aspects = this.analyzeAspects(elevationSurface);

        // Calculate solar exposure score (northern hemisphere)
        const exposureScore =
            aspects.southFacing * 1.0 +
            (aspects.eastFacing + aspects.westFacing) * 0.7 +
            aspects.northFacing * 0.4;

        return {
            score: exposureScore,
            category: this.classifySolarExposure(exposureScore),
            aspects
        };
    }

    /**
 * Classify solar exposure based on a solar exposure score
 * @param {number} exposureScore - Solar exposure score (0 to 1)
 * @returns {string} - Solar exposure classification
 * @throws {Error} If exposureScore is invalid
 */
    static classifySolarExposure(exposureScore) {
        // Input validation
        if (typeof exposureScore !== 'number' || exposureScore < 0 || exposureScore > 1 || isNaN(exposureScore)) {
            throw new Error('Invalid exposureScore: Must be a number between 0 and 1');
        }

        // Classification thresholds (based on solar radiation models)
        const EXPOSURE_CLASSES = [
            { threshold: 0.3, classification: 'Low' },
            { threshold: 0.5, classification: 'Moderate' },
            { threshold: 0.7, classification: 'High' },
            { threshold: 0.9, classification: 'Very High' },
            { threshold: 1.0, classification: 'Optimal' }
        ];

        // Find the appropriate classification
        for (const { threshold, classification } of EXPOSURE_CLASSES) {
            if (exposureScore <= threshold) {
                return classification;
            }
        }

        // Default to 'Optimal' if score exceeds all thresholds
        return 'Optimal';
    }

    /**
     * Calculate terrain complexity
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Terrain complexity analysis
     */
    static calculateTerrainComplexity(elevationSurface) {
        const slopes = elevationSurface.features.map(triangle =>
            this.calculateSlopeBetweenPoints(
                triangle.geometry.coordinates[0][0],
                triangle.geometry.coordinates[0][1],
                triangle.properties
            )
        );

        return {
            score: StatisticsUtils.stdDev(slopes) / 45,
            variability: StatisticsUtils.mean(slopes.map(s => Math.abs(s - StatisticsUtils.mean(slopes))))
        };
    }

    /**
     * Calculate crop suitability score
     * @param {string} cropType - Type of crop
     * @param {Object} slopeStats - Slope statistics
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - Crop suitability score
     */
    static calculateCropSuitabilityScore(cropType, slopeStats, terrainAnalysis) {
        const factors = this.CROP_FACTORS;
        const weights = factors.SLOPE_WEIGHTS[cropType];
        const elevRange = factors.ELEVATION_RANGES[cropType];

        // Calculate base suitability
        const slopeSuitability = this.calculateSlopeSuitability(slopeStats.mean, weights);
        const elevationSuitability = this.calculateElevationSuitability(
            this.FIELD_ELEVATION.MEAN,
            elevRange
        );

        // Adjust for other factors
        const drainageAdjustment = 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.5);
        const erosionAdjustment = 1 - (terrainAnalysis.erosionRisk.score * 0.3);

        const score = slopeSuitability *
            elevationSuitability *
            drainageAdjustment *
            erosionAdjustment;

        console.log('slopeSuitability:', slopeSuitability, 'elevationSuitability:', elevationSuitability, 'drainageAdjustment:', drainageAdjustment, 'erosionAdjustment:', erosionAdjustment);
        console.log('score:', score);

        return {
            score,
            category: this.classifySuitability(score),
            factors: {
                slopeSuitability,
                elevationSuitability,
                drainageAdjustment,
                erosionAdjustment
            }
        };
    }

    /**
 * Classify land suitability based on comprehensive score analysis
 * @param {number} score - Suitability score between 0 and 1
 * @returns {Object} - Detailed suitability classification with confidence levels
 * @throws {Error} If score is invalid
 */
    static classifySuitability(score) {
        // Input validation with specific error message
        if (typeof score !== 'number' || score < 0 || score > 1 || Number.isNaN(score)) {
            throw new Error('Suitability score must be a number between 0 and 1');
        }

        // Classification thresholds based on FAO land evaluation guidelines
        const SUITABILITY_CLASSES = Object.freeze({
            S1: { threshold: 0.85, name: 'Highly Suitable', confidence: 0.95 },
            S2: { threshold: 0.70, name: 'Moderately Suitable', confidence: 0.85 },
            S3: { threshold: 0.50, name: 'Marginally Suitable', confidence: 0.75 },
            N1: { threshold: 0.30, name: 'Currently Not Suitable', confidence: 0.70 },
            N2: { threshold: 0.00, name: 'Permanently Not Suitable', confidence: 0.90 }
        });

        // Performance optimization using early return
        for (const [className, data] of Object.entries(SUITABILITY_CLASSES)) {
            if (score >= data.threshold) {
                return {
                    class: className,
                    name: data.name,
                    score,
                    confidence: data.confidence,
                    limitations: this.calculateLimitations(score, data.threshold),
                    recommendations: this.getSuitabilityRecommendations(className, score)
                };
            }
        }

        // Fallback classification (should never reach here due to threshold structure)
        return {
            class: 'N2',
            name: SUITABILITY_CLASSES.N2.name,
            score,
            confidence: SUITABILITY_CLASSES.N2.confidence,
            limitations: this.calculateLimitations(score, 0),
            recommendations: this.getSuitabilityRecommendations('N2', score)
        };
    }

    /**
     * Calculate limitations based on score difference from threshold
     * @private
     * @param {number} score - Current suitability score
     * @param {number} threshold - Classification threshold
     * @returns {Object} - Limitation factors
     */
    static calculateLimitations(score, threshold) {
        const limitationFactor = Math.max(0, (threshold - score) / threshold);
        return {
            severity: limitationFactor,
            impact: limitationFactor > 0.5 ? 'Significant' : 'Moderate',
            improvementPotential: Math.min(1, (1 - limitationFactor) * 1.5)
        };
    }

    /**
     * Generate specific recommendations based on suitability class
     * @private
     * @param {string} className - Suitability class identifier
     * @param {number} score - Suitability score
     * @returns {string[]} - Array of specific recommendations
     */
    static getSuitabilityRecommendations(className, score) {
        const recommendations = new Set();

        switch (className) {
            case 'S1':
                recommendations.add('Maintain current land management practices');
                if (score < 0.95) {
                    recommendations.add('Consider minor optimizations for maximum yield');
                }
                break;
            case 'S2':
                recommendations.add('Implement targeted improvements for specific limitations');
                recommendations.add('Regular monitoring of soil conditions recommended');
                break;
            case 'S3':
                recommendations.add('Significant improvements required for optimal production');
                recommendations.add('Conduct detailed soil analysis');
                recommendations.add('Consider alternative crop selections');
                break;
            case 'N1':
                recommendations.add('Major land improvements required');
                recommendations.add('Evaluate cost-benefit of land development');
                recommendations.add('Consider temporary alternative land use');
                break;
            case 'N2':
                recommendations.add('Land not recommended for agricultural use');
                recommendations.add('Consider permanent alternative land use options');
                break;
        }

        return Array.from(recommendations);
    }

    /**
     * Calculate slope suitability
     * @param {number} slope - Mean slope in degrees
     * @param {Object} weights - Slope weights for the crop
     * @returns {number} - Slope suitability score
     */
    static calculateSlopeSuitability(slope, weights) {
        if (slope <= weights.optimal) return 1.0;
        if (slope <= weights.max) return 1.0 - ((slope - weights.optimal) / (weights.max - weights.optimal));
        return 0.0;
    }

    /**
     * Calculates elevation suitability score between 0.0 and 1.0
     * @param {number} elevation - Elevation in meters
     * @param {Object} range - Elevation range object with min/max values
     * @returns {number} Suitability score between 0.0 and 1.0
     * @throws {Error} If parameters are invalid
     */
    static calculateElevationSuitability(elevation, range) {
        // Input validation
        if (typeof elevation !== 'number' ||
            range?.min === undefined ||
            range?.max === undefined) {
            throw new Error('Invalid elevation or range parameters');
        }

        // Range validation
        if (range.max <= range.min) {
            throw new Error('Invalid range: max must be greater than min');
        }

        // Check if elevation is within range
        if (elevation < range.min || elevation > range.max) {
            return this.MIN_SUITABILITY;
        }

        // Calculate suitability using intermediate variables
        const midpoint = (range.min + range.max) / 2;
        const halfRange = (range.max - range.min) / 2;

        return this.MAX_SUITABILITY - (Math.abs(elevation - midpoint) / halfRange);
    }

    /**
     * Generate suitability zones
     * @param {Object} suitabilityScores - Crop suitability scores
     * @returns {Object[]} - Suitability zones
     */
    static generateSuitabilityZones(suitabilityScores) {
        const zones = [];

        Object.entries(suitabilityScores).forEach(([cropType, assessment]) => {
            if (assessment.score > 0.7) {
                zones.push({
                    type: 'Optimal',
                    crop: cropType,
                    score: assessment.score
                });
            } else if (assessment.score > 0.4) {
                zones.push({
                    type: 'Suitable',
                    crop: cropType,
                    score: assessment.score
                });
            }
        });

        return zones;
    }

    /**
     * Identify crop limitations
     * @param {Object} slopeStats - Slope statistics
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object[]} - Crop limitations
     */
    static identifyCropLimitations(slopeStats, terrainAnalysis) {
        const limitations = [];

        if (slopeStats.mean > 15) {
            limitations.push({
                type: 'Slope',
                description: 'Steep slopes may require terracing or other conservation measures'
            });
        }

        if (terrainAnalysis.drainage.waterloggingRisk > 0.5) {
            limitations.push({
                type: 'Drainage',
                description: 'Poor drainage may require additional infrastructure'
            });
        }

        return limitations;
    }

    /**
     * Estimate development costs
     * @param {number} area - Area in square meters
     * @param {Object} slopeStats - Slope statistics
     * @returns {Object} - Development cost analysis
     */
    static estimateDevelopmentCosts(area, slopeStats) {
        const baseCost = 5000; // Base cost per hectare in USD
        const areaHectares = area / 10000;

        // Cost multipliers
        const slopeMultiplier = 1 + (slopeStats.mean / 10);
        const complexityMultiplier = 1 + (slopeStats.stdDev / 15);

        const totalCost = baseCost * areaHectares * slopeMultiplier * complexityMultiplier;

        return {
            totalCost,
            perHectare: totalCost / areaHectares,
            factors: {
                slopeMultiplier,
                complexityMultiplier
            }
        };
    }

    /**
     * Assess maintenance requirements
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - Maintenance requirements
     */
    static assessMaintenanceRequirements(terrainAnalysis) {
        const requirements = [];
        const scores = {};

        // Erosion control
        if (terrainAnalysis.erosionRisk.score > 0.3) {
            requirements.push({
                type: 'Erosion Control',
                frequency: 'Quarterly',
                priority: 'High'
            });
            scores.erosionControl = terrainAnalysis.erosionRisk.score;
        }

        // Drainage maintenance
        if (terrainAnalysis.drainage.waterloggingRisk > 0.3) {
            requirements.push({
                type: 'Drainage Maintenance',
                frequency: 'Bi-annual',
                priority: 'Medium'
            });
            scores.drainageMaintenance = terrainAnalysis.drainage.waterloggingRisk;
        }

        return {
            requirements,
            scores,
            annualEstimate: this.calculateAnnualMaintenance(scores)
        };
    }

    /**
     * Calculate annual maintenance cost estimate
     * @param {Object} scores - Maintenance scores
     * @returns {number} - Annual maintenance cost
     */
    static calculateAnnualMaintenance(scores) {
        const baseCost = 1000; // USD per hectare
        const multiplier = 1 +
            (scores.erosionControl || 0) * 0.5 +
            (scores.drainageMaintenance || 0) * 0.3;

        return baseCost * multiplier;
    }

    /**
     * Estimate productivity potential
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - Productivity potential analysis
     */
    static estimateProductivityPotential(terrainAnalysis) {
        const baseScore = 1;
        const adjustments = {
            drainage: 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.4),
            erosion: 1 - (terrainAnalysis.erosionRisk.score * 0.3),
            solar: terrainAnalysis.solarExposure.score * 0.2
        };

        const score = baseScore *
            adjustments.drainage *
            adjustments.erosion *
            (adjustments.solar); // refactored this ensure a 0 - 1 range

        return {
            score,
            category: this.classifyProductivityPotential(score),
            adjustments
        };
    }

    /**
     * Assess risk factors
     * @param {Object} slopeStats - Slope statistics
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {Object} - Risk factors analysis
     */
    static assessRiskFactors(slopeStats, terrainAnalysis) {
        return {
            erosionRisk: terrainAnalysis.erosionRisk,
            waterloggingRisk: terrainAnalysis.drainage.waterloggingRisk,
            solarRisk: 1 - terrainAnalysis.solarExposure.score
        };
    }

    /**
     * Calculate sustainability score
     * @param {Object} terrainAnalysis - Terrain analysis results
     * @returns {number} - Sustainability score
     */
    static calculateSustainabilityScore(terrainAnalysis) {
        const baseScore = 1;
        const adjustments = {
            erosion: Math.max(0, Math.min(1, 1 - (terrainAnalysis.erosionRisk.score * 0.5))),
            drainage: Math.max(0, Math.min(1, 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.3))),
            solar: Math.max(0, Math.min(1, terrainAnalysis.solarExposure.score * 0.2))
        };

        return Number((baseScore * adjustments.erosion * adjustments.drainage * (1 + adjustments.solar)).toFixed(2));
    }

    /**
     * Generate recommendations based on analysis
     * @param {Object} cropSuitability - Crop suitability analysis
     * @param {Object} roiAnalysis - ROI analysis results
     * @returns {Object[]} - Recommendations
     */
    static generateRecommendations(cropSuitability, roiAnalysis) {
        const recommendations = [];

        // Crop recommendations
        const bestCrops = Object.entries(cropSuitability.scores)
            .filter(([_, assessment]) => assessment.score > 0.6)
            .sort((a, b) => b[1].score - a[1].score);

        if (bestCrops.length > 0) {
            recommendations.push({
                category: 'Crop Selection',
                suggestions: bestCrops.map(([crop, assessment]) => ({
                    crop,
                    score: assessment.score,
                    rationale: `Suitable based on terrain analysis with ${(assessment.score * 100).toFixed(1)}% compatibility`
                }))
            });
        }

        // Development recommendations
        if (roiAnalysis.developmentCosts.perHectare > 7000) {
            recommendations.push({
                category: 'Development Strategy',
                suggestions: [{
                    type: 'Phased Development',
                    rationale: 'High development costs suggest a phased approach to optimize ROI'
                }]
            });
        }

        return recommendations;
    }

    /**
 * Classify productivity potential based on comprehensive scoring
 * @param {number} score - Productivity potential score between 0 and 1
 * @returns {Object} Detailed productivity classification with confidence metrics
 * @throws {Error} If score is invalid
 */
    static classifyProductivityPotential(score) {
        // Input validation
        console.log('Classifying productivity potential...', score);
        if (typeof score !== 'number' || score < 0 || score > 1 || Number.isNaN(score)) {
            throw new Error('Productivity score must be a number between 0 and 1');
        }

        // Classification thresholds based on agricultural productivity standards
        const PRODUCTIVITY_CLASSES = Object.freeze({
            EXCEPTIONAL: {
                threshold: 0.85,
                name: 'Exceptional Productivity',
                confidence: 0.95,
                yieldPotential: '> 90%',
                managementLevel: 'Minimal'
            },
            HIGH: {
                threshold: 0.70,
                name: 'High Productivity',
                confidence: 0.85,
                yieldPotential: '75-90%',
                managementLevel: 'Low'
            },
            MODERATE: {
                threshold: 0.50,
                name: 'Moderate Productivity',
                confidence: 0.75,
                yieldPotential: '50-75%',
                managementLevel: 'Medium'
            },
            LOW: {
                threshold: 0.30,
                name: 'Low Productivity',
                confidence: 0.65,
                yieldPotential: '25-50%',
                managementLevel: 'High'
            },
            MARGINAL: {
                threshold: 0.00,
                name: 'Marginal Productivity',
                confidence: 0.80,
                yieldPotential: '< 25%',
                managementLevel: 'Intensive'
            }
        });

        // Find appropriate classification using early return
        for (const [className, data] of Object.entries(PRODUCTIVITY_CLASSES)) {
            if (score >= data.threshold) {
                return {
                    class: className,
                    name: data.name,
                    score,
                    confidence: data.confidence,
                    yieldPotential: data.yieldPotential,
                    managementLevel: data.managementLevel,
                    improvementPotential: this.calculateImprovementPotential(score, data.threshold),
                    constraints: this.identifyProductivityConstraints(score, data.threshold),
                    recommendations: this.getProductivityRecommendations(className, score)
                };
            }
        }

        // Fallback classification (should never reach here due to threshold structure)
        const marginalClass = PRODUCTIVITY_CLASSES.MARGINAL;
        return {
            class: 'MARGINAL',
            name: marginalClass.name,
            score,
            confidence: marginalClass.confidence,
            yieldPotential: marginalClass.yieldPotential,
            managementLevel: marginalClass.managementLevel,
            improvementPotential: this.calculateImprovementPotential(score, 0),
            constraints: this.identifyProductivityConstraints(score, 0),
            recommendations: this.getProductivityRecommendations('MARGINAL', score)
        };
    }

    /**
     * Calculate potential for productivity improvement
     * @private
     * @param {number} score - Current productivity score
     * @param {number} threshold - Classification threshold
     * @returns {Object} Improvement potential metrics
     */
    static calculateImprovementPotential(score, threshold) {
        const potentialGain = Math.max(0, (1 - score));
        const feasibility = score >= threshold ? 'High' : 'Moderate';

        return {
            potentialGain: Number(potentialGain.toFixed(2)),
            feasibility,
            timeframe: potentialGain > 0.3 ? 'Long-term' : 'Short-term',
            roi: potentialGain > 0.5 ? 'High' : 'Moderate'
        };
    }

    /**
     * Identify constraints limiting productivity
     * @private
     * @param {number} score - Current productivity score
     * @param {number} threshold - Classification threshold
     * @returns {Object[]} Array of identified constraints
     */
    static identifyProductivityConstraints(score, threshold) {
        const constraints = [];
        const gap = threshold - score;

        if (gap > 0.3) {
            constraints.push({
                type: 'Structural',
                severity: 'High',
                impact: 'Significant yield reduction',
                mitigationComplexity: 'Complex'
            });
        }

        if (gap > 0.1) {
            constraints.push({
                type: 'Management',
                severity: 'Moderate',
                impact: 'Reduced efficiency',
                mitigationComplexity: 'Moderate'
            });
        }

        return constraints;
    }

    /**
     * Generate productivity-specific recommendations
     * @private
     * @param {string} className - Productivity class identifier
     * @param {number} score - Productivity score
     * @returns {Object[]} Array of targeted recommendations
     */
    static getProductivityRecommendations(className, score) {
        const recommendations = [];

        switch (className) {
            case 'EXCEPTIONAL':
                recommendations.push({
                    focus: 'Maintenance',
                    priority: 'High',
                    action: 'Maintain current management practices',
                    timeframe: 'Ongoing'
                });
                break;
            case 'HIGH':
                recommendations.push({
                    focus: 'Optimization',
                    priority: 'Medium',
                    action: 'Fine-tune management practices',
                    timeframe: 'Quarterly'
                });
                break;
            case 'MODERATE':
                recommendations.push({
                    focus: 'Enhancement',
                    priority: 'High',
                    action: 'Implement targeted improvements',
                    timeframe: 'Monthly'
                });
                break;
            case 'LOW':
                recommendations.push({
                    focus: 'Rehabilitation',
                    priority: 'Urgent',
                    action: 'Major management changes required',
                    timeframe: 'Immediate'
                });
                break;
            case 'MARGINAL':
                recommendations.push({
                    focus: 'Evaluation',
                    priority: 'Critical',
                    action: 'Reassess land use options',
                    timeframe: 'Immediate'
                });
                break;
        }

        return recommendations;
    }
}

module.exports = AgriculturalLandAnalyzer;