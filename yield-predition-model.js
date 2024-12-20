const { RandomForestRegressor } = require('ml-random-forest');
const { GradientBoostingRegressor } = require('ml-xgboost');
const fs = require('fs');

/**
 * Safely get a nested property from an object using an array of keys.
 * @param {Object} obj - The object to retrieve the value from.
 * @param {string[]} keys - Array of property names to follow.
 * @returns {*}
 */
function getNestedValue(obj, keys) {
    return keys.reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

/**
 * @typedef {Object} ModelConfig
 * @property {Object} randomForest - Random Forest configuration
 * @property {Object} gradientBoosting - Gradient Boosting configuration
 */

/**
 * @typedef {Object} PredictionResult
 * @property {number} prediction - Predicted yield value
 * @property {number} confidence - Confidence score
 * @property {Array<number>} modelWeights - Weights of each model in ensemble
 * @property {Date} timestamp - Prediction timestamp
 */

class YieldPredictionModel {
    constructor(configPath, version = '1.0.0') {
        this.version = version;
        this.modelConfig = this.loadModelConfig(configPath);
        this.models = {};
        this.selectedFeatures = new Map();
        this.maxCacheSize = 1000;
        this.featureCache = new Map();
        this.data = [];
    }

    /**
     * Loads model configuration from file or uses defaults
     * @param {string} configPath 
     * @returns {ModelConfig}
     */
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
                nEstimators: 100,
                maxDepth: 12,
                minSamplesSplit: 5,
                seed: 42
            },
            gradientBoosting: {
                learningRate: 0.1,
                nEstimators: 100,
                maxDepth: 6,
                seed: 42
            }
        };
    }

    /**
     * Validates daily data structure
     * @param {Object} dailyData 
     * @throws {Error} If data structure is invalid
     */
    validateDailyData(dailyData) {
        const requiredFields = [
            ['fieldId'],
            ['date'],
            ['ndvi', 'data', 'mean'],
            ['weather', 'weather_current', 'main', 'temp'],
            ['soil', 'moisture'],
            ['uvi', 'uvi']
        ];

        for (const fieldPath of requiredFields) {
            const value = getNestedValue(dailyData, fieldPath);
            if (value === undefined) {
                throw new Error(`Missing required field: ${fieldPath.join('.')}`);
            }
        }
    }

    /**
     * Trains machine learning models with feature selection
     * @param {string} fieldId 
     * @param {Array} historicalData 
     * @param {string} cropType 
     * @param {string} modelType 
     * @returns {Promise<Object>}
     */
    async trainModel(fieldId, historicalData, cropType, modelType = 'randomForest') {
        try {
            if (!historicalData || historicalData.length === 0) {
                throw new Error('No historical data provided');
            }

            this.validateDailyData(historicalData[0]); // Validate data structure
            this.data = this.data.concat(historicalData);

            const features = [];
            const labels = [];

            // Process features for all historical data
            for (const entry of historicalData) {
                try {
                    const computedFeatures = this.computeFeatures(entry);
                    features.push(Object.values(computedFeatures));
                    labels.push(entry.yield);
                } catch (error) {
                    console.warn(`Skipping invalid entry: ${error.message}`);
                }
            }

            if (features.length === 0) {
                throw new Error('No valid training data after preprocessing');
            }

            // Perform feature selection
            const topFeatures = this.selectTopFeatures(features, labels);
            this.selectedFeatures.set(fieldId, topFeatures);

            // Filter features based on selection
            const selectedFeatures = features.map(f =>
                topFeatures
                    .map(index => f[index])
                    .filter(val => val !== undefined)
            );

            // Initialize and train the appropriate model
            let model;
            switch (modelType) {
                case 'randomForest':
                    model = new RandomForestRegressor({
                        ...this.modelConfig.randomForest,
                        nEstimators: this.modelConfig.randomForest.nEstimators,
                        maxDepth: this.modelConfig.randomForest.maxDepth,
                        minSamplesSplit: this.modelConfig.randomForest.minSamplesSplit,
                        seed: this.modelConfig.randomForest.seed
                    });
                    await model.train(selectedFeatures, labels);
                    break;

                case 'gradientBoosting':
                    model = new GradientBoostingRegressor({
                        ...this.modelConfig.gradientBoosting,
                        learningRate: this.modelConfig.gradientBoosting.learningRate,
                        nEstimators: this.modelConfig.gradientBoosting.nEstimators,
                        maxDepth: this.modelConfig.gradientBoosting.maxDepth,
                        seed: this.modelConfig.gradientBoosting.seed
                    });
                    await model.train(selectedFeatures, labels);
                    break;

                default:
                    throw new Error(`Invalid model type: ${modelType}`);
            }

            // Initialize model storage structure if needed
            if (!this.models[fieldId]) this.models[fieldId] = {};
            if (!this.models[fieldId][cropType]) this.models[fieldId][cropType] = {};

            // Calculate validation metrics
            let validationData = historicalData.slice(-Math.floor(historicalData.length * 0.2));
            if (validationData.length < 1) {
                // If not enough data for validation, fallback to last entry
                validationData = [historicalData[historicalData.length - 1]];
            }
            const validation = await this.evaluateModel(fieldId, cropType, validationData);

            // Store model with metadata
            this.models[fieldId][cropType][modelType] = {
                model,
                trainedAt: new Date(),
                featureImportance: this.calculateFeatureImportance(model, selectedFeatures, topFeatures, labels),
                lastRMSE: validation.rmse,
                selectedFeatures: topFeatures
            };

            return {
                success: true,
                validation,
                selectedFeatures: topFeatures,
                featureImportance: this.models[fieldId][cropType][modelType].featureImportance
            };

        } catch (error) {
            console.error(`Training error: ${error.message}`);
            throw new Error(`Model training failed: ${error.message}`);
        }
    }

    /**
     * Predict yield using trained model
     * @param {string} fieldId 
     * @param {Object} dailyData 
     * @param {string} cropType 
     * @param {string} modelType 
     * @returns {Promise<Object>}
     */
    async predictYield(fieldId, dailyData, cropType, modelType = 'randomForest') {
        try {
            this.validateDailyData(dailyData);
            const featuresObject = this.computeFeatures(dailyData);
            const modelInfo = this.models[fieldId]?.[cropType]?.[modelType];

            if (!modelInfo) {
                throw new Error(`Model not found for ${fieldId}, ${cropType}, ${modelType}`);
            }

            const selectedFeatures = modelInfo.selectedFeatures;
            const allFeatures = Object.values(featuresObject);
            const finalFeatures = selectedFeatures
                .map(i => allFeatures[i])
                .filter(val => val !== undefined);

            const prediction = modelInfo.model.predict([finalFeatures])[0];

            // Calculate prediction confidence based on model type
            const confidence = this.calculatePredictionConfidence(
                modelInfo.model,
                finalFeatures,
                prediction,
                modelType
            );

            return { prediction, confidence };
        } catch (error) {
            throw new Error(`Prediction failed: ${error.message}`);
        }
    }

    /**
     * Calculate prediction confidence based on model type
     * @param {Object} model 
     * @param {Array} features 
     * @param {number} prediction 
     * @param {string} modelType 
     * @returns {number}
     */
    calculatePredictionConfidence(model, features, prediction, modelType) {
        if (modelType === 'randomForest' && model instanceof RandomForestRegressor) {
            // For Random Forest, use the variance of tree predictions
            const treePredictions = model.predictTree([features]);
            const variance = this.calculateVariance(treePredictions);
            return 1 / (1 + variance);
        } else if (modelType === 'gradientBoosting') {
            // For Gradient Boosting, use the model's native confidence score if available
            return model.predictConfidence ? model.predictConfidence([features])[0] : 0.9;
        }

        return 0.9; // Default confidence if no better metric available
    }

    /**
     * Calculate variance for array of predictions
     * @param {Array} predictions 
     * @returns {number}
     */
    calculateVariance(predictions) {
        const mean = this.mean(predictions);
        const squaredDiffs = predictions.map(p => Math.pow(p - mean, 2));
        return this.mean(squaredDiffs);
    }

    /**
     * Calculate feature importance with proper model support
     * @param {Object} model 
     * @param {Array} features 
     * @param {Array} featureIndices 
     * @param {Array} labels
     * @returns {Array}
     */
    calculateFeatureImportance(model, features, featureIndices, labels) {
        if (model instanceof RandomForestRegressor) {
            // Random Forest provides feature importance directly
            return model.featureImportances_;
        } else if (model instanceof GradientBoostingRegressor) {
            // For XGBoost, feature importance is available through the model
            return model.featureImportance();
        }

        // Fallback: Calculate permutation importance
        return this.calculatePermutationImportance(model, features, featureIndices, labels);
    }

    /**
     * Calculate permutation importance when direct importance not available
     * @param {Object} model 
     * @param {Array} features 
     * @param {Array} featureIndices 
     * @param {Array} labels
     * @returns {Array}
     */
    calculatePermutationImportance(model, features, featureIndices, labels) {
        const baselinePredictions = model.predict(features);
        const baselineMSE = this.meanSquaredError(baselinePredictions, labels);

        return featureIndices.map(featureIndex => {
            const permutedFeatures = features.map(row => [...row]);
            const featureColumn = permutedFeatures.map(row => row[featureIndex]);
            this.shuffle(featureColumn);

            permutedFeatures.forEach((row, i) => {
                row[featureIndex] = featureColumn[i];
            });

            const permutedPredictions = model.predict(permutedFeatures);
            const permutedMSE = this.meanSquaredError(permutedPredictions, labels);

            return permutedMSE - baselineMSE;
        });
    }

    /**
     * Evaluate model on validation data
     * @param {string} fieldId 
     * @param {string} cropType 
     * @param {Array} validationData 
     * @returns {Promise<Object>}
     */
    async evaluateModel(fieldId, cropType, validationData) {
        // A simple evaluation logic for demonstration
        const modelTypes = Object.keys(this.models[fieldId][cropType]);
        if (modelTypes.length === 0) {
            return { rmse: null };
        }

        // Use the specified model type for evaluation or pick one if multiple exist
        const modelType = modelTypes[0];
        const modelInfo = this.models[fieldId][cropType][modelType];

        const features = [];
        const labels = [];

        for (const entry of validationData) {
            try {
                const computedFeatures = this.computeFeatures(entry);
                const allFeatures = Object.values(computedFeatures);
                const finalFeatures = modelInfo.selectedFeatures
                    .map(i => allFeatures[i])
                    .filter(val => val !== undefined);

                features.push(finalFeatures);
                labels.push(entry.yield);
            } catch (error) {
                console.warn(`Validation entry skipped: ${error.message}`);
            }
        }

        if (features.length === 0) {
            return { rmse: null }; // No valid validation data
        }

        const predictions = modelInfo.model.predict(features);
        const mse = this.meanSquaredError(predictions, labels);
        const rmse = Math.sqrt(mse);
        return { rmse };
    }

    /**
     * Adds feature data to cache with size management
     * @param {string} key 
     * @param {Object} value 
     */
    addToCache(key, value) {
        if (this.featureCache.size >= this.maxCacheSize) {
            const oldestKey = this.featureCache.keys().next().value;
            this.featureCache.delete(oldestKey);
        }
        this.featureCache.set(key, value);
    }

    /**
     * Compute features from a single day's data
     * @param {Object} dailyData
     * @returns {Object}
     */
    computeFeatures(dailyData) {
        const key = dailyData.fieldId + '_' + dailyData.date;
        if (this.featureCache.has(key)) {
            return this.featureCache.get(key);
        }

        const ndviFeatures = this.processNDVI(dailyData.ndvi);
        const weatherFeatures = this.processWeather(dailyData);
        const soilFeatures = this.processSoil(dailyData.soil);
        const date = new Date(dailyData.date);
        const seasonalFeatures = this.extractSeasonalFeatures(date);

        const features = {
            ...ndviFeatures,
            ...weatherFeatures,
            ...soilFeatures,
            yieldTrend: this.calculateYieldTrend(this.data, dailyData.fieldId),
            ...seasonalFeatures
        };

        this.addToCache(key, features);
        return features;
    }

    /**
     * Process NDVI data with comprehensive vegetation analysis
     * @param {Object} ndviData 
     * @returns {Object}
     */
    processNDVI(ndviData) {
        const { mean, min, max } = ndviData.data;
        const range = max - min;
        const normalizedNDVI = range !== 0 ? (mean - min) / range : 0;

        return {
            ndviMean: mean,
            ndviNormalized: normalizedNDVI,
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
     * Process weather data with advanced metrics
     * @param {Object} dailyData 
     * @returns {Object}
     */
    processWeather(dailyData) {
        const { temp, humidity, pressure } = dailyData.weather.weather_current.main;
        const tempC = temp - 273.15;
        const dewPoint = this.calculateDewPoint(tempC, humidity);
        const heatIndex = this.calculateHeatIndex(tempC, humidity);

        return {
            temperature: tempC,
            humidity,
            pressure,
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

    /**
     * Serialize model for storage
     * @returns {Object}
     */
    serializeModel() {
        return {
            models: this.models,
            selectedFeatures: Array.from(this.selectedFeatures.entries()),
            version: this.version,
            timestamp: new Date()
        };
    }

    /**
     * Load serialized model
     * @param {Object} serializedData 
     */
    loadSerializedModel(serializedData) {
        if (serializedData.version !== this.version) {
            throw new Error(`Version mismatch: expected ${this.version}, got ${serializedData.version}`);
        }

        this.models = serializedData.models;
        this.selectedFeatures = new Map(serializedData.selectedFeatures);
    }

    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    mean(array) {
        return array.reduce((sum, val) => sum + val, 0) / array.length;
    }

    standardDeviation(array) {
        const avg = this.mean(array);
        const squareDiffs = array.map(value => (value - avg) ** 2);
        return Math.sqrt(this.mean(squareDiffs));
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

    /**
     * Calculate MSE
     * @param {Array<number>} predictions 
     * @param {Array<number>} labels 
     * @returns {number}
     */
    meanSquaredError(predictions, labels) {
        const n = labels.length;
        const diff = predictions.map((p, i) => (p - labels[i]) ** 2);
        return diff.reduce((a, b) => a + b, 0) / n;
    }

    /**
     * Calculate the yield trend for a fieldId from historical data
     * @param {Array} data 
     * @param {string} fieldId 
     * @returns {number}
     */
    calculateYieldTrend(data, fieldId) {
        const fieldData = data.filter(d => d.fieldId === fieldId && d.yield !== undefined);
        fieldData.sort((a, b) => new Date(a.date) - new Date(b.date));
        const yields = fieldData.map(d => d.yield);
        return this.calculateTrend(yields);
    }

    /**
     * Selects the top N features based on feature importance using Random Forest.
     * @param {Array<Array<number>>} features The feature matrix.
     * @param {Array<number>} labels The target variable.
     * @param {number} [numTopFeatures=10] The number of top features to select.
     * @returns {Array<number>} An array of indices representing the selected features.
     */
    selectTopFeatures(features, labels, numTopFeatures = 10) {
        try {
            if (!features || !labels || features.length === 0 || labels.length === 0) {
                throw new Error("Invalid input data for feature selection.");
            }
            if (features.length !== labels.length) {
                throw new Error("Mismatched lengths of features and labels");
            }

            const rf = new RandomForestRegressor({
                ...this.modelConfig.randomForest,
                nEstimators: this.modelConfig.randomForest.nEstimators * 2, // Use more trees for feature selection
                maxDepth: this.modelConfig.randomForest.maxDepth,
                minSamplesSplit: this.modelConfig.randomForest.minSamplesSplit,
                seed: this.modelConfig.randomForest.seed
            });
            rf.train(features, labels);

            const featureImportances = rf.featureImportances_;

            // Create an array of feature indices with their importances
            const featureIndicesWithImportance = featureImportances.map((importance, index) => ({
                index,
                importance
            }));

            // Sort features by importance in descending order
            featureIndicesWithImportance.sort((a, b) => b.importance - a.importance);

            // Select the top N features
            const selectedFeatureIndices = featureIndicesWithImportance
                .slice(0, Math.min(numTopFeatures, features[0].length))
                .map(feature => feature.index);

            return selectedFeatureIndices;
        } catch (error) {
            console.error(`Feature selection error: ${error.message}`);
            // Fallback: If anything goes wrong, return a default set of features
            return Array.from(Array(Math.min(numTopFeatures, features[0].length)).keys());
        }
    }
}

module.exports = YieldPredictionModel;