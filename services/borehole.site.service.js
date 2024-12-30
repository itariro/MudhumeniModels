const ee = require('@google/earthengine');
const axios = require('axios');

const AGRO_API_KEY = process.env.AGRO_API_KEY;
const AGRO_BASE_URL = 'https://api.agromonitoring.com/agro/1.0';

if (!AGRO_API_KEY) {
    throw new Error('Missing AGRO_API_KEY. Please set it in your environment variables.');
}

class BoreholeSiteService {
    static async identifyLocations(polygon) {
        try {
            // Validate polygon structure
            if (!polygon?.geometry?.coordinates) {
                throw new Error('Invalid polygon structure. Ensure it has a "geometry" field with coordinates.');
            }

            console.log('Input parameters:', {
                polygonCoordinates: polygon.geometry.coordinates,
            });

            // Create an Earth Engine polygon
            const area = ee.Geometry.Polygon(polygon.geometry.coordinates);

            // Perform groundwater potential analysis
            const { potentialMap, geologicalFormations, precipitationAnalysis } =
                await this.calculateGroundwaterPotential(area);

            // Estimate borehole depth
            const depthEstimate = await this.estimateBoreholeDepth(area, geologicalFormations, precipitationAnalysis);

            // Calculate success probability
            const probability = await this.calculateSuccessProbability(
                { area }, geologicalFormations, precipitationAnalysis
            );

            // Return final response
            return {
                probability,
                potentialMap: await this.generateMapUrl(potentialMap, area),
                geologicalFormations,
                precipitationAnalysis,
                depthEstimate,
            };
        } catch (error) {
            console.error('Error in identifyLocations:', error);
            throw new Error(`Borehole site identification failed: ${error.message}`);
        }
    }

    static async calculateGroundwaterPotential(polygon) {
        const center = polygon.centroid().coordinates().getInfo();
        const [lon, lat] = center;

        const precipitationAnalysis = await this.analyzePrecipitation(lat, lon);

        const elevation = ee.Image('USGS/SRTMGL1_003');
        const landcover = ee.ImageCollection('MODIS/006/MCD12Q1').first();
        const soilMoisture = ee.ImageCollection('NASA_USDA/HSL/SMAP_soil_moisture').first();
        const temperature = ee.ImageCollection('MODIS/006/MOD11A1').first();

        const bbox = polygon.bounds().getInfo().coordinates[0];
        const geologicalData = await this.getGeologicalFormations(bbox);

        const weights = this.calculateDynamicWeights(precipitationAnalysis);

        const slope = ee.Terrain.slope(elevation);

        const normalizedElevation = elevation.unitScale(0, 3000);
        const normalizedSlope = slope.unitScale(0, 45);
        const normalizedSoilMoisture = soilMoisture.select('ssm').unitScale(0, 1);
        const normalizedTemp = temperature.select('LST_Day_1km').unitScale(250, 350);

        const geologyScore = ee.Image.constant(geologicalData.map((f) => f.score)).clip(polygon);
        const precipScore = ee.Image.constant(precipitationAnalysis.reliabilityScore).clip(polygon);

        const weightedSum = ee.Image([
            normalizedElevation.multiply(weights.elevation),
            normalizedSlope.multiply(weights.slope),
            normalizedSoilMoisture.multiply(weights.soilMoisture),
            normalizedTemp.multiply(weights.temperature),
            geologyScore.multiply(weights.geology),
            precipScore.multiply(weights.precipitation),
        ]).reduce(ee.Reducer.sum());

        return {
            potentialMap: weightedSum,
            geologicalFormations: geologicalData,
            precipitationAnalysis,
        };
    }

    static async estimateBoreholeDepth(polygon, geologicalData, precipitationAnalysis) {
        const geologicalFactors = this.analyzeGeologicalDepth(geologicalData);
        const waterTable = await this.estimateWaterTable(polygon);

        const depthRanges = this.calculateDepthRanges(geologicalFactors, waterTable, precipitationAnalysis);

        return {
            minimumDepth: depthRanges.minimum,
            maximumDepth: depthRanges.maximum,
            recommendedDepth: depthRanges.recommended,
            confidenceScore: this.calculateDepthConfidence(depthRanges, geologicalData),
            factors: {
                geological: geologicalFactors,
                waterTable,
                precipitation: precipitationAnalysis.rechargePatterns,
            },
            limitations: this.identifyDepthLimitations(depthRanges),
        };
    }

    static async analyzePrecipitation(lat, lon) {
        const end = Math.floor(Date.now() / 1000);
        const start = end - 5 * 365 * 24 * 60 * 60; // 5 years in seconds

        try {
            const response = await axios.get(`${AGRO_BASE_URL}/weather/history/accumulated_precipitation`, {
                params: {
                    lat,
                    lon,
                    start,
                    end,
                    appid: AGRO_API_KEY,
                },
            });

            return this.calculateAdvancedPrecipitationMetrics(response.data);
        } catch (error) {
            console.error('Error fetching precipitation data:', error);
            throw new Error('Precipitation data fetch failed.');
        }
    }

    /**
   * Calculate advanced precipitation metrics
   */
    static calculateAdvancedPrecipitationMetrics(precipData) {
        const metrics = {
            annualMetrics: [],
            monthlyAverages: {},
            seasonalPatterns: {},
            extremeEvents: {
                droughts: [],
                heavyRainfall: [],
            },
            trends: {},
            rechargePatterns: {},
            reliabilityScores: {},
        };

        const groupedData = this.groupPrecipitationData(precipData);

        metrics.annualMetrics = this.calculateAnnualMetrics(groupedData);
        const seasonalResults = this.analyzeSeasonalPatterns(groupedData);
        metrics.monthlyAverages = seasonalResults.monthlyAverages;
        metrics.seasonalPatterns = seasonalResults.seasonalPatterns;

        metrics.extremeEvents = this.identifyExtremeEvents(precipData, metrics.monthlyAverages);
        metrics.trends = this.analyzePrecipitationTrends(groupedData);
        metrics.rechargePatterns = this.analyzeRechargePatterns(precipData, metrics.monthlyAverages);

        metrics.reliabilityScores = this.calculateReliabilityScores(metrics);

        return metrics;
    }

    /**
     * Group precipitation data by years and months
     */
    static groupPrecipitationData(precipData) {
        return precipData.reduce((acc, record) => {
            const date = new Date(record.dt * 1000);
            const year = date.getFullYear();
            const month = date.getMonth();

            if (!acc[year]) acc[year] = {};
            if (!acc[year][month]) acc[year][month] = [];

            acc[year][month].push(record.rain);
            return acc;
        }, {});
    }

    /**
     * Calculate annual metrics
     */
    static calculateAnnualMetrics(groupedData) {
        return Object.entries(groupedData).map(([year, months]) => {
            const annualRainfall = Object.values(months)
                .flat()
                .reduce((sum, rain) => sum + rain, 0);

            const monthlyRainfalls = Object.values(months).map((rains) =>
                rains.reduce((sum, rain) => sum + rain, 0)
            );

            return {
                year: parseInt(year),
                totalRainfall: annualRainfall,
                averageMonthlyRainfall: annualRainfall / 12,
                variabilityCoefficient: this.calculateVariabilityCoefficient(monthlyRainfalls),
                dryMonths: monthlyRainfalls.filter((rain) => rain < 30).length,
            };
        });
    }

    /**
     * Analyze seasonal patterns
     */
    static analyzeSeasonalPatterns(groupedData) {
        const monthlyAverages = {};
        const monthlyVariability = {};

        for (let month = 0; month < 12; month++) {
            const monthlyRainfall = Object.values(groupedData).map((yearData) => {
                const monthData = yearData[month] || [];
                return monthData.reduce((sum, rain) => sum + rain, 0);
            });

            monthlyAverages[month] = this.average(monthlyRainfall);
            monthlyVariability[month] = this.calculateVariabilityCoefficient(monthlyRainfall);
        }

        return {
            monthlyAverages,
            seasonalPatterns: {
                wetSeason: this.identifyWetSeason(monthlyAverages),
                drySeason: this.identifyDrySeason(monthlyAverages),
                transitionPeriods: this.identifyTransitionPeriods(monthlyAverages),
                seasonalityIndex: this.calculateSeasonalityIndex(monthlyAverages),
            },
        };
    }

    /**
     * Identify extreme events
     */
    static identifyExtremeEvents(precipData, monthlyAverages) {
        const events = {
            droughts: [],
            heavyRainfall: [],
        };

        let consecutiveDryDays = 0;

        precipData.forEach((record, index) => {
            const date = new Date(record.dt * 1000);
            const month = date.getMonth();
            const monthlyAverage = monthlyAverages[month];

            if (record.rain < monthlyAverage * 0.3) {
                consecutiveDryDays++;
                if (consecutiveDryDays >= 30) {
                    events.droughts.push({
                        startDate: new Date(precipData[index - 29].dt * 1000),
                        endDate: date,
                        severity: this.calculateDroughtSeverity(record.rain, monthlyAverage),
                    });
                }
            } else {
                consecutiveDryDays = 0;
            }

            if (record.rain > monthlyAverage * 2) {
                events.heavyRainfall.push({
                    date,
                    amount: record.rain,
                    intensity: record.rain / monthlyAverage,
                });
            }
        });

        return events;
    }

    /**
     * Analyze precipitation trends
     */
    static analyzePrecipitationTrends(groupedData) {
        const yearlyTotals = Object.entries(groupedData).map(([year, months]) => ({
            year: parseInt(year),
            total: Object.values(months)
                .flat()
                .reduce((sum, rain) => sum + rain, 0),
        }));

        return {
            longTermTrend: this.calculateTrendSlope(yearlyTotals),
            yearOverYearChange: this.calculateYearOverYearChanges(yearlyTotals),
            cycleAnalysis: this.analyzePrecipitationCycles(yearlyTotals),
        };
    }

    /**
     * Analyze recharge patterns
     */
    static analyzeRechargePatterns(precipData, monthlyAverages) {
        const rechargeThreshold = this.calculateRechargeThreshold(monthlyAverages);

        return {
            potentialRechargeEvents: this.identifyRechargeEvents(precipData, rechargeThreshold),
            annualRechargePattern: this.calculateAnnualRechargePattern(precipData, rechargeThreshold),
            rechargeEfficiency: this.calculateRechargeEfficiency(precipData, monthlyAverages),
        };
    }

    /**
     * Calculate reliability scores
     */
    static calculateReliabilityScores(metrics) {
        return {
            overall: this.calculateOverallReliability(metrics),
            seasonal: this.calculateSeasonalReliability(metrics.seasonalPatterns),
            trend: this.calculateTrendReliability(metrics.trends),
            recharge: this.calculateRechargeReliability(metrics.rechargePatterns),
        };
    }

    /**
     * Helper function to calculate variability coefficient
     */
    static calculateVariabilityCoefficient(values) {
        const avg = this.average(values);
        const stdDev = Math.sqrt(
            values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length
        );
        return stdDev / avg;
    }

    /**
     * Helper function to calculate average
     */
    static average(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    /**
     * Calculate trend slope
     */
    static calculateTrendSlope(data) {
        const n = data.length;
        const sumX = data.reduce((sum, { year }) => sum + year, 0);
        const sumY = data.reduce((sum, { total }) => sum + total, 0);
        const sumXY = data.reduce((sum, { year, total }) => sum + year * total, 0);
        const sumXX = data.reduce((sum, { year }) => sum + year * year, 0);

        return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    }

    static calculateDynamicWeights = (precipAnalysis) => {
        const baseWeights = {
            elevation: 0.15,
            slope: 0.10,
            landcover: 0.10,
            soilMoisture: 0.15,
            temperature: 0.10,
            geology: 0.20,
            precipitation: 0.20
        };

        // Adjust weights based on precipitation reliability
        const reliabilityScore = precipAnalysis.reliabilityScores.overall;
        if (reliabilityScore > 0.8) {
            // High reliability - increase precipitation weight
            return adjustWeights(baseWeights, 'precipitation', 0.05);
        } else if (reliabilityScore < 0.4) {
            // Low reliability - decrease precipitation weight
            return adjustWeights(baseWeights, 'precipitation', -0.05);
        }

        return baseWeights;
    };

    // Adjust weights while maintaining sum of 1.0
    static adjustWeights = (weights, factor, adjustment) => {
        const newWeights = { ...weights };
        const oldWeight = newWeights[factor];
        const remainingFactors = Object.keys(weights).filter(k => k !== factor);

        newWeights[factor] = oldWeight + adjustment;
        const adjustmentPerFactor = adjustment / remainingFactors.length;

        remainingFactors.forEach(k => {
            newWeights[k] -= adjustmentPerFactor;
        });

        return newWeights;
    }

    // Enhanced success probability calculation
    static calculateSuccessProbability = async (stats, geologicalFormations, precipitationAnalysis) => {
        const weights = {
            elevation: 0.15,
            soilMoisture: 0.20,
            temperature: 0.15,
            geology: 0.25,
            precipitation: 0.25
        };

        // Calculate scores
        const geologyScore = geologicalFormations.reduce((sum, formation) =>
            sum + formation.score, 0) / geologicalFormations.length;

        const precipScore = precipitationAnalysis.reliabilityScore;

        // Combine all factors
        const probability = Object.entries(stats).reduce((acc, [key, value]) => {
            if (weights[key]) {
                return acc + (value * weights[key]);
            }
            return acc;
        }, 0) +
            (geologyScore * weights.geology) +
            (precipScore * weights.precipitation);

        return Math.min(Math.max(probability * 100, 0), 100);
    };

    // Estimate potential borehole depth
    static estimateBoreholeDepth = async (polygon, geologicalData, precipitationAnalysis) => {
        try {
            // Get elevation data for the area
            const elevation = ee.Image('USGS/SRTMGL1_003');
            const region = polygon;

            // Calculate basic depth metrics
            const depthEstimate = {
                minimumDepth: null,
                maximumDepth: null,
                recommendedDepth: null,
                confidenceScore: null,
                factors: {},
                limitations: []
            };

            // Analyze geological formations for depth estimation
            const geologicalDepthFactors = analyzeGeologicalDepth(geologicalData);

            // Get regional water table estimates if available
            const waterTableEstimate = await estimateWaterTable(polygon);

            // Calculate depth ranges based on available data
            const depthRanges = calculateDepthRanges(
                geologicalDepthFactors,
                waterTableEstimate,
                precipitationAnalysis
            );

            // Update depth estimate object
            depthEstimate.minimumDepth = depthRanges.minimum;
            depthEstimate.maximumDepth = depthRanges.maximum;
            depthEstimate.recommendedDepth = depthRanges.recommended;
            depthEstimate.confidenceScore = calculateDepthConfidence(depthRanges, geologicalData);
            depthEstimate.factors = {
                geological: geologicalDepthFactors,
                waterTable: waterTableEstimate,
                precipitation: precipitationAnalysis.rechargePatterns
            };

            // Add limitations and recommendations
            depthEstimate.limitations = identifyDepthLimitations(depthEstimate);

            return depthEstimate;
        } catch (error) {
            console.error('Error in depth estimation:', error);
            throw error;
        }
    };

    // Analyze geological formations for depth estimation
    static analyzeGeologicalDepth = (geologicalData) => {
        const depthFactors = {
            estimatedAquiferDepth: null,
            rockHardness: null,
            fractureZones: [],
            confiningLayers: []
        };

        // Analyze each geological formation
        geologicalData.forEach(formation => {
            // Estimate depth based on formation type
            const depthEstimate = estimateDepthFromFormation(formation);

            // Track confining layers
            if (isConfiningLayer(formation)) {
                depthFactors.confiningLayers.push({
                    type: formation.type,
                    estimatedDepth: depthEstimate
                });
            }

            // Identify fracture zones
            if (formation.structural_features) {
                depthFactors.fractureZones.push({
                    depth: depthEstimate,
                    type: formation.structural_features
                });
            }

            // Update aquifer depth if formation is water-bearing
            if (isAquifer(formation)) {
                depthFactors.estimatedAquiferDepth = depthEstimate;
            }

            // Record rock hardness for drilling considerations
            depthFactors.rockHardness = calculateRockHardness(formation);
        });

        return depthFactors;
    };

    // Estimate water table depth
    static estimateWaterTable = async (polygon) => {
        return {
            estimatedDepth: null,
            confidence: 'low',
            note: 'Local well data recommended for accurate water table depth'
        };
    };

    // Calculate depth ranges based on available data
    static calculateDepthRanges = (geologicalFactors, waterTable, precipAnalysis) => {
        const ranges = {
            minimum: 30, // Default minimum depth in meters
            maximum: 200, // Default maximum depth in meters
            recommended: null
        };

        // Adjust based on geological factors
        if (geologicalFactors.estimatedAquiferDepth) {
            ranges.recommended = geologicalFactors.estimatedAquiferDepth;
            ranges.minimum = Math.max(ranges.minimum,
                geologicalFactors.estimatedAquiferDepth - 20);
            ranges.maximum = Math.min(ranges.maximum,
                geologicalFactors.estimatedAquiferDepth + 50);
        }

        // Adjust based on confining layers
        geologicalFactors.confiningLayers.forEach(layer => {
            if (layer.estimatedDepth > ranges.minimum) {
                ranges.minimum = layer.estimatedDepth + 10;
            }
        });

        // Consider precipitation patterns
        if (precipAnalysis.rechargePatterns.rechargeEfficiency > 0.7) {
            ranges.minimum = Math.max(20, ranges.minimum - 10);
        }

        // Set recommended depth if not set by aquifer
        if (!ranges.recommended) {
            ranges.recommended = ranges.minimum +
                (ranges.maximum - ranges.minimum) * 0.4;
        }

        return ranges;
    };

    // Calculate confidence score for depth estimation
    static calculateDepthConfidence = (depthRanges, geologicalData) => {
        let confidenceScore = 0.5; // Base confidence

        // Adjust based on geological data quality
        if (geologicalData.length > 0) {
            confidenceScore += 0.2;
        }

        // Adjust based on range spread
        const rangeSpread = depthRanges.maximum - depthRanges.minimum;
        if (rangeSpread < 50) {
            confidenceScore += 0.2;
        } else if (rangeSpread > 100) {
            confidenceScore -= 0.2;
        }

        return Math.min(Math.max(confidenceScore, 0), 1);
    };

    // Identify limitations in depth estimation
    static identifyDepthLimitations = (depthEstimate) => {
        const limitations = [];

        // Add known limitations
        limitations.push(
            "Local well data would improve accuracy",
            "Actual water table depth may vary",
            "Local geological variations may not be captured"
        );

        // Add specific limitations based on confidence
        if (depthEstimate.confidenceScore < 0.6) {
            limitations.push(
                "Limited geological data available",
                "Recommend local hydrogeological survey"
            );
        }

        return limitations;
    };

    // Helper functions
    static estimateDepthFromFormation = (formation) => {
        // Depth estimates based on formation type
        const depthEstimates = {
            'sandstone': { min: 30, max: 150 },
            'limestone': { min: 40, max: 200 },
            'granite': { min: 60, max: 250 },
            'shale': { min: 20, max: 100 }
        };

        const estimate = depthEstimates[formation.type.toLowerCase()];
        return estimate ?
            (estimate.min + estimate.max) / 2 :
            null;
    };

    static isConfiningLayer = (formation) => {
        const confiningTypes = ['clay', 'shale', 'silt'];
        return confiningTypes.includes(formation.type.toLowerCase());
    };

    static isAquifer = (formation) => {
        const aquiferTypes = ['sandstone', 'limestone', 'gravel'];
        return aquiferTypes.includes(formation.type.toLowerCase());
    };

    static calculateRockHardness = (formation) => {
        const hardnessScale = {
            'sandstone': 4,
            'limestone': 5,
            'granite': 7,
            'shale': 3,
            'clay': 1
        };

        return hardnessScale[formation.type.toLowerCase()] || 5;
    };

    // Add depth estimation
    static depthEstimate = this.estimateBoreholeDepth(
        area,
        geologicalFormations,
        precipitationAnalysis
    );


    // Additional helper functions (calculateAdvancedPrecipitationMetrics, analyzeGeologicalDepth, etc.)
    // should be added here following similar principles: modular, robust, and efficient logic.

    static async getGeologicalFormations(bbox) {
        // Placeholder for actual implementation
        return [];
    }

    static async generateMapUrl(potentialMap, area) {
        // Placeholder for actual implementation
        return 'map_url';
    }
}

module.exports = BoreholeSiteService;