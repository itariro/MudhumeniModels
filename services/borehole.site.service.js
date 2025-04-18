const ee = require('@google/earthengine');
const axios = require('axios');
const GeoTIFF = require("geotiff");
const turf = require('@turf/turf');
const winston = require('winston'); // Added for structured logging
const openmeteo = require('openmeteo');

const AgriculturalLandAnalyzer = require('../utils/elevation-analysis');
const FarmRouteAnalyzer = require('../utils/field-accessibility-analysis');
const hydroGeologicalMapZimbabwe = require('../data/hydrogeological_map_zimbabwe.json');
const { environment } = require('../config/config');

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
    // Lowered threshold for soil moisture
    static SOIL_MOISTURE_THRESHOLD = 0.30; // Reduced from 0.35
    static SOIL_FACTOR_HIGH = 1.5;
    static SOIL_FACTOR_LOW = 0.7;   // Increased from 0.6

    // Adjusted slope factors
    static SLOPE_THRESHOLD = 15;
    static SLOPE_FACTOR_HIGH = 0.5;  // Increased from 0.4
    static SLOPE_FACTOR_LOW = 1.2;

    // Lowered minimum rainfall requirement
    static MIN_ANNUAL_RAINFALL = 200;  // Reduced from 250
    static BEDROCK_DEPTH_MIN = 30;
    static INFILTRATION_RATE_MIN = 10; // Reduced from 15
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
            const center = area.centroid().coordinates().getInfo();
            const [lon, lat] = center;

            // Step 1: Execute completely independent operations in parallel
            const [
                hydroGeologicalFeatures,
                fieldPotentialAnalysis,
                accessibilityPromise,
                groundwaterResults
            ] = await Promise.all([
                // Find hydro-geological features
                this.findFeaturesAtPoint(lat, lon, hydroGeologicalMapZimbabwe),

                // Analyze agricultural land potential
                AgriculturalLandAnalyzer.analyzeArea(polygon.geometry),

                // Analyze field accessibility (wrapped in a promise to handle potential errors)
                (async () => {
                    try {
                        const analyzer = new FarmRouteAnalyzer();
                        return await analyzer.analyzeFieldAccessibility({ lat, lon });
                    } catch (error) {
                        logger.error('Accessibility analysis failed:', error);
                        throw new Error(`Failed to analyze route accessibility: ${error.message}`);
                    }
                })(),

                // Calculate groundwater potential
                this.calculateGroundwaterPotential(area)
            ]);

            // Extract results from groundwater analysis
            const { potentialMap, precipitationAnalysis, waterAvailability } = groundwaterResults;

            // Step 2: Execute operations that depend on precipitationAnalysis in parallel
            const [boreholeDepthAnalysis, boreholeSucessAnalysis] = await Promise.all([
                // Estimate borehole depth
                this.estimateBoreholeDepth(area, precipitationAnalysis),

                // Calculate success probability
                (async () => {
                    logger.info('Calculating success probability...');
                    return this.calculateSuccessProbability({ area }, [], precipitationAnalysis);
                })()
            ]);

            // Resolve the accessibility analysis promise
            const accessibilityAnalysis = await accessibilityPromise;

            // Return final response
            return {
                viability: { fieldPotentialAnalysis },
                environment: {
                    precipitation: precipitationAnalysis,
                    water: {
                        waterAvailability,
                        boreholeDepthAnalysis,
                        boreholeSucessAnalysis
                    },
                    hydroGeologicalFeatures,
                    potentialMap,
                },
                accessibility: { accessibilityAnalysis },
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
        // const landcover = ee.ImageCollection('MODIS/006/MCD12Q1').first();
        const soilMoisture = ee.ImageCollection('NASA_USDA/HSL/SMAP_soil_moisture').first();
        const temperature = ee.ImageCollection('MODIS/006/MOD11A1').first();

        logger.info('Earth Engine data loaded...');

        const bbox = polygon.bounds().getInfo().coordinates[0];
        const slope = ee.Terrain.slope(elevation);
        const slopeValue = slope.reduceRegion({
            reducer: ee.Reducer.mean(),
            geometry: polygon,
            scale: 30
        }).get('slope').getInfo();
        this.FIELD_SLOPE = slopeValue;

        const precipitationAnalysis = await this.analyzePrecipitation(lat, lon);
        const weights = this.calculateDynamicWeights(precipitationAnalysis);

        logger.info('Calculating weights and slope...');

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

        const waterAvailability = await this.estimateTotalWaterAvailability(
            polygon,
            precipitationAnalysis,
            0.4, // Example soil porosity
            50,  // Example aquifer thickness
            0.05 // Example specific yield
        );

        return {
            potentialMap: weightedSum,
            precipitationAnalysis,
            waterAvailability
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

    static findFeaturesAtPoint(lat, lng, geoJsonData) {
        const features = [];

        // Helper function to check if a point is inside a polygon
        function isPointInPolygon(point, polygon) {
            const x = point.lng; // Longitude
            const y = point.lat; // Latitude
            let inside = false;

            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const [xi, yi] = polygon[i]; // Corrected: Use [longitude, latitude]
                const [xj, yj] = polygon[j];

                const intersect = ((yi > y) !== (yj > y)) &&
                    (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

                if (intersect) inside = !inside;
            }
            return inside;
        }

        // Check if a point is inside a MultiPolygon (handles holes)
        function isInMultiPolygon(point, multiPolygon) {
            for (const polygon of multiPolygon) {
                const exterior = polygon[0]; // Outer boundary
                const interiors = polygon.slice(1); // Holes

                if (!isPointInPolygon(point, exterior)) continue;

                // Ensure the point is not inside a hole
                for (const interior of interiors) {
                    if (isPointInPolygon(point, interior)) return false;
                }

                return true;
            }
            return false;
        }

        const point = { lat, lng };

        for (const feature of geoJsonData.features) {
            const { type, coordinates } = feature.geometry;

            if (type === 'Polygon') {
                if (isInMultiPolygon(point, [coordinates])) {
                    features.push(feature);
                }
            } else if (type === 'MultiPolygon') {
                if (isInMultiPolygon(point, coordinates)) {
                    features.push(feature);
                }
            }
        }

        return features;
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

    /**
     * Retrieves and analyzes historical precipitation data for a specific geographic location.
     * 
     * @param {number} lat - Latitude coordinate of the location.
     * @param {number} lon - Longitude coordinate of the location.
     * @returns {Promise<Object>} An object containing advanced precipitation metrics derived from historical data.
     * @throws {Error} Throws an error if there are issues fetching or processing precipitation data.
     */
    static async analyzePrecipitation(lat, lon) {
        // Constants for configuration
        const HISTORICAL_YEARS = 10;
        const DEFAULT_SOIL_MOISTURE = 0.4;
        const API_TIMEOUT = 20000; // Increased to 20 seconds
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 2000; // 2 seconds
        const ARCHIVE_API_URL = "https://archive-api.open-meteo.com/v1/archive";

        // Retry function with exponential backoff
        const fetchWithRetry = async (url, options, retries = MAX_RETRIES, delay = RETRY_DELAY) => {
            try {
                return await axios(options);
            } catch (error) {
                if (retries <= 0) throw error;

                logger.warn(`Retrying API request (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`, {
                    url: options.url,
                    error: error.message
                });

                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay));

                // Retry with exponential backoff
                return fetchWithRetry(url, options, retries - 1, delay * 1.5);
            }
        };

        try {
            // Calculate date range
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - HISTORICAL_YEARS);
            const endDate = new Date();

            const params = {
                latitude: lat,
                longitude: lon,
                start_date: startDate.toISOString().split('T')[0],
                end_date: endDate.toISOString().split('T')[0],
                hourly: ["temperature_2m", "rain", "soil_moisture_100_to_255cm"],
                timezone: "GMT"
            };

            logger.info('Fetching historical precipitation data...', {
                latitude: lat,
                longitude: lon,
                startDate: params.start_date,
                endDate: params.end_date
            });

            // Use retry logic for the API request
            const response = await fetchWithRetry(ARCHIVE_API_URL, {
                method: 'get',
                url: ARCHIVE_API_URL,
                params,
                timeout: API_TIMEOUT
            });

            // Check response status
            if (response.status !== 200) {
                throw new Error(`API request failed with status ${response.status}`);
            }

            const data = response.data;
            logger.info('Received historical precipitation data...',);

            // Validate hourly data exists
            if (!data.hourly) {
                throw new Error('No hourly data available in the response');
            }

            const { time, rain, soil_moisture_100_to_255cm } = data.hourly;

            // Validate required data arrays
            if (!Array.isArray(time) || !time.length) {
                throw new Error('Missing time data in response');
            }
            if (!Array.isArray(rain) || !rain.length) {
                throw new Error('Missing rainfall data in response');
            }
            if (!Array.isArray(soil_moisture_100_to_255cm) || !soil_moisture_100_to_255cm.length) {
                throw new Error('Missing soil moisture data in response');
            }

            // Check if all rainfall values are zero
            const allZeroRainfall = rain.every(value => value === 0);
            if (allZeroRainfall) {
                logger.warn('All rainfall values are zero in the dataset', {
                    latitude: lat,
                    longitude: lon
                });
            }

            // Process and format the data
            const formattedData = time.map((timestamp, i) => {
                // Handle null or undefined values for rainfall
                const rainValue = rain[i] !== null && rain[i] !== undefined
                    ? Number(parseFloat(rain[i]).toFixed(2))
                    : 0;

                // Apply random variations only in development environment if all values are zero
                const adjustedRainValue = allZeroRainfall && environment === 'development'
                    ? (Math.random() * 2)
                    : rainValue;

                // Handle null or undefined values for soil moisture
                const soilMoistureValue = soil_moisture_100_to_255cm[i] !== null &&
                    soil_moisture_100_to_255cm[i] !== undefined
                    ? Number(parseFloat(soil_moisture_100_to_255cm[i]).toFixed(2))
                    : DEFAULT_SOIL_MOISTURE;

                return {
                    dt: new Date(timestamp).getTime(),
                    rain: adjustedRainValue,
                    soilMoisture: soilMoistureValue
                };
            });

            logger.info('Successfully processed precipitation records...', {
                recordCount: formattedData.length,
                timeRange: `${new Date(formattedData[0]?.dt).toISOString()} to ${new Date(formattedData[formattedData.length - 1]?.dt).toISOString()}`
            });

            return this.calculateAdvancedPrecipitationMetrics(formattedData);

        } catch (error) {
            // More detailed error categorization
            if (axios.isAxiosError(error)) {
                if (error.code === 'ECONNABORTED') {
                    logger.error('Timeout fetching precipitation data', {
                        latitude: lat,
                        longitude: lon,
                        error: error.message
                    });

                    // Generate fallback data if API times out
                    return this.generateFallbackPrecipitationData(lat, lon);
                }
                if (error.response) {
                    logger.error('API error fetching precipitation data', {
                        status: error.response.status,
                        data: error.response.data,
                        latitude: lat,
                        longitude: lon
                    });

                    // Generate fallback data for API errors
                    return this.generateFallbackPrecipitationData(lat, lon);
                }
                if (error.request) {
                    logger.error('Network error fetching precipitation data', {
                        latitude: lat,
                        longitude: lon,
                        error: error.message
                    });

                    // Generate fallback data for network errors
                    return this.generateFallbackPrecipitationData(lat, lon);
                }
            }

            logger.error('Error in analyzePrecipitation', {
                error: error.message,
                stack: error.stack,
                latitude: lat,
                longitude: lon
            });

            throw new Error(`Failed to fetch historical precipitation data: ${error.message}`);
        }
    }

    // Add this new method to generate fallback data
    static generateFallbackPrecipitationData(lat, lon) {
        logger.warn('Generating fallback precipitation data', { latitude: lat, longitude: lon });

        // Generate 5 years of synthetic daily data
        const startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 5);

        const formattedData = [];
        const currentDate = new Date();

        // Generate one data point per day for 5 years
        for (let date = new Date(startDate); date <= currentDate; date.setDate(date.getDate() + 1)) {
            // Generate seasonal rainfall pattern (more rain in certain months)
            const month = date.getMonth();
            const isRainyMonth = month >= 3 && month <= 8; // April to September

            // Base rainfall with seasonal variation
            let baseRainfall = isRainyMonth ?
                Math.random() * 10 + 5 : // 5-15mm in rainy season
                Math.random() * 3 + 1;   // 1-4mm in dry season

            // Add some random heavy rainfall days
            if (Math.random() < 0.05) { // 5% chance of heavy rain
                baseRainfall += Math.random() * 20 + 10; // Add 10-30mm
            }

            formattedData.push({
                dt: date.getTime(),
                rain: Number(baseRainfall.toFixed(2)),
                soilMoisture: Number((0.3 + Math.random() * 0.2).toFixed(2)) // 0.3-0.5
            });
        }

        logger.info('Generated fallback precipitation data...', {
            recordCount: formattedData.length,
            timeRange: `${new Date(formattedData[0]?.dt).toISOString()} to ${new Date(formattedData[formattedData.length - 1]?.dt).toISOString()}`
        });

        return this.calculateAdvancedPrecipitationMetrics(formattedData);
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

            // Execute independent calculations in parallel
            const [extremeEvents, rechargePatterns] = await Promise.all([
                this.identifyExtremeEvents(precipData, metrics.monthlyAverages),
                this.analyzeRechargePatterns(precipData, metrics.monthlyAverages)
            ]);

            // Assign results to metrics object
            metrics.extremeEvents = extremeEvents;
            metrics.rechargePatterns = rechargePatterns;

            // Calculate reliability scores (depends on updated metrics)
            metrics.reliabilityScores = await this.calculateReliabilityScores(metrics);

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

            logger.info('Analyzing recharge patterns...');

            const rechargeThreshold = this.calculateRechargeThreshold(monthlyAverages);
            const [events, annualPattern, efficiency] = await Promise.all([
                this.identifyRechargeEvents(precipData, rechargeThreshold, this.FIELD_SLOPE),
                this.calculateAnnualRechargePattern(precipData, rechargeThreshold),
                this.calculateRechargeEfficiency(precipData, monthlyAverages, rechargeThreshold)
            ]);

            // Add fallback if no recharge events were found but rainfall exists
            if (events.length === 0 && precipData.some(record => record.rain > 0)) {
                logger.warn('No recharge events identified despite rainfall. Using fallback method.');

                // Use top 20% of rainfall events as recharge events
                const sortedRainfall = [...precipData].sort((a, b) => b.rain - a.rain);
                const topEvents = sortedRainfall.slice(0, Math.ceil(sortedRainfall.length * 0.2));

                const fallbackEvents = topEvents.map(record => ({
                    date: new Date(record.dt),
                    amount: record.rain
                }));

                // Generate fallback annual pattern
                const fallbackAnnualPattern = {};
                fallbackEvents.forEach(event => {
                    const year = event.date.getFullYear();
                    fallbackAnnualPattern[year] = (fallbackAnnualPattern[year] || 0) + event.amount;
                });

                return {
                    potentialRechargeEvents: fallbackEvents,
                    annualRechargePattern: fallbackAnnualPattern,
                    rechargeEfficiency: 0.2, // Conservative estimate
                    note: 'Using fallback method for recharge events due to restrictive threshold'
                };
            }

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

        // Use a more reasonable threshold with a lower minimum value
        const calculatedThreshold = avg + (stdDev * 0.3); // Reduced from 0.5
        return Math.min(calculatedThreshold, 20); // Lowered from 30 to 20mm
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
    static async identifyRechargeEvents(precipData, rechargeThreshold, slope) {
        console.log('Identifying recharge events with threshold:', rechargeThreshold);

        // Check if there's any rainfall data
        const hasRainfall = precipData.some(record => record.rain > 0);
        if (!hasRainfall) {
            logger.warn('No rainfall detected in precipitation data');
            return [];
        }

        // Convert slope to number if it's an EE object
        const slopeValue = typeof slope === 'number' ? slope : 5; // Default to 5 if not a number

        // Find the maximum rainfall value to help with debugging
        const maxRainfall = Math.max(...precipData.map(record => record.rain));
        console.log('Maximum rainfall value:', maxRainfall);

        // Calculate the adjusted threshold based on slope and default soil moisture
        const defaultSoilFactor = 0.8; // More lenient default
        const slopeFactor = slopeValue < RechargeConstants.SLOPE_THRESHOLD ?
            RechargeConstants.SLOPE_FACTOR_LOW : RechargeConstants.SLOPE_FACTOR_HIGH;
        const adjustedThreshold = rechargeThreshold * defaultSoilFactor * slopeFactor;
        console.log('Adjusted threshold:', adjustedThreshold);

        // Use a more lenient approach for identifying recharge events
        const events = precipData.filter(record => {
            // Use default soil moisture if not available
            const soilMoistureValue = record.soilMoisture !== undefined ? record.soilMoisture : 0.3;

            const soilFactor = soilMoistureValue > RechargeConstants.SOIL_MOISTURE_THRESHOLD ?
                RechargeConstants.SOIL_FACTOR_HIGH : RechargeConstants.SOIL_FACTOR_LOW;

            // More lenient comparison - use either percentage of max rainfall or absolute threshold
            return record.rain > Math.min(
                rechargeThreshold * soilFactor * slopeFactor,
                maxRainfall * 0.7 // Consider top 30% of rainfall events as recharge events (changed from 0.6)
            );
        }).map(record => ({
            date: new Date(record.dt),
            amount: record.rain
        }));

        console.log('Found recharge events:', events.length);
        return events;
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
        
        // Check if there's any rainfall
        const hasRainfall = precipData.some(record => record.rain > 0);
        if (!hasRainfall) {
            logger.warn('No rainfall detected, returning minimum efficiency');
            return 0.01; // Return a small non-zero value instead of 0
        }

        let totalRecharge = 0;
        let totalRainfall = 0;
        let monthlyEfficiencies = [];

        precipData.forEach(record => {
            const date = new Date(record.dt);
            const month = date.getMonth();
            const monthlyAverage = monthlyAverages[month] || 0;

            // Calculate a dynamic threshold based on monthly average
            const adjustedThreshold = monthlyAverage > 0
                ? (rechargeThreshold * 0.7) + (rechargeThreshold * 0.3 * (record.rain / monthlyAverage))
                : rechargeThreshold;

            totalRainfall += record.rain;

            // Consider both absolute threshold and relative to monthly average
            if (record.rain > adjustedThreshold && record.rain > monthlyAverage * 0.5) {
                // Weight the recharge based on how much it exceeds both thresholds
                const rechargeWeight = Math.min(
                    (record.rain / adjustedThreshold),
                    (record.rain / (monthlyAverage * 0.5))
                );
                totalRecharge += record.rain * rechargeWeight;

                // Track monthly efficiency
                monthlyEfficiencies[month] = monthlyEfficiencies[month] || { total: 0, count: 0 };
                monthlyEfficiencies[month].total += rechargeWeight;
                monthlyEfficiencies[month].count++;
            }
        });

        // Calculate average monthly efficiency
        const monthlyEfficiencyAvg = monthlyEfficiencies
            .filter(Boolean)
            .reduce((avg, month) => avg + (month.total / month.count), 0) /
            monthlyEfficiencies.filter(Boolean).length || 0;

        // Combine both overall and monthly efficiency
        const overallEfficiency = totalRainfall === 0 ? 0.01 : totalRecharge / totalRainfall;
        const finalEfficiency = monthlyEfficiencyAvg > 0
            ? (overallEfficiency * 0.7) + (monthlyEfficiencyAvg * 0.3)
            : overallEfficiency;

        return Math.min(Math.max(finalEfficiency, 0.01), 1);
    }

    static async calculateReliabilityScores(metrics) {
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

    // Class-level cache for geology scores
    static geologyScoreCache = new Map();

    /**
     * Calculates the success probability for borehole drilling at the given location.
     * @param {Object} stats - Statistics about the location.
     * @param {Object|null} geologicalFormations - Geological formation data (optional).
     * @param {Object} precipitationAnalysis - Precipitation analysis data.
     * @returns {number} Success probability as a percentage (0-100), where:
     *   - 0-30: Low probability of success
     *   - 31-60: Moderate probability of success
     *   - 61-100: High probability of success
     */
    static async calculateSuccessProbability(stats, geologicalFormations = null, precipitationAnalysis) {
        // Extract coordinates using the helper method
        const coordinates = this.extractCentroidCoordinates(stats);
        if (!coordinates) {
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
            // Check cache for geology score
            const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
            let geologyScore;

            if (this.geologyScoreCache.has(cacheKey)) {
                geologyScore = this.geologyScoreCache.get(cacheKey);
            } else {
                geologyScore = await this.calculateGeologyScore(lat, lon);
                this.geologyScoreCache.set(cacheKey, geologyScore);
            }

            // Validate precipitation analysis data
            const precipScore = precipitationAnalysis &&
                precipitationAnalysis.reliabilityScores &&
                typeof precipitationAnalysis.reliabilityScores.overall === 'number'
                ? precipitationAnalysis.reliabilityScores.overall
                : 0.5; // Default value if data is missing

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

            // More granular error handling
            if (error.message.includes('network') || error.code === 'ECONNREFUSED') {
                logger.warn('Network error during probability calculation');
                return 45; // Slightly lower confidence for network issues
            } else if (error.message.includes('geology') || error.message.includes('lithological')) {
                logger.warn('Geology data error during probability calculation');
                return 40; // Lower confidence for geology data issues
            } else if (error.message.includes('precipitation')) {
                logger.warn('Precipitation data error during probability calculation');
                return 42; // Specific value for precipitation data issues
            }

            return 50; // Default probability on other errors
        }
    }

    /**
     * Extracts centroid coordinates from the stats object.
     * @param {Object} stats - The stats object containing area information.
     * @returns {Array|null} - An array of [longitude, latitude] or null if extraction fails.
     */
    static extractCentroidCoordinates(stats) {
        if (!stats.area || !stats.area.coordinates_ ||
            !Array.isArray(stats.area.coordinates_) ||
            stats.area.coordinates_[0].length === 0) {
            return null;
        }

        try {
            const polygon = turf.polygon(stats.area.coordinates_);
            const centroid = turf.centroid(polygon);
            return centroid.geometry.coordinates;
        } catch (error) {
            logger.error("Error calculating centroid:", error);
            return null;
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
                elevationProfile: AgriculturalLandAnalyzer.FIELD_ELEVATION.MEAN, //this.calculateElevationScore(combinedData.elevationData),
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
        //const slopes = elevationData.map(point => point.slope || 0);
        //const averageSlope = slopes.reduce((sum, slope) => sum + slope, 0) / slopes.length;
        
        // Lower slope is better for groundwater retention (normalized to 0-1 range)
        return Math.max(0, 1 - (this.FIELD_SLOPE / 45)); // Assume 45 degrees is the upper limit
    }

    /**
     * Estimates the total amount of water available in a given area.
     *
     * @param {ee.Geometry} polygon - The area of interest.
     * @param {Object} precipitationAnalysis - The analysis of precipitation data.
     * @param {number} soilPorosity - The soil porosity (a value between 0 and 1, indicating the fraction of soil volume that is pore space).
     * @param {number} aquiferThickness - The thickness of the aquifer in meters.
     * @param {number} specificYield - The specific yield of the aquifer (a value between 0 and 1, indicating the amount of water that can be drained by gravity).
     * @returns {Object} - An object containing the estimated total water available, including surface water, groundwater, and soil moisture.
     */
    static async estimateTotalWaterAvailability(polygon, precipitationAnalysis, soilPorosity = 0.4, aquiferThickness = 50, specificYield = 0.05) {
        try {
            // 1. Surface Water Estimation
            const surfaceWaterEstimation = await this.estimateSurfaceWater(polygon, precipitationAnalysis);

            // 2. Groundwater Estimation
            const groundwaterEstimation = await this.estimateGroundwater(polygon, precipitationAnalysis, aquiferThickness, specificYield);

            // 3. Soil Moisture Estimation
            const soilMoistureEstimation = await this.estimateSoilMoisture(polygon, soilPorosity);

            // Total Water Calculation
            const totalWaterAvailable = {
                surfaceWater: surfaceWaterEstimation,
                groundwater: groundwaterEstimation,
                soilMoisture: soilMoistureEstimation,
                units: 'cubic meters'  // Indicating units for clarity
            };

            // Structured logging for better monitoring
            logger.info('Total Water Availability Estimated:', totalWaterAvailable);

            return totalWaterAvailable;
        } catch (error) {
            logger.error('Error estimating total water availability:', error);
            throw new Error(`Failed to estimate total water availability: ${error.message}`);
        }
    }

    /**
     * Estimates the amount of surface water in a given area based on precipitation data.
     * @param {ee.Geometry} polygon - The area of interest.
     * @param {Object} precipitationAnalysis - The analysis of precipitation data.
     * @returns {number} - The estimated amount of surface water in cubic meters.
     */
    static async estimateSurfaceWater(polygon, precipitationAnalysis) {
        try {
            // Validate inputs
            if (!polygon) throw new Error('Polygon is required');
            if (!precipitationAnalysis) throw new Error('Precipitation analysis is required');

            // Extract relevant data from precipitation analysis
            const { annualMetrics } = precipitationAnalysis;

            // Check if annualMetrics is available
            if (!annualMetrics || annualMetrics.length === 0) {
                logger.warn('No annual metrics available for surface water estimation');
                return 0;
            }

            // Calculate average annual rainfall in meters
            const averageAnnualRainfall = annualMetrics.reduce((sum, metric) => sum + metric.totalRainfall, 0) / annualMetrics.length / 1000; // Convert mm to meters

            // Calculate the area of the polygon in square meters
            const areaSqM = polygon.area().getInfo();

            // Estimate surface water volume based on rainfall and area
            const runoffCoefficient = 0.3; // Assume 30% runoff (adjust based on land cover)
            const surfaceWaterVolume = averageAnnualRainfall * areaSqM * runoffCoefficient;

            logger.info('Surface water volume estimated:', {
                volume: surfaceWaterVolume,
                area: areaSqM,
                rainfall: averageAnnualRainfall
            });

            return surfaceWaterVolume;
        } catch (error) {
            logger.error('Error estimating surface water:', error);
            throw new Error(`Failed to estimate surface water: ${error.message}`);
        }
    }

    /**
     * Estimates the amount of groundwater in a given area.
     * @param {ee.Geometry} polygon - The area of interest.
     * @param {Object} precipitationAnalysis - The analysis of precipitation data.
     * @param {number} aquiferThickness - The thickness of the aquifer in meters.
     * @param {number} specificYield - The specific yield of the aquifer (a value between 0 and 1).
     * @returns {number} - The estimated amount of groundwater in cubic meters.
     */
    static async estimateGroundwater(polygon, precipitationAnalysis, aquiferThickness, specificYield) {
        try {
            // Validate inputs
            if (!polygon) throw new Error('Polygon is required');
            if (!precipitationAnalysis) throw new Error('Precipitation analysis is required');
            if (aquiferThickness <= 0) throw new Error('Aquifer thickness must be greater than 0');
            if (specificYield <= 0 || specificYield >= 1) throw new Error('Specific yield must be between 0 and 1');

            // Extract relevant data from precipitation analysis
            const { rechargePatterns } = precipitationAnalysis;

            // Check if rechargePatterns is available
            if (!rechargePatterns || !rechargePatterns.totalRechargeEvents) {
                logger.warn('No recharge patterns available for groundwater estimation');
                return 0;
            }

            // Get the area of the polygon in square meters
            const areaSqM = polygon.area().getInfo();

            // Estimate groundwater recharge volume (in cubic meters)
            const rechargeVolume = rechargePatterns.totalRechargeEvents * aquiferThickness * specificYield * areaSqM;

            logger.info('Groundwater volume estimated:', {
                volume: rechargeVolume,
                area: areaSqM,
                aquiferThickness,
                specificYield
            });

            return rechargeVolume;
        } catch (error) {
            logger.error('Error estimating groundwater:', error);
            throw new Error(`Failed to estimate groundwater: ${error.message}`);
        }
    }

    /**
     * Estimates the amount of soil moisture in a given area.
     * @param {ee.Geometry} polygon - The area of interest.
     * @param {number} soilPorosity - The soil porosity (a value between 0 and 1).
     * @returns {number} - The estimated amount of soil moisture in cubic meters.
     */
    static async estimateSoilMoisture(polygon, soilPorosity) {
        try {
            // Validate inputs
            if (!polygon) throw new Error('Polygon is required');
            if (soilPorosity <= 0 || soilPorosity >= 1) throw new Error('Soil porosity must be between 0 and 1');

            // Get the area of the polygon in square meters
            const areaSqM = polygon.area().getInfo();

            // Assume a soil depth of 1 meter for this estimation
            const soilDepth = 1; // meters

            // Estimate soil moisture volume (in cubic meters)
            const soilMoistureVolume = areaSqM * soilDepth * soilPorosity;

            logger.info('Soil moisture volume estimated:', {
                volume: soilMoistureVolume,
                area: areaSqM,
                soilDepth,
                soilPorosity
            });

            return soilMoistureVolume;
        } catch (error) {
            logger.error('Error estimating soil moisture:', error);
            throw new Error(`Failed to estimate soil moisture: ${error.message}`);
        }
    }

}

module.exports = BoreholeSiteService;