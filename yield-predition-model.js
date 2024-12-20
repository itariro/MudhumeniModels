const { RandomForestRegressor } = require('ml-random-forest');
const { GradientBoostingRegressor } = require('ml-xgboost');

class YieldPredictionModel {
    constructor(options = {}) {
        this.data = [];
        this.models = {};
        this.modelConfig = {
            randomForest: {
                nEstimators: options.rfEstimators || 100,
                maxDepth: options.rfMaxDepth || 12,
                minSamplesSplit: options.rfMinSamplesSplit || 5,
                seed: options.seed || 42
            },
            gradientBoosting: {
                learningRate: options.gbLearningRate || 0.1,
                nEstimators: options.gbEstimators || 100,
                maxDepth: options.gbMaxDepth || 6,
                seed: options.seed || 42
            }
        };
        this.featureCache = new Map();
        this.rollingWindowSize = options.rollingWindowSize || 7;
        this.selectedFeatures = new Map();
    }

    // Mean Squared Error
    meanSquaredError(trueValues, predictedValues) {
        const errors = trueValues.map((t, i) => t - predictedValues[i]);
        const squaredErrors = errors.map(e => e * e);
        return squaredErrors.reduce((sum, val) => sum + val, 0) / squaredErrors.length;
    }

    // R² Score
    r2Score(trueValues, predictedValues) {
        const meanTrue = this.mean(trueValues);
        let ssRes = 0;
        let ssTot = 0;
        for (let i = 0; i < trueValues.length; i++) {
            ssRes += (trueValues[i] - predictedValues[i]) ** 2;
            ssTot += (trueValues[i] - meanTrue) ** 2;
        }
        return 1 - (ssRes / ssTot);
    }

    // Cross-Validation Implementation
    async crossValidate(fieldId, historicalData, cropType, k = 5) {
        const shuffled = this.shuffle([...historicalData]);
        const foldSize = Math.floor(shuffled.length / k);
        const scores = [];

        for (let i = 0; i < k; i++) {
            const testData = shuffled.slice(i * foldSize, (i + 1) * foldSize);
            const trainData = [
                ...shuffled.slice(0, i * foldSize),
                ...shuffled.slice((i + 1) * foldSize)
            ];

            await this.trainModel(fieldId, trainData, cropType);
            const score = await this.evaluateModel(fieldId, cropType, testData);
            scores.push(score);
        }

        return {
            meanRMSE: this.mean(scores.map(s => s.rmse)),
            meanR2: this.mean(scores.map(s => s.r2)),
            stdRMSE: this.standardDeviation(scores.map(s => s.rmse)),
            folds: scores
        };
    }

    // Evaluate Model
    async evaluateModel(fieldId, cropType, testData) {
        const predictions = [];
        const actuals = [];

        for (const data of testData) {
            const result = await this.predictYieldEnsemble(fieldId, data, cropType);
            predictions.push(result.prediction);
            actuals.push(data.yield);
        }

        const mse = this.meanSquaredError(actuals, predictions);
        const rmse = Math.sqrt(mse);
        const r2 = this.r2Score(actuals, predictions);

        return { rmse, r2 };
    }

    // Feature Selection Implementation
    selectTopFeatures(features, labels, numFeatures = 10) {
        const correlations = features[0].map((_, featureIndex) => {
            const featureValues = features.map(row => row[featureIndex]);
            return {
                feature: featureIndex,
                correlation: Math.abs(this.pearsonCorrelation(featureValues, labels))
            };
        });

        return correlations
            .sort((a, b) => b.correlation - a.correlation)
            .slice(0, numFeatures)
            .map(item => item.feature);
    }

    pearsonCorrelation(x, y) {
        const meanX = this.mean(x);
        const meanY = this.mean(y);

        let numerator = 0;
        let denomX = 0;
        let denomY = 0;
        for (let i = 0; i < x.length; i++) {
            numerator += (x[i] - meanX) * (y[i] - meanY);
            denomX += (x[i] - meanX)**2;
            denomY += (y[i] - meanY)**2;
        }

        const denom = Math.sqrt(denomX) * Math.sqrt(denomY);
        if (denom === 0) return 0;
        return numerator / denom;
    }

    // Enhanced Ensemble Implementation
    async predictYieldEnsemble(fieldId, dailyData, cropType) {
        const modelEntries = Object.entries(this.models[fieldId]?.[cropType] || {});
        const predictions = await Promise.all(
            modelEntries.map(async ([modelType, modelInfo]) => {
                const prediction = await this.predictYield(fieldId, dailyData, cropType, modelType);
                const weight = this.calculateModelWeight(modelInfo);
                return { prediction, weight };
            })
        );

        if (predictions.length === 0) {
            throw new Error('No models available for ensemble prediction');
        }

        const totalWeight = predictions.reduce((sum, p) => sum + p.weight, 0);
        const weightedPrediction = predictions.reduce(
            (sum, p) => sum + p.prediction.prediction * p.weight, 0
        ) / totalWeight;

        const confidenceScores = predictions.map(p => p.prediction.confidence);

        return {
            prediction: weightedPrediction,
            confidence: this.mean(confidenceScores),
            modelWeights: predictions.map(p => p.weight / totalWeight),
            timestamp: new Date()
        };
    }

    calculateModelWeight(modelInfo) {
        const daysSinceTraining = (new Date() - modelInfo.trainedAt) / (1000 * 60 * 60 * 24);
        const performanceScore = 1 / (modelInfo.lastRMSE || 1);
        return performanceScore * Math.exp(-daysSinceTraining / 365); // Decay over a year
    }

    // Time Series Features Implementation
    calculateRollingFeatures(dailyData) {
        const window = this.rollingWindowSize;
        const historicalData = this.data
            .filter(d => d.fieldId === dailyData.fieldId)
            .slice(-window);

        // Include current day's data
        historicalData.push(dailyData);

        const features = {
            rollingTempMean: null,
            rollingTempStd: null,
            rollingMoistureMean: null,
            rollingMoistureStd: null,
            rollingNDVIMean: null,
            rollingNDVITrend: null,
            temperatureTrend: null,
            moistureTrend: null
        };

        if (historicalData.length > 1) {
            const temps = historicalData.map(d => (d.weather.weather_current.main.temp - 273.15));
            const moistures = historicalData.map(d => d.soil.moisture);
            const ndviValues = historicalData.map(d => d.ndvi.data.mean);

            features.rollingTempMean = this.mean(temps);
            features.rollingTempStd = this.standardDeviation(temps);
            features.rollingMoistureMean = this.mean(moistures);
            features.rollingMoistureStd = this.standardDeviation(moistures);
            features.rollingNDVIMean = this.mean(ndviValues);
            features.rollingNDVITrend = this.calculateTrend(ndviValues);
            features.temperatureTrend = this.calculateTrend(temps);
            features.moistureTrend = this.calculateTrend(moistures);
        }

        return features;
    }

    // Compute Features
    computeFeatures(dailyData) {
        // Ensure date is a Date object
        const dateObj = new Date(dailyData.date);
        const cacheKey = `${dailyData.fieldId}-${dateObj.getTime()}`;
        if (this.featureCache.has(cacheKey)) {
            return this.featureCache.get(cacheKey);
        }

        const baseFeatures = {
            ...this.processNDVI(dailyData.ndvi),
            ...this.processWeather(dailyData.weather),
            ...this.processSoil(dailyData.soil),
            ...this.calculateRollingFeatures(dailyData),
            ...this.extractSeasonalFeatures(dateObj),
            uvIndex: dailyData.uvi.uvi
        };

        const features = this.selectedFeatures.has(dailyData.fieldId)
            ? this.filterSelectedFeatures(baseFeatures, dailyData.fieldId)
            : baseFeatures;

        this.featureCache.set(cacheKey, features);
        return features;
    }

    filterSelectedFeatures(features, fieldId) {
        const selectedIndices = this.selectedFeatures.get(fieldId);
        if (!selectedIndices) return features;

        const keys = Object.keys(features);
        const values = Object.values(features);
        const filtered = {};
        for (const idx of selectedIndices) {
            filtered[keys[idx]] = values[idx];
        }
        return filtered;
    }

    // Enhanced Training with Feature Selection
    async trainModel(fieldId, historicalData, cropType, modelType = 'randomForest') {
        try {
            // Append new historical data to the global store
            this.data = this.data.concat(historicalData);

            const features = [];
            const labels = [];

            for (const entry of historicalData) {
                try {
                    // Convert date if needed
                    if (!(entry.date instanceof Date)) {
                        entry.date = new Date(entry.date);
                    }
                    const computedFeatures = Object.values(this.computeFeatures(entry));
                    features.push(computedFeatures);
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
                topFeatures.map(index => f[index])
            );

            let model;
            switch (modelType) {
                case 'randomForest':
                    model = new RandomForestRegressor(this.modelConfig.randomForest);
                    break;
                case 'gradientBoosting':
                    model = new GradientBoostingRegressor(this.modelConfig.gradientBoosting);
                    break;
                default:
                    throw new Error(`Invalid model type: ${modelType}`);
            }

            await model.train(selectedFeatures, labels);

            if (!this.models[fieldId]) this.models[fieldId] = {};
            if (!this.models[fieldId][cropType]) this.models[fieldId][cropType] = {};

            const validationData = historicalData.slice(-Math.floor(historicalData.length * 0.2));
            const validation = await this.evaluateModel(fieldId, cropType, validationData);

            this.models[fieldId][cropType][modelType] = {
                model,
                trainedAt: new Date(),
                featureImportance: this.calculateFeatureImportance(model, selectedFeatures),
                lastRMSE: validation.rmse,
                selectedFeatures: topFeatures
            };

            return {
                success: true,
                validation,
                selectedFeatures: topFeatures
            };
        } catch (error) {
            console.error(`Training error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // Predict Yield for a Single Model
    async predictYield(fieldId, dailyData, cropType, modelType = 'randomForest') {
        const featuresObject = this.computeFeatures(dailyData);
        const modelInfo = this.models[fieldId]?.[cropType]?.[modelType];
        if (!modelInfo) {
            throw new Error(`Model not found for ${fieldId}, ${cropType}, ${modelType}`);
        }

        const selectedFeatures = modelInfo.selectedFeatures;
        const allFeatures = Object.values(featuresObject);
        const finalFeatures = selectedFeatures.map(i => allFeatures[i]);

        const prediction = modelInfo.model.predict([finalFeatures])[0];
        // Confidence can be a placeholder value or derived from model (if available)
        return { prediction, confidence: 0.9 };
    }

    // Placeholder for feature importance calculation
    calculateFeatureImportance(model, selectedFeatures) {
        // If model supports feature importance, return it. Otherwise, return empty array.
        // For example, RandomForestRegressor might have model.featureImportances_
        return model.featureImportances_ || [];
    }

    // Placeholder for NDVI processing
    processNDVI(ndviData) {
        return { ndviMean: ndviData.data.mean };
    }

    // Placeholder for Weather processing
    processWeather(weatherData) {
        const tempC = weatherData.weather_current.main.temp - 273.15;
        return { temperature: tempC };
    }

    // Placeholder for Soil processing
    processSoil(soilData) {
        return { soilMoisture: soilData.moisture };
    }

    // Placeholder for Seasonal feature extraction
    extractSeasonalFeatures(date) {
        const month = date.getMonth() + 1;
        return { monthIndicator: month };
    }

    // Utility Methods
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
}

module.exports = YieldPredictionModel;