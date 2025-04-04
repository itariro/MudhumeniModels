const turf = require('@turf/turf');
const axios = require('axios');
const dotenv = require('dotenv');
const Ajv = require('ajv');
const { LRUCache } = require('lru-cache');
const { orsSchema, overpassSchema } = require('../schemas/overpass.schema.js');
const { default: def } = require('ajv/dist/vocabularies/applicator/additionalItems.js');

dotenv.config();

class FarmRouteAnalyzer {
    constructor() {
        this.orsConfig = {
            url: process.env.ORS_URL || 'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
            apiKey: process.env.ORS_API_KEY,
            timeout: parseInt(process.env.ORS_TIMEOUT) || 10000
        };

        this.overpassConfig = {
            url: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
            timeout: parseInt(process.env.OVERPASS_TIMEOUT) || 15000,
            cacheMax: parseInt(process.env.OVERPASS_CACHE_MAX) || 100
        };

        this.roadMetrics = this.initRoadMetrics();
        this.validator = new Ajv();
        this.overpassCache = new LRUCache({ max: this.overpassConfig.cacheMax });
        this.requestQueue = [];
        this.rateLimit = parseInt(process.env.RATE_LIMIT) || 5; // Requests per second
        this.lastRequest = 0;
        this.RATE_LIMIT_INTERVAL = 5000; // 5 seconds between requests
        this.routeCache = new LRUCache({ max: 50 }); // Cache for routes
    }

    initRoadMetrics() {
        return {
            ranking: {
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
            },
            weights: {
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
            }, hazardWeights: {
                bridge: parseFloat(process.env.HAZARD_WEIGHT_BRIDGE) || 0.2,
                water: parseFloat(process.env.HAZARD_WEIGHT_WATER) || 0.1,
                landslide: parseFloat(process.env.HAZARD_WEIGHT_LANDSLIDE) || 0.3
            }
        };
    }

    /**
     * Analyzes the accessibility of a field based on its geographical coordinates.
     * 
     * @param {Object} coordinates - The geographical coordinates to analyze.
     * @returns {Promise<Object>} An object containing accessibility metrics, hazards, and an overall accessibility score.
     * @throws {Error} Throws an error if the accessibility analysis fails.
     */
    async analyzeFieldAccessibility(coordinates) {
        console.log(`Analyzing field accessibility for coordinates: ${JSON.stringify(coordinates)}`);

        try {
            // Get basic distance metrics and route information
            console.log("Calculating accessibility metrics...");
            const accessibilityMetrics = await this.calculateAccessibilityMetrics(coordinates);

            // Calculate hazards using the new route-based approach
            console.log("Calculating hazards along critical routes...");
            const hazards = await this.calculateHazardsForRoads(coordinates, accessibilityMetrics);

            const result = {
                metrics: accessibilityMetrics,
                hazards: hazards,
                overall_accessibility_score: this.calculateOverallAccessibilityScore(accessibilityMetrics, hazards)
            };

            // Add a summary of the critical segment for quick reference
            if (hazards.critical_segment) {
                result.critical_segment_summary = {
                    distance_to_primary_road: accessibilityMetrics.distance_to_primary,
                    hazards_count: hazards.critical_segment.bridges +
                        hazards.critical_segment.water_crossings +
                        hazards.critical_segment.landslides,
                    risk_level: this.getRiskLevel(hazards.critical_segment.risk_score)
                };
            }

            console.log("Field accessibility analysis completed successfully.");
            return result;
        } catch (error) {
            console.error("Field accessibility analysis failed:", error);
            throw error;
        }
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

    async fetchWithRetry(fetchFn, cacheKey, maxRetries = 3, delay = 1000) {
        if (this.overpassCache.has(cacheKey)) {
            return this.overpassCache.get(cacheKey)
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await fetchFn()
                this.overpassCache.set(cacheKey, result)
                return result
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error
                }

                if (error.response?.status === 429 || error.code === 'ECONNRESET') {
                    await new Promise(resolve => setTimeout(resolve, delay * attempt))
                    continue
                }

                throw error
            }
        }
    }

    async buildOverpassQuery(geometry) {
        const buffered = turf.buffer(geometry, 0.02, { units: 'kilometers' });
        const bbox = turf.bbox(buffered);

        return `
            [out:json][timeout:25];
            (
                way[bridge=yes](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
                way["waterway"~"river|stream"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
                way["natural"~"water|landslide"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
            );
            out body;
        `.trim(); // Removes leading/trailing whitespace but keeps formatting
    }

    async queryHazards(geometry) {
        const cacheKey = `hazards_${this.hashGeometry(geometry)}`;
        const cached = this.overpassCache.get(cacheKey);
        if (cached) return cached;

        const MAX_RETRIES = 3;
        let retryCount = 0;
        let response;

        while (retryCount <= MAX_RETRIES) {
            let timeoutId;
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), this.overpassConfig.timeout);

            try {
                await this.rateLimitCheckHazardQuery(); // Client-side rate limiting

                const query = await this.buildOverpassQuery(geometry);
                response = await axios.post(
                    this.overpassConfig.url,
                    `data=${encodeURIComponent(query)}`,
                    {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        signal: controller.signal
                    }
                );

                clearTimeout(timeoutId);

                // Handle HTTP 429 from server
                if (response.status === 429) {
                    throw new axios.AxiosError('Rate limit exceeded', null, null, null, response);
                }

                // Validate response structure
                if (!this.validateApiResponse(response.data, 'overpass')) {
                    throw new Error('Invalid hazard data format');
                }

                // Exit loop on success
                break;
            } catch (error) {
                clearTimeout(timeoutId);

                // Determine if retry is needed
                const isRateLimit = error.response?.status === 429;
                const isTimeout = error.code === 'ECONNABORTED' || error.name === 'AbortError';

                if (retryCount >= MAX_RETRIES) {
                    throw new Error(`Request failed after ${MAX_RETRIES} retries: ${error.message}`);
                }

                if (isRateLimit || isTimeout) {
                    // Calculate delay with exponential backoff and jitter
                    const retryAfterHeader = error.response?.headers?.['retry-after'];
                    const baseDelay = retryAfterHeader
                        ? parseInt(retryAfterHeader) * 1000
                        : Math.pow(2, retryCount) * 1000;

                    const jitter = Math.random() * 1000;
                    const delay = baseDelay + jitter;

                    console.warn(`Retry ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    retryCount++;
                } else {
                    // Non-retryable error
                    throw error;
                }
            }
        }

        // Process and cache successful response
        const result = {
            bridges: this.processBridgeElements(response.data),
            water: this.processWaterElements(response.data),
            landslides: this.processLandslideElements(response.data)
        };

        this.overpassCache.set(cacheKey, result);
        return result;
    }

    calculateCompositeRisk(hazards) {
        const bridgeRisk = Math.min(hazards.bridges.length * this.roadMetrics.hazardWeights.bridge, 1);
        const waterRisk = Math.min(hazards.water.length * this.roadMetrics.hazardWeights.water, 1);
        const landslideRisk = Math.min(hazards.landslides.length * this.roadMetrics.hazardWeights.landslide, 1);

        return (bridgeRisk + waterRisk + landslideRisk) / 3;
    }

    validateApiResponse(response, type = 'ors') {
        const ajv = new Ajv({ strict: false });
        const schema = type === 'ors' ? orsSchema : overpassSchema;
        return ajv.validate(schema, response);
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

    async rateLimitCheckHazardQuery() {
        const now = Date.now();
        const elapsed = now - this.lastRequest;
        if (elapsed < this.RATE_LIMIT_INTERVAL) {
            await new Promise(resolve =>
                setTimeout(resolve, this.RATE_LIMIT_INTERVAL - elapsed)
            );
        }
        this.lastRequest = Date.now();
    }

    hashGeometry(geometry) {
        return turf.centroid(geometry).geometry.coordinates
            .map(c => c.toFixed(6)).join('-');
    }

    validateCoordinates(start, end) {
        const validate = (coord, name) => {
            if (!coord || typeof coord.lat !== 'number' || typeof coord.lon !== 'number') {
                throw new Error(`Invalid ${name} coordinates`);
            }
            if (isNaN(coord.lat) || isNaN(coord.lon)) {
                throw new Error(`Invalid ${name} coordinates: Lat/Lon must be numbers`);
            }
        };

        validate(start, 'start');
        validate(end, 'end');
    }

    validateCoordinatesRefactored(start) {
        const validate = (coord, name) => {
            if (!coord || typeof coord.lat !== 'number' || typeof coord.lon !== 'number') {
                throw new Error(`Invalid ${name} coordinates`);
            }
            if (isNaN(coord.lat) || isNaN(coord.lon)) {
                throw new Error(`Invalid ${name} coordinates: Lat/Lon must be numbers`);
            }
        };

        validate(start, 'start');
    }

    processBridgeElements(data) {
        return data.elements?.filter(el =>
            el.tags?.bridge === 'yes' &&
            el.geometry?.length > 1
        ) || [];
    }

    processWaterElements(data) {
        return data.elements?.filter(el =>
            el.tags?.waterway ||
            el.tags?.natural === 'water'
        ) || [];
    }

    processLandslideElements(data) {
        return data.elements?.filter(el => el.tags?.natural === 'landslide') || [];
    }

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

    enhanceError(error, context) {
        return Object.assign(new Error(`${context}: ${error.message}`), { original: error });
    }

    handleError(error, context) {
        console.error(`${context}:`, error);
        throw this.enhanceError(error, context);
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
        if (!elements || elements.length === 0) {
            console.log("No elements found for distance calculation");
            return -1;
        }

        let minDistance = Infinity;

        for (const element of elements) {
            // Handle different element types (nodes vs ways)
            if (element.type === "node") {
                const distance = this.haversineDistance(
                    coordinates.lat, coordinates.lon,
                    element.lat, element.lon
                );

                if (distance < minDistance) {
                    minDistance = distance;
                }
            }
            // For ways, check each point in the geometry
            else if (element.geometry) {
                for (const point of element.geometry) {
                    const distance = this.haversineDistance(
                        coordinates.lat, coordinates.lon,
                        point.lat, point.lon
                    );

                    if (distance < minDistance) {
                        minDistance = distance;
                    }
                }
            }
        }

        if (minDistance === Infinity) {
            console.log("Could not calculate minimum distance");
            return -1;
        }

        console.log(`Calculated minimum distance: ${minDistance}`);
        return minDistance;
    }

    async calculatePopulationDistances(coordinates) {
        // First, determine the country based on coordinates
        try {
            const country = await this.determineCountry(coordinates);

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
        await this.rateLimitCheck();

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
            throw this.enhanceError(error, 'Overpass query failed');
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
            // Validate input coordinates
            this.validateCoordinatesRefactored(coordinates);

            // Calculate distances to different road types
            const roadDistances = await this.calculateRoadDistances(coordinates);

            // Calculate distances to population centers
            const populationDistances = await this.calculatePopulationDistances(coordinates);

            // Add route information for the critical segment (field to primary road)
            const primaryRoadInfo = await this.findNearestPrimaryRoadPoint(coordinates);

            // Only add route data if we found a primary road
            let routeData = {};
            if (primaryRoadInfo.point) {
                const route = await this.calculateRealRouteWithCache(coordinates, primaryRoadInfo.point);
                routeData = {
                    primary_road_route: {
                        distance: primaryRoadInfo.distance,
                        route_geometry: route.features[0].geometry
                    }
                };
            }

            return {
                ...roadDistances,
                ...populationDistances,
                ...routeData
            };
        } catch (error) {
            this.handleError(error, 'Accessibility metrics calculation failed');
        }
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
            await this.rateLimitCheck();

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
            throw this.enhanceError(error, 'Route calculation failed');
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
     * Calculates road hazards for different road types based on field coordinates and road metrics.
     * 
     * @param {Object} coordinates - The geographic coordinates of the field
     * @param {Object} metrics - Road distance metrics for different road types
     * @returns {Promise<Object>} A comprehensive hazard analysis for primary, secondary, tertiary roads, and city/town segments
     * @throws {Error} If hazard calculation encounters any issues during processing
     */
    async calculateHazardsForRoads(coordinates, metrics) {
        const hazards = {};

        try {
            // Find nearest primary road point
            const primaryRoadInfo = await this.findNearestPrimaryRoadPoint(coordinates);

            if (primaryRoadInfo.point) {
                // Get actual route from field to primary road
                const routeToMainRoad = await this.calculateRealRouteWithCache(
                    coordinates,
                    primaryRoadInfo.point
                );

                // Extract route geometry as GeoJSON
                const routeGeometry = routeToMainRoad.features[0].geometry;

                // Analyze hazards along this critical segment
                const hazardAnalysis = await this.queryHazards(routeGeometry);

                // Store hazard information for the critical segment
                hazards.critical_segment = {
                    distance: primaryRoadInfo.distance,
                    bridges: hazardAnalysis.bridges.length,
                    water_crossings: hazardAnalysis.water.length,
                    landslides: hazardAnalysis.landslides.length,
                    risk_score: this.calculateCompositeRisk(hazardAnalysis)
                };

                // For other road types, we'll maintain simplified analysis
                for (const roadType of ['secondary', 'tertiary']) {
                    if (metrics[`distance_to_${roadType}`] > 0) {
                        // Only analyze if this road type is closer than primary
                        if (metrics[`distance_to_${roadType}`] < primaryRoadInfo.distance) {
                            const nearestPoint = await this.findNearestRoadPoint(coordinates, roadType);
                            if (nearestPoint) {
                                const routeToRoad = await this.calculateRealRouteWithCache(
                                    coordinates,
                                    nearestPoint
                                );
                                const routeGeom = routeToRoad.features[0].geometry;
                                const roadHazards = await this.queryHazards(routeGeom);

                                hazards[roadType] = {
                                    bridges: roadHazards.bridges.length,
                                    water_crossings: roadHazards.water.length,
                                    landslides: roadHazards.landslides.length,
                                    risk_score: this.calculateCompositeRisk(roadHazards)
                                };
                            }
                        }
                    }
                }
            }

            // For cities and towns, we'll just use the critical segment hazards
            // since we're focusing on the field-to-main-road segment
            hazards.city = hazards.critical_segment;
            hazards.town = hazards.critical_segment;

            return hazards;
        } catch (error) {
            console.error("Error calculating hazards:", error);
            // Return empty hazard data as fallback
            return {
                critical_segment: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
                secondary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
                tertiary: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
                city: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 },
                town: { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 }
            };
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
}

module.exports = FarmRouteAnalyzer;