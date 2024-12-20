const { RandomForestRegressor } = require('ml-random-forest');
const { GradientBoostingRegressor } = require('ml-xgboost');
const fs = require('fs');

// Type definitions
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
    // ... previous constructor and methods remain the same ...

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
                topFeatures.map(index => f[index])
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
            const validationData = historicalData.slice(-Math.floor(historicalData.length * 0.2));
            const validation = await this.evaluateModel(fieldId, cropType, validationData);

            // Store model with metadata
            this.models[fieldId][cropType][modelType] = {
                model,
                trainedAt: new Date(),
                featureImportance: this.calculateFeatureImportance(model, selectedFeatures, topFeatures),
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
     * Calculate feature importance with proper model support
     * @param {Object} model 
     * @param {Array} features 
     * @param {Array} featureIndices 
     * @returns {Array}
     */
    calculateFeatureImportance(model, features, featureIndices) {
        if (model instanceof RandomForestRegressor) {
            // Random Forest provides feature importance directly
            return model.featureImportances_;
        } else if (model instanceof GradientBoostingRegressor) {
            // For XGBoost, feature importance is available through the model
            return model.featureImportance();
        }

        // Fallback: Calculate permutation importance
        return this.calculatePermutationImportance(model, features, featureIndices);
    }

    /**
     * Calculate permutation importance when direct importance not available
     * @param {Object} model 
     * @param {Array} features 
     * @param {Array} featureIndices 
     * @returns {Array}
     */
    calculatePermutationImportance(model, features, featureIndices) {
        const baselinePredictions = model.predict(features);
        const baselineMSE = this.meanSquaredError(baselinePredictions, labels);

        return featureIndices.map(featureIndex => {
            const permutedFeatures = features.map(row => [...row]);
            this.shuffle(permutedFeatures.map(row => row[featureIndex]));

            const permutedPredictions = model.predict(permutedFeatures);
            const permutedMSE = this.meanSquaredError(permutedPredictions, labels);

            return permutedMSE - baselineMSE;
        });
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
            const finalFeatures = selectedFeatures.map(i => allFeatures[i]);

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

    // ... rest of the previous methods remain the same ...
}

module.exports = YieldPredictionModel;