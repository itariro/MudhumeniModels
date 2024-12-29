const { RandomForestRegressor } = require('ml-random-forest');
const { GradientBoostingRegressor } = require('ml-xgboost');
const fs = require('fs');

/**
 * Utility function for safe access to nested object properties.
 */
function getNestedValue(obj, keys) {
    return keys.reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

/**
 * Main Yield Prediction Model Class with Extended Use Cases
 */
class YieldPredictionModel {
    constructor(configPath, version = '2.0.0') {
        this.version = version;
        this.modelConfig = this.loadModelConfig(configPath);
        this.models = {};
        this.selectedFeatures = new Map();
        this.maxCacheSize = 1000;
        this.featureCache = new Map();
        this.data = [];
    }

    loadModelConfig(configPath) {
        if (configPath && fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (error) {
                console.warn(`Failed to load config from ${configPath}, using defaults:`, error);
            }
        }
        return {
            randomForest: {
                nEstimators: 150,
                maxDepth: 15,
                minSamplesSplit: 5,
                seed: 42
            },
            gradientBoosting: {
                learningRate: 0.05,
                nEstimators: 200,
                maxDepth: 10,
                seed: 42
            }
        };
    }

    validateDailyData(dailyData) {
        const requiredFields = [
            ['fieldId'], ['date'], ['ndvi', 'data', 'mean'],
            ['weather', 'weather_current', 'main', 'temp'],
            ['soil', 'moisture'], ['uvi', 'uvi']
        ];
        for (const fieldPath of requiredFields) {
            const value = getNestedValue(dailyData, fieldPath);
            if (value === undefined) {
                throw new Error(`Missing required field: ${fieldPath.join('.')}`);
            }
        }
    }

    /**
     * Compute extended features including advanced vegetation indices and irrigation recommendations.
     */
    computeFeatures(dailyData) {
        const key = `${dailyData.fieldId}_${dailyData.date}`;
        if (this.featureCache.has(key)) return this.featureCache.get(key);

        const ndviFeatures = this.processNDVI(dailyData.ndvi);
        const weatherFeatures = this.processWeather(dailyData.weather.weather_current);
        const soilFeatures = this.processSoil(dailyData.soil);
        const cropHealth = this.calculateCropHealth(ndviFeatures.ndviMean, soilFeatures.soilMoisture);
        const irrigationAdvice = this.calculateIrrigation(soilFeatures.soilMoisture, weatherFeatures.temperature);
        const pestRisk = this.calculatePestRisk(weatherFeatures.humidity, cropHealth);
        const date = new Date(dailyData.date);
        const seasonalFeatures = this.extractSeasonalFeatures(date);

        const features = {
            ...ndviFeatures,
            ...weatherFeatures,
            ...soilFeatures,
            cropHealth,
            irrigationAdvice,
            pestRisk,
            yieldTrend: this.calculateYieldTrend(this.data, dailyData.fieldId),
            ...seasonalFeatures
        };
        this.addToCache(key, features);
        return features;
    }

    /**
     * Process NDVI and calculate multiple vegetation indices.
     */
    processNDVI(ndviData) {
        const { mean, min, max } = ndviData.data;
        const range = max - min;
        const normalizedNDVI = range !== 0 ? (mean - min) / range : 0;

        const ndvi = mean;
        const ndre = (max - min) / (max + min); // Example NDRE calculation
        const ccci = (ndre - 0.3) / (0.7 - 0.3); // Example CCCI normalization

        return {
            ndvi,
            ndre,
            ccci,
            ndviVariability: range,
            vegetationHealth: this.calculateVegetationHealth(mean)
        };
    }

    /**
     * Calculate vegetation health score
     * @param {number} ndviMean 
     * @returns {number}
     */
    calculateVegetationHealth(ndviMean) {
        // NDVI values typically range from -1 to 1
        // < 0: No vegetation
        // 0-0.33: Unhealthy vegetation
        // 0.33-0.66: Moderately healthy
        // > 0.66: Very healthy
        if (ndviMean < 0) return 0;
        if (ndviMean > 1) return 100;
        return (ndviMean / 1) * 100;
    }

    /**
     * Process weather data for temperature, humidity, and calculated metrics.
     */
    processWeather(weatherData) {
        const { temp, humidity } = weatherData;
        const tempC = temp - 273.15; // Convert Kelvin to Celsius
        const dewPoint = this.calculateDewPoint(tempC, humidity);
        const heatIndex = this.calculateHeatIndex(tempC, humidity);

        return {
            temperature: tempC,
            humidity,
            pressure: weatherData.pressure,
            dewPoint,
            heatIndex,
            growingDegreeDays: this.calculateGrowingDegreeDays(tempC)
        };
    }

    /**
     * Calculate dew point
     * @param {number} tempC 
     * @param {number} humidity 
     * @returns {number}
     */
    calculateDewPoint(tempC, humidity) {
        const a = 17.27;
        const b = 237.7;
        const alpha = ((a * tempC) / (b + tempC)) + Math.log(humidity / 100);
        return (b * alpha) / (a - alpha);
    }

    /**
     * Calculate heat index
     * @param {number} tempC 
     * @param {number} humidity 
     * @returns {number}
     */
    calculateHeatIndex(tempC, humidity) {
        const tempF = (tempC * 9 / 5) + 32;
        if (tempF < 80) return tempF;

        let index = -42.379 + (2.04901523 * tempF) + (10.14333127 * humidity);
        index -= (0.22475541 * tempF * humidity);
        index -= (6.83783 * Math.pow(10, -3) * tempF * tempF);
        index -= (5.481717 * Math.pow(10, -2) * humidity * humidity);
        index += (1.22874 * Math.pow(10, -3) * tempF * tempF * humidity);
        index += (8.5282 * Math.pow(10, -4) * tempF * humidity * humidity);
        index -= (1.99 * Math.pow(10, -6) * tempF * tempF * humidity * humidity);

        return (index - 32) * 5 / 9; // Convert back to Celsius
    }

    /**
     * Calculate growing degree days
     * @param {number} tempC 
     * @returns {number}
     */
    calculateGrowingDegreeDays(tempC) {
        const baseTemp = 10; // Base temperature for most crops
        return Math.max(0, tempC - baseTemp);
    }

    /**
     * Process soil data with comprehensive analysis
     * @param {Object} soilData 
     * @returns {Object}
     */
    processSoil(soilData) {
        const { moisture, temperature, ph, organic_matter } = soilData;

        return {
            soilMoisture: moisture,
            soilTemperature: temperature,
            soilPH: ph,
            organicMatter: organic_matter,
            soilProductivityIndex: this.calculateSoilProductivityIndex(soilData),
            moistureDeficit: this.calculateMoistureDeficit(moisture)
        };
    }

    /**
     * Calculate soil productivity index
     * @param {Object} soilData 
     * @returns {number}
     */
    calculateSoilProductivityIndex(soilData) {
        const { moisture, ph, organic_matter } = soilData;

        // Normalize each factor to 0-1 scale
        const moistureScore = this.normalize(moisture, 0, 100);
        const phScore = this.normalize(ph, 5.5, 7.5);
        const organicScore = this.normalize(organic_matter, 0, 10);

        // Weight factors based on importance
        return (moistureScore * 0.4 + phScore * 0.3 + organicScore * 0.3) * 100;
    }

    /**
     * Calculate moisture deficit
     * @param {number} moisture 
     * @returns {number}
     */
    calculateMoistureDeficit(moisture) {
        const optimalMoisture = 75; // Optimal soil moisture percentage
        return Math.max(0, optimalMoisture - moisture);
    }

    /**
     * Calculate irrigation advice based on soil and temperature data.
     */
    calculateIrrigation(soilMoisture, temperature) {
        const optimalMoisture = 75; // Optimal percentage
        if (soilMoisture < 50) return 'High irrigation needed';
        if (soilMoisture < 70 && temperature > 30) return 'Moderate irrigation needed';
        return 'No irrigation needed';
    }

    /**
     * Calculate crop health score using NDVI and soil data.
     */
    calculateCropHealth(ndviMean, soilMoisture) {
        const healthScore = (ndviMean * 0.7 + (soilMoisture / 100) * 0.3) * 100;
        return Math.min(100, healthScore);
    }

    /**
     * Calculate pest risk based on environmental conditions.
     */
    calculatePestRisk(humidity, cropHealth) {
        if (humidity > 70 && cropHealth < 50) return 'High pest risk';
        if (humidity > 50) return 'Moderate pest risk';
        return 'Low pest risk';
    }

    /**
     * Extract seasonal features with advanced metrics
     * @param {Date} date 
     * @returns {Object}
     */
    extractSeasonalFeatures(date) {
        const dayOfYear = this.getDayOfYear(date);
        const seasonalPhase = this.calculateSeasonalPhase(dayOfYear);

        return {
            dayOfYear,
            monthIndicator: date.getMonth() + 1,
            seasonalPhase,
            growingSeasonProgress: this.calculateGrowingSeasonProgress(dayOfYear),
            dayLength: this.calculateDayLength(date, 45) // Assuming latitude 45°N
        };
    }

    /**
     * Calculate day length
     * @param {Date} date 
     * @param {number} latitude 
     * @returns {number}
     */
    calculateDayLength(date, latitude) {
        const dayOfYear = this.getDayOfYear(date);
        const p = Math.asin(0.39795 * Math.cos(0.2163108 + 2 * Math.atan(0.9671396 * Math.tan(0.00860 * (dayOfYear - 186)))));
        const phi = latitude * (Math.PI / 180);

        return 24 - (24 / Math.PI) * Math.acos(
            (Math.sin(0.8333 * Math.PI / 180) + Math.sin(phi) * Math.sin(p)) /
            (Math.cos(phi) * Math.cos(p))
        );
    }

    /**
     * Calculate seasonal phase
     * @param {number} dayOfYear 
     * @returns {number}
     */
    calculateSeasonalPhase(dayOfYear) {
        return (Math.cos(2 * Math.PI * (dayOfYear / 365 - 0.5)) + 1) / 2;
    }

    /**
     * Calculate growing season progress
     * @param {number} dayOfYear 
     * @returns {number}
     */
    calculateGrowingSeasonProgress(dayOfYear) {
        // Assuming growing season is between day 90 (April 1) and 270 (September 27)
        const startDay = 90;
        const seasonLength = 180;

        if (dayOfYear < startDay) return 0;
        if (dayOfYear > startDay + seasonLength) return 1;

        return (dayOfYear - startDay) / seasonLength;
    }

    /**
     * Get day of year
     * @param {Date} date 
     * @returns {number}
     */
    getDayOfYear(date) {
        const start = new Date(date.getFullYear(), 0, 0);
        const diff = date - start;
        const oneDay = 1000 * 60 * 60 * 24;
        return Math.floor(diff / oneDay);
    }

    /**
     * Normalize value to 0-1 range
     * @param {number} value 
     * @param {number} min 
     * @param {number} max 
     * @returns {number}
     */
    normalize(value, min, max) {
        return Math.max(0, Math.min(1, (value - min) / (max - min)));
    }

    async trainModel(fieldId, historicalData, cropType, modelType = 'randomForest') {
        this.validateDailyData(historicalData[0]);
        const features = historicalData.map(d => this.computeFeatures(d));
        const labels = historicalData.map(d => d.yield);
        const model = modelType === 'randomForest'
            ? new RandomForestRegressor({ ...this.modelConfig.randomForest })
            : new GradientBoostingRegressor({ ...this.modelConfig.gradientBoosting });
        await model.train(features, labels);
        this.models[fieldId] = { model, cropType };
    }

    async predictYield(fieldId, dailyData) {
        this.validateDailyData(dailyData);
        const features = Object.values(this.computeFeatures(dailyData));
        const model = this.models[fieldId]?.model;
        if (!model) throw new Error('Model not found for fieldId');
        const prediction = model.predict([features])[0];
        return { prediction, timestamp: new Date() };
    }

    addToCache(key, value) {
        if (this.featureCache.size >= this.maxCacheSize) {
            const oldestKey = this.featureCache.keys().next().value;
            this.featureCache.delete(oldestKey);
        }
        this.featureCache.set(key, value);
    }

    calculateYieldTrend(data, fieldId) {
        const fieldData = data.filter(d => d.fieldId === fieldId && d.yield !== undefined);
        fieldData.sort((a, b) => new Date(a.date) - new Date(b.date));
        const yields = fieldData.map(d => d.yield);
        return this.calculateTrend(yields);
    }

    calculateTrend(array) {
        const n = array.length;
        if (n < 2) return 0;

        const xMean = (n - 1) / 2;
        const yMean = this.mean(array);

        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i < n; i++) {
            numerator += (i - xMean) * (array[i] - yMean);
            denominator += (i - xMean) ** 2;
        }

        return denominator !== 0 ? numerator / denominator : 0;
    }

    mean(array) {
        return array.reduce((sum, val) => sum + val, 0) / array.length;
    }
}

module.exports = YieldPredictionModel;