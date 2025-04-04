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

    async analyzeFieldAccessibility(coordinates) {
        console.log(`Analyzing field accessibility for coordinates: ${JSON.stringify(coordinates)}`);

        try {
            // Get basic distance metrics
            console.log("Calculating accessibility metrics...");
            const accessibilityMetrics = await this.calculateAccessibilityMetrics(coordinates);

            // Calculate hazards for each road type
            console.log("Calculating hazards...");
            const hazards = await this.calculateHazardsForRoads(coordinates, accessibilityMetrics);

            const result = {
                metrics: accessibilityMetrics,
                hazards: hazards,
                overall_accessibility_score: this.calculateOverallAccessibilityScore(accessibilityMetrics, hazards)
            };
            console.log("Field accessibility analysis completed successfully.");
            return result;
        } catch (error) {
            console.error("Field accessibility analysis failed:", error);
            throw error;
        }
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

    truncateCoordinate(coord) {
        return parseFloat(coord.toFixed(6));
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

    async calculateHazardsForRoads(coordinates, metrics) {
        // We can reuse the existing hazard analysis logic but apply it to each road type
        // This is a simplified version - you'd need to expand this
        const hazards = {};

        // For each road type, calculate hazards along the route to that road
        for (const roadType of ['primary', 'secondary', 'tertiary', 'city', 'town']) {
            if (metrics[`distance_to_${roadType}`] > 0) {
                // Create a simple line from coordinates to nearest point of this type
                // This is simplified - you'd need actual route geometry
                const lineString = this.createSimpleLineString(coordinates, roadType, metrics);

                // Use existing hazard analysis
                const hazardAnalysis = await this.queryHazards(lineString);

                hazards[roadType] = {
                    bridges: hazardAnalysis.bridges.length,
                    water_crossings: hazardAnalysis.water.length,
                    landslides: hazardAnalysis.landslides.length,
                    risk_score: this.calculateCompositeRisk(hazardAnalysis)
                };
            } else {
                hazards[roadType] = { bridges: 0, water_crossings: 0, landslides: 0, risk_score: 0 };
            }
        }

        return hazards;
    }

    calculateOverallAccessibilityScore(metrics, hazards) {
        // Calculate a weighted score based on distances and hazards
        // This is a simple example - you'd want to refine this formula
        let score = 0;
        const weights = {
            primary: 0.3,
            secondary: 0.25,
            tertiary: 0.2,
            city: 0.15,
            town: 0.1
        };

        for (const type in weights) {
            const distance = metrics[`distance_to_${type}`];
            if (distance > 0) {
                // Normalize distance (closer is better)
                const normalizedDistance = Math.min(1, 10000 / distance);
                // Factor in hazards
                const hazardPenalty = hazards[type] ? hazards[type].risk_score : 0;

                score += weights[type] * normalizedDistance * (1 - hazardPenalty);
            }
        }

        return score;
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

    async calculateAccessibilityMetrics(coordinates) {
        try {
            // Validate input coordinates
            this.validateCoordinatesRefactored(coordinates);

            // Calculate distances to different road types
            const roadDistances = await this.calculateRoadDistances(coordinates);

            // Calculate distances to population centers
            const populationDistances = await this.calculatePopulationDistances(coordinates);

            return {
                ...roadDistances,
                ...populationDistances
            };
        } catch (error) {
            this.handleError(error, 'Accessibility metrics calculation failed');
        }
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
}

module.exports = FarmRouteAnalyzer;