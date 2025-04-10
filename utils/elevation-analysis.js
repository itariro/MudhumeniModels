const axios = require('axios');
const turf = require('@turf/turf');
const winston = require('winston');
const { valid } = require('geojson-validation');
const { default: PQueue } = require('p-queue');
const config = require('../config/config');

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        //new winston.transports.Console(),
        new winston.transports.File({ filename: 'elevation-analysis.log' })
    ]
});

/**
 * Utility class for statistical calculations
 */
class StatisticsUtils {
    /**
     * Calculate the mean of an array of numbers
     * @param {number[]} values - Array of numbers
     * @returns {number} - Mean value
     */
    static mean(values) {
        if (!values.length) throw new Error('Input array cannot be empty');
        return values.reduce((sum, val) => sum + val, 0) / values.length;
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
        console.log('Calculating confidence interval...');
        if (values.length < 2) {
            throw new Error('Need at least 2 values for confidence interval');
        }

        // Use t-distribution for small samples
        const tTable = {
            0.95: [12.706, 4.303, 3.182, 2.776, 2.571], // df 1-5
            0.99: [63.657, 9.925, 5.841, 4.604, 4.032]
        };

        const zScores = { 0.95: 1.96, 0.99: 2.576 };

        const df = values.length - 1;
        const tValue = df <= 5 ? (tTable[confidence]?.[df - 1] || 1.96) : (zScores[confidence] || 1.96);

        // Use two-pass algorithm for better numerical stability
        const mean = this.mean(values);
        const squaredDiffs = values.map(x => Math.pow(x - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b) / (values.length - 1);
        const stdErr = Math.sqrt(variance / values.length);

        return {
            mean,
            lower: mean - tValue * stdErr,
            upper: mean + tValue * stdErr,
            confidence
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

    /**
     * Analyze an area defined by a GeoJSON polygon
     * @param {Object} geoJson - GeoJSON polygon defining the area
     * @returns {Promise<Object>} - Comprehensive analysis results
     */
    static async analyzeArea(geoJson) {
        try {
            logger.info('Starting analysis for GeoJSON area');

            // Validate GeoJSON input
            if (!this.validateGeoJSON(geoJson)) {
                throw new Error('Invalid GeoJSON polygon input');
            }

            // Generate sampling points within the polygon
            const samplingPoints = this.generateSamplingPoints(geoJson);

            console.log('Fetching elevation data...');
            const elevationData = await this.fetchElevationData(samplingPoints);

            const transformedElevationData = this.transformElevationData(elevationData);
            console.log('Transformed elevation data...');

            const elevations = elevationData
                .filter(item => item.status === "fulfilled")
                .flatMap(item => item.value.elevation);

            const { mean, median, min, max } = StatisticsUtils;

            this.FIELD_ELEVATION = {
                MEAN: parseFloat(mean(elevations)),
                MEDIAN: parseFloat(median(elevations)),
                MIN: parseFloat(min(elevations)),
                MAX: parseFloat(max(elevations))
            };
            console.log('Elevation data:', this.FIELD_ELEVATION);

            // Perform comprehensive analysis
            const analysis = await this.performAnalysis(geoJson, transformedElevationData);
            console.log('Analysis:', analysis);

            logger.info('Analysis completed successfully');
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
        if (!turf.booleanValid(geoJson)) {
            throw new Error('Invalid GeoJSON input');
        }

        const area = turf.area(geoJson);
        const MAX_POINTS_PER_CHUNK = 1000;
        const GRID_SPACING = 10; // 10 meters

        if (area > 1000000) { // 1 km²
            const chunks = this.divideIntoChunks(geoJson);
            return chunks.reduce((points, chunk) => {
                const chunkPoints = this.generateGridPoints(chunk, GRID_SPACING, MAX_POINTS_PER_CHUNK);
                return turf.featureCollection([...points.features, ...chunkPoints.features]);
            }, turf.featureCollection([]));
        }

        return this.generateGridPoints(geoJson, GRID_SPACING, MAX_POINTS_PER_CHUNK);
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
     * Perform comprehensive analysis of the area
     * @param {Object} geoJson - GeoJSON polygon
     * @param {Object[]} elevationData - Array of elevation data objects
     * @returns {Promise<Object>} - Analysis results
     */
    static async performAnalysis(geoJson, elevationData) {
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

        // Calculate slope statistics
        const slopeStats = this.calculateSlopeStatistics(elevationSurface);
        // Analyze terrain characteristics
        const terrainAnalysis = this.analyzeTerrainCharacteristics(elevationSurface, slopeStats);
        console.log('Terrain analysis completed:');
        // Assess crop suitability
        const cropSuitability = this.assessCropSuitability(slopeStats, terrainAnalysis);
        console.log('Crop suitability:', cropSuitability);
        // Calculate ROI factors
        const roiAnalysis = this.calculateROIFactors(area, slopeStats, terrainAnalysis);
        console.log('ROI analysis:', roiAnalysis);
        return {
            areaCharacteristics: {
                totalArea: area,
                elevationRange: {
                    min: Math.min(...elevationData.map(d => d.elevation)),
                    max: Math.max(...elevationData.map(d => d.elevation)),
                    mean: StatisticsUtils.mean(elevationData.map(d => d.elevation))
                },
                slope: slopeStats
            },
            terrainAnalysis,
            cropSuitability,
            roiAnalysis,
            recommendations: this.generateRecommendations(cropSuitability, roiAnalysis)
        };
    }

    /**
     * Calculate detailed slope statistics
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Slope statistics
     */
    static calculateSlopeStatistics(elevationSurface) {
        const slopes = [];
        // Calculate slopes between all adjacent points in TIN
        console.log('Calculate slopes between all adjacent points in TIN...');
        elevationSurface.features.forEach(triangle => {
            const coords = triangle.geometry.coordinates[0];
            for (let i = 0; i < 3; i++) {
                const slope = this.calculateSlopeBetweenPoints(
                    coords[i],
                    coords[(i + 1) % 3],
                    triangle.properties
                );
                slopes.push(slope);
            }
        });
        const slopeConfidence = StatisticsUtils.confidenceInterval(slopes);
        return {
            mean: StatisticsUtils.mean(slopes),
            median: StatisticsUtils.median(slopes),
            stdDev: StatisticsUtils.stdDev(slopes),
            confidence: slopeConfidence,
            distribution: this.calculateSlopeDistribution(slopes),
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
        return {
            drainage: this.analyzeDrainage(elevationSurface),
            erosionRisk: this.calculateErosionRisk(slopeStats),
            waterRetention: this.calculateWaterRetention(slopeStats),
            solarExposure: this.analyzeSolarExposure(elevationSurface),
            terrainComplexity: this.calculateTerrainComplexity(elevationSurface)
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

        for (const [cropType, factors] of Object.entries(this.CROP_FACTORS.SLOPE_WEIGHTS)) {
            suitability[cropType] = this.calculateCropSuitabilityScore(
                cropType,
                slopeStats,
                terrainAnalysis
            );
        }

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
    static divideIntoChunks(geoJson) {
        const bbox = turf.bbox(geoJson);
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        const chunks = [];

        // Determine chunk size based on area
        const area = turf.area(geoJson);
        const numChunks = Math.ceil(area / 1000000); // 1 km² chunks
        const chunksPerSide = Math.ceil(Math.sqrt(numChunks));

        const chunkWidth = width / chunksPerSide;
        const chunkHeight = height / chunksPerSide;

        // Generate grid of chunks
        for (let i = 0; i < chunksPerSide; i++) {
            for (let j = 0; j < chunksPerSide; j++) {
                const chunkBbox = [
                    bbox[0] + (i * chunkWidth),
                    bbox[1] + (j * chunkHeight),
                    bbox[0] + ((i + 1) * chunkWidth),
                    bbox[1] + ((j + 1) * chunkHeight)
                ];

                const chunk = turf.bboxPolygon(chunkBbox);
                const intersection = turf.intersect(geoJson, chunk);

                if (intersection && turf.area(intersection) > 0) {
                    chunks.push(intersection);
                }
            }
        }

        return chunks;
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

        logger.info('Slope distribution calculated', { distribution });

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
     * Analyze drainage patterns
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Drainage analysis results
     */
    static analyzeDrainage(elevationSurface) {
        const flowAccumulation = this.calculateFlowAccumulation(elevationSurface);
        return {
            drainagePattern: this.classifyDrainagePattern(flowAccumulation),
            drainageDensity: this.calculateDrainageDensity(flowAccumulation),
            waterloggingRisk: this.assessWaterloggingRisk(flowAccumulation)
        };
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
     * Converts a TIN elevation surface to a regular grid with optimized resolution
     * @param {Object} elevationSurface - TIN elevation surface
     * @param {number} [targetCells=25] - Target number of cells (default 5x5=25)
     * @returns {Object} - Regular grid with interpolated elevation values
     */
    static convertToGrid(elevationSurface, targetCells = 25) {
        // Input validation
        if (!elevationSurface || !elevationSurface.features || elevationSurface.features.length === 0) {
            logger.warn('Invalid elevation surface provided to convertToGrid');
            return turf.featureCollection([]);
        }

        try {
            // Calculate bounding box
            const bbox = turf.bbox(elevationSurface);

            // Calculate optimal cell size based on area and target cell count
            const width = bbox[2] - bbox[0];
            const height = bbox[3] - bbox[1];
            const area = width * height;
            const cellSize = Math.sqrt(area / targetCells);

            // Create grid with dynamic resolution
            const grid = turf.pointGrid(bbox, cellSize, { units: 'degrees' });

            // Interpolate elevation values from TIN to grid points
            return {
                type: 'FeatureCollection',
                features: grid.features.map(point => {
                    // Find the containing triangle in the TIN
                    const elevation = this.interpolateElevation(point, elevationSurface);

                    return {
                        ...point,
                        properties: {
                            ...point.properties,
                            elevation: elevation
                        }
                    };
                })
            };
        } catch (error) {
            logger.error(`Error in convertToGrid: ${error.message}`);
            return turf.featureCollection([]);
        }
    }

    /**
     * Interpolates elevation for a point from the TIN surface
     * @param {Object} point - Point feature
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {number} - Interpolated elevation value
     */
    static interpolateElevation(point, elevationSurface) {
        try {
            // Get point coordinates
            const [x, y] = point.geometry.coordinates;

            // Find the triangle containing this point
            for (const triangle of elevationSurface.features) {
                if (turf.booleanPointInPolygon(point, triangle)) {
                    // Extract triangle vertices and elevations
                    const vertices = triangle.geometry.coordinates[0].slice(0, 3);
                    const elevations = vertices.map((_, i) => {
                        // Use properties.a, properties.b, properties.c for elevations
                        const propKey = String.fromCharCode(97 + i); // 'a', 'b', 'c'
                        return triangle.properties[propKey] || 0;
                    });

                    // Perform barycentric interpolation
                    return this.barycentricInterpolation(x, y, vertices, elevations);
                }
            }

            // If point is not in any triangle, use nearest neighbor
            const nearest = turf.nearestPoint(point, turf.featureCollection(
                elevationSurface.features.flatMap(f =>
                    f.geometry.coordinates[0].slice(0, 3).map((coord, i) => ({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: coord },
                        properties: {
                            elevation: f.properties[String.fromCharCode(97 + i)] || 0
                        }
                    }))
                )
            ));

            return nearest.properties.elevation;
        } catch (error) {
            logger.warn(`Interpolation error: ${error.message}`);
            return 0; // Default elevation if interpolation fails
        }
    }

    /**
     * Performs barycentric interpolation for a point within a triangle
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {Array} vertices - Triangle vertices [[x1,y1], [x2,y2], [x3,y3]]
     * @param {Array} values - Values at vertices [v1, v2, v3]
     * @returns {number} - Interpolated value
     */
    static barycentricInterpolation(x, y, vertices, values) {
        const [[x1, y1], [x2, y2], [x3, y3]] = vertices;

        // Calculate barycentric coordinates
        const denominator = ((y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3));
        if (Math.abs(denominator) < 1e-10) {
            // Degenerate triangle, return average
            return values.reduce((sum, val) => sum + val, 0) / values.length;
        }

        const lambda1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / denominator;
        const lambda2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / denominator;
        const lambda3 = 1 - lambda1 - lambda2;

        // Interpolate value
        return lambda1 * values[0] + lambda2 * values[1] + lambda3 * values[2];
    }

    /**
     * Calculate D8 flow accumulation
     * @param {Object} grid - Regular grid
     * @returns {Object} - Flow accumulation grid
     */
    static d8FlowAccumulation(grid) {
        // Use TypedArrays for better memory efficiency
        const rows = Math.sqrt(grid.features.length);
        const cells = new Float32Array(grid.features.map(f => f.properties.elevation));
        const flowAccumulation = new Uint32Array(cells.length).fill(1);
        const flowDirections = new Int32Array(cells.length).fill(-1);

        // Chunk processing for depression filling
        const chunkSize = 10;
        const filledCells = this.fillDepressionsInChunks(cells, rows, chunkSize);

        // Parallel processing for flow directions
        const chunks = this.splitIntoChunks(filledCells, chunkSize);
        chunks.forEach((chunk, startIndex) => {
            for (let i = 0; i < chunk.length; i++) {
                const absoluteIndex = startIndex * chunkSize + i;
                const neighbors = this.getNeighbors(absoluteIndex, rows, filledCells);

                // Use Set for faster lookups
                const flatArea = new Set(this.identifyFlatArea(absoluteIndex, neighbors, filledCells));

                if (flatArea.size > 0) {
                    this.resolveFlatArea(Array.from(flatArea), flowDirections, rows, filledCells);
                } else {
                    flowDirections[absoluteIndex] = this.findSteepestDescent(absoluteIndex, neighbors);
                }
            }
        });

        console.log('Flow directions calculated.');

        // Optimize flow accumulation calculation
        const visited = new Uint8Array(cells.length);
        for (let i = 0; i < filledCells.length; i++) {
            if (visited[i]) continue;

            let currentCell = i;
            const path = [];

            while (flowDirections[currentCell] !== -1 && !visited[currentCell]) {
                visited[currentCell] = 1;
                path.push(currentCell);
                currentCell = flowDirections[currentCell];
            }

            // Batch update accumulation values
            path.forEach(cell => {
                flowAccumulation[currentCell]++;
            });
        }

        console.log('Flow accumulation calculated.');

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