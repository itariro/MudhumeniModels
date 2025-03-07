const turf = require('@turf/turf');
const axios = require('axios');
const dotenv = require('dotenv');
const Ajv = require('ajv');
const { LRUCache } = require('lru-cache');
const { orsSchema, overpassSchema } = require('../schemas/overpass.schema.js');

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
    }

    initRoadMetrics() {
        return {
            ranking: JSON.parse(process.env.ROAD_RANKING || '{}') || { /* default ranking */ },
            weights: JSON.parse(process.env.ROAD_WEIGHTS || '{}') || { /* default weights */ },
            hazardWeights: {
                bridge: parseFloat(process.env.HAZARD_WEIGHT_BRIDGE) || 0.2,
                water: parseFloat(process.env.HAZARD_WEIGHT_WATER) || 0.1,
                landslide: parseFloat(process.env.HAZARD_WEIGHT_LANDSLIDE) || 0.3
            }
        };
    }

    async analyzeRouteQuality(start, end) {
        this.validateCoordinates(start, end);
        const cacheKey = this.generateCacheKey(start, end);

        try {
            const routeData = await this.fetchRouteData(start, end);
            if (!this.validateApiResponse(routeData, 'ors')) {
                throw new Error('Invalid route data format');
            }
            const analysis = await this.processRouteData(routeData);
            const enhancedAnalysis = await this.enhanceWithHazards(analysis);

            return this.formatResults(enhancedAnalysis, routeData);
        } catch (error) {
            this.handleError(error, 'Route analysis failed');
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

    async fetchRouteData(start, end) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.orsConfig.timeout);

        try {
            const response = await axios({
                method: 'post',
                url: this.orsConfig.url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this.orsConfig.apiKey
                },
                data: {
                    coordinates: [
                        [start.lon, start.lat],
                        [end.lon, end.lat]
                    ],
                    extra_info: ['waytype', 'steepness', 'surface']
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            return response.data;
        } catch (error) {
            clearTimeout(timeoutId);
            throw this.enhanceError(error, 'Route data fetch failed');
        }
    }

    async processRouteData(routeData) {
        const feature = routeData.features[0];
        const coords = feature.geometry.coordinates;
        const totalDistance = feature.properties.summary?.distance || this.computeTotalDistance(coords);

        const waytypeGroups = this.extractWaytypeGroups(feature);
        const segments = this.analyzeSegments(waytypeGroups, coords, totalDistance);

        return {
            segments,
            worstRoad: this.determineWorstRoad(segments),
            geometry: turf.lineString(coords),
            totalDistance
        };
    }
    //#endregion

    //#region Analysis Enhancements
    async enhanceWithHazards(analysis) {
        console.log('Enhancing analysis with hazards...');
        console.log('Analysis:', analysis);
        try {
            const hazardLine = await this.createHazardLineString(analysis.segments, analysis.geometry);
            console.log('Hazard line:', hazardLine);

            console.log('Querying hazards...');
            const hazards = await this.queryHazards(hazardLine);
            console.log('Hazards:', hazards);

            return {
                ...analysis,
                hazards: {
                    bridges: hazards.bridges,
                    waterCrossings: hazards.water,
                    compositeRisk: this.calculateCompositeRisk(hazards)
                }
            };
        } catch (error) {
            console.warn('Hazard analysis partial failure:', error);
            return analysis; // Return basic analysis
        }
    }

    // Improved spatial query with buffered bounding box
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

    // Enhanced hazard analysis with caching
    async queryHazards(geometry) {
        const cacheKey = `hazards_${this.hashGeometry(geometry)}`;
        const cached = this.overpassCache.get(cacheKey);
        if (cached) return cached;

        await this.rateLimitCheck();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.overpassConfig.timeout);

        try {
            // Ensure the query is awaited before use
            const query = await this.buildOverpassQuery(geometry);
            console.log('Query:', query);

            const response = await axios.post(
                this.overpassConfig.url,
                `data=${encodeURIComponent(query)}`, // Correctly format the body
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    signal: controller.signal
                }
            );

            console.log('Response:', response.data);

            if (!this.validateApiResponse(response.data, 'overpass')) {
                throw new Error('Invalid hazard data format');
            }

            const result = {
                bridges: this.processBridgeElements(response.data),
                water: this.processWaterElements(response.data),
                landslides: this.processLandslideElements(response.data)
            };

            this.overpassCache.set(cacheKey, result);
            return result;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // Improved risk calculation with configurable weights
    calculateCompositeRisk(hazards) {
        const bridgeRisk = Math.min(hazards.bridges.length * this.roadMetrics.hazardWeights.bridge, 1);
        const waterRisk = Math.min(hazards.water.length * this.roadMetrics.hazardWeights.water, 1);
        const landslideRisk = Math.min(hazards.landslides.length * this.roadMetrics.hazardWeights.landslide, 1);

        return (bridgeRisk + waterRisk + landslideRisk) / 3;
    }

    // Memory-optimized coordinate processing
    createHazardLineString(segments, routeGeometry) {
        const MAX_POINTS = 1000;
        const coordinates = [];

        console.log('Processing coordinates for hazard line...');
        console.log('Segments:', segments);

        for (const seg of segments) {
            coordinates.push(...seg.coordinates.map(([lon, lat]) => [
                this.truncateCoordinate(lon),
                this.truncateCoordinate(lat)
            ]));

            if (coordinates.length > MAX_POINTS) {
                coordinates.length = MAX_POINTS;
                break;
            }
        }

        return coordinates.length > 1 ? turf.lineString(coordinates) : routeGeometry;
    }

    // New validation system
    validateApiResponse(response, type = 'ors') {
        const ajv = new Ajv({ strict: false });
        const schema = type === 'ors' ? orsSchema : overpassSchema;
        return ajv.validate(schema, response);
    }

    // Rate limiting implementation
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

    // Utility improvements
    truncateCoordinate(coord) {
        return parseFloat(coord.toFixed(6));
    }

    hashGeometry(geometry) {
        return turf.centroid(geometry).geometry.coordinates
            .map(c => c.toFixed(6)).join('-');
    }

    generateCacheKey(start, end) {
        return [start.lat, start.lon, end.lat, end.lon]
            .map(c => c.toFixed(6)).join('_');
    }


    //#region Helper Methods
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

    extractWaytypeGroups(feature) {
        const fallbackGroup = [{
            start_index: 0,
            end_index: feature.geometry.coordinates.length - 1,
            value: 'unclassified'
        }];

        return feature.properties.extra_info?.waytype?.groups || fallbackGroup;
    }

    analyzeSegments(groups, coords, totalDistance) {
        return groups.map(group => {
            const segmentCoords = coords.slice(group.start_index, group.end_index + 1);
            const length = this.computeSegmentLength(segmentCoords);

            return {
                roadType: group.value,
                length,
                percentage: (length / totalDistance) * 100,
                ranking: this.roadMetrics.ranking[group.value] || this.roadMetrics.ranking.default,
                weight: this.roadMetrics.weights[group.value] || this.roadMetrics.weights.default,
                coordinates: segmentCoords
            };
        });
    }

    computeSegmentLength(coords) {
        return coords.slice(1).reduce((total, [lon, lat], i) => {
            const [prevLon, prevLat] = coords[i];
            return total + this.haversineDistance(prevLat, prevLon, lat, lon);
        }, 0);
    }

    determineWorstRoad(segments) {
        return segments.reduce((worst, current) => {
            const currentScore = current.ranking * current.weight;
            const worstScore = worst.ranking * worst.weight;

            if (currentScore === worstScore) {
                return current.length > worst.length ? current : worst; // Stable sorting
            }

            return currentScore > worstScore ? current : worst;
        }, { ranking: -Infinity, weight: 1, length: 0 });
    }

    //#region Hazard Analysis
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
    //#endregion

    //#region Utilities
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

    computeTotalDistance(coords) {
        return coords.slice(1).reduce((total, [lon, lat], i) => {
            const [prevLon, prevLat] = coords[i];
            return total + this.haversineDistance(prevLat, prevLon, lat, lon);
        }, 0);
    }

    formatResults(analysis, rawData) {
        return {
            segments: analysis.segments.map(seg => ({
                roadType: seg.roadType,
                length: seg.length,
                percentage: seg.percentage,
                qualityScore: (1 - (seg.ranking / 10)) ** 2 * seg.weight * seg.percentage
            })),
            overallQuality: analysis.segments.reduce((sum, seg) =>
                sum + (1 - (seg.ranking / 10)) ** 2 * seg.weight * seg.percentage, 0),
            riskAssessment: {
                worstRoadType: analysis.worstRoad.roadType,
                hazardRisk: analysis.hazards?.compositeRisk || 0, // Safe access in case of errors
                bridges: analysis.hazards?.bridges?.length || 0,
                waterCrossings: analysis.hazards?.water?.length || 0,
                landslides: analysis.hazards?.landslides?.length || 0
            },
            metadata: {
                distance: analysis.totalDistance,
                coordinates: analysis.geometry.geometry.coordinates
            },
            rawData
        };
    }

    enhanceError(error, context) {
        return Object.assign(new Error(`${context}: ${error.message}`), { original: error });
    }

    handleError(error, context) {
        console.error(`${context}:`, error);
        throw this.enhanceError(error, context);
    }
}

module.exports = FarmRouteAnalyzer;
