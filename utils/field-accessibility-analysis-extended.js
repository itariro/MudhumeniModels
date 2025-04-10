const turf = require('@turf/turf');
const axios = require('axios');
const dotenv = require('dotenv');
const Ajv = require('ajv');
const { LRUCache } = require('lru-cache');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const os = require('os');
const path = require('path');
const { orsSchema, overpassSchema } = require('../schemas/overpass.schema.js');

dotenv.config();

// Static configuration objects moved outside the class for better memory usage
const ROAD_RANKING = {
    motorway: 1,
    trunk: 0.9,
    primary: 0.8,
    secondary: 0.7,
    tertiary: 0.6,
    residential: 0.5,
    unclassified: 0.4,
    track: 0.3,
    path: 0.2,
    service: 0.4,
    default: 0.5
};

const ROAD_WEIGHTS = {
    surface_paved: 1.0,
    surface_asphalt: 1.0,
    surface_concrete: 0.9,
    surface_gravel: 0.6,
    surface_unpaved: 0.4,
    surface_dirt: 0.3,
    surface_grass: 0.2,
    width_wide: 1.0,
    width_medium: 0.7,
    width_narrow: 0.4,
    width_very_narrow: 0.2,
    default: 0.5
};

// Worker thread handler for CPU-intensive operations
if (!isMainThread) {
    const { operation, data } = workerData;

    // Define available operations
    const operations = {
        calculateHaversine: (params) => {
            const { lat1, lon1, lat2, lon2 } = params;
            const R = 6371e3;
            const φ1 = lat1 * Math.PI / 180;
            const φ2 = lat2 * Math.PI / 180;
            const Δφ = (lat2 - lat1) * Math.PI / 180;
            const Δλ = (lon2 - lon1) * Math.PI / 180;

            const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        },

        processHazards: (params) => {
            const { hazardData, weights } = params;
            // Process hazard data in parallel
            const bridgeRisk = Math.min(hazardData.bridges.length * weights.bridge, 1);
            const waterRisk = Math.min(hazardData.water.length * weights.water, 1);
            const landslideRisk = Math.min(hazardData.landslides.length * weights.landslide, 1);

            return (bridgeRisk + waterRisk + landslideRisk) / 3;
        },

        bufferGeometry: (params) => {
            const { geometry, bufferSize } = params;
            return turf.bbox(turf.buffer(geometry, bufferSize, { units: 'kilometers' }));
        },

        // Add any other CPU-intensive operations here
        calculateNearestDistance: (params) => {
            const { coordinates, elements } = params;
            let minDistance = Infinity;

            elements.forEach(element => {
                if (element.geometry) {
                    const line = turf.lineString(
                        element.geometry.map(p => [p.lon, p.lat])
                    );
                    const nearest = turf.nearestPointOnLine(
                        line,
                        turf.point([coordinates.lon, coordinates.lat])
                    );

                    if (nearest.properties.dist < minDistance) {
                        minDistance = nearest.properties.dist;
                    }
                }
            });

            return minDistance !== Infinity ? minDistance : -1;
        }
    };

    // Execute the requested operation and return the result
    if (operations[operation]) {
        const result = operations[operation](data);
        parentPort.postMessage(result);
    } else {
        parentPort.postMessage({ error: `Unknown operation: ${operation}` });
    }
}


class FarmRouteAnalyzer {
    constructor() {
        // Initialize Ajv validator with optimized settings
        this.ajv = new Ajv({
            strict: false,
            allErrors: false, // Only capture first error for performance
            validateFormats: false // Skip format validation for performance
        });
        this.orsValidator = this.ajv.compile(orsSchema);
        this.overpassValidator = this.ajv.compile(overpassSchema);

        // Centralized API configuration
        this.apiConfig = {
            ors: {
                url: process.env.ORS_URL || 'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
                apiKey: process.env.ORS_API_KEY,
                timeout: parseInt(process.env.ORS_TIMEOUT) || 10000
            },
            overpass: {
                url: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
                timeout: parseInt(process.env.OVERPASS_TIMEOUT) || 15000,
                bufferSize: parseFloat(process.env.OVERPASS_BUFFER) || 0.02, // km
            }
        };

        // Unified rate limiting system
        this.rateLimits = {
            default: {
                requests: parseInt(process.env.RATE_LIMIT) || 5,
                interval: 1000
            },
            hazard: {
                requests: 1,
                interval: 5000
            }
        };

        // Adaptive rate limiting
        this.rateLimitStats = {
            successCount: 0,
            failureCount: 0,
            lastAdjustment: Date.now()
        };

        // Single request queue map for all rate limit types
        this.requestQueues = new Map();

        // Unified caching system with LRU caches for different types of data
        this.caches = {
            routes: new LRUCache({
                max: parseInt(process.env.ROUTE_CACHE_MAX) || 50,
                ttl: 1000 * 60 * 60, // 1 hour expiration
                updateAgeOnGet: true // Refresh TTL on cache hits
            }),
            overpass: new LRUCache({
                max: parseInt(process.env.OVERPASS_CACHE_MAX) || 100,
                ttl: 1000 * 60 * 60 * 24, // 24 hours for spatial data
                updateAgeOnGet: true
            })
        };

        // Configure road and hazard metrics
        this.roadMetrics = {
            ranking: ROAD_RANKING,
            weights: ROAD_WEIGHTS,
            hazardWeights: {
                bridge: parseFloat(process.env.HAZARD_WEIGHT_BRIDGE) || 0.2,
                water: parseFloat(process.env.HAZARD_WEIGHT_WATER) || 0.1,
                landslide: parseFloat(process.env.HAZARD_WEIGHT_LANDSLIDE) || 0.3
            }
        };

        // Initialize worker pool for CPU-intensive operations
        this.workerPool = [];
        this.maxWorkers = Math.max(1, os.cpus().length - 1);
        this.workerFile = __filename;
        this.initializeWorkerPool();
    }

    /**
     * Initializes a pool of worker threads for parallel processing.
     * Creates worker threads based on the number of available CPU cores,
     * with each worker initially marked as not busy.
     * 
     * @private
     */
    initializeWorkerPool() {
        for (let i = 0; i < this.maxWorkers; i++) {
            this.workerPool.push({
                worker: new Worker(this.workerFile),
                busy: false
            });
        }
    }

    /**
     * Executes a CPU-intensive operation in a worker thread
     * 
     * @param {string} operation - The name of the operation to execute
     * @param {object} data - Input data for the operation
     * @returns {Promise<any>} Result of the operation
     */
    async executeInWorker(operation, data) {
        // Find an available worker or wait for one
        const getAvailableWorker = () => {
            return new Promise(resolve => {
                const checkWorkers = () => {
                    const availableWorker = this.workerPool.find(w => !w.busy);
                    if (availableWorker) {
                        availableWorker.busy = true;
                        resolve(availableWorker);
                    } else {
                        setTimeout(checkWorkers, 10);
                    }
                };
                checkWorkers();
            });
        };

        const workerInfo = await getAvailableWorker();

        return new Promise((resolve, reject) => {
            const messageHandler = (result) => {
                workerInfo.worker.removeListener('message', messageHandler);
                workerInfo.worker.removeListener('error', errorHandler);
                workerInfo.busy = false;
                resolve(result);
            };

            const errorHandler = (error) => {
                workerInfo.worker.removeListener('message', messageHandler);
                workerInfo.worker.removeListener('error', errorHandler);
                workerInfo.busy = false;
                reject(error);
            };

            workerInfo.worker.on('message', messageHandler);
            workerInfo.worker.on('error', errorHandler);
            workerInfo.worker.postMessage({ operation, data });
        });
    }

    /**
     * Analyzes the accessibility of a field based on its geographical coordinates.
     * Now optimized with parallel processing.
     * 
     * @param {Object} coordinates - The geographical coordinates to analyze.
     * @returns {Promise<Object>} An object containing accessibility metrics, hazards, and an overall accessibility score.
     * @throws {Error} Throws an error if the accessibility analysis fails.
     */
    async analyzeFieldAccessibility(coordinates) {
        try {
            // Validate input
            this.validateCoordinates(coordinates);

            // Execute accessibility metrics and hazard calculations in parallel
            const [accessibilityMetrics, spatialData] = await Promise.all([
                this.calculateAccessibilityMetrics(coordinates)
            ]);

            // Calculate hazards based on the retrieved spatial data
            const hazards = await this.calculateHazardsForRoads(coordinates, accessibilityMetrics, spatialData);

            // Calculate overall score
            const overallScore = await this.calculateOverallAccessibilityScore(accessibilityMetrics, hazards);

            // Create and return the final result
            return this.formatAccessibilityResult(accessibilityMetrics, hazards, overallScore);
        } catch (error) {
            throw this.handleApiError(error, 'Field accessibility analysis');
        }
    }

    /**
     * Unified rate limiting method that handles all rate limiting scenarios
     * 
     * @param {string} type - The type of rate limit to apply (default, hazard, etc.)
     * @returns {Promise<void>} Resolves when the request can proceed
     */
    async applyRateLimit(type = 'default') {
        const config = this.rateLimits[type] || this.rateLimits.default;
        const now = Date.now();

        if (!this.requestQueues.has(type)) {
            this.requestQueues.set(type, []);
        }

        // Filter out expired timestamps for better performance
        const queue = this.requestQueues.get(type).filter(t => t > now - config.interval);

        // Wait if we've reached the limit
        if (queue.length >= config.requests) {
            const waitTime = config.interval - (now - queue[0]);
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        // Record this request
        queue.push(now);
        this.requestQueues.set(type, queue);
    }

    /**
     * Optimized fetch method with retry logic, caching, and rate limiting
     * 
     * @param {Function} fetchFn - Function that performs the actual fetch
     * @param {Object} options - Configuration options
     * @returns {Promise<any>} The fetch result
     */
    async fetchWithRetry(fetchFn, options = {}) {
        const {
            maxRetries = 3,
            baseDelay = 1000,
            useCache = true,
            cacheKey = null,
            cacheStore = 'overpass',
            rateLimitType = 'default'
        } = options;

        // Select the appropriate cache based on the cacheStore parameter
        const selectedCache = typeof cacheStore === 'string'
            ? this.caches[cacheStore]
            : cacheStore;

        // Check cache first if enabled and available
        if (useCache && cacheKey && selectedCache && selectedCache.has(cacheKey)) {
            return selectedCache.get(cacheKey);
        }

        // Apply rate limiting before attempting fetch
        await this.applyRateLimit(rateLimitType);

        // Retry logic with exponential backoff
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await fetchFn();

                // Cache successful result if caching is enabled
                if (useCache && cacheKey && selectedCache) {
                    selectedCache.set(cacheKey, result);
                }

                return result;
            } catch (error) {
                // Determine if the error is retryable
                const isRetryable = error.response?.status === 429 ||
                    error.code === 'ECONNRESET' ||
                    error.code === 'ECONNABORTED';

                if (attempt === maxRetries || !isRetryable) {
                    throw error;
                }

                // Calculate delay with exponential backoff and jitter
                const retryAfter = error.response?.headers?.['retry-after'];
                const delay = retryAfter
                    ? parseInt(retryAfter) * 1000
                    : Math.pow(2, attempt) * baseDelay + (Math.random() * baseDelay);

                console.warn(`Retry ${attempt}/${maxRetries} in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Calculates a route between two coordinates with optimized caching
     * 
     * @param {Object} startCoord - The starting coordinate
     * @param {Object} endCoord - The ending coordinate
     * @returns {Promise<Object>} The calculated route
     */
    async calculateRouteWithCache(startCoord, endCoord) {
        const cacheKey = `route_${startCoord.lat.toFixed(6)}_${startCoord.lon.toFixed(6)}_${endCoord.lat.toFixed(6)}_${endCoord.lon.toFixed(6)}`;

        return this.fetchWithRetry(
            () => this.calculateRealRoute(startCoord, endCoord),
            {
                cacheKey,
                cacheStore: 'routes',
                rateLimitType: 'default'
            }
        );
    }


    /**
     * Optimized method for calculating multiple routes in parallel
     * 
     * @param {Array<Object>} routeRequests - Array of {start, end} coordinate pairs
     * @returns {Promise<Array<Object>>} Array of calculated routes
     */
    async calculateMultipleRoutes(routeRequests) {
        // Use Promise.all to execute route calculations in parallel
        return Promise.all(
            routeRequests.map(request =>
                this.calculateRouteWithCache(request.start, request.end)
            )
        );
    }

    /**
     * Build an Overpass query with optimized buffer calculation
     * 
     * @param {Object} geometry - GeoJSON geometry to query around
     * @returns {Promise<string>} Overpass query string
     */
    async buildOverpassQuery(geometry) {
        // Use worker thread for buffer calculation (CPU-intensive operation)
        const bbox = await this.executeInWorker('bufferGeometry', {
            geometry,
            bufferSize: this.apiConfig.overpass.bufferSize
        });

        return `[out:json][timeout:25];(
          way[bridge=yes](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
          way["waterway"~"river|stream"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
          way["natural"~"water|landslide"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
        );
        out body;`.trim();
    }

    /**
     * Optimized spatial data query with improved caching
     * 
     * @param {Object} coordinates - Coordinates to query around
     * @returns {Promise<Object>} Spatial data results
     */
    async querySpatialData(coordinates) {
        const query = `
        [out:json][timeout:60];
        (
            way["highway"~"primary|secondary|tertiary"](around:50000,${coordinates.lat},${coordinates.lon});
            node["place"~"city|town"](around:200000,${coordinates.lat},${coordinates.lon});
        );
        out body;
        `;

        return this.fetchWithRetry(
            () => this.queryOverpass(query),
            {
                cacheKey: `spatial_${coordinates.lat.toFixed(4)}_${coordinates.lon.toFixed(4)}`,
                cacheStore: 'overpass',
                rateLimitType: 'default'
            }
        );
    }

    /**
     * Query hazards with improved parallelization and caching
     * 
     * @param {Object} geometry - GeoJSON geometry to query hazards for
     * @returns {Promise<Object>} Processed hazard data
     */
    async queryHazards(geometry) {
        const cacheKey = `hazards_${this.hashGeometry(geometry)}`;

        return this.fetchWithRetry(
            async () => {
                const query = await this.buildOverpassQuery(geometry);

                const controller = new AbortController();
                const timeoutId = setTimeout(
                    () => controller.abort(),
                    this.apiConfig.overpass.timeout
                );

                try {
                    const response = await axios.post(
                        this.apiConfig.overpass.url,
                        `data=${encodeURIComponent(query)}`,
                        {
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            signal: controller.signal
                        }
                    );

                    if (!this.validateApiResponse(response.data, 'overpass')) {
                        throw new Error('Invalid hazard data format');
                    }

                    return this.processHazardElements(response.data);
                } finally {
                    clearTimeout(timeoutId);
                }
            },
            {
                cacheKey,
                cacheStore: 'overpass',
                rateLimitType: 'hazard'
            }
        );
    }

    /**
     * Calculates a composite risk score based on hazard data
     * 
     * @param {Object} hazards - Object containing hazard data
     * @param {Array} hazards.bridges - Array of bridge elements
     * @param {Array} hazards.water - Array of water crossing elements
     * @param {Array} hazards.landslides - Array of landslide elements
     * @returns {number} A risk score between 0 and 1
     */
    async calculateCompositeRisk(hazards) {
        // Use worker thread for risk calculation
        return this.executeInWorker('processHazards', {
            hazardData: hazards,
            weights: this.roadMetrics.hazardWeights
        });
    }

    /**
     * Optimized Haversine distance calculation using worker threads
     * 
     * @param {number} lat1 - Start latitude
     * @param {number} lon1 - Start longitude
     * @param {number} lat2 - End latitude
     * @param {number} lon2 - End longitude
     * @returns {Promise<number>} Distance in meters
     */
    async haversineDistance(lat1, lon1, lat2, lon2) {
        return this.executeInWorker('calculateHaversine', { lat1, lon1, lat2, lon2 });
    }

    /**
     * Generates a hash string for a GeoJSON geometry object
     * 
     * @param {Object} geometry - GeoJSON geometry object
     * @returns {string} A hash string representing the geometry's center point
     */
    hashGeometry(geometry) {
        const center = turf.centroid(geometry).geometry.coordinates;
        // More efficient string creation with precise decimal precision
        return `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
    }

    /**
     * Validate API response with improved error handling
     * 
     * @param {Object} response - API response data
     * @param {string} type - Validation schema type
     * @returns {boolean} True if valid
     */
    validateApiResponse(response, type = 'ors') {
        const validator = type === 'ors' ? this.orsValidator : this.overpassValidator;
        const valid = validator(response);

        if (!valid && validator.errors && validator.errors.length > 0) {
            console.warn(`API validation errors (${type}):`, validator.errors);
        }

        return valid;
    }

    /**
     * Improved error handler with better contextual information
     * 
     * @param {Error} error - The error object
     * @param {string} context - Error context
     * @returns {Error} Enhanced error object
     */

    handleApiError(error, context) {
        // If it's already an enhanced error, just return it
        if (error.context) return error;

        // Enhance the error with additional context
        const enhancedError = new Error(
            `${context} failed: ${error.message || 'Unknown error'}`
        );

        // Preserve the original error properties
        enhancedError.originalError = error;
        enhancedError.status = error.response?.status || 500;
        enhancedError.context = context;

        // Add API response details if available
        if (error.response?.data) {
            enhancedError.responseData = error.response.data;
        }

        // Log error for debugging (optional)
        if (process.env.NODE_ENV === 'development') {
            console.error(`${context}:`, error);
        }

        return enhancedError;
    }

    /**
     * Helper method to format accessibility results consistently
     * 
     * @param {Object} metrics - Accessibility metrics
     * @param {Object} hazards - Hazard information
     * @param {number} overallScore - Overall accessibility score
     * @returns {Object} Formatted result
     */
    formatAccessibilityResult(metrics, hazards, overallScore) {
        const result = {
            metrics,
            hazards,
            overall_accessibility_score: overallScore
        };

        // Add critical segment summary if available
        if (hazards.critical_segment) {
            result.critical_segment_summary = {
                distance_to_primary_road: metrics.distance_to_primary,
                hazards_count: hazards.critical_segment.bridges +
                    hazards.critical_segment.water_crossings +
                    hazards.critical_segment.landslides,
                risk_level: this.getRiskLevel(hazards.critical_segment.risk_score)
            };
        }

        return result;
    }

    /**
     * Determines risk level from score with improved categorization
     * 
     * @param {number} riskScore - Risk score between 0 and 1
     * @returns {string} Risk level category
     */
    getRiskLevel(riskScore) {
        if (riskScore < 0.2) return "Low";
        if (riskScore < 0.5) return "Medium";
        if (riskScore < 0.8) return "High";
        return "Very High";
    }

    /**
     * Generates a hash string for a geometry by creating a precise coordinate representation
     * 
     * @param {Object} geometry - Geometry object to hash
     * @returns {string} Hashed coordinates with 4 decimal places of precision
     */
    hashGeometry(geometry) {
        const center = turf.centroid(geometry).geometry.coordinates;
        // More efficient string creation with precise decimal precision
        return `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
    }

    /**
     * Validates the structure and values of coordinate objects
     * 
     * @param {Object} coord - Coordinate object to validate
     * @param {number} coord.lat - Latitude value
     * @param {number} coord.lon - Longitude value
     * @param {string} [name='coordinates'] - Optional name for error messaging
     * @throws {Error} If coordinates are missing, invalid, or out of acceptable range
     */
    validateCoordinates(coord, name = 'coordinates') {
        if (!coord) {
            throw new Error(`Missing ${name}`);
        }

        if (typeof coord.lat !== 'number' || typeof coord.lon !== 'number') {
            throw new Error(`Invalid ${name}: lat and lon must be numbers`);
        }

        if (isNaN(coord.lat) || isNaN(coord.lon)) {
            throw new Error(`Invalid ${name}: lat and lon cannot be NaN`);
        }

        // Add range validation for extra safety
        if (coord.lat < -90 || coord.lat > 90) {
            throw new Error(`Invalid ${name}: latitude must be between -90 and 90`);
        }

        if (coord.lon < -180 || coord.lon > 180) {
            throw new Error(`Invalid ${name}: longitude must be between -180 and 180`);
        }
    }

    /**
     * Calculates the nearest distance from coordinates to any element in the provided array
     * 
     * @param {Object} coordinates - Reference coordinates {lat, lon}
     * @param {Array} elements - Array of elements with geometry data
     * @returns {Promise<number>} Distance in meters or -1 if no elements found
     */
    async calculateNearestDistance(coordinates, elements) {
        if (!elements || elements.length === 0) return -1;

        // Use worker thread for CPU-intensive distance calculation
        return this.executeInWorker('calculateNearestDistance', {
            coordinates,
            elements
        });
    }

    /**
     * Calculates distance to nearest populated place from spatial data
     * @param {Object} coordinates - Reference coordinates {lat, lon}
     * @param {Array} places - Array of OSM node elements with place tags
     * @returns {number} Distance in meters or -1 if no places found
     */
    async findNearestPlaceDistance(coordinates, places) {
        if (!places || places.length === 0) return -1;

        // Calculate all distances in parallel
        const distances = await Promise.all(
            places.map(place =>
                this.haversineDistance(
                    coordinates.lat,
                    coordinates.lon,
                    parseFloat(place.lat),
                    parseFloat(place.lon)
                )
            )
        );

        // Find the minimum distance
        return Math.min(...distances);
    }

    /**
     * Finds the nearest place from a given set of places
     * @param {Object} coordinates - Reference coordinates {lat, lon}
     * @param {Array} places - Array of place objects with lat and lon properties
     * @returns {Object|null} The nearest place object or null if no places found
     */
    findNearestPlace(coordinates, places) {
        if (!places || places.length === 0) return null;

        let nearest = null;
        let minDistance = Infinity;

        for (const place of places) {
            const distance = this.haversineDistance(
                coordinates.lat, coordinates.lon,
                place.lat, place.lon
            );

            if (distance < minDistance) {
                minDistance = distance;
                nearest = place;
            }
        }

        return nearest;
    }

    /**
     * Executes multiple Overpass API queries in a single batch request
     * @param {string[]} queries - An array of Overpass QL queries to execute
     * @returns {Promise<Object>} Parsed results from the combined query
     */

    /**
     * Parses results from a batch Overpass API query with multiple statements
     * @param {Object} result - Raw result from a combined Overpass query
     * @returns {Object} Separated query results
     */
    async batchOverpassQueries(queries) {
        // Create a combined query with multiple statements
        const combinedQuery = queries.join('\n');

        // Execute the combined query once
        const result = await this.queryOverpass(combinedQuery);

        // Parse and separate the results
        return this.parseMultiQueryResults(result);
    }

    parseMultiQueryResults(result) {
        // Implementation to separate combined results
        // This would depend on how you structure your combined queries
    }

    /**
     * Queries the Overpass API with the provided query
     * @param {string} query - The Overpass QL query to execute
     * @param {Object} [config] - Configuration options for the query
     * @returns {Promise<Object>} - The response data from Overpass API
     */
    async queryOverpass(query, config) {
        // Ensure config always exists with sensible defaults
        const defaultConfig = {
            timeout: this.apiConfig.overpass.timeout || 30000,
            endpoint: this.apiConfig.overpass.url || 'https://overpass-api.de/api/interpreter',
            maxRetries: 3,
            retryDelay: 2000
        };

        // Merge provided config with defaults
        const mergedConfig = { ...defaultConfig, ...(config || {}) };

        try {
            // Create abort controller for timeout handling
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), mergedConfig.timeout);

            try {
                // Prepare the request data
                const requestData = new URLSearchParams();
                requestData.append('data', query);

                // Make the request to the Overpass API
                const response = await fetch(mergedConfig.endpoint, {
                    method: 'POST',
                    body: requestData,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`Overpass API request failed with status: ${response.status}`);
                }

                // Parse and return the response
                const data = await response.json();

                // Validate response format
                if (!this.validateApiResponse(data, 'overpass')) {
                    throw new Error('Invalid Overpass API response format');
                }

                return data;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error) {
            // Categorize errors for better handling
            if (error.name === 'AbortError') {
                throw this.handleApiError(new Error('Request timeout'), 'Overpass API timeout');
            } else if (error.name === 'SyntaxError') {
                throw this.handleApiError(error, 'Overpass API returned invalid JSON');
            } else if (error.message.includes('fetch')) {
                throw this.handleApiError(error, 'Network error querying Overpass API');
            } else {
                throw this.handleApiError(error, 'Error querying Overpass API');
            }
        }
    }

    /**
     * Calculates comprehensive accessibility metrics for a given geographic location.
     * 
     * @param {Object} coordinates - The geographic coordinates to analyze
     * @param {number} coordinates.lat - Latitude of the location
     * @param {number} coordinates.lon - Longitude of the location
     * @returns {Promise<Object>} Accessibility metrics including road distances, population distances, and optional route information
     * @throws {Error} If accessibility metrics calculation fails
     */

    async calculateAccessibilityMetrics(coordinates) {
        try {
            // Input validation
            this.validateCoordinates(coordinates);

            // Single combined API call
            const spatialData = await this.querySpatialData(coordinates);

            // Process road and population data in parallel using worker threads
            const [roadMetrics, populationMetrics] = await Promise.all([
                this.executeInWorker('processRoadData', { spatialData, coordinates }),
                this.executeInWorker('processPopulationData', { spatialData, coordinates })
            ]);

            // Find primary road distance
            const primaryRoadDistance = await this.executeInWorker('findNearestPrimaryFromSpatialData',
                { spatialData, coordinates });

            // Return only the essential data
            return {
                ...roadMetrics,
                ...populationMetrics,
                primary_road_route: {
                    distance: primaryRoadDistance,
                    type: 'primary'
                },
                spatialData
            };
        } catch (error) {
            const enhancedError = this.handleApiError(error, 'Accessibility metrics calculation');
            throw enhancedError;
        }
    }

    /**
     * Processes road data from spatial data to calculate distances to different road types.
     * 
     * @param {Object} spatialData - The spatial data containing road elements
     * @param {Object} coordinates - The geographic coordinates to measure distances from
     * @returns {Object} Distances to primary, secondary, and tertiary roads
     */
    processRoadData(spatialData, coordinates) {
        const roads = {
            primary: spatialData.elements.filter(el =>
                el.type === 'way' && el.tags?.highway === 'primary'
            ),
            secondary: spatialData.elements.filter(el =>
                el.type === 'way' && el.tags?.highway === 'secondary'
            ),
            tertiary: spatialData.elements.filter(el =>
                el.type === 'way' && el.tags?.highway === 'tertiary'
            )
        };

        return {
            distance_to_primary: this.calculateNearestDistance(coordinates, roads.primary),
            distance_to_secondary: this.calculateNearestDistance(coordinates, roads.secondary),
            distance_to_tertiary: this.calculateNearestDistance(coordinates, roads.tertiary)
        };
    }

    /**
     * Processes population data from spatial data to calculate distances to cities and towns.
     * 
     * @param {Object} spatialData - The spatial data containing population elements
     * @param {Object} coordinates - The geographic coordinates to measure distances from
     * @returns {Object} Distances to the nearest city and town
     */
    processPopulationData(spatialData, coordinates) {
        const places = {
            cities: spatialData.elements.filter(el =>
                el.type === 'node' && el.tags?.place === 'city'
            ),
            towns: spatialData.elements.filter(el =>
                el.type === 'node' && el.tags?.place === 'town'
            )
        };

        return {
            distance_to_city: this.findNearestPlaceDistance(coordinates, places.cities),
            distance_to_town: this.findNearestPlaceDistance(coordinates, places.towns)
        };
    }

    /**
     * Finds the nearest primary road from the given spatial data for the specified coordinates.
     * 
     * @param {Object} spatialData - The spatial data containing road elements
     * @param {Object} coordinates - The geographic coordinates to find the nearest primary road from
     * @returns {number} The distance to the nearest primary road
     * @throws {Error} If no primary roads are found in the spatial data
     */
    findNearestPrimaryFromSpatialData(spatialData, coordinates) {
        const primaryRoads = spatialData.elements.filter(el =>
            el.type === 'way' && el.tags?.highway === 'primary'
        );

        if (!primaryRoads.length) throw new Error('No primary roads found');

        // Uses optimized Turf.js calculation
        return this.calculateNearestDistance(coordinates, primaryRoads);
    }

    /**
     * Calculates the shortest route between two geographic coordinates using OpenRouteService.
     * 
     * @param {Object} startCoord - The starting coordinate with longitude and latitude
     * @param {Object} endCoord - The destination coordinate with longitude and latitude
     * @returns {Promise<Object>} The route data from the OpenRouteService API
     * @throws {Error} If route calculation fails or returns invalid data
     */
    async calculateRealRoute(startCoord, endCoord) {
        try {
            await this.applyRateLimit('default');

            const response = await axios.post(
                this.orsConfig.url,
                {
                    coordinates: [
                        [startCoord.lon, startCoord.lat],
                        [endCoord.lon, endCoord.lat]
                    ],
                    preference: "shortest",
                    instructions: false
                },
                {
                    headers: {
                        'Authorization': this.orsConfig.apiKey,
                        'Content-Type': 'application/json'
                    },
                    timeout: this.orsConfig.timeout
                }
            );

            if (!this.validateApiResponse(response.data, 'ors')) {
                throw new Error('Invalid route data format');
            }

            return response.data;
        } catch (error) {
            throw this.handleApiError(error, 'Route calculation failed');
        }
    }

    /**
     * Finds the nearest point on a primary road to the given coordinates.
     * 
     * @param {Object} coordinates - The reference coordinates with latitude and longitude
     * @returns {Promise<Object>} An object containing the nearest point and its distance from the reference coordinates
     * @throws {Error} If no primary roads are found within the search radius
     */
    async findNearestPrimaryRoadPoint(coordinates) {
        const query = `
            [out:json][timeout:60];
            way["highway"="primary"](around:50000,${coordinates.lat},${coordinates.lon});
            out geom;
        `;

        const data = await this.queryOverpass(query);

        if (!data.elements || data.elements.length === 0) {
            throw new Error('No primary roads found within search radius');
        }

        let nearestPoint = null;
        let minDistance = Infinity;

        for (const road of data.elements) {
            if (road.geometry) {
                for (const point of road.geometry) {
                    const distance = this.haversineDistance(
                        coordinates.lat, coordinates.lon,
                        point.lat, point.lon
                    );

                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestPoint = { lat: point.lat, lon: point.lon };
                    }
                }
            }
        }

        return { point: nearestPoint, distance: minDistance };
    }

    /**
     * Calculates hazards along routes from a field to various road types
     * 
     * @param {Object} coordinates - The coordinates of the field (lat/lon)
     * @param {Object} metrics - Distance metrics to different road types
     * @returns {Object} Hazard information for different road segments
     */
    async calculateHazardsForRoads(coordinates, metrics) {
        // Initialize hazards object
        const hazards = {
            critical_segment: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            secondary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            tertiary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            city: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            town: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 }
        };

        try {
            // Find nearest primary road point and analyze all road types in parallel
            const [primaryRoadInfo, secondaryPoint, tertiaryPoint] = await Promise.all([
                this.findNearestPrimaryRoadPoint(coordinates),
                this.findNearestRoadPoint(coordinates, 'secondary'),
                this.findNearestRoadPoint(coordinates, 'tertiary')
            ]);

            if (!primaryRoadInfo || !primaryRoadInfo.point) {
                throw new Error("No primary road found within search radius");
            }

            // Calculate routes in parallel
            const routePromises = [];
            routePromises.push(this.calculateRouteWithCache(coordinates, primaryRoadInfo.point));

            if (secondaryPoint) {
                routePromises.push(this.calculateRouteWithCache(coordinates, secondaryPoint));
            }

            if (tertiaryPoint) {
                routePromises.push(this.calculateRouteWithCache(coordinates, tertiaryPoint));
            }

            const routes = await Promise.all(routePromises);

            // Extract route geometries
            const primaryRouteGeometry = routes[0].features[0].geometry;

            // Query hazards for all routes in parallel
            const hazardPromises = [this.queryHazards(primaryRouteGeometry)];

            if (routes.length > 1) {
                hazardPromises.push(this.queryHazards(routes[1].features[0].geometry));
            }

            if (routes.length > 2) {
                hazardPromises.push(this.queryHazards(routes[2].features[0].geometry));
            }

            const hazardResults = await Promise.all(hazardPromises);

            // Process primary hazards
            const primaryHazardAnalysis = hazardResults[0];
            hazards.critical_segment = {
                distance: primaryRoadInfo.distance,
                bridges: primaryHazardAnalysis.bridges.length,
                water_crossings: primaryHazardAnalysis.water.length,
                landslides: primaryHazardAnalysis.landslides.length,
                risk_score: await this.calculateCompositeRisk(primaryHazardAnalysis)
            };

            // Process secondary and tertiary hazards if available
            if (hazardResults.length > 1) {
                hazards.secondary = {
                    bridges: hazardResults[1].bridges.length,
                    water_crossings: hazardResults[1].water.length,
                    landslides: hazardResults[1].landslides.length,
                    risk_score: await this.calculateCompositeRisk(hazardResults[1])
                };
            }

            if (hazardResults.length > 2) {
                hazards.tertiary = {
                    bridges: hazardResults[2].bridges.length,
                    water_crossings: hazardResults[2].water.length,
                    landslides: hazardResults[2].landslides.length,
                    risk_score: await this.calculateCompositeRisk(hazardResults[2])
                };
            }

            // For cities and towns, use the critical segment hazards
            hazards.city = hazards.critical_segment;
            hazards.town = hazards.critical_segment;

            return hazards;
        } catch (error) {
            throw this.handleApiError(error, "Hazard calculation");
        }
    }

    /**
     * Finds the nearest point on a specific road type within a 50km radius of given coordinates.
     * 
     * @param {Object} coordinates - The reference coordinates with lat and lon properties
     * @param {string} roadType - The type of road to search for (e.g., 'secondary', 'tertiary')
     * @returns {Object|null} The nearest road point with lat and lon, or null if no roads found
    */
    async findNearestRoadPoint(coordinates, roadType) {
        const query = `
            [out:json][timeout:60];
            way["highway"="${roadType}"](around:50000,${coordinates.lat},${coordinates.lon});
            out geom;
        `;

        const data = await this.queryOverpass(query);

        if (!data.elements || data.elements.length === 0) {
            return null;
        }

        let nearestPoint = null;
        let minDistance = Infinity;

        for (const road of data.elements) {
            if (road.geometry) {
                for (const point of road.geometry) {
                    const distance = this.haversineDistance(
                        coordinates.lat, coordinates.lon,
                        point.lat, point.lon
                    );

                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestPoint = { lat: point.lat, lon: point.lon };
                    }
                }
            }
        }

        return nearestPoint;
    }

    /**
     * Calculates an overall accessibility score based on road distances and potential hazards.
     * 
     * @param {Object} metrics - Distance metrics to different road types
     * @param {Object} hazards - Hazard information for critical road segments
     * @returns {number} A normalized accessibility score between 0 and 1
    */
    calculateOverallAccessibilityScore(metrics, hazards) {
        // Base score on distances
        let score = 0;
        const weights = {
            primary: 0.4,    // Increased weight for primary roads
            secondary: 0.2,
            tertiary: 0.15,
            city: 0.15,
            town: 0.1
        };

        for (const type in weights) {
            const distance = metrics[`distance_to_${type}`];
            if (distance > 0) {
                // Normalize distance (closer is better)
                const normalizedDistance = Math.min(1, 10000 / distance);
                score += weights[type] * normalizedDistance;
            }
        }

        // Apply critical segment hazard penalty
        // This focuses on the most important part - getting from field to main road
        if (hazards.critical_segment) {
            const hazardPenalty = hazards.critical_segment.risk_score;
            // Reduce score based on hazards, but never below 20% of original
            score = score * (1 - (hazardPenalty * 0.8));
        }

        return score;
    }

    /**
     * Processes hazard elements from geographic data, categorizing them into bridges, water features, and landslides.
     * 
     * @param {Object} data - The input data containing geographic elements
     * @returns {Object} A categorized result with arrays of bridges, water features, and landslides
    */
    processHazardElements(data) {
        const result = {
            bridges: [],
            water: [],
            landslides: []
        };

        if (!data.elements || !Array.isArray(data.elements)) {
            return result;
        }

        // Process all elements in a single iteration
        data.elements.forEach(el => {
            if (el.tags) {
                // Check for bridges
                if (el.tags.bridge === 'yes' && el.geometry?.length > 1) {
                    result.bridges.push(el);
                }

                // Check for water elements
                if (el.tags.waterway || el.tags.natural === 'water') {
                    result.water.push(el);
                }

                // Check for landslides
                if (el.tags.natural === 'landslide') {
                    result.landslides.push(el);
                }
            }
        });

        return result;
    }

    /**
     * Validates input parameters for various methods
     * 
     * @param {Object} params - Parameters to validate
     * @param {Object} schema - Validation schema defining required fields and types
     * @param {string} context - Context for error messages
     * @throws {Error} If validation fails
     */
    validateParams(params, schema, context) {
        if (!params) {
            throw new Error(`${context}: Missing required parameters`);
        }

        for (const [key, config] of Object.entries(schema)) {
            // Check required fields
            if (config.required && (params[key] === undefined || params[key] === null)) {
                throw new Error(`${context}: Missing required parameter '${key}'`);
            }

            // Check types if value exists
            if (params[key] !== undefined && params[key] !== null && config.type) {
                const actualType = Array.isArray(params[key]) ? 'array' : typeof params[key];
                if (actualType !== config.type) {
                    throw new Error(`${context}: Parameter '${key}' must be of type ${config.type}, got ${actualType}`);
                }
            }

            // Check array item types if specified
            if (config.type === 'array' && config.itemType && Array.isArray(params[key])) {
                for (const item of params[key]) {
                    if (typeof item !== config.itemType) {
                        throw new Error(`${context}: Items in '${key}' must be of type ${config.itemType}`);
                    }
                }
            }
        }
    }

    async applyAdaptiveRateLimit(type = 'default') {
        const config = this.rateLimits[type] || this.rateLimits.default;
        const now = Date.now();

        // Adjust rate limits based on success/failure ratio
        if (now - this.rateLimitStats.lastAdjustment > 60000) { // Every minute
            const total = this.rateLimitStats.successCount + this.rateLimitStats.failureCount;
            if (total > 10) {
                const successRate = this.rateLimitStats.successCount / total;

                if (successRate > 0.95 && config.requests < 10) {
                    // Increase rate limit if success rate is high
                    config.requests += 1;
                } else if (successRate < 0.8 && config.requests > 1) {
                    // Decrease rate limit if failure rate is high
                    config.requests -= 1;
                }

                // Reset stats
                this.rateLimitStats.successCount = 0;
                this.rateLimitStats.failureCount = 0;
                this.rateLimitStats.lastAdjustment = now;
            }
        }

        // Apply the rate limit as before
        if (!this.requestQueues.has(type)) {
            this.requestQueues.set(type, []);
        }

        const queue = this.requestQueues.get(type).filter(t => t > now - config.interval);

        if (queue.length >= config.requests) {
            const waitTime = config.interval - (now - queue[0]);
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        queue.push(now);
        this.requestQueues.set(type, queue);
    }

}

module.exports = FarmRouteAnalyzer;