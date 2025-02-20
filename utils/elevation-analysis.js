const axios = require('axios');
const turf = require('@turf/turf');
const booleanValid = require('@turf/boolean-valid');
const winston = require('winston');
const { valid } = require('geojson-validation');
const config = require('../config/config');

// Configure logger
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
        console.log('Calculating confidence interval...', values);
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

            // Fetch elevation data for all points
            const elevationData = await this.fetchElevationData(samplingPoints);
            if (elevationData.length < 2) {
                logger.warn(`Insufficient elevation data: ${elevationData.length} valid points`);
            }

            console.log('Elevation data:', elevationData);

            // Perform comprehensive analysis
            const analysis = await this.performAnalysis(geoJson, elevationData);
            console.log('Analysis:', analysis);

            logger.info('Analysis completed successfully');
            return analysis;
        } catch (error) {
            logger.error('Error in area analysis:', error);
            throw new Error(`Agricultural land analysis failed: ${error.message}`);
        }
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
        // Input validation
        if (!points?.features?.length) {
            throw new Error('Invalid points input: Empty or missing features array');
        }

        const coordinates = points.features.map(f => f.geometry.coordinates);
        const results = [];
        const total = coordinates.length;

        // Dynamic batch size calculation
        const batchSize = this.getBatchSize(total);

        // Exponential backoff configuration
        const maxRetries = 3;
        const backoff = (attempt) => this.REQUEST_DELAY_MS * Math.pow(2, attempt);

        logger.info(`Starting elevation data fetch for ${total} points`);

        for (let i = 0; i < coordinates.length; i += batchSize) {
            const batch = coordinates.slice(i, i + batchSize);

            // Progress tracking
            const progress = Math.round((i / total) * 100);
            logger.info(`Elevation data fetch progress: ${progress}%`);

            // Implement retry with backoff
            let attempt = 0;
            let batchResults;

            while (attempt < maxRetries) {
                try {
                    await new Promise(resolve => setTimeout(resolve, backoff(attempt)));
                    const batchPromises = batch.map(coord =>
                        this.fetchSinglePointElevation(coord[1], coord[0])
                    );
                    batchResults = await Promise.allSettled(batchPromises);
                    break;
                } catch (error) {
                    attempt++;
                    logger.warn(`Batch retry ${attempt}/${maxRetries} due to: ${error.message}`);
                    if (attempt === maxRetries) {
                        logger.error(`Failed to fetch batch after ${maxRetries} attempts`);
                        throw error;
                    }
                }
            }
            results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : null));
        }

        // Calculate and log success statistics
        const validResults = results.filter(r => r !== null);
        const successRate = (validResults.length / results.length) * 100;

        logger.info(`Elevation fetch complete: ${successRate.toFixed(2)}% success rate`);
        logger.info(`Retrieved ${validResults.length} valid elevation points out of ${results.length} total`);

        return validResults;
    }

    // Helper method for dynamic batch size calculation
    static getBatchSize(total) {
        const OPTIMAL_BATCHES = 10;
        return Math.min(
            this.MAX_BATCH_SIZE,
            Math.ceil(total / OPTIMAL_BATCHES)
        );
    }

    /**
     * Fetch elevation for a single point
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {Promise<Object>} - Elevation data object
     */
    static async fetchSinglePointElevation(lat, lon) {
        // Add input validation
        if (!this.isValidCoordinate(lat, lon)) {
            throw new Error('Invalid coordinates');
        }

        // Add retry mechanism
        let retries = 3;
        while (retries > 0) {
            try {
                const response = await axios.get(`${this.GMRT_API_URL}?longitude=${lon}&latitude=${lat}&format=json`, { timeout: 5000 });
                if (!response.data?.elevation) {
                    throw new Error('Invalid elevation data');
                }
                return {
                    coordinates: [lon, lat],
                    elevation: parseFloat(response.data.elevation)
                };
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
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
        const points = elevationData.map(d => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: d.coordinates
            },
            properties: {
                elevation: d.elevation
            }
        }));

        // Create elevation surface for analysis
        const elevationSurface = turf.tin(turf.featureCollection(points), 'elevation');
        console.log('Elevation surface:', elevationSurface);

        // Calculate slope statistics
        const slopeStats = this.calculateSlopeStatistics(elevationSurface);
        console.log('Slope stats:', slopeStats);
        // Analyze terrain characteristics
        const terrainAnalysis = this.analyzeTerrainCharacteristics(elevationSurface, slopeStats);
        console.log('Terrain analysis:', terrainAnalysis);
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
        console.log('slopes ->', slopes);
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

        logger.info('sortedSlopes -> ', { sortedSlopes });

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

        console.log('distribution -> ', distribution);

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
        const cells = this.convertToGrid(elevationSurface);
        return this.d8FlowAccumulation(cells);
    }

    /**
     * Convert TIN to regular grid
     * @param {Object} elevationSurface - TIN elevation surface
     * @returns {Object} - Regular grid
     */
    static convertToGrid(elevationSurface) {
        const bbox = turf.bbox(elevationSurface);
        const cellSize = (bbox[2] - bbox[0]) / 50; // 50x50 grid
        return turf.pointGrid(bbox, cellSize, {
            properties: { elevation: 0 }
        });
    }

    /**
     * Calculate D8 flow accumulation
     * @param {Object} grid - Regular grid
     * @returns {Object} - Flow accumulation grid
     */
    static d8FlowAccumulation(grid) {
        const rows = Math.sqrt(grid.features.length);
        const cells = grid.features.map(f => f.properties.elevation);
        const flowAccumulation = new Array(cells.length).fill(1);
        const flowDirections = new Array(cells.length).fill(-1);

        // Depression filling
        const filledCells = this.fillDepressions(cells, rows);

        // Calculate flow directions with flat resolution
        for (let i = 0; i < filledCells.length; i++) {
            const neighbors = this.getNeighbors(i, rows, filledCells);
            const flatArea = this.identifyFlatArea(i, neighbors, filledCells);

            if (flatArea.length > 0) {
                this.resolveFlatArea(flatArea, flowDirections, rows, filledCells);
            } else {
                flowDirections[i] = this.findSteepestDescent(i, neighbors);
            }
        }

        // Calculate flow accumulation
        for (let i = 0; i < filledCells.length; i++) {
            let currentCell = i;
            let visited = new Set();

            while (flowDirections[currentCell] !== -1 && !visited.has(currentCell)) {
                visited.add(currentCell);
                currentCell = flowDirections[currentCell];
                flowAccumulation[currentCell]++;
            }
        }

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
            terrainAnalysis.elevation,
            elevRange
        );

        // Adjust for other factors
        const drainageAdjustment = 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.5);
        const erosionAdjustment = 1 - (terrainAnalysis.erosionRisk.score * 0.3);

        const score = slopeSuitability *
            elevationSuitability *
            drainageAdjustment *
            erosionAdjustment;

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
     * Calculate elevation suitability
     * @param {number} elevation - Mean elevation in meters
     * @param {Object} range - Elevation range for the crop
     * @returns {number} - Elevation suitability score
     */
    static calculateElevationSuitability(elevation, range) {
        if (elevation < range.min || elevation > range.max) return 0.0;
        return 1.0 - (Math.abs(elevation - (range.min + range.max) / 2) / ((range.max - range.min) / 2));
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
            (1 + adjustments.solar);

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
            erosion: 1 - (terrainAnalysis.erosionRisk.score * 0.5),
            drainage: 1 - (terrainAnalysis.drainage.waterloggingRisk * 0.3),
            solar: terrainAnalysis.solarExposure.score * 0.2
        };

        return baseScore * adjustments.erosion * adjustments.drainage * (1 + adjustments.solar);
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
}

module.exports = AgriculturalLandAnalyzer;