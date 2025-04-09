const turf = require('@turf/turf');
const axios = require('axios');
const dotenv = require('dotenv');
const Ajv = require('ajv');
const { LRUCache } = require('lru-cache');
const { orsSchema, overpassSchema } = require('../schemas/overpass.schema.js');
//const { default: def } = require('ajv/dist/vocabularies/applicator/additionalItems.js');

dotenv.config();

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

class FarmRouteAnalyzer {
    constructor() {

        this.ajv = new Ajv({ strict: false });
        this.orsValidator = this.ajv.compile(orsSchema);
        this.overpassValidator = this.ajv.compile(overpassSchema);

        this.orsConfig = {
            url: process.env.ORS_URL || 'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
            apiKey: process.env.ORS_API_KEY,
            timeout: parseInt(process.env.ORS_TIMEOUT) || 10000
        };

        this.requestQueue = [];
        this.rateLimit = parseInt(process.env.RATE_LIMIT) || 5; // Requests per second
        this.lastRequest = 0;
        this.RATE_LIMIT_INTERVAL = 5000; // 5 seconds between requests

        // Change this from a property to a method
        this.rateLimitConfig = {
            default: { requests: parseInt(process.env.RATE_LIMIT) || 5, interval: 1000 },
            hazard: { requests: 1, interval: 5000 }
        };
        this.requestTimestamps = new Map();

        this.routeCache = new LRUCache({
            max: 50,
            ttl: 1000 * 60 * 60, // 1 hour expiration
            updateAgeOnGet: true // Refresh TTL on cache hits
        }); // Cache for routes



        // refactored
        // Unified rate limiting configuration
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
        this.requestQueues = new Map();

        // Optimized spatial query configuration
        this.overpassConfig = {
            url: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
            timeout: parseInt(process.env.OVERPASS_TIMEOUT) || 15000,
            bufferSize: parseFloat(process.env.OVERPASS_BUFFER) || 0.02, // km
            cacheMax: parseInt(process.env.OVERPASS_CACHE_MAX) || 100
        };

        // Static road metrics
        this.roadMetrics = {
            ranking: ROAD_RANKING,
            weights: ROAD_WEIGHTS,
            hazardWeights: {
                bridge: parseFloat(process.env.HAZARD_WEIGHT_BRIDGE) || 0.2,
                water: parseFloat(process.env.HAZARD_WEIGHT_WATER) || 0.1,
                landslide: parseFloat(process.env.HAZARD_WEIGHT_LANDSLIDE) || 0.3
            }
        };

        // Cache initialization
        this.overpassCache = new LRUCache({ max: this.overpassConfig.cacheMax });
    }

    /**
     * Analyzes the accessibility of a field based on its geographical coordinates.
     * 
     * @param {Object} coordinates - The geographical coordinates to analyze.
     * @returns {Promise<Object>} An object containing accessibility metrics, hazards, and an overall accessibility score.
     * @throws {Error} Throws an error if the accessibility analysis fails.
     */
    async analyzeFieldAccessibility(coordinates) {
        try {
            // Validate input
            this.validateCoordinates(coordinates);

            // Get accessibility metrics (improved function name for clarity)
            console.log("Calculating accessibility metrics...");
            const accessibilityMetrics = await this.calculateAccessibilityMetrics(coordinates);

            // Calculate hazards along critical routes
            console.log("Calculating hazards along critical routes...");
            const hazards = await this.calculateHazardsForRoads(coordinates, accessibilityMetrics);

            // Create and return the final result
            return this.formatAccessibilityResult(
                accessibilityMetrics,
                hazards,
                this.calculateOverallAccessibilityScore(accessibilityMetrics, hazards)
            );
        } catch (error) {
            throw this.handleApiError(error, 'Field accessibility analysis');
        }
    }

    // Helper method to format results consistently
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
     * Determines the risk level based on a numerical risk score.
     * 
     * @param {number} riskScore - A numerical score between 0 and 1 representing risk level.
     * @returns {string} The risk level categorization: "Low", "Medium", "High", or "Very High".
     */
    getRiskLevel(riskScore) {
        if (riskScore < 0.2) return "Low";
        if (riskScore < 0.5) return "Medium";
        if (riskScore < 0.8) return "High";
        return "Very High";
    }

    /**
     * Calculates a route between two coordinates with caching to improve performance.
     * 
     * @param {Object} startCoord - The starting coordinate with latitude and longitude.
     * @param {Object} endCoord - The ending coordinate with latitude and longitude.
     * @returns {Promise<Object>} A cached or newly calculated route between the coordinates.
     */
    async calculateRealRouteWithCache(startCoord, endCoord) {
        const cacheKey = `route_${startCoord.lat.toFixed(6)}_${startCoord.lon.toFixed(6)}_${endCoord.lat.toFixed(6)}_${endCoord.lon.toFixed(6)}`;

        if (this.routeCache.has(cacheKey)) {
            return this.routeCache.get(cacheKey);
        }

        const route = await this.calculateRealRoute(startCoord, endCoord);
        this.routeCache.set(cacheKey, route);
        return route;
    }

    // Add this new method
    async applyRateLimit(type = 'default') {
        const config = this.rateLimits[type] || this.rateLimits.default;

        if (!this.requestQueues.has(type)) {
            this.requestQueues.set(type, []);
        }

        const now = Date.now();
        const queue = this.requestQueues.get(type).filter(t => t > now - config.interval);

        if (queue.length >= config.requests) {
            const waitTime = config.interval - (now - queue[0]);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.requestQueues.set(type, [...queue, Date.now()]);
    }

    async fetchWithRetry(fetchFn, options = {}) {
        const {
            maxRetries = 3,
            baseDelay = 1000,
            useCache = true,
            cacheKey = null,
            cacheStore = this.overpassCache
        } = options;

        // Check cache first if enabled
        if (useCache && cacheKey && cacheStore.has(cacheKey)) {
            return cacheStore.get(cacheKey);
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await fetchFn();

                // Cache successful result
                if (useCache && cacheKey) {
                    cacheStore.set(cacheKey, result);
                }

                return result;
            } catch (error) {
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

    async buildOverpassQuery(geometry) {
        const buffered = turf.buffer(
            geometry,
            this.overpassConfig.bufferSize,
            { units: 'kilometers' }
        );
        const bbox = turf.bbox(buffered);

        return `[out:json][timeout:25];(
          way[bridge=yes](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
          way["waterway"~"river|stream"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
          way["natural"~"water|landslide"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
        );
        out body;`.trim();
    }

    // Combined spatial query for roads and population centers
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
            { cacheKey: `spatial_${coordinates.lat}_${coordinates.lon}` }
        );
    }

    async queryHazards(geometry) {
        const cacheKey = `hazards_${this.hashGeometry(geometry)}`;

        return this.fetchWithRetry(
            async () => {
                await this.applyRateLimit('hazard'); // Changed from this.rateLimit

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.overpassConfig.timeout);

                try {
                    const query = await this.buildOverpassQuery(geometry);
                    const response = await axios.post(
                        this.overpassConfig.url,
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
            { cacheKey }
        );
    }

    calculateCompositeRisk(hazards) {
        const bridgeRisk = Math.min(hazards.bridges.length * this.roadMetrics.hazardWeights.bridge, 1);
        const waterRisk = Math.min(hazards.water.length * this.roadMetrics.hazardWeights.water, 1);
        const landslideRisk = Math.min(hazards.landslides.length * this.roadMetrics.hazardWeights.landslide, 1);

        return (bridgeRisk + waterRisk + landslideRisk) / 3;
    }

    validateApiResponse(response, type = 'ors') {
        return type === 'ors' ? this.orsValidator(response) : this.overpassValidator(response);
    }

    // Replace separate rate limiting methods with a unified approach
    async rateLimit(type = 'default') {
        const limits = {
            'default': { requests: this.rateLimit, period: 1000 },
            'hazard': { requests: 1, period: this.RATE_LIMIT_INTERVAL }
        };

        const config = limits[type] || limits['default'];
        const now = Date.now();

        if (!this.requestQueues) this.requestQueues = {};
        if (!this.requestQueues[type]) this.requestQueues[type] = [];

        // Clean up old timestamps
        this.requestQueues[type] = this.requestQueues[type]
            .filter(t => t > now - config.period);

        // Wait if we've reached the limit
        if (this.requestQueues[type].length >= config.requests) {
            const oldestRequest = this.requestQueues[type][0];
            const waitTime = config.period - (now - oldestRequest);
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        // Record this request
        this.requestQueues[type].push(Date.now());
    }

    async rateLimitCheck() {
        const now = Date.now();
        this.requestQueue = this.requestQueue.filter(t => t > now - 1000);

        if (this.requestQueue.length >= this.rateLimit) {
            await new Promise(resolve =>
                setTimeout(resolve, 1000 - (now - this.requestQueue[0]))
            );
        }

        this.requestQueue.push(Date.now());
    }

    hashGeometry(geometry) {
        const center = turf.centroid(geometry).geometry.coordinates;
        // More efficient string creation with precise decimal precision
        return `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
    }

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
     * Optimized Haversine distance calculation
     * @param {number} lat1 - Start latitude
     * @param {number} lon1 - Start longitude
     * @param {number} lat2 - End latitude
     * @param {number} lon2 - End longitude
     * @returns {number} Distance in meters
     */
    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    handleError(error, context) {
        console.error(`${context}:`, error);
        throw this.handleApiError(error, context);
    }

    createSimpleLineString(coordinates, roadType, metrics) {
        // This is a placeholder - in reality, you'd need to get the actual coordinates
        // of the nearest road/city/town point

        // For now, we'll create a dummy line with a length proportional to the distance
        const distance = metrics[`distance_to_${roadType}`];
        const angle = Math.random() * Math.PI * 2; // Random direction

        // Calculate a point roughly in the direction of the nearest feature
        // This is just for demonstration - not accurate
        const endLat = coordinates.lat + (Math.sin(angle) * distance / 111000);
        const endLon = coordinates.lon + (Math.cos(angle) * distance / (111000 * Math.cos(coordinates.lat * Math.PI / 180)));

        return turf.lineString([
            [coordinates.lon, coordinates.lat],
            [endLon, endLat]
        ]);
    }

    async calculateRoadDistances(coordinates) {
        // Increase the search radius and simplify the query
        const query = `
            [out:json][timeout:60];
            (
                way["highway"="primary"](around:50000,${coordinates.lat},${coordinates.lon});
                way["highway"="secondary"](around:50000,${coordinates.lat},${coordinates.lon});
                way["highway"="tertiary"](around:50000,${coordinates.lat},${coordinates.lon});
            );
            out geom;
        `;

        const cacheKey = `roads_${coordinates.lat}_${coordinates.lon}`;

        try {
            const data = await this.fetchWithRetry(
                () => this.queryOverpass(query),
                cacheKey
            );

            console.log(`Found ${data.elements.length} road elements`);

            // Process the results to find nearest roads of each type
            const primaryRoads = data.elements.filter(el => el.tags.highway === "primary");
            const secondaryRoads = data.elements.filter(el => el.tags.highway === "secondary");
            const tertiaryRoads = data.elements.filter(el => el.tags.highway === "tertiary");

            console.log(`Primary: ${primaryRoads.length}, Secondary: ${secondaryRoads.length}, Tertiary: ${tertiaryRoads.length}`);

            return {
                distance_to_primary: this.calculateNearestDistance(coordinates, primaryRoads),
                distance_to_secondary: this.calculateNearestDistance(coordinates, secondaryRoads),
                distance_to_tertiary: this.calculateNearestDistance(coordinates, tertiaryRoads)
            };
        } catch (error) {
            console.error("Road distance calculation failed:", error);
            return {
                distance_to_primary: -1,
                distance_to_secondary: -1,
                distance_to_tertiary: -1
            };
        }
    }

    calculateNearestDistance(coordinates, elements) {
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

    /**
   * Calculates distance to nearest populated place from spatial data
   * @param {Object} coordinates - Reference coordinates {lat, lon}
   * @param {Array} places - Array of OSM node elements with place tags
   * @returns {number} Distance in meters or -1 if no places found
   */
    findNearestPlaceDistance(coordinates, places) {
        if (!places || places.length === 0) return -1;

        let minDistance = Infinity;

        for (const place of places) {
            // Validate place structure
            if (!place.lat || !place.lon) {
                console.warn('Invalid place element missing coordinates:', place);
                continue;
            }

            const distance = this.haversineDistance(
                coordinates.lat,
                coordinates.lon,
                parseFloat(place.lat),
                parseFloat(place.lon)
            );

            if (distance < minDistance) {
                minDistance = distance;
            }
        }

        return minDistance !== Infinity ? Math.round(minDistance) : -1;
    }

    async calculatePopulationDistances(coordinates) {
        // First, determine the country based on coordinates
        try {
            // const country = await this.determineCountry(coordinates);

            // More flexible query for cities and towns
            const query = `
                [out:json][timeout:60];
                (
                    // Look for capital cities
                    node["place"="city"](around:200000,${coordinates.lat},${coordinates.lon});
                    // Look for administrative towns
                    node["place"="town"](around:100000,${coordinates.lat},${coordinates.lon});
                );
                out body;
            `;

            const cacheKey = `population_${coordinates.lat}_${coordinates.lon}`;

            const data = await this.fetchWithRetry(
                () => this.queryOverpass(query),
                cacheKey
            );

            // Find cities and towns
            const cities = data.elements.filter(el => el.tags.place === "city");
            const capitalCity = cities.find(el => el.tags.capital === "yes" || el.tags.admin_level === "2");

            const towns = data.elements.filter(el => el.tags.place === "town");
            const adminTown = towns.find(el => el.tags.admin_level);

            // If we can't find a specific capital or admin town, use the nearest city and town
            const nearestCity = cities.length > 0 ?
                this.findNearestPlace(coordinates, cities) : null;

            const nearestTown = towns.length > 0 ?
                this.findNearestPlace(coordinates, towns) : null;

            return {
                distance_to_city: capitalCity ?
                    this.calculatePointDistance(coordinates, capitalCity) :
                    (nearestCity ? this.calculatePointDistance(coordinates, nearestCity) : -1),

                distance_to_town: adminTown ?
                    this.calculatePointDistance(coordinates, adminTown) :
                    (nearestTown ? this.calculatePointDistance(coordinates, nearestTown) : -1),

                capitalCity,
                nearestTown
            };
        } catch (error) {
            console.error("Population distance calculation failed:", error);
            return {
                distance_to_city: -1,
                distance_to_town: -1
            };
        }
    }

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

    calculatePointDistance(coordinates, point) {
        return this.haversineDistance(
            coordinates.lat, coordinates.lon,
            point.lat, point.lon
        );
    }

    async determineCountry(coordinates) {
        try {
            // Simpler query to determine country
            const query = `
                [out:json][timeout:30];
                is_in(${coordinates.lat},${coordinates.lon});
                out tags;
            `;

            const cacheKey = `country_${coordinates.lat}_${coordinates.lon}`;

            const data = await this.fetchWithRetry(
                () => this.queryOverpass(query),
                cacheKey
            );

            console.log(`Country determination returned ${data.elements.length} elements`);

            // Look for country information in any of the returned elements
            for (const element of data.elements) {
                if (element.tags) {
                    if (element.tags.ISO3166) return element.tags.ISO3166;
                    if (element.tags.country) return element.tags.country;
                    if (element.tags.name && element.tags.admin_level === "2") return element.tags.name;
                }
            }

            return "unknown";
        } catch (error) {
            console.error("Country determination failed:", error);
            return "unknown";
        }
    }

    async queryOverpass(query) {
        await this.applyRateLimit('default');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.overpassConfig.timeout);

        try {
            const response = await axios.post(
                this.overpassConfig.url,
                `data=${encodeURIComponent(query)}`,
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    signal: controller.signal
                }
            );

            clearTimeout(timeoutId);
            return response.data;
        } catch (error) {
            clearTimeout(timeoutId);
            throw this.handleApiError(error, 'Overpass query failed');
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
            // Single combined API call
            const spatialData = await this.querySpatialData(coordinates);

            // Process both datasets from single response
            const roadMetrics = this.processRoadData(spatialData, coordinates);
            const populationMetrics = this.processPopulationData(spatialData, coordinates);

            // Uses cached data for primary road lookup
            const primaryRoadInfo = this.findNearestPrimaryFromSpatialData(spatialData, coordinates);

            return {
                ...roadMetrics,
                ...populationMetrics,
                primary_road_route: {
                    distance: primaryRoadInfo,
                    type: 'primary'
                }
            };
        } catch (error) {
            this.handleError(error, 'Accessibility metrics calculation');
        }
    }

    // New processing methods for combined data
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

    // Updated primary road finding using cached data
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
        // Initialize hazards object with default structure
        const hazards = {
            critical_segment: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            secondary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            tertiary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            city: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
            town: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 }
        };

        // Configuration constants
        const TIMEOUT = 15000; // 15 second timeout for external API calls
        const MAX_RETRIES = 2;  // Maximum number of retries for failed operations

        // Create a timeout promise
        const createTimeout = (ms) => {
            return new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
            });
        };

        // Execute promise with timeout and retry logic
        const withTimeoutAndRetry = async (promiseFn, ms, retries = 0) => {
            try {
                return await Promise.race([promiseFn(), createTimeout(ms)]);
            } catch (error) {
                if (retries < MAX_RETRIES) {
                    console.warn(`Retrying operation (${retries + 1}/${MAX_RETRIES})...`);
                    return withTimeoutAndRetry(promiseFn, ms, retries + 1);
                }
                throw error;
            }
        };

        try {
            // Validate input parameters
            if (!coordinates || !coordinates.lat || !coordinates.lon) {
                throw new Error("Invalid coordinates provided");
            }

            if (!metrics || typeof metrics !== 'object') {
                throw new Error("Invalid metrics object provided");
            }

            // Find nearest primary road point with timeout and retry
            const primaryRoadInfo = await withTimeoutAndRetry(
                () => this.findNearestPrimaryRoadPoint(coordinates),
                TIMEOUT
            );

            if (!primaryRoadInfo || !primaryRoadInfo.point) {
                throw new Error("No primary road found within search radius");
            }

            // Get actual route from field to primary road
            const primaryRoutePromise = withTimeoutAndRetry(
                () => this.calculateRealRouteWithCache(coordinates, primaryRoadInfo.point),
                TIMEOUT
            );

            // Prepare promises for secondary and tertiary roads in parallel
            const roadPromises = [];
            const roadTypes = ['secondary', 'tertiary'];

            for (const roadType of roadTypes) {
                // Only analyze if this road type exists and is closer than primary
                if (metrics[`distance_to_${roadType}`] > 0 &&
                    metrics[`distance_to_${roadType}`] < primaryRoadInfo.distance) {

                    roadPromises.push(
                        withTimeoutAndRetry(() => this.findNearestRoadPoint(coordinates, roadType), TIMEOUT)
                            .then(nearestPoint => {
                                if (!nearestPoint) return null;
                                return {
                                    type: roadType,
                                    point: nearestPoint,
                                    routePromise: withTimeoutAndRetry(
                                        () => this.calculateRealRouteWithCache(coordinates, nearestPoint),
                                        TIMEOUT
                                    )
                                };
                            })
                            .catch(err => {
                                console.warn(`Error finding ${roadType} road:`, err);
                                return null;
                            })
                    );
                } else {
                    roadPromises.push(Promise.resolve(null));
                }
            }

            // Wait for all road points to be found
            const [primaryRoute, ...otherRoads] = await Promise.all([
                primaryRoutePromise,
                ...roadPromises
            ]);

            // Validate primary route data
            if (!primaryRoute || !primaryRoute.features || !primaryRoute.features[0] ||
                !primaryRoute.features[0].geometry) {
                throw new Error("Invalid primary route data returned from routing service");
            }

            // Extract route geometry and analyze primary road hazards
            const primaryRouteGeometry = primaryRoute.features[0].geometry;
            const primaryHazardAnalysis = await withTimeoutAndRetry(
                () => this.queryHazards(primaryRouteGeometry),
                TIMEOUT
            );

            // Validate hazard analysis data
            if (!primaryHazardAnalysis ||
                !Array.isArray(primaryHazardAnalysis.bridges) ||
                !Array.isArray(primaryHazardAnalysis.water) ||
                !Array.isArray(primaryHazardAnalysis.landslides)) {
                throw new Error("Invalid hazard analysis data for primary route");
            }

            // Store hazard information for the critical segment
            hazards.critical_segment = {
                distance: primaryRoadInfo.distance,
                bridges: primaryHazardAnalysis.bridges.length,
                water_crossings: primaryHazardAnalysis.water.length,
                landslides: primaryHazardAnalysis.landslides.length,
                risk_score: this.calculateCompositeRisk(primaryHazardAnalysis)
            };

            // Process other road types in parallel with error handling for each
            const hazardPromises = otherRoads
                .filter(road => road !== null)
                .map(async (road) => {
                    try {
                        const route = await road.routePromise;

                        // Validate route data
                        if (!route || !route.features || !route.features[0] || !route.features[0].geometry) {
                            throw new Error(`Invalid route data for ${road.type} road`);
                        }

                        const routeGeom = route.features[0].geometry;
                        const roadHazards = await withTimeoutAndRetry(
                            () => this.queryHazards(routeGeom),
                            TIMEOUT
                        );

                        // Validate hazard data
                        if (!roadHazards ||
                            !Array.isArray(roadHazards.bridges) ||
                            !Array.isArray(roadHazards.water) ||
                            !Array.isArray(roadHazards.landslides)) {
                            throw new Error(`Invalid hazard data for ${road.type} road`);
                        }

                        return {
                            type: road.type,
                            hazardData: {
                                bridges: roadHazards.bridges.length,
                                water_crossings: roadHazards.water.length,
                                landslides: roadHazards.landslides.length,
                                risk_score: this.calculateCompositeRisk(roadHazards)
                            }
                        };
                    } catch (err) {
                        console.warn(`Error processing ${road.type} road:`, err);
                        return {
                            type: road.type,
                            hazardData: {
                                bridges: 0,
                                water_crossings: 0,
                                landslides: 0,
                                risk_score: 0,
                                error: err.message
                            }
                        };
                    }
                });

            // Wait for all hazard analyses to complete
            const hazardResults = await Promise.allSettled(hazardPromises);

            // Assign results to appropriate road types
            hazardResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    hazards[result.value.type] = result.value.hazardData;
                }
            });

            // For cities and towns, use the critical segment hazards
            // This is intentional as we're focusing on the field-to-main-road segment
            hazards.city = hazards.critical_segment;
            hazards.town = hazards.critical_segment;

            return hazards;
        } catch (error) {
            console.error("Error calculating hazards:", error);

            // Add error information to critical segment
            hazards.critical_segment.error = error.message;
            hazards.critical_segment.error_type = error.name;
            hazards.critical_segment.error_stack = process.env.NODE_ENV === 'development' ? error.stack : undefined;

            return hazards;
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
     * Handles and enhances API errors with additional context and retry information.
     * 
     * @param {Error} error - The original error object
     * @param {string} context - Contextual information about where the error occurred
     * @returns {Error} An enhanced error object with additional metadata and retry guidance
    */
    handleApiError(error, context) {
        // Create a structured error object
        const enhancedError = {
            message: `${context}: ${error.message}`,
            original: error,
            timestamp: new Date().toISOString(),
            context,
            isRetryable: false
        };

        // Determine if the error is retryable
        if (error.response) {
            enhancedError.status = error.response.status;
            enhancedError.isRetryable = [429, 500, 502, 503, 504].includes(error.response.status);
        } else if (error.code) {
            enhancedError.code = error.code;
            enhancedError.isRetryable = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
        }

        // Log with appropriate details
        console.error(JSON.stringify(enhancedError));

        // Return a proper Error object with enhanced properties
        const resultError = new Error(enhancedError.message);
        Object.assign(resultError, enhancedError);
        return resultError;
    }
}

module.exports = FarmRouteAnalyzer;