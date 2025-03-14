const ee = require('@google/earthengine');
const axios = require('axios');
const GeoTIFF = require("geotiff");
const turf = require('@turf/turf');
const winston = require('winston'); // Added for structured logging
const openmeteo = require('openmeteo');

const AgriculturalLandAnalyzer = require('../utils/elevation-analysis');
const FarmRouteAnalyzer = require('../utils/field-accessibility-analysis');
const locationsZimbabwe = require('../data/zw.json');

const OPENTOPOGRAPHY_KEY = process.env.OPENTOPOGRAPHY_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OPENWEATHER_URL = 'https://history.openweathermap.org/data/2.5/history/city?';

const AGRO_API_KEY = process.env.AGRO_API_KEY;
const AGRO_BASE_URL = 'https://api.agromonitoring.com/agro/1.0';

if (!AGRO_API_KEY) {
    throw new Error('Missing AGRO_API_KEY. Please set it in your environment variables.');
}

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        //new winston.transports.Console(),
        new winston.transports.File({ filename: 'borehole-site-service.log' })
    ]
});

class RechargeConstants {
    // Soil moisture thresholds based on USDA soil classification
    static SOIL_MOISTURE_THRESHOLD = 0.35; // Field capacity threshold for most agricultural soils
    static SOIL_FACTOR_HIGH = 1.5;  // Higher recharge potential above field capacity
    static SOIL_FACTOR_LOW = 0.6;   // Lower recharge potential in dry conditions

    // Slope thresholds based on FAO land classification
    static SLOPE_THRESHOLD = 15;     // 15 degrees (approximately 27% slope)
    static SLOPE_FACTOR_HIGH = 0.4;  // Steep slopes reduce recharge significantly
    static SLOPE_FACTOR_LOW = 1.2;   // Gentle slopes favor groundwater recharge

    // Additional real-world factors
    static MIN_ANNUAL_RAINFALL = 250;  // Minimum annual rainfall in mm for viable recharge
    static BEDROCK_DEPTH_MIN = 30;     // Minimum depth to bedrock in meters
    static INFILTRATION_RATE_MIN = 15; // Minimum infiltration rate in mm/hour
}

class BoreholeSiteService {
    static FIELD_SLOPE = 0
    static async identifyLocations(polygon) {
        try {
            // Validate polygon structure
            if (!polygon?.geometry?.coordinates) {
                throw new Error('Invalid polygon structure. Ensure it has a "geometry" field with coordinates.');
            }

            logger.info('Input parameters:', {
                polygonCoordinates: polygon.geometry.coordinates,
            });

            // Create an Earth Engine polygon
            const area = ee.Geometry.Polygon(polygon.geometry.coordinates);

            // Perform field potential analysis
            const fieldPotentialAnalysis = []; // await AgriculturalLandAnalyzer.analyzeArea(polygon.geometry);

            const center = area.centroid().coordinates().getInfo();
            const [lon, lat] = center;

            let AccessibilityAnalysis = [];
            console.log('locationsZimbabwe -> ', locationsZimbabwe);
            try {
                const analyzer = new FarmRouteAnalyzer();
                await Promise.all(locationsZimbabwe.map(async (location) => {
                    const routeAnalysis = await analyzer.analyzeRouteQuality(
                        { lat, lon }, // field location
                        { lat: parseFloat(location.lat), lon: parseFloat(location.lng) }
                    );

                    return {
                        location: location.city,
                        admin: location.admin_name,
                        distance: Number(routeAnalysis.metadata.distance).toFixed(0),
                        overallQuality: (routeAnalysis.overallQuality / 100).toFixed(1),
                        riskAssessment: {
                            worstRoadType: routeAnalysis.riskAssessment.worstRoadType,
                            hazardRisk: Number(routeAnalysis.riskAssessment.hazardRisk).toFixed(2),
                            bridges: routeAnalysis.riskAssessment.bridges,
                            waterCrossings: routeAnalysis.riskAssessment.waterCrossings
                        },
                        unabridged: routeAnalysis.analysis
                    };
                })).then(results => {
                    AccessibilityAnalysis = results;
                });
            } catch (error) {
                logger.error('Accessibility analysis failed:', error);
                throw new Error(`Failed to analyze route accessibility: ${error.message}`);
            }
            // Perform groundwater potential analysis
            const { potentialMap, precipitationAnalysis } = await this.calculateGroundwaterPotential(area);

            // Estimate borehole depth
            const boreholeDepthAnalysis = await this.estimateBoreholeDepth(area, precipitationAnalysis);

            // Calculate success probability
            logger.info('Calculating success probability...');
            const boreholeSucessAnalysis = this.calculateSuccessProbability(
                { area }, [], precipitationAnalysis
            );

            // Return final response
            return {
                boreholeSucessAnalysis,
                potentialMap,
                precipitationAnalysis,
                boreholeDepthAnalysis,
                fieldPotentialAnalysis,
                AccessibilityAnalysis
            };
        } catch (error) {
            logger.error('Error in identifyLocations:', error);
            throw new Error(`Borehole site identification failed: ${error.message}`);
        }
    }

    static async calculateGroundwaterPotential(polygon) {
        const center = polygon.centroid().coordinates().getInfo();
        const [lon, lat] = center;

        logger.info('Center coordinates:', { lon, lat });

        // Batch Earth Engine API calls for efficiency
        const elevation = ee.Image('USGS/SRTMGL1_003');
        const landcover = ee.ImageCollection('MODIS/006/MCD12Q1').first();
        const soilMoisture = ee.ImageCollection('NASA_USDA/HSL/SMAP_soil_moisture').first();
        const temperature = ee.ImageCollection('MODIS/006/MOD11A1').first();

        logger.info('Earth Engine data loaded:', { elevation, landcover, soilMoisture, temperature });

        const bbox = polygon.bounds().getInfo().coordinates[0];
        const slope = ee.Terrain.slope(elevation);
        this.FIELD_SLOPE = slope;

        const precipitationAnalysis = await this.analyzePrecipitation(lat, lon);
        const weights = this.calculateDynamicWeights(precipitationAnalysis);

        logger.info('Calculating weights and slope:', { weights, slope });

        const normalizedElevation = elevation.unitScale(0, 3000);
        const normalizedSlope = slope.unitScale(0, 45);
        const normalizedSoilMoisture = soilMoisture.select('ssm').unitScale(0, 1);
        const normalizedTemp = temperature.select('LST_Day_1km').unitScale(250, 350);

        const precipScore = ee.Image.constant(Math.round(precipitationAnalysis.reliabilityScores.overall)).clip(bbox);

        const weightedSum = ee.Image([
            normalizedElevation.multiply(weights.elevation),
            normalizedSlope.multiply(weights.slope),
            normalizedSoilMoisture.multiply(weights.soilMoisture),
            normalizedTemp.multiply(weights.temperature),
            precipScore.multiply(weights.precipitation),
        ]).reduce(ee.Reducer.sum());

        return {
            potentialMap: weightedSum,
            precipitationAnalysis,
        };
    }

    static createEarthEngineObjects(polygon) {
        return {
            elevation: ee.Image('USGS/SRTMGL1_003'),
            landcover: ee.ImageCollection('MODIS/006/MCD12Q1').first(),
            soilMoisture: ee.ImageCollection('NASA_USDA/HSL/SMAP_soil_moisture').first(),
            temperature: ee.ImageCollection('MODIS/006/MOD11A1').first(),
            slope: ee.Terrain.slope(ee.Image('USGS/SRTMGL1_003')),
            bbox: polygon.bounds().getInfo().coordinates[0]
        };
    }

    static async estimateBoreholeDepth(polygon, precipitationAnalysis) {
        const elevation = ee.Image('USGS/SRTMGL1_003');
        const slope = ee.Terrain.slope(elevation);
        const geologicalFactors = {
            terrainType: slope.reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: polygon,
                scale: 30
            }).getInfo(),
            elevationProfile: elevation.reduceRegion({
                reducer: ee.Reducer.mean(),
                geometry: polygon,
                scale: 30
            }).getInfo()
        };

        const waterTable = await this.estimateWaterTable(polygon);
        const depthRanges = this.calculateDepthRanges(geologicalFactors, waterTable, precipitationAnalysis);

        return {
            minimumDepth: depthRanges.minimum,
            maximumDepth: depthRanges.maximum,
            recommendedDepth: depthRanges.recommended,
            confidenceScore: this.calculateDepthConfidence(depthRanges),
            factors: {
                terrain: geologicalFactors,
                waterTable,
                precipitation: precipitationAnalysis.rechargePatterns,
            },
            limitations: this.identifyDepthLimitations(depthRanges),
        };
    }

    // Move helper function outside
    static range(start, stop, step) {
        return Array.from(
            { length: Math.ceil((stop - start) / step) },
            (_, i) => start + i * step
        );
    }

    static async analyzePrecipitation(lat, lon) {
        try {
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 5);

            const params = {
                latitude: lat,
                longitude: lon,
                start_date: startDate.toISOString().split('T')[0],
                end_date: new Date().toISOString().split('T')[0],
                hourly: ["temperature_2m", "rain", "soil_moisture_100_to_255cm"],
                timezone: "GMT"
            };

            logger.info(`Fetching historical precipitation data for lat: ${lat}, lon: ${lon}`);

            const url = "https://archive-api.open-meteo.com/v1/archive";
            const response = await fetch(url + '?' + new URLSearchParams(params));

            if (!response.ok) {
                throw new Error(`API request failed with status ${response.status}`);
            }

            const data = await response.json();
            logger.info(`Fetching historical precipitation data`);

            if (!data.hourly) {
                throw new Error('No hourly data available in the response');
            }

            const { time, rain, soil_moisture_100_to_255cm } = data.hourly;

            if (!time?.length || !rain?.length || !soil_moisture_100_to_255cm?.length) {
                throw new Error('Missing required weather data in response');
            }

            const formattedData = time.map((timestamp, i) => {
                // Handle null or undefined values
                const rainValue = rain[i] !== null && rain[i] !== undefined ? Number(rain[i].toFixed(2)) : 0;
                const soilMoistureValue = soil_moisture_100_to_255cm[i] !== null && soil_moisture_100_to_255cm[i] !== undefined
                    ? Number(soil_moisture_100_to_255cm[i].toFixed(2))
                    : 0;
                return {
                    dt: new Date(timestamp).getTime(),
                    rain: rainValue,
                    soilMoisture: soilMoistureValue
                };
            });

            logger.info(`Successfully processed ${formattedData.length} precipitation records`);
            return this.calculateAdvancedPrecipitationMetrics(formattedData);

        } catch (error) {
            logger.error('Error in analyzePrecipitation:', error);
            throw new Error(`Failed to fetch historical precipitation data: ${error.message}`);
        }
    }

    /**
     * Calculates advanced precipitation metrics from the provided precipitation data.
     *
     * @param {Object[]} precipData - The precipitation data to analyze.
     * @returns {Object} - An object containing advanced precipitation metrics, including annual metrics, monthly averages, seasonal patterns, extreme events, trends, recharge patterns, and reliability scores.
     */
    static async calculateAdvancedPrecipitationMetrics(precipData) {
        try {
            //console.log('precipData -> ', precipData);

            // Initialize metrics object
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

            // Group precipitation data first since other calculations depend on it
            const groupedData = await Promise.resolve(this.groupPrecipitationData(precipData));
            //console.log('groupedData -> ', groupedData);

            // Execute all independent calculations concurrently
            const [
                annualMetrics,
                seasonalResults,
                trends
            ] = await Promise.all([
                Promise.resolve(this.calculateAnnualMetrics(groupedData)),
                Promise.resolve(this.analyzeSeasonalPatterns(groupedData)),
                Promise.resolve(this.analyzePrecipitationTrends(groupedData))
            ]);

            // Assign results from parallel operations
            metrics.annualMetrics = annualMetrics;
            metrics.monthlyAverages = seasonalResults.monthlyAverages;
            metrics.seasonalPatterns = seasonalResults.seasonalPatterns;
            metrics.trends = trends;

            // Execute dependent calculations sequentially
            metrics.extremeEvents = await Promise.resolve(
                this.identifyExtremeEvents(precipData, metrics.monthlyAverages)
            );

            metrics.rechargePatterns = await Promise.resolve(
                this.analyzeRechargePatterns(precipData, metrics.monthlyAverages)
            );

            metrics.reliabilityScores = await Promise.resolve(
                this.calculateReliabilityScores(metrics)
            );

            return metrics;
        } catch (error) {
            console.error('Error calculating precipitation metrics:', error);
            throw new Error('Failed to calculate precipitation metrics: ' + error.message);
        }
    }

    /**
     * Groups precipitation data by year and month.
     *
     * @param {Object[]} precipData - The precipitation data to group.
     * @returns {Object} - An object with precipitation data grouped by year and month.
     */
    static groupPrecipitationData(precipData) {
        return precipData.reduce((acc, record) => {
            const date = new Date(record.dt);
            const year = date.getFullYear();
            const month = date.getMonth();

            if (!acc[year]) acc[year] = {};
            if (!acc[year][month]) acc[year][month] = [];

            acc[year][month].push(record.rain);
            return acc;
        }, {});
    }

    /**
     * Calculates annual precipitation metrics from grouped precipitation data.
     *
     * @param {Object} groupedData - An object with precipitation data grouped by year and month.
     * @returns {Object[]} - An array of annual precipitation metric objects, each containing the following properties:
     *   - year: The year for the annual metrics.
     *   - totalRainfall: The total rainfall for the year.
     *   - averageMonthlyRainfall: The average monthly rainfall for the year.
     *   - variabilityCoefficient: The coefficient of variability for the monthly rainfall.
     *   - dryMonths: The number of months with rainfall less than 30 mm.
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

    static identifyWetSeason(monthlyAverages) {
        const maxRainMonth = Object.keys(monthlyAverages).reduce((a, b) => monthlyAverages[a] > monthlyAverages[b] ? a : b);
        const wetSeason = [parseInt(maxRainMonth)];
        let prevMonth = (parseInt(maxRainMonth) - 1 + 12) % 12;
        let nextMonth = (parseInt(maxRainMonth) + 1) % 12;

        if (monthlyAverages[prevMonth] > monthlyAverages[maxRainMonth] / 2) wetSeason.push(prevMonth);
        if (monthlyAverages[nextMonth] > monthlyAverages[maxRainMonth] / 2) wetSeason.push(nextMonth);
        return wetSeason.sort((a, b) => a - b);
    }

    static identifyDrySeason(monthlyAverages) {
        const minRainMonth = Object.keys(monthlyAverages).reduce((a, b) => monthlyAverages[a] < monthlyAverages[b] ? a : b);
        const drySeason = [parseInt(minRainMonth)];
        let prevMonth = (parseInt(minRainMonth) - 1 + 12) % 12;
        let nextMonth = (parseInt(minRainMonth) + 1) % 12;

        if (monthlyAverages[prevMonth] < monthlyAverages[minRainMonth] * 2) drySeason.push(prevMonth);
        if (monthlyAverages[nextMonth] < monthlyAverages[minRainMonth] * 2) drySeason.push(nextMonth);
        return drySeason.sort((a, b) => a - b);
    }

    static identifyTransitionPeriods(monthlyAverages) {
        const wetSeason = this.identifyWetSeason(monthlyAverages);
        const drySeason = this.identifyDrySeason(monthlyAverages);
        const allMonths = Array.from({ length: 12 }, (_, i) => i);
        const transitionPeriods = allMonths.filter(month => !wetSeason.includes(month) && !drySeason.includes(month));
        return transitionPeriods;
    }

    static calculateSeasonalityIndex(monthlyAverages) {
        const maxRain = Math.max(...Object.values(monthlyAverages));
        const minRain = Math.min(...Object.values(monthlyAverages));
        return (maxRain - minRain) / (maxRain + minRain);
    }

    static identifyExtremeEvents(precipData, monthlyAverages) {
        const events = {
            droughts: [],
            heavyRainfall: [],
        };

        let consecutiveDryDays = 0;

        precipData.forEach((record, index) => {
            const date = new Date(record.dt);
            const month = date.getMonth();
            const monthlyAverage = monthlyAverages[month];

            if (record.rain < monthlyAverage * 0.3) {
                consecutiveDryDays++;
                if (consecutiveDryDays >= 30) {
                    events.droughts.push({
                        startDate: new Date(precipData[index - 29].dt),
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
     * Calculates the severity of a drought based on the ratio of rainfall to the monthly average.
     *
     * @param {number} rainfall - The amount of rainfall.
     * @param {number} monthlyAverage - The monthly average rainfall.
     * @returns {number} - The drought severity, ranging from 0 (not a drought) to 1 (severe drought).
     */
    static calculateDroughtSeverity(rainfall, monthlyAverage) {
        if (monthlyAverage === 0) return 1; // Maximum severity if no rain is expected

        const ratio = rainfall / monthlyAverage;
        if (ratio >= 0.5) return 0; // Not a drought
        if (ratio >= 0.3) return 0.3; // Mild drought
        if (ratio >= 0.1) return 0.7; // Moderate drought
        return 1; // Severe drought
    }

    /**
     * Analyzes the precipitation trends in the provided grouped precipitation data.
     *
     * @param {Object} groupedData - An object where the keys are years and the values are arrays of monthly precipitation totals.
     * @returns {Object} - An object containing the long-term trend, year-over-year changes, and precipitation cycle analysis.
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
     * Calculates the year-over-year changes in precipitation totals.
     *
     * @param {Object[]} yearlyTotals - An array of objects, where each object represents a year and has `year` and `total` properties.
     * @returns {Object[]} - An array of objects, where each object represents a year and has `year`, `change`, and `percentageChange` properties.
     */
    static calculateYearOverYearChanges(yearlyTotals) {
        if (!yearlyTotals || yearlyTotals.length < 2) {
            return [];
        }

        const changes = [];
        for (let i = 1; i < yearlyTotals.length; i++) {
            const currentYear = yearlyTotals[i];
            const previousYear = yearlyTotals[i - 1];

            const change = currentYear.total - previousYear.total;
            changes.push({
                year: currentYear.year,
                change: change,
                percentageChange: (change / previousYear.total) * 100
            });
        }
        return changes;
    }

    /**
     * Analyzes the precipitation cycles in the provided yearly precipitation data.
     *
     * @param {Object[]} yearlyTotals - An array of objects, where each object represents a year and has `year` and `total` properties.
     * @returns {Object} - An object containing the identified precipitation cycle peaks, troughs, and the average cycle length.
     */
    static analyzePrecipitationCycles(yearlyTotals) {
        if (!yearlyTotals || yearlyTotals.length < 3) {
            return { peaks: [], troughs: [], averageCycleLength: null };
        }

        const peaks = [];
        const troughs = [];
        let cycleLengths = [];

        for (let i = 1; i < yearlyTotals.length - 1; i++) {
            const prevYear = yearlyTotals[i - 1];
            const currentYear = yearlyTotals[i];
            const nextYear = yearlyTotals[i + 1];

            if (currentYear.total > prevYear.total && currentYear.total > nextYear.total) {
                peaks.push(currentYear.year);
                if (troughs.length > 0) {
                    const lastTroughYear = troughs[troughs.length - 1];
                    const cycleLength = currentYear.year - lastTroughYear;
                    cycleLengths.push(cycleLength);
                }
            } else if (currentYear.total < prevYear.total && currentYear.total < nextYear.total) {
                troughs.push(currentYear.year);
                if (peaks.length > 0) {
                    const lastPeakYear = peaks[peaks.length - 1];
                    const cycleLength = currentYear.year - lastPeakYear;
                    cycleLengths.push(cycleLength);
                }
            }
        }

        const averageCycleLength = cycleLengths.length > 0
            ? cycleLengths.reduce((sum, len) => sum + len, 0) / cycleLengths.length
            : null;

        return { peaks, troughs, averageCycleLength };
    }

    /**
     * Analyzes the recharge patterns for a borehole site based on precipitation data, monthly averages, soil moisture, and slope.
     *
     * @param {Array<{dt: number, rain: number}>} precipData - An array of precipitation data records, where each record has `dt` (timestamp) and `rain` (precipitation amount) properties.
     * @param {Object.<string, number>} monthlyAverages - An object with monthly precipitation averages, where the keys are month names and the values are the average precipitation for that month.
     * @param {number} [soilMoisture=0.5] - The soil moisture level, ranging from 0 to 1.
     * @param {number} [slope=5] - The slope of the borehole site, in degrees.
     * @returns {Promise<{
     *   potentialRechargeEvents: {date: Date, amount: number}[],
     *   annualRechargePattern: {[year: number]: number},
     *   rechargeEfficiency: number,
     *   error?: string
     * }>} - An object containing the analyzed recharge patterns, including potential recharge events, annual recharge pattern, and recharge efficiency.  Includes an error property if an error occurs.
     * @example
     * const precipData = [{dt: 1678886400, rain: 10}, {dt: 1678972800, rain: 15}];
     * const monthlyAverages = {"0": 12, "1": 15};
     * analyzeRechargePatterns(precipData, monthlyAverages, 0.6, 8).then(console.log);
     */
    static async analyzeRechargePatterns(precipData, monthlyAverages) {
        try {
            if (!Array.isArray(precipData) || !monthlyAverages || typeof monthlyAverages !== 'object') {
                throw new Error('Invalid input parameters');
            }

            const rechargeThreshold = this.calculateRechargeThreshold(monthlyAverages);
            const [events, annualPattern, efficiency] = await Promise.all([
                this.identifyRechargeEvents(precipData, rechargeThreshold, this.FIELD_SLOPE),
                this.calculateAnnualRechargePattern(precipData, rechargeThreshold),
                this.calculateRechargeEfficiency(precipData, monthlyAverages, rechargeThreshold)
            ]);

            console.log('events -> ', events, 'efficiency -> ', efficiency);

            return {
                potentialRechargeEvents: events,
                annualRechargePattern: annualPattern,
                rechargeEfficiency: efficiency
            };
        } catch (error) {
            logger.error('Error analyzing recharge patterns:', error);
            return {
                potentialRechargeEvents: [],
                annualRechargePattern: {},
                rechargeEfficiency: 0,
                error: error.message
            };
        }
    }

    /**
     * Calculate recharge threshold using dynamic statistical methods.
     * @param {Object.<string, number>} monthlyAverages - Monthly average rainfall data.
     * @returns {number} - The calculated recharge threshold.
     * @example
     * calculateRechargeThreshold({"0": 10, "1": 12}) // Returns a number
     */
    static calculateRechargeThreshold(monthlyAverages) {
        const monthlyRainfall = Object.values(monthlyAverages);
        const avg = this.average(monthlyRainfall);
        const stdDev = Math.sqrt(monthlyRainfall.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / monthlyRainfall.length);
        return avg + (stdDev * 1.5); // Adjust multiplier based on local conditions
    }

    /**
     * Identify recharge events with additional factors like soil moisture and slope.
     * @param {Array<{dt: number, rain: number}>} precipData - Precipitation data array.
     * @param {number} rechargeThreshold - Calculated recharge threshold.
     * @param {number} soilMoisture - Soil moisture value (0-1).
     * @param {number} slope - Slope value (degrees).
     * @returns {Array<{date: Date, amount: number}>} - Array of recharge events.
     * @example
     * identifyRechargeEvents([{dt: 1623456789, rain: 25}], 20, 0.6, 8)
     * // Returns: [{date: Date, amount: 25}]
     */
    static identifyRechargeEvents(precipData, rechargeThreshold, slope) {
        return precipData.filter(record => {
            const soilFactor = record.soilMoisture > RechargeConstants.SOIL_MOISTURE_THRESHOLD ? RechargeConstants.SOIL_FACTOR_HIGH : RechargeConstants.SOIL_FACTOR_LOW;
            const slopeFactor = slope < RechargeConstants.SLOPE_THRESHOLD ? RechargeConstants.SLOPE_FACTOR_LOW : RechargeConstants.SLOPE_FACTOR_HIGH;
            return record.rain > (rechargeThreshold * soilFactor * slopeFactor);
        }).map(record => ({
            date: new Date(record.dt),
            amount: record.rain
        }));
    }

    /**
     * @param {Array<{dt: number, rain: number}>} precipData - Precipitation data array
     * @param {number} rechargeThreshold - Calculated recharge threshold
     * @returns {Object.<number, number>} - Yearly recharge totals
     * @example
     * calculateAnnualRechargePattern([{dt: 1623456789, rain: 25}], 20)
     * // Returns: {2021: 25}
     */
    static calculateAnnualRechargePattern(precipData, rechargeThreshold) {
        return precipData.reduce((yearlyRecharge, record) => {
            if (record.rain > rechargeThreshold) {
                const year = new Date(record.dt).getFullYear();
                yearlyRecharge[year] = (yearlyRecharge[year] || 0) + record.rain;
            }
            return yearlyRecharge;
        }, {});
    }

    /**
     * Calculates recharge efficiency.
     * @param {Array<{dt: number, rain: number}>} precipData - Precipitation data.
     * @param {Object.<string, number>} monthlyAverages - Monthly precipitation averages.
     * @param {number} rechargeThreshold - Recharge threshold.
     * @returns {number} Recharge efficiency (0-1).
     * @example
     * calculateRechargeEfficiency([{dt: 123, rain: 15}], {'0': 10}, 12)
     */
    static calculateRechargeEfficiency(precipData, monthlyAverages, rechargeThreshold) {
        let totalRecharge = 0;
        let totalRainfall = 0;

        precipData.forEach(record => {
            totalRainfall += record.rain;
            if (record.rain > rechargeThreshold) {
                totalRecharge += record.rain;
            }
        });

        return totalRainfall === 0 ? 0 : totalRecharge / totalRainfall;
    }

    static calculateReliabilityScores(metrics) {
        return {
            overall: this.calculateOverallReliability(metrics),
            seasonal: this.calculateSeasonalReliability(metrics.seasonalPatterns),
            trend: this.calculateTrendReliability(metrics.trends),
            recharge: this.calculateRechargeReliability(metrics.rechargePatterns),
        };
    }

    static calculateOverallReliability(metrics) {
        const { seasonalPatterns, trends, rechargePatterns } = metrics;
        const seasonalReliability = this.calculateSeasonalReliability(seasonalPatterns);
        const trendReliability = this.calculateTrendReliability(trends);
        const rechargeReliability = this.calculateRechargeReliability(rechargePatterns);

        return (seasonalReliability + trendReliability + rechargeReliability) / 3;
    }

    static calculateSeasonalReliability(seasonalPatterns) {
        const seasonalityIndex = seasonalPatterns.seasonalityIndex;
        return 1 - seasonalityIndex;
    }

    static calculateTrendReliability(trends) {
        const trendSlope = Math.abs(trends.longTermTrend);
        return Math.max(0, Math.min(1, 1 - trendSlope));
    }

    static calculateRechargeReliability(rechargePatterns) {
        return rechargePatterns.rechargeEfficiency;
    }

    static calculateVariabilityCoefficient(values) {
        const avg = this.average(values);
        const stdDev = Math.sqrt(
            values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length
        );
        return stdDev / avg;
    }

    static average(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    static calculateTrendSlope(data) {
        const n = data.length;
        const sumX = data.reduce((sum, { year }) => sum + year, 0);
        const sumY = data.reduce((sum, { total }) => sum + total, 0);
        const sumXY = data.reduce((sum, { year, total }) => sum + year * total, 0);
        const sumXX = data.reduce((sum, { year }) => sum + year * year, 0);

        return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    }

    static calculateDynamicWeights(precipAnalysis) {
        const baseWeights = {
            elevation: 0.15,
            slope: 0.10,
            landcover: 0.10,
            soilMoisture: 0.15,
            temperature: 0.10,
            geology: 0.20,
            precipitation: 0.20
        };

        const reliabilityScore = precipAnalysis.reliabilityScores.overall;
        if (reliabilityScore > 0.8) {
            return this.adjustWeights(baseWeights, 'precipitation', 0.05);
        } else if (reliabilityScore < 0.4) {
            return this.adjustWeights(baseWeights, 'precipitation', -0.05);
        }

        return baseWeights;
    }

    static adjustWeights(weights, factor, adjustment) {
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

    /**
     * Calculates the success probability for a given set of statistics, geological formations, and precipitation analysis.
     *
     * @param {Object} stats - An object containing various statistics related to the borehole site.
     * @param {Object} [geologicalFormations=null] - An optional object containing information about the geological formations.
     * @param {Object} precipitationAnalysis - An object containing precipitation analysis data.
     * @returns {number} The calculated success probability, between 0 and 100.
     */
    static async calculateSuccessProbability(stats, geologicalFormations = null, precipitationAnalysis) {
        let coordinates;
        if (stats.area && stats.area.coordinates_ && Array.isArray(stats.area.coordinates_) && stats.area.coordinates_[0].length > 0) {
            try {
                const polygon = turf.polygon(stats.area.coordinates_);
                const centroid = turf.centroid(polygon);
                coordinates = centroid.geometry.coordinates;
            } catch (error) {
                logger.error("Error calculating centroid:", error);
                return 50; // Return default probability if centroid calculation fails
            }
        } else {
            logger.warn('Missing or invalid coordinates for probability calculation');
            return 50; // Return default probability if coordinates are missing or invalid
        }


        const [lon, lat] = coordinates;

        const weights = {
            elevation: 0.15,
            soilMoisture: 0.20,
            temperature: 0.15,
            geology: 0.25,
            precipitation: 0.25
        };

        try {
            const geologyScore = await this.calculateGeologyScore(lat, lon);
            const precipScore = precipitationAnalysis.reliabilityScores.overall;

            // Calculate weighted score (refactored for clarity)
            let probability = 0;
            for (const [key, value] of Object.entries(stats)) {
                if (weights[key] && typeof value === 'number') {
                    probability += value * weights[key];
                }
            }
            probability += geologyScore * weights.geology;
            probability += precipScore * weights.precipitation;

            return Math.min(Math.max(probability * 100, 0), 100);

        } catch (error) {
            logger.error('Error calculating success probability:', error);
            return 50; // Return default probability on error
        }
    }

    /**
     * Estimates the water table depth for a given polygon.
     *
     * @param {Object} polygon - The polygon for which to estimate the water table depth.
     * @returns {Object} An object containing the estimated water table depth, confidence level, and a note.
     */
    static async estimateWaterTable(polygon) {
        return {
            estimatedDepth: null,
            confidence: 'low',
            note: 'Local well data recommended for accurate water table depth'
        };
    }

    static calculateDepthRanges(geologicalFactors, waterTable, precipAnalysis) {
        // Initialize with default values
        const ranges = {
            minimum: 30,
            maximum: 200,
            recommended: null
        };

        // Estimate aquifer depth based on available data
        const estimatedAquiferDepth = this.estimateAquiferDepth(geologicalFactors, precipAnalysis);
        if (estimatedAquiferDepth) {
            ranges.recommended = estimatedAquiferDepth;
            ranges.minimum = Math.max(ranges.minimum, estimatedAquiferDepth - 20);
            ranges.maximum = Math.min(ranges.maximum, estimatedAquiferDepth + 50);
        }

        // Check for confining layers
        const confiningLayers = this.identifyConfiningLayers(geologicalFactors);
        confiningLayers.forEach(layer => {
            if (layer.estimatedDepth > ranges.minimum) {
                ranges.minimum = layer.estimatedDepth + 10;
            }
        });

        // Adjust based on precipitation patterns
        if (precipAnalysis.rechargePatterns.rechargeEfficiency > 0.7) {
            ranges.minimum = Math.max(20, ranges.minimum - 10);
        }

        // Set recommended depth if not already set
        if (!ranges.recommended) {
            ranges.recommended = ranges.minimum + (ranges.maximum - ranges.minimum) * 0.4;
        }

        return ranges;
    }

    // Helper methods
    static estimateAquiferDepth(geologicalFactors, precipAnalysis) {
        // Use terrain data to estimate aquifer depth
        const elevation = geologicalFactors.elevationProfile?.elevation || 0;
        const terrainSlope = geologicalFactors.terrainType?.slope || 0;

        // Basic estimation based on terrain and precipitation
        let baseDepth = 50; // Default base depth

        // Adjust for elevation (higher elevation = deeper aquifer)
        baseDepth += elevation / 100;

        // Adjust for slope (steeper slope = deeper aquifer)
        baseDepth += terrainSlope * 2;

        // Adjust for precipitation (higher recharge = shallower aquifer)
        if (precipAnalysis.rechargePatterns.rechargeEfficiency > 0.6) {
            baseDepth -= 15;
        }

        return Math.max(20, baseDepth); // Ensure minimum depth of 20m
    }

    static identifyConfiningLayers(geologicalFactors) {
        // Default empty array if no data is available
        if (!geologicalFactors.terrainType) {
            return [];
        }

        // Simple logic to identify possible confining layers based on terrain
        const possibleLayers = [];
        const slope = geologicalFactors.terrainType.slope || 0;

        // Add a confining layer at 25m for flat terrain (clay often forms here)
        if (slope < 5) {
            possibleLayers.push({ type: 'clay', estimatedDepth: 25 });
        }

        // Add deeper layer for hilly terrain
        if (slope > 10) {
            possibleLayers.push({ type: 'bedrock', estimatedDepth: 60 });
        }

        return possibleLayers;
    }

    static calculateDepthConfidence(depthRanges) {
        let confidenceScore = 0.5; // Start with moderate confidence

        // Check for reasonable range spread
        const rangeSpread = depthRanges.maximum - depthRanges.minimum;
        if (rangeSpread < 50) {
            confidenceScore += 0.2; // More confident with narrower range
        } else if (rangeSpread > 100) {
            confidenceScore -= 0.2; // Less confident with wider range
        }

        // Check if we have a recommended depth
        if (depthRanges.recommended) {
            confidenceScore += 0.1;
        }

        // Bound the confidence score between 0 and 1
        return Math.min(Math.max(confidenceScore, 0), 1);
    }

    static identifyDepthLimitations(depthEstimate) {
        const limitations = [
            "Local well data would improve accuracy",
            "Actual water table depth may vary",
            "Local geological variations may not be captured"
        ];

        if (depthEstimate.confidenceScore < 0.6) {
            limitations.push(
                "Limited geological data available",
                "Recommend local hydrogeological survey"
            );
        }

        return limitations;
    }

    /**
     * Generates a URL for a groundwater potential map using the Earth Engine API.
     * @param {object} potentialMap - The Earth Engine map object representing the groundwater potential.
     * @param {object} area - The geographic area for which the map should be generated.
     * @returns {Promise<string>} - The URL of the generated map image.
     */
    static async generateMapUrl(potentialMap, area) {
        try {
            // Get high-resolution map URL from Earth Engine
            const mapUrl = await potentialMap.getThumbURL({
                dimensions: '2048x1536',
                format: 'png',
                min: 0,
                max: 1,
                palette: ['0000FF', '00FFFF', '00FF00', 'FFFF00', 'FF0000'],
                region: area.geometry,
                scale: 10,
                quality: 100
            });

            return mapUrl;
        } catch (error) {
            logger.error('Error generating map URL:', error);
            return 'Error generating map. Please try again later.';
        }
    }

    /**
     * Calculate the geology score based on geological and climatic data.
     * @param {number} lat - Latitude of the area.
     * @param {number} lon - Longitude of the area.
     * @returns {Promise<number>} - Geology score (0 to 1).
     */
    static async calculateGeologyScore(lat, lon) {
        try {
            // Fetch geological data from APIs
            const geologicalFormations = await this.fetchGeologicalFormations(lat, lon);
            const elevationData = await AgriculturalLandAnalyzer.fetchSinglePointElevation(lat, lon);
            const geologicalFeatures = await this.fetchGeologicalFeatures(lat, lon);
            const lithologicalData = await this.fetchLithologicalData(lat, lon);

            // Combine all data into a single dataset
            const combinedData = {
                geologicalFormations,
                elevationData,
                geologicalFeatures,
                lithologicalData
            };

            // Calculate individual scores for each factor
            const scores = {
                aquiferPresence: this.calculateAquiferScore(combinedData.geologicalFormations),
                rockHardness: this.calculateRockHardnessScore(combinedData.lithologicalData),
                fractureZones: this.calculateFractureZoneScore(combinedData.geologicalFeatures),
                elevationProfile: this.calculateElevationScore(combinedData.elevationData),
                slope: this.calculateSlopeScore(combinedData.elevationData)
            };

            // Define weights based on real-world research
            const weights = {
                aquiferPresence: 0.4, // Most important factor for groundwater potential
                rockHardness: 0.2,    // Harder rocks reduce drilling feasibility
                fractureZones: 0.2,   // Fractures improve water flow
                elevationProfile: 0.1, // Lower elevation is better for groundwater
                slope: 0.1            // Steeper slopes reduce groundwater retention
            };

            // Calculate the weighted sum of scores
            const geologyScore = Object.keys(weights).reduce((sum, factor) => {
                return sum + (scores[factor] * weights[factor]);
            }, 0);

            // Normalize the score to ensure it is between 0 and 1
            return Math.min(Math.max(geologyScore, 0), 1);
        } catch (error) {
            logger.error('Error calculating geology score:', error);
            return 0.5; // Default score if data fetch fails
        }
    }

    /**
     * Fetch geological formations from USGS API.
     */
    static async fetchGeologicalFormations(lat, lon) {
        const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${lat}&longitude=${lon}&maxradiuskm=50`;
        try {
            const response = await axios.get(url);
            return response.data.features.map(feature => ({
                type: feature.properties.place, // Example: "Sandstone"
                coordinates: feature.geometry.coordinates,
                magnitude: feature.properties.mag // Optional: seismic activity
            }));
        } catch (error) {
            logger.error('Error fetching geological data from USGS:', error);
            throw new Error('Failed to fetch geological data.');
        }
    }

    /**
     * Fetch geological features from Overpass API.
     */
    static async fetchGeologicalFeatures(lat, lon) {
        const query = `
            [out:json];
            node["geological"](around:5000,${lat},${lon});
            out body;
        `;
        try {
            const response = await axios.post('https://overpass-api.de/api/interpreter', query);
            return response.data.elements; // Contains geological features
        } catch (error) {
            logger.error('Error fetching geological features from Overpass API:', error);
            throw new Error('Failed to fetch geological features.');
        }
    }

    /**
     * Fetch lithological data from the MacroStrat API for the given latitude and longitude coordinates.
     *
     * @param {number} lat - The latitude coordinate.
     * @param {number} lon - The longitude coordinate.
     * @returns {Promise<{ success: boolean, message: string, data: Array<{ type: string, age: string, name: string, unit_id: string, description: string, coordinates: { lat: number, lon: number } }>, source: string }>} - An object containing the fetched lithological data, or an error message if the fetch failed.
     */
    static async fetchLithologicalData(lat, lon) {
        // Using MacroStrat API for global geological data
        const macrostratUrl = `https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lon}&format=json&all_units=true`;
        try {
            logger.info('Fetching MacroStrat geological data for coordinates:', { lat, lon });
            const response = await axios.get(macrostratUrl, {
                timeout: 8000  // 8 second timeout
            });

            logger.info('MacroStrat API response:', response.data);
            if (!response.data.success || !response.data.success.data || response.data.success.data.length === 0) {
                logger.warn('No MacroStrat geological data found for these coordinates', { lat, lon });
                return {
                    success: false,
                    message: 'No geological data available for these coordinates in MacroStrat',
                    data: []
                };
            }

            // Process the response
            const lithologyData = response.data.success.data.map(record => {
                return {
                    type: record.lith || 'unknown',
                    age: record.b_age && record.t_age ? `${record.b_age} - ${record.t_age}` : 'unknown',
                    name: record.name || '',
                    unit_id: record.map_id || '',
                    description: record.descrip || '',
                    coordinates: {
                        lat: lat,
                        lon: lon
                    }
                };
            });
            return {
                success: true,
                message: 'Successfully retrieved geological data',
                data: lithologyData,
                source: 'MacroStrat API'
            };
        } catch (error) {
            logger.error('Error fetching MacroStrat geological data:', error);
            return {
                success: false,
                message: 'Failed to fetch MacroStrat geological data: ' + (error.message || 'Unknown error'),
                error: error.toString(),
                data: []
            };
        }
    }

    /**
     * Maps a pixel value to a lithological type and coverage.
     * The mapping is based on the GLiM (Global Lithological Map) classification.
     *
     * @param {number} pixelValue - The pixel value to be mapped to a lithological type.
     * @returns {Object|null} - An object with the lithological type and coverage, or null if the pixel value is not found in the mapping.
     */
    static mapPixelValueToLithology(pixelValue) {
        // GLiM classification mapping
        const lithologyMap = {
            1: { type: 'granite', coverage: 1.0 },
            2: { type: 'sandstone', coverage: 1.0 },
            3: { type: 'limestone', coverage: 1.0 },
            4: { type: 'shale', coverage: 1.0 },
            5: { type: 'clay', coverage: 1.0 }
        };

        return lithologyMap[pixelValue] || null;
    }

    /**
     * Calculate the aquifer presence score.
     */
    static calculateAquiferScore(geologicalFormations) {
        const aquiferTypes = ['sandstone', 'limestone', 'gravel'];
        const aquiferFormations = geologicalFormations.filter(formation =>
            aquiferTypes.includes(formation.type.toLowerCase())
        );

        if (aquiferFormations.length === 0) {
            return 0; // No aquifers present
        }

        // Score is proportional to the number of aquifer formations
        return Math.min(aquiferFormations.length / geologicalFormations.length, 1);
    }

    /**
     * Calculates the rock hardness score based on the provided lithological data.
     * The score is calculated as a weighted average of the Mohs hardness and compressive strength of the rock types,
     * taking into account the coverage of each rock type.
     * If the rock type is not found in the hardness scale, an attempt is made to classify it using an external API.
     * The final score is normalized to the range of 0-1.
     *
     * @param {Array<{ type: string, coverage: number }>} lithologicalData - An array of lithological formations with their types and coverage.
     * @returns {Promise<number>} - The calculated rock hardness score, normalized to the range of 0-1.
    */
    static async calculateRockHardnessScore(lithologicalData) {
        const hardnessScale = {
            'sandstone': {
                mohs: 4,
                compressiveStrength: 50, // MPa
                weight: 0.4
            },
            'limestone': {
                mohs: 5,
                compressiveStrength: 60, // MPa
                weight: 0.5
            },
            'granite': {
                mohs: 7,
                compressiveStrength: 200, // MPa
                weight: 0.7
            },
            'shale': {
                mohs: 3,
                compressiveStrength: 30, // MPa
                weight: 0.3
            },
            'clay': {
                mohs: 1,
                compressiveStrength: 10, // MPa
                weight: 0.1
            },
            'metamorphic': {
                mohs: 6,
                compressiveStrength: 150, // MPa
                weight: 0.6
            },
            'plutonic': {
                mohs: 7,
                compressiveStrength: 200, // MPa
                weight: 0.7
            }
        };

        if (lithologicalData.success) {
            lithologicalData.data.forEach(formation => {
            });
        }

        const totalScore = await lithologicalData.data.reduce(async (sumPromise, formation) => {
            const sum = await sumPromise;
            let rockProperties = hardnessScale[formation.type.toLowerCase()];

            if (!rockProperties) {
                // Attempt to classify unknown rock types based on description or name
                rockProperties = await this.classifyUnknownRockType(formation);
            }

            if (!rockProperties) {
                return sum + 0.5; // Default score for unknown rock types
            }

            // Calculate weighted score based on multiple factors
            const mohsScore = rockProperties.mohs / 10;
            const strengthScore = rockProperties.compressiveStrength / 200;
            const combinedScore = (mohsScore * 0.4 + strengthScore * 0.6) * rockProperties.weight;

            return sum + (combinedScore * formation.coverage);
        }, Promise.resolve(0));

        const totalCoverage = lithologicalData.data.reduce((sum, formation) => sum + formation.coverage, 0);
        const averageScore = totalScore / totalCoverage;

        // Normalize final score to 0-1 range
        return Math.min(Math.max(1 - averageScore, 0), 1);
    }

    /**
     * Attempts to classify an unknown rock type based on geological features near the given coordinates.
     * @param {Object} formation - The geological formation to classify.
     * @param {Object} formation.coordinates - The coordinates of the geological formation.
     * @param {number} formation.coordinates.lat - The latitude of the geological formation.
     * @param {number} formation.coordinates.lon - The longitude of the geological formation.
     * @returns {Object|null} - The rock properties if a match is found, or null if no match is found.
     */
    static async classifyUnknownRockType(formation) {
        const hardnessScale = {
            'sandstone': { mohs: 4, compressiveStrength: 50, weight: 0.4 },
            'limestone': { mohs: 5, compressiveStrength: 60, weight: 0.5 },
            'granite': { mohs: 7, compressiveStrength: 200, weight: 0.7 },
            'shale': { mohs: 3, compressiveStrength: 30, weight: 0.3 },
            'clay': { mohs: 1, compressiveStrength: 10, weight: 0.1 },
            'metamorphic': { mohs: 6, compressiveStrength: 150, weight: 0.6 },
            'plutonic': { mohs: 7, compressiveStrength: 200, weight: 0.7 }
        };

        const { lat, lon } = formation.coordinates;

        try {
            // Step 1: Query OpenStreetMap Overpass API for geological features near the coordinates
            const overpassQuery = `
                [out:json][timeout:25];
                (
                    node["geology"](around:1000, ${lat}, ${lon});
                    way["geology"](around:1000, ${lat}, ${lon});
                    relation["geology"](around:1000, ${lat}, ${lon});
                );
                out body;
                >;
                out skel qt;
            `;

            const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
            const response = await axios.get(overpassUrl);

            // Step 2: Parse the response and look for relevant geological tags
            const elements = response.data.elements;
            if (elements.length === 0) return null;

            // Step 3: Extract geology tags and match them to known rock types
            for (const element of elements) {
                const geologyTags = element.tags?.geology || '';
                if (!geologyTags) continue;

                // Check if the geology tags contain any known rock types
                const knownRockTypes = Object.keys(hardnessScale);
                for (const rockType of knownRockTypes) {
                    if (geologyTags.toLowerCase().includes(rockType)) {
                        return hardnessScale[rockType];
                    }
                }
            }

            return null; // No matching rock type found
        } catch (error) {
            console.error('Error classifying rock type using Overpass API:', error);
            return null;
        }
    }

    /**
     * Calculates the fracture zone score based on the provided geological features.
     * The score is proportional to the number of fracture formations relative to the total number of geological features.
     * @param {Object[]} geologicalFeatures - An array of geological feature objects.
     * @returns {number} The fracture zone score, ranging from 0 to 1.
     */
    static calculateFractureZoneScore(geologicalFeatures) {
        const fractureFormations = geologicalFeatures.filter(formation =>
            formation.tags?.geological === 'fracture'
        );

        if (fractureFormations.length === 0) {
            return 0; // No fracture zones present
        }

        // Score is proportional to the number of fracture formations
        return Math.min(fractureFormations.length / geologicalFeatures.length, 1);
    }


    /**
     * Calculates the elevation score based on the provided elevation data.
     * The score is normalized to a range of 0 to 1, where 0 represents the highest elevation and 1 represents the lowest elevation.
     * The score is calculated as 1 - (average elevation / 1000), assuming 1000m as the upper limit.
     * @param {Object|Object[]} elevationData - The elevation data, which can be a single object or an array of objects with an 'elevation' property.
     * @returns {number} The elevation score, ranging from 0 to 1.
     */
    static calculateElevationScore(elevationData) {
        if (Array.isArray(elevationData)) {
            console.log('elevationData:', elevationData);

            const elevations = elevationData.map(point => parseFloat(point.elevation)).filter(e => !isNaN(e));
            if (elevations.length === 0) return 0;
            const averageElevation = elevations.reduce((sum, e) => sum + e, 0) / elevations.length;
            return Math.max(0, 1 - (averageElevation / 1000)); // Assume 1000m is the upper limit
        } else if (elevationData && elevationData.elevation) {
            const elevation = parseFloat(elevationData.elevation);
            if (isNaN(elevation)) return 0;
            return Math.max(0, 1 - (elevation / 1000)); // Assume 1000m is the upper limit
        } else {
            return 0;
        }
    }

    /**
     * Calculate the slope score.
     */
    static calculateSlopeScore(elevationData) {
        const slopes = elevationData.map(point => point.slope || 0);
        const averageSlope = slopes.reduce((sum, slope) => sum + slope, 0) / slopes.length;

        // Lower slope is better for groundwater retention (normalized to 0-1 range)
        return Math.max(0, 1 - (averageSlope / 45)); // Assume 45 degrees is the upper limit
    }

}

module.exports = BoreholeSiteService;