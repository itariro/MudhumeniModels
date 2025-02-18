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
        const area = turf.area(geoJson);
        const samplingDensity = this.calculateSamplingDensity(area);
        const bbox = turf.bbox(geoJson);
        const options = { units: 'meters', mask: geoJson };
        return turf.pointGrid(bbox, samplingDensity, options);
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
        const coordinates = points.features.map(f => f.geometry.coordinates);
        const results = [];
        const batchSize = Math.min(this.MAX_BATCH_SIZE, Math.ceil(coordinates.length / 10));

        for (let i = 0; i < coordinates.length; i += batchSize) {
            const batch = coordinates.slice(i, i + batchSize);
            await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY_MS));

            const batchPromises = batch.map(coord =>
                this.fetchSinglePointElevation(coord[1], coord[0])
            );

            const batchResults = await Promise.allSettled(batchPromises);
            results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : null));
        }

        return results.filter(r => r !== null);
    }

    /**
     * Fetch elevation for a single point
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @returns {Promise<Object>} - Elevation data object
     */
    static async fetchSinglePointElevation(lat, lon) {
        try {
            const response = await axios.get(`${this.GMRT_API_URL}?longitude=${lon}&latitude=${lat}&format=json`, { timeout: 5000 });
            if (!response.data || typeof response.data.elevation !== 'string') {
                throw new Error('Invalid elevation data received from API');
            }

            return {
                coordinates: [lon, lat],
                elevation: parseFloat(response.data.elevation)
            };
        } catch (error) {
            logger.error(`Elevation fetch failed for ${lat},${lon}: ${error.message}`);
            return null;
        }
    }

    /**
     * Perform comprehensive analysis of the area
     * @param {Object} geoJson - GeoJSON polygon
     * @param {Object[]} elevationData - Array of elevation data objects
     * @returns {Promise<Object>} - Analysis results
     */
    static async performAnalysis(geoJson, elevationData) {
        const area = turf.area(geoJson);
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
        console.log('Calculating slope statistics...');
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

        console.log('Slope statistics calculated:', slopes);
        return {
            mean: StatisticsUtils.mean(slopes),
            median: StatisticsUtils.median(slopes),
            stdDev: StatisticsUtils.stdDev(slopes),
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
     * Calculate slope between two points with elevation
     * @param {number[]} point1 - First point coordinates [lon, lat]
     * @param {number[]} point2 - Second point coordinates [lon, lat]
     * @param {Object} properties - Elevation properties
     * @returns {number} - Slope in degrees
     */
    static calculateSlopeBetweenPoints(point1, point2, properties) {
        console.log('Calculating slope between points:', point1, point2);
        console.log('Properties:', JSON.stringify(properties));
        if (!point1 || !point2 || !properties) {
            throw new Error('Invalid input: points and properties are required');
        }

        const [x1, y1] = point1;
        const [x2, y2] = point2;

        console.log('x1:', x1, 'y1:', y1, 'x2:', x2, 'y2:', y2);

        // Calculate horizontal distance using Haversine formula
        const distance = turf.distance(
            turf.point([x1, y1]),
            turf.point([x2, y2]),
            { units: 'meters' }
        );

        console.log('Distance:', distance);

        // Calculate elevation difference
        const elevDiff = Math.abs(properties.a - properties.b);
        console.log('elevDiff:', elevDiff);

        // Calculate slope in degrees
        return Math.atan2(elevDiff, distance) * (180 / Math.PI);
    }

    /**
     * Calculate slope distribution across classes
     * @param {number[]} slopes - Array of slope values
     * @returns {Object} - Slope distribution
     */
    static calculateSlopeDistribution(slopes) {
        const distribution = {};
        let total = slopes.length;

        for (const [className, limits] of Object.entries(this.SLOPE_CLASSES)) {
            const count = slopes.filter(slope => slope <= limits.max).length;
            distribution[className] = {
                percentage: (count / total) * 100,
                area: turf.area(this.polygon) * (count / total),
                description: limits.description
            };
        }

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
    /**
     * Calculate D8 flow accumulation
     * @private
     */
    static d8FlowAccumulation(grid) {
        const rows = Math.sqrt(grid.features.length);
        const cells = grid.features.map(f => f.properties.elevation);
        const flowAccumulation = new Array(cells.length).fill(1);
        const flowDirections = new Array(cells.length).fill(-1);

        // Calculate flow directions
        for (let i = 0; i < cells.length; i++) {
            const neighbors = [];
            const row = Math.floor(i / rows);
            const col = i % rows;

            // Check all 8 neighbors
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;

                    const r = row + dr;
                    const c = col + dc;

                    if (r >= 0 && r < rows && c >= 0 && c < rows) {
                        const neighborIdx = r * rows + c;
                        const slope = (cells[i] - cells[neighborIdx]) /
                            Math.sqrt(dr * dr + dc * dc);
                        neighbors.push({ index: neighborIdx, slope: slope });
                    }
                }
            }

            // Find steepest downslope neighbor
            const steepest = neighbors.reduce((max, curr) =>
                curr.slope > max.slope ? curr : max,
                { slope: -Infinity });

            if (steepest.slope > 0) {
                flowDirections[i] = steepest.index;
            }
        }

        // Calculate flow accumulation
        for (let i = 0; i < cells.length; i++) {
            let currentCell = i;
            while (flowDirections[currentCell] !== -1) {
                currentCell = flowDirections[currentCell];
                flowAccumulation[currentCell]++;
            }
        }

        // Map accumulation values back to grid features
        return {
            type: "FeatureCollection",
            features: grid.features.map((cell, index) => ({
                ...cell,
                properties: {
                    ...cell.properties,
                    accumulation: flowAccumulation[index]
                }
            }))
        };
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