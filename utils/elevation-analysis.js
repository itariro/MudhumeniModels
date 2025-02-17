const axios = require('axios');
const turf = require('@turf/turf');
const booleanValid = require('@turf/boolean-valid');
const winston = require('winston'); // Added for structured logging

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'elevation-analysis.log' })
    ]
});

/**
 * Agricultural Land Analysis System
 * Analyzes terrain characteristics for agricultural viability
 */
class AgriculturalLandAnalyzer {
    // Constants for analysis
    static GMRT_API_URL = 'https://www.gmrt.org:443/services/PointServer';
    static EARTH_RADIUS = 6371000; // meters

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
     * @returns {Promise<Object>} Comprehensive analysis results
     */
    static async analyzeArea(geoJson) {
        try {
            // Validate GeoJSON input
            console.log('geoJson -> ', JSON.stringify(geoJson, null, 2));
            console.log(typeof geoJson);

            if (!this.validateGeoJSON(geoJson)) {
                throw new Error('Invalid GeoJSON polygon input');
            }

            // Generate analysis points within the polygon
            const samplingPoints = this.generateSamplingPoints(geoJson);

            // Fetch elevation data for all points
            const elevationData = await this.fetchElevationData(samplingPoints);

            // Perform comprehensive analysis
            const analysis = await this.performAnalysis(geoJson, elevationData);

            return analysis;
        } catch (error) {
            logger.error('Error in area analysis:', error);
            throw new Error(`Agricultural land analysis failed: ${error.message}`);
        }
    }

    /**
     * Validate GeoJSON input
     * @private
     */
    static validateGeoJSON(geoJson) {
        try {
            if (!geoJson.type || !geoJson.coordinates) {
                return false;
            }
            if (geoJson.type !== 'Polygon' && geoJson.type !== 'MultiPolygon') {
                return false;
            }
            return turf.booleanValid(geoJson);
        } catch (error) {
            console.log('Validation error:', error);
            return false;
        }
    }

    /**
     * Generate sampling points within the polygon
     * @private
     */
    static generateSamplingPoints(geoJson) {
        // Calculate appropriate sampling density based on area size
        const area = turf.area(geoJson);
        const samplingDensity = this.calculateSamplingDensity(area);

        // Generate grid of points
        const bbox = turf.bbox(geoJson);
        const options = {
            units: 'meters',
            mask: geoJson
        };

        return turf.pointGrid(bbox, samplingDensity, options);
    }

    /**
     * Calculate appropriate sampling density based on area
     * @private
     */
    static calculateSamplingDensity(area) {
        // Base density on area size to balance accuracy and API calls
        const baseDistance = Math.sqrt(area) / 20; // Aim for ~400 points
        return Math.max(50, Math.min(200, baseDistance)); // Min 50m, max 200m between points
    }

    /**
     * Fetch elevation data for multiple points with rate limiting
     * @private
     */
    static async fetchElevationData(points) {
        const results = [];
        const coordinates = points.features.map(f => f.geometry.coordinates);

        for (let i = 0; i < coordinates.length; i += 10) { // Process in batches of 10
            const batch = coordinates.slice(i, i + 10);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting

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
     * @private
     */
    static async fetchSinglePointElevation(lat, lon) {
        try {
            const response = await axios.get(this.GMRT_API_URL, {
                params: {
                    longitude: lon,
                    latitude: lat,
                    format: 'json'
                },
                timeout: 5000
            });

            return {
                coordinates: [lon, lat],
                elevation: response.data.elevation
            };
        } catch (error) {
            logger.error(`Elevation fetch failed for ${lat},${lon}: ${error.message}`);
            return null;
        }
    }

    /**
     * Perform comprehensive analysis of the area
     * @private
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

        // Analyze terrain characteristics
        const terrainAnalysis = this.analyzeTerrainCharacteristics(elevationSurface, slopeStats);

        // Assess crop suitability
        const cropSuitability = this.assessCropSuitability(slopeStats, terrainAnalysis);

        // Calculate ROI factors
        const roiAnalysis = this.calculateROIFactors(area, slopeStats, terrainAnalysis);

        return {
            areaCharacteristics: {
                totalArea: area,
                elevationRange: {
                    min: Math.min(...elevationData.map(d => d.elevation)),
                    max: Math.max(...elevationData.map(d => d.elevation)),
                    mean: this.calculateMean(elevationData.map(d => d.elevation))
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
     * @private
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

        return {
            mean: this.calculateMean(slopes),
            median: this.calculateMedian(slopes),
            stdDev: this.calculateStdDev(slopes),
            distribution: this.calculateSlopeDistribution(slopes),
            aspectAnalysis: this.analyzeAspects(elevationSurface)
        };
    }

    /**
     * Analyze terrain characteristics
     * @private
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
     * @private
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
     * @private
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
     * @private
     */
    static calculateSlopeBetweenPoints(point1, point2, properties) {
        const [x1, y1] = point1;
        const [x2, y2] = point2;

        // Calculate horizontal distance using Haversine formula
        const distance = turf.distance(
            turf.point([x1, y1]),
            turf.point([x2, y2]),
            { units: 'meters' }
        );

        // Calculate elevation difference
        const elevDiff = Math.abs(properties.elevation[0] - properties.elevation[1]);

        // Calculate slope in degrees
        return Math.atan2(elevDiff, distance) * (180 / Math.PI);
    }

    /**
     * Calculate the mean of an array of numbers
     * @private
     */
    static calculateMean(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    /**
     * Calculate the median of an array of numbers
     * @private
     */
    static calculateMedian(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);

        if (sorted.length % 2 === 0) {
            return (sorted[middle - 1] + sorted[middle]) / 2;
        }
        return sorted[middle];
    }

    /**
     * Calculate standard deviation
     * @private
     */
    static calculateStdDev(values) {
        const mean = this.calculateMean(values);
        const squareDiffs = values.map(value => Math.pow(value - mean, 2));
        return Math.sqrt(this.calculateMean(squareDiffs));
    }

    /**
     * Calculate slope distribution across classes
     * @private
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
     * @private
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
     * @private
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
     * @private
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
     * @private
     */
    static calculateFlowAccumulation(elevationSurface) {
        // Simplified D8 flow algorithm
        const cells = this.convertToGrid(elevationSurface);
        return this.d8FlowAccumulation(cells);
    }

    /**
     * Convert TIN to regular grid
     * @private
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
     * @private
     */
    static d8FlowAccumulation(grid) {
        // Simplified implementation for demonstration
        return grid.features.map(cell => ({
            ...cell,
            properties: {
                ...cell.properties,
                accumulation: Math.random() // Would be actual calculation in production
            }
        }));
    }

    /**
     * Calculate erosion risk
     * @private
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
     * @private
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
     * @private
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
     * @private
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
            score: this.calculateStdDev(slopes) / 45,
            variability: this.calculateMean(slopes.map(s => Math.abs(s - this.calculateMean(slopes))))
        };
    }

    /**
     * Calculate crop suitability score
     * @private
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
     * Calculate elevation score (maintained for backward compatibility)
     */
    static calculateElevationScore(elevation) {
        const optimalRange = { min: 0, max: 2000 }; // meters
        const elevation_value = parseFloat(elevation);

        if (elevation_value < optimalRange.min) {
            return 0;
        }

        if (elevation_value > optimalRange.max) {
            return Math.max(0, 1 - ((elevation_value - optimalRange.max) / 1000));
        }

        // Calculate score within optimal range
        return 1 - (elevation_value / optimalRange.max) * 0.3;
    }

    /**
     * Estimate development costs
     * @private
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
     * @private
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
     * @private
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
     * @private
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
     * Generate suitability zones
     * @private
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
     * Generate recommendations based on analysis
     * @private
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