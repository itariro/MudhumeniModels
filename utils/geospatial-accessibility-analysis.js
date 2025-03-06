const axios = require('axios');
const turf = require('@turf/turf');
const winston = require('winston');
const AgriculturalLandAnalyzer = require('./elevation-analysis');

// Configure structured logging
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        }),
        new winston.transports.File({
            filename: 'geospatial-accessibility.log',
            maxsize: 10 * 1024 * 1024 // 10MB
        })
    ]
});

class GeospatialCache {
    constructor(cleanupInterval = 300000) { // 5 minutes default
        this._cacheMap = new Map();
        this._timers = new Map();

        // Set up automatic cleanup
        this._cleanupInterval = setInterval(() => this.cleanup(), cleanupInterval);
    }

    set(key, value, ttl) {
        this._cacheMap.set(key, value);

        // Clear any existing timer
        if (this._timers.has(key)) {
            clearTimeout(this._timers.get(key));
        }

        // Set new expiration timer
        const timer = setTimeout(() => {
            this._cacheMap.delete(key);
            this._timers.delete(key);
        }, ttl);

        this._timers.set(key, timer);

        return value;
    }

    get(key) {
        return this._cacheMap.get(key);
    }

    has(key) {
        return this._cacheMap.has(key);
    }

    delete(key) {
        if (this._timers.has(key)) {
            clearTimeout(this._timers.get(key));
            this._timers.delete(key);
        }
        return this._cacheMap.delete(key);
    }

    cleanup() {
        // Nothing to do - expiration is handled by individual timers
    }

    clear() {
        // Clear all timers
        this._timers.forEach(timer => clearTimeout(timer));

        // Clear maps
        this._timers.clear();
        this._cacheMap.clear();
    }

    dispose() {
        this.clear();
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
        }
    }

    size() {
        return this._cacheMap.size;
    }
}

class GeospatialAccessibilityAssessment {
    constructor(lat, long) {
        this.lat = lat;
        this.long = long;
        this.countryCode = null;
        this.cache = new GeospatialCache();

        this.config = {
            cacheTTL: {
                floodData: 3600000, // 1 hour
                roads: 1800000,     // 30 minutes
                countryCode: 86400000 // 24 hours
            },
            thresholds: {
                minorRoadFloodRadius: 5000, // meters
                maxRouteDistance: 100000,    // meters
                floodRiskWeights: {
                    elevation: 0.5,
                    waterProximity: 0.3,
                    historical: 0.2
                }
            },
            apis: {
                overpass: {
                    endpoint: process.env.OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter',
                    timeout: 20000
                },
                openRouteService: {
                    key: process.env.ORS_API_KEY,
                    endpoint: process.env.ORS_ENDPOINT || 'https://api.openrouteservice.org/v2'
                },
                nominatim: {
                    baseURL: 'https://nominatim.openstreetmap.org',
                    email: process.env.NOMINATIM_EMAIL || 'contact@example.com' // Should be configurable
                }
            }
        };
    }

    // Core functionality
    async assessAccessibility() {
        try {
            const [countryCode, roads, floodRisk, transport] = await Promise.all([
                this.getCountryCode(),
                this.getRoadData(),
                this.assessFloodRisk(),
                this.analyzeTransportRoute()
            ]);

            const scores = await this.calculateComponentScores(roads, floodRisk, transport);

            return {
                score: this.calculateCompositeScore(scores),
                components: scores,
                metadata: {
                    countryCode,
                    coordinates: [this.lat, this.long],
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            logger.error('Critical assessment failure', { error: error.stack });
            return this.generateFallbackAssessment(error);
        }
    }

    // Flood risk assessment with minor road consideration
    async assessFloodRisk() {
        try {
            const [locationRisk, roads] = await Promise.all([
                this.getFloodRisk(this.lat, this.long),
                this.getRoadData()
            ]);

            let roadRisk = 0;
            if (roads.minor.distance < this.config.thresholds.minorRoadFloodRadius) {
                const roadRiskData = await this.getFloodRisk(
                    roads.minor.point[1],
                    roads.minor.point[0]
                );
                roadRisk = roadRiskData.riskLevel;
            }

            return {
                ...locationRisk,
                roadRisk,
                combinedRisk: Math.max(locationRisk.riskLevel, roadRisk)
            };
        } catch (error) {
            logger.warn('Flood risk assessment degraded', { error: error.message });
            return this.getHistoricalFloodRisk();
        }
    }

    // Road data with caching and fallback
    async getRoadData() {
        const cacheKey = `roads-${this.lat},${this.long}`;

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            const data = await this.fetchRoadData();
            this.cache.set(cacheKey, data, this.config.cacheTTL.roads);
            return data;
        } catch (error) {
            logger.warn('Using cached road data', { error: error.message });
            return this.cache.get(cacheKey) || this.generateRoadFallback();
        }
    }

    // Enhanced transport analysis
    async analyzeTransportRoute() {
        try {
            const settlements = await this.findNearbySettlements();
            const target = this.selectOptimalSettlement(settlements);

            if (!target) return null;

            const route = await this.fetchRouteData(target.coords);
            return this.processRouteData(route);
        } catch (error) {
            logger.warn('Transport analysis degraded', { error: error.message });
            return null;
        }
    }

    // TODO: Implement the following methods    
    async selectOptimalSettlement(settlements) {
        if (!settlements || !Array.isArray(settlements) || settlements.length === 0) {
            logger.warn('No settlements provided for optimization');
            return null;
        }

        try {
            // Pre-fetch road data and flood risk once to avoid multiple API calls
            const roadData = await this.getRoadData();
            const floodRiskData = await this.getFloodRisk(this.lat, this.long);

            // Process settlements in parallel for better performance
            const scoredSettlements = await Promise.all(
                settlements.map(async settlement => {
                    try {
                        if (!settlement || !settlement.coords || !Array.isArray(settlement.coords)) {
                            logger.warn('Invalid settlement data', { settlement });
                            return { ...settlement, score: 0 };
                        }

                        const distance = turf.distance(
                            [this.long, this.lat],
                            settlement.coords,
                            { units: 'kilometers' }
                        );

                        // Use pre-fetched data rather than calling APIs again
                        const score = this.calculateSettlementScore({
                            population: settlement.population || 0,
                            distance: distance,
                            facilities: settlement.facilities || [],
                            roadQuality: roadData?.quality || 0.5,
                            floodRisk: floodRiskData?.combinedRisk || 0.5
                        });

                        return {
                            ...settlement,
                            distance,
                            score
                        };
                    } catch (error) {
                        logger.warn('Error scoring settlement', {
                            settlement: settlement.name,
                            error: error.message
                        });
                        return { ...settlement, score: 0 };
                    }
                })
            );

            // Find the settlement with the highest score
            return scoredSettlements.reduce((optimal, current) => {
                if (!optimal || (current.score > optimal.score)) {
                    return current;
                }
                return optimal;
            }, null);

        } catch (error) {
            logger.warn('Settlement selection degraded', { error: error.message });

            // Return the closest settlement as fallback
            if (settlements.length > 0) {
                const withDistances = settlements.map(s => {
                    try {
                        const distance = turf.distance(
                            [this.long, this.lat],
                            s.coords,
                            { units: 'kilometers' }
                        );
                        return { ...s, distance };
                    } catch (e) {
                        return { ...s, distance: Infinity };
                    }
                });

                return withDistances.sort((a, b) => a.distance - b.distance)[0];
            }

            return null;
        }
    }

    calculateSettlementScore({ population = 0, distance = 0, facilities = [], roadQuality = 0.5, floodRisk = 0.5 }) {
        // Base weights for each factor
        const weights = {
            population: 0.25,
            distance: 0.3,
            facilities: 0.2,
            roadQuality: 0.15,
            floodRisk: 0.1
        };

        // Normalize population (assuming max population of 1M)
        const normalizedPopulation = Math.min(population / 1000000, 1);

        // Normalize distance (inverse relationship - closer is better)
        // Assuming max reasonable distance is 100km
        const normalizedDistance = Math.max(0, 1 - (distance / 100));

        // Normalize facilities score with safer implementation
        let facilityScore = 0;
        if (Array.isArray(facilities) && facilities.length > 0) {
            // Define facility weights
            const facilityWeights = {
                hospital: 1.0,
                school: 0.8,
                market: 0.6,
                waterSource: 0.9,
                powerStation: 0.7
            };

            // Calculate total facility weight
            let totalWeight = 0;
            let weightSum = 0;

            facilities.forEach(facility => {
                if (facility && typeof facility === 'object' && facility.type) {
                    const weight = facilityWeights[facility.type] || 0.5;
                    weightSum += weight;
                    totalWeight += 1;
                }
            });

            facilityScore = totalWeight > 0 ? weightSum / totalWeight : 0;
        }

        // Ensure road quality is within bounds
        const normalizedRoadQuality = Math.max(0, Math.min(1, roadQuality));

        // Ensure flood risk is within bounds and inverse (lower risk is better)
        const normalizedFloodRisk = Math.max(0, Math.min(1, 1 - floodRisk));

        // Calculate weighted score
        const score = (
            weights.population * normalizedPopulation +
            weights.distance * normalizedDistance +
            weights.facilities * facilityScore +
            weights.roadQuality * normalizedRoadQuality +
            weights.floodRisk * normalizedFloodRisk
        );

        // Return normalized score between 0-100
        return Math.round(Math.max(0, Math.min(100, score * 100)));
    }

    async getElevationProfile(coordinates) {
        try {
            // Check if coordinates array is valid
            if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0) {
                logger.warn('Invalid coordinates for elevation profile');
                return [];
            }

            const elevationData = [];
            // Sample points with increased step to reduce API calls
            const step = Math.max(1, Math.floor(coordinates.length / 20)); // Limit to max 20 API calls

            for (let i = 0; i < coordinates.length; i += step) {
                const [lon, lat] = coordinates[i];
                // Check if AgriculturalLandAnalyzer is available
                if (!AgriculturalLandAnalyzer || !AgriculturalLandAnalyzer.fetchSinglePointElevation) {
                    throw new Error('Elevation analysis module not available');
                }

                const elevation = await AgriculturalLandAnalyzer.fetchSinglePointElevation(lat, lon);
                elevationData.push({
                    distance: i / coordinates.length, // Normalize distance to 0-1 range
                    elevation: elevation && elevation.elevation ? elevation.elevation : 0
                });
            }
            return elevationData;
        } catch (error) {
            logger.error('Error fetching elevation data:', error);
            // Return empty array with warning flag
            return [];
        }
    }

    async calculateTerrainMetrics(elevationProfile) {
        // Check if profile is valid
        if (!elevationProfile || !Array.isArray(elevationProfile) || elevationProfile.length < 2) {
            return { totalAscent: 0, totalDescent: 0, maxGradient: 0 };
        }

        let totalAscent = 0;
        let totalDescent = 0;
        let maxGradient = 0;

        // Single pass through the array for better performance
        for (let i = 1; i < elevationProfile.length; i++) {
            const current = elevationProfile[i];
            const previous = elevationProfile[i - 1];

            // Skip invalid data points
            if (!current || !previous ||
                typeof current.elevation !== 'number' ||
                typeof previous.elevation !== 'number') {
                continue;
            }

            const elevationDiff = current.elevation - previous.elevation;
            const distance = Math.abs(current.distance - previous.distance);

            // Avoid division by zero
            if (distance > 0) {
                const gradient = (elevationDiff / distance) * 100;
                maxGradient = Math.max(maxGradient, Math.abs(gradient));

                if (elevationDiff > 0) {
                    totalAscent += elevationDiff;
                } else if (elevationDiff < 0) {
                    totalDescent += Math.abs(elevationDiff);
                }
            }
        }

        return { totalAscent, totalDescent, maxGradient };
    }

    async analyzeRoadConditions(coordinates) {
        try {
            const conditions = {
                surfaceType: 'unknown',
                quality: 0.5,
                hazards: []
            }

            // TODO: Implement road data analysis using external APIs
            // const roadData = await this.mapService.getRoadData(coordinates)

            // if (roadData) {
            //     conditions.surfaceType = roadData.surface || 'unknown'
            //     conditions.quality = this.calculateRoadQuality(roadData)
            //     conditions.hazards = roadData.hazards || []
            // }

            return conditions
        } catch (error) {
            console.error('Error analyzing road conditions:', error)
            return { surfaceType: 'unknown', quality: 0.5, hazards: [] }
        }
    }

    async calculateRoadQuality(roadData) {
        if (!roadData) {
            return 0.5; // Default quality if no data available
        }

        let qualityScore = 1.0

        // Reduce quality based on surface condition
        if (roadData.condition) {
            switch (roadData.condition.toLowerCase()) {
                case 'excellent':
                    qualityScore *= 1.0
                    break
                case 'good':
                    qualityScore *= 0.9
                    break
                case 'fair':
                    qualityScore *= 0.7
                    break
                case 'poor':
                    qualityScore *= 0.5
                    break
                case 'very_poor':
                    qualityScore *= 0.3
                    break
                default:
                    qualityScore *= 0.5
            }
        }

        // Reduce quality based on reported hazards
        if (roadData.hazards && roadData.hazards.length > 0) {
            const hazardPenalty = Math.min(roadData.hazards.length * 0.1, 0.5)
            qualityScore *= (1 - hazardPenalty)
        }

        // Adjust for maintenance status
        if (roadData.lastMaintenance) {
            const monthsSinceLastMaintenance = (new Date() - new Date(roadData.lastMaintenance)) / (1000 * 60 * 60 * 24 * 30)
            if (monthsSinceLastMaintenance > 12) {
                qualityScore *= 0.9
            }
        }

        // Adjust for weather damage if available
        if (roadData.weatherDamage) {
            qualityScore *= (1 - roadData.weatherDamage * 0.2)
        }

        // Ensure quality score stays within 0.1 to 1.0 range
        return Math.max(0.1, Math.min(1.0, qualityScore))
    }

    async calculateWalkingTime(distance, maxGradient) {
        // Average walking speed: 5 km/h on flat ground
        let baseSpeed = 5

        // Adjust speed based on gradient
        if (maxGradient > 5) {
            baseSpeed *= (1 - (maxGradient - 5) * 0.05)
        }

        // Calculate time in hours
        const time = distance / Math.max(baseSpeed, 2) // Minimum speed of 2 km/h

        return time * 60 // Convert to minutes
    }

    async calculateDrivingTime(distance, roadConditions) {
        // Base speed depending on road surface type
        const speedLimits = {
            'paved': 80,
            'gravel': 40,
            'dirt': 30,
            'unknown': 50
        }

        let baseSpeed = speedLimits[roadConditions.surfaceType] || 50

        // Adjust speed based on road quality (0-1)
        baseSpeed *= Math.max(0.5, roadConditions.quality)

        // Calculate time in hours
        const time = distance / baseSpeed

        return time * 60 // Convert to minutes
    }

    async calculateCyclingTime(distance, maxGradient, roadConditions) {
        // Average cycling speed: 20 km/h on flat ground
        let baseSpeed = 20

        // Adjust speed based on gradient
        if (maxGradient > 3) {
            baseSpeed *= (1 - (maxGradient - 3) * 0.1)
        }

        // Adjust speed based on road conditions
        baseSpeed *= Math.max(0.6, roadConditions.quality)

        // Calculate time in hours
        const time = distance / Math.max(baseSpeed, 5) // Minimum speed of 5 km/h

        return time * 60 // Convert to minutes
    }

    async calculateAccessibilityScore({ distance, maxGradient, roadConditions, travelTimes }) {
        // Weights for different factors
        const weights = {
            distance: 0.3,
            gradient: 0.2,
            roadQuality: 0.2,
            travelTimes: 0.3
        }

        // Normalize distance (inverse relationship - closer is better)
        const normalizedDistance = Math.max(0, 1 - (distance / 100)) // Assuming max distance of 100km

        // Normalize gradient (inverse relationship - flatter is better)
        const normalizedGradient = Math.max(0, 1 - (maxGradient / 30)) // Assuming max gradient of 30%

        // Road quality is already normalized (0-1)
        const normalizedRoadQuality = roadConditions.quality

        // Normalize travel times (inverse relationship - faster is better)
        const normalizedTravelTimes = {
            walking: Math.max(0, 1 - (travelTimes.walking / 180)), // Max 3 hours
            driving: Math.max(0, 1 - (travelTimes.driving / 120)), // Max 2 hours
            cycling: Math.max(0, 1 - (travelTimes.cycling / 150))  // Max 2.5 hours
        }
        const avgTravelTimeScore = Object.values(normalizedTravelTimes).reduce((a, b) => a + b, 0) / 3

        // Calculate final score
        const score = (
            weights.distance * normalizedDistance +
            weights.gradient * normalizedGradient +
            weights.roadQuality * normalizedRoadQuality +
            weights.travelTimes * avgTravelTimeScore
        )

        // Return normalized score between 0-100
        return Math.round(score * 100)
    }

    async processRouteData(route) {
        if (!route || !route.features || !route.features.length) {
            logger.warn('Invalid route data received');
            return null;
        }

        try {
            const routeFeature = route.features[0];
            const coordinates = routeFeature.geometry.coordinates;

            // Validate coordinates
            if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
                logger.warn('Invalid route coordinates');
                return null;
            }

            const distance = turf.length(routeFeature, { units: 'kilometers' });

            // Get elevation data with error handling
            let elevationProfile = [];
            let terrainMetrics = { totalAscent: 0, totalDescent: 0, maxGradient: 0 };

            try {
                elevationProfile = await this.getElevationProfile(coordinates);
                if (elevationProfile && elevationProfile.length > 1) {
                    terrainMetrics = await this.calculateTerrainMetrics(elevationProfile);
                }
            } catch (error) {
                logger.warn('Elevation analysis failed, using defaults', { error: error.message });
            }

            // Analyze road conditions with error handling
            let roadConditions;
            try {
                roadConditions = await this.analyzeRoadConditions(coordinates);
            } catch (error) {
                logger.warn('Road condition analysis failed, using defaults', { error: error.message });
                roadConditions = { surfaceType: 'unknown', quality: 0.5, hazards: [] };
            }

            // Calculate travel times with proper error handling
            let travelTimes = {};
            try {
                travelTimes = {
                    walking: await this.calculateWalkingTime(distance, terrainMetrics.maxGradient),
                    driving: await this.calculateDrivingTime(distance, roadConditions),
                    cycling: await this.calculateCyclingTime(distance, terrainMetrics.maxGradient, roadConditions)
                };
            } catch (error) {
                logger.warn('Travel time calculation failed, using estimates', { error: error.message });
                // Fallback estimates based on distance
                travelTimes = {
                    walking: distance * 12, // 5 km/h pace
                    driving: distance * 1.5, // 40 km/h pace
                    cycling: distance * 4 // 15 km/h pace
                };
            }

            // Calculate accessibility score with error handling
            let accessibility = 50; // Default middling score
            try {
                accessibility = await this.calculateAccessibilityScore({
                    distance,
                    maxGradient: terrainMetrics.maxGradient,
                    roadConditions,
                    travelTimes
                });
            } catch (error) {
                logger.warn('Accessibility score calculation failed', { error: error.message });
            }

            return {
                distance,
                elevationProfile: terrainMetrics,
                roadConditions,
                travelTimes,
                coordinates: coordinates.length > 100 ? coordinates.filter((_, i) => i % 5 === 0) : coordinates, // Downsample if needed
                duration: routeFeature.properties?.duration || travelTimes.driving,
                accessibility
            };
        } catch (error) {
            logger.error('Route processing failed', { error: error.message });
            return null;
        }
    }

    /**
     * Finds nearby settlements within a specified radius.
     *
     * @param {number} [radiusKm=2] - The radius in kilometers to search for nearby settlements.
     * @returns {Promise<Array<{ name: string, type: string, coords: [number, number], distance: number }>>} - An array of nearby settlements with their name, type, coordinates, and distance from the current location.
     */
    async findNearbySettlements(radiusKm = 2) {
        const buffer = turf.buffer(turf.point([this.long, this.lat]), radiusKm, { units: 'kilometers' });
        const bbox = turf.bbox(buffer);
        const query = `[out:json][timeout:30];
      node[place~"town|village|hamlet|cities"](${bbox});
      out body;`;

        logger.info('making request to overpass api');
        const data = await this.makeApiRequest(this.config.apis.overpass.endpoint, { data: query });
        logger.info('response from overpass api', { data });
        
        return data.elements
            .map(el => ({
                name: el.tags.name,
                type: el.tags.place,
                coords: [el.lon, el.lat],
                distance: turf.distance(
                    turf.point([this.long, this.lat]),
                    turf.point([el.lon, el.lat])
                )
            }))
            .filter(s => s.distance <= radiusKm)
            .sort((a, b) => a.distance - b.distance);
    }

    // Helper methods
    async getCountryCode() {
        if (this.countryCode) return this.countryCode;

        const cacheKey = `country-${this.lat},${this.long}`;
        if (this.cache.has(cacheKey)) {
            this.countryCode = this.cache.get(cacheKey);
            return this.countryCode;
        }

        try {
            const data = await this.reverseGeocode();
            this.countryCode = data.address.country_code.toUpperCase();
            this.cache.set(cacheKey, this.countryCode, this.config.cacheTTL.countryCode);
            return this.countryCode;
        } catch (error) {
            logger.error('Country code detection failed', { error: error.message });
            return 'UNKNOWN';
        }
    }

    // Risk calculation engine
    calculateFloodRisk(elevation, waterDistance) {
        const elevationRisk = Math.min(1, Math.max(0, (10 - elevation) / 10));
        const waterRisk = 1 - Math.min(1, waterDistance / 5000);
        const historicalRisk = this.getHistoricalFloodRisk();

        return (
            elevationRisk * this.config.thresholds.floodRiskWeights.elevation +
            waterRisk * this.config.thresholds.floodRiskWeights.waterProximity +
            historicalRisk * this.config.thresholds.floodRiskWeights.historical
        );
    }

    // Historical risk data from flood APIs
    async getHistoricalFloodRisk(lat = this.lat, long = this.long) {
        const cacheKey = `flood-risk-historical-${lat}-${long}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            // Implement more robust error handling for API requests
            let gfmsEvents = [];
            let dfoEvents = [];

            try {
                // NASA GFMS (Global Flood Monitoring System) API
                const gfmsResponse = await axios.get('https://flood.nasa.gov/gfms/api/flood/historical', {
                    params: {
                        lat: lat,
                        lon: long,
                        start: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(), // Last year
                        end: new Date().toISOString()
                    },
                    timeout: 10000
                });
                gfmsEvents = gfmsResponse.data.events || [];
            } catch (error) {
                logger.warn('GFMS API request failed', { error: error.message });
            }

            try {
                // DFO (Dartmouth Flood Observatory) API for historical records
                const dfoResponse = await axios.get('https://floodobservatory.colorado.edu/api/events', {
                    params: {
                        bbox: `${long - 1},${lat - 1},${long + 1},${lat + 1}`,
                        from: '1985-01-01'
                    },
                    timeout: 10000
                });
                dfoEvents = dfoResponse.data.features || [];
            } catch (error) {
                logger.warn('DFO API request failed', { error: error.message });
            }

            // Calculate risk based on frequency and severity
            const annualFrequency = gfmsEvents.length / 1; // Events per year
            const historicalFrequency = dfoEvents.length / 38; // Events since 1985

            // Normalize and combine risk factors
            const normalizedGFMS = Math.min(1, annualFrequency / 4); // Cap at 4 events per year
            const normalizedDFO = Math.min(1, historicalFrequency * 5); // Weight historical events

            const combinedRisk = (normalizedGFMS * 0.6) + (normalizedDFO * 0.4);

            // Cache the result
            this.cache.set(cacheKey, combinedRisk, 24 * 60 * 60 * 1000); // 24 hour cache

            return combinedRisk;
        } catch (error) {
            logger.error('Historical flood risk calculation failed', {
                error: error.message,
                location: `${lat},${long}`
            });
            // Return a moderately cautious default risk level
            return 0.2; // Fallback to base risk
        }
    }

    // API integrations
    async fetchRoadData() {
        const bbox = this.generateSearchBoundingBox(10000); // 10km radius
        const query = this.buildOverpassQuery(bbox);

        try {
            const response = await this.makeApiRequest(
                this.config.apis.overpass.endpoint,
                { data: query },
                { service: 'overpass' }
            );
            return this.processRoadResponse(response);
        } catch (error) {
            logger.error('Road data fetch failed', { error: error.message });
            throw error;
        }
    }

    async fetchRouteData(targetCoords) {
        const params = {
            start: `${this.long},${this.lat}`,
            end: `${targetCoords[0]},${targetCoords[1]}`,
            profile: 'driving-car'
        };

        try {
            return await this.makeApiRequest(
                `${this.config.apis.openRouteService.endpoint}/directions/driving-car/json`,
                params,
                { service: 'ors' }
            );
        } catch (error) {
            logger.error('Route data fetch failed', { error: error.message });
            throw error;
        }
    }

    // Resilient API handler
    async makeApiRequest(url, params, context = {}) {
        const cacheKey = `${url}:${JSON.stringify(params)}`;

        // Check cache first
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        // Implement retry logic
        const maxRetries = context.maxRetries || 2;
        let retries = 0;
        let lastError = null;

        while (retries <= maxRetries) {
            try {
                const timeout = context.service === 'overpass'
                    ? this.config.apis.overpass.timeout
                    : 15000;

                const response = await axios.get(url, {
                    params,
                    timeout: timeout,
                    headers: this.getAuthHeaders(context.service),
                    // Add exponential backoff
                    ...(retries > 0 ? {
                        timeout: timeout * (1 + retries * 0.5)
                    } : {})
                });

                // Validate response
                if (!response || !response.data) {
                    throw new Error('Empty response received');
                }

                // Cache successful response
                this.cache.set(cacheKey, response.data, this.getCacheTTL(context.service));
                return response.data;
            } catch (error) {
                lastError = error;

                // Check if error is retryable
                const isRetryable = error.code === 'ECONNABORTED' ||
                    error.code === 'ETIMEDOUT' ||
                    (error.response && error.response.status >= 500);

                if (!isRetryable) {
                    break;
                }

                retries++;

                // Log retry attempt
                logger.warn(`API request failed, retrying (${retries}/${maxRetries})`, {
                    url,
                    service: context.service,
                    error: error.message
                });

                // Wait before retrying with exponential backoff
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retries - 1)));
            }
        }

        // All retries failed
        logger.error(`API request failed after ${retries} retries (${context.service})`, {
            url,
            params,
            error: lastError.message
        });
        throw lastError;
    }

    /**
     * Generates a bounding box around the target coordinates with specified radius
     * @param {number} radius - Search radius in meters
     * @returns {Array<number>} [minLon, minLat, maxLon, maxLat]
     */
    generateSearchBoundingBox(radius) {
        try {
            const point = turf.point([this.long, this.lat]);
            const buffered = turf.buffer(point, radius / 1000, { units: 'kilometers' });
            return turf.bbox(buffered);
        } catch (error) {
            logger.error('Bounding box generation failed', { error: error.message });
            return [
                this.long - 0.1,
                this.lat - 0.1,
                this.long + 0.1,
                this.lat + 0.1
            ];
        }
    }

    /**
     * Constructs optimized Overpass QL query for road detection
     * @param {Array<number>} bbox - Bounding box coordinates
     * @returns {string} Overpass QL query
     */
    buildOverpassQuery(bbox) {
        // Validate bbox
        if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
            logger.warn('Invalid bbox for Overpass query', { bbox });
            // Use default bbox around the location
            bbox = [
                this.long - 0.1,
                this.lat - 0.1,
                this.long + 0.1,
                this.lat + 0.1
            ];
        }

        // Make sure bbox coordinates are in the correct order
        const [minLon, minLat, maxLon, maxLat] = bbox;

        return `[out:json][timeout:25];
        (
            way[highway~"motorway|trunk|primary|secondary|tertiary|unclassified|residential"]
                (${minLat},${minLon},${maxLat},${maxLon});
            node[highway~"motorway|trunk|primary|secondary|tertiary|unclassified|residential"]
                (${minLat},${minLon},${maxLat},${maxLon});
        );
        out body 100;
        >;
        out skel qt;`;
    }

    /**
     * Processes raw Overpass API response into structured road data
     * @param {Object} response - Overpass API response
     * @returns {Object} Processed road data
     */
    processRoadResponse(response) {
        const targetPoint = turf.point([this.long, this.lat]);
        const results = {
            minor: { distance: Infinity, point: null },
            major: { distance: Infinity, point: null },
            roads: []
        };

        try {
            response.elements.forEach(element => {
                if (!element.tags?.highway) return;

                try {
                    const coords = element.geometry?.map(p => [p.lon, p.lat]);
                    if (!coords || coords.length < 2) return;

                    const line = turf.lineString(coords);
                    const nearest = turf.nearestPointOnLine(line, targetPoint);
                    const distance = turf.convertDistance(
                        nearest.properties.dist,
                        'kilometers'
                    ) * 1000; // Convert to meters

                    const roadType = this._classifyRoad(
                        element.tags.highway,
                        this.countryCode
                    );

                    if (distance < results[roadType].distance) {
                        results[roadType] = {
                            distance,
                            point: nearest.geometry.coordinates,
                            type: element.tags.highway,
                            osmId: element.id
                        };
                    }

                    results.roads.push({
                        type: roadType,
                        distance,
                        osmId: element.id,
                        geometry: coords
                    });
                } catch (e) {
                    logger.warn('Invalid road element skipped', { error: e.message });
                }
            });
        } catch (error) {
            logger.error('Road processing failed', { error: error.message });
        }

        return results;
    }

    async _classifyRoad(highwayType, countryCode) {
        // Major road types that are consistent across countries
        const majorRoads = new Set([
            'motorway',
            'trunk',
            'primary',
            'secondary',
            'motorway_link',
            'trunk_link',
            'primary_link',
            'secondary_link'
        ])

        // Minor road types that are consistent across countries
        const minorRoads = new Set([
            'tertiary',
            'residential',
            'tertiary_link',
            'unclassified',
            'service',
            'living_street'
        ])

        // Country-specific classifications 
        // TODO: add dynamic country specific road classifications
        const countrySpecificClassifications = {
            'ZW': { // Zimbabwe
                major: new Set(['national_road', 'regional_road']),
                minor: new Set(['district_road', 'rural_road'])
            },
            'ZM': { // Zambia
                major: new Set(['trunk_road', 'main_road']),
                minor: new Set(['district_road', 'feeder_road'])
            },
            'MZ': { // Mozambique
                major: new Set(['estrada_nacional', 'estrada_regional']),
                minor: new Set(['estrada_distrital', 'estrada_vicinal'])
            },
            'BW': { // Botswana
                major: new Set(['primary_road', 'secondary_road']),
                minor: new Set(['tertiary_road', 'access_road'])
            },
            'NA': { // Namibia
                major: new Set(['trunk_road', 'main_road']),
                minor: new Set(['district_road', 'farm_road'])
            },
            'MW': { // Malawi
                major: new Set(['national_road', 'regional_road']),
                minor: new Set(['district_road', 'community_road'])
            },
        }

        try {
            // Check country-specific classifications first
            if (countryCode && countrySpecificClassifications[countryCode]) {
                if (countrySpecificClassifications[countryCode].major.has(highwayType)) {
                    return 'major'
                }
                if (countrySpecificClassifications[countryCode].minor.has(highwayType)) {
                    return 'minor'
                }
            }

            // Fall back to general classification
            if (majorRoads.has(highwayType)) {
                return 'major'
            }
            if (minorRoads.has(highwayType)) {
                return 'minor'
            }

            // Default classification for unknown types
            return 'minor'
        } catch (error) {
            logger.error('Road classification failed', {
                highwayType,
                countryCode,
                error: error.message
            })
            return 'minor'; // Safe default
        }
    }

    /**
     * Calculates normalized component scores from raw data
     * @param {Object} roads - Processed road data
     * @param {Object} floodRisk - Flood risk assessment
     * @param {Object|null} transport - Transport route analysis
     * @returns {Object} Normalized component scores
     */
    calculateComponentScores(roads, floodRisk, transport) {
        // Road accessibility score (exponential decay based on distance)
        const roadScore = Math.exp(-0.0002 * Math.min(
            roads.minor.distance,
            roads.major.distance
        ));

        // Flood safety score (1 - combined risk)
        const floodScore = 1 - Math.min(floodRisk.combinedRisk, 1);

        // Transport accessibility score
        let transportScore = 0.5; // Default neutral score
        if (transport) {
            const distanceScore = Math.exp(-0.00001 * transport.distance);
            const elevationPenalty = transport.elevationGain > 100 ? 0.8 : 1;
            transportScore = distanceScore * elevationPenalty;
        }

        // Settlement proximity score (example implementation)
        const settlementScore = Math.exp(-0.001 * (roads.minor.distance / 1000));

        return {
            road: Math.min(Math.max(roadScore, 0), 1),
            flood: Math.min(Math.max(floodScore, 0), 1),
            transport: Math.min(Math.max(transportScore, 0), 1),
            settlement: Math.min(Math.max(settlementScore, 0), 1)
        };
    }

    /**
     * Computes weighted composite score from component scores
     * @param {Object} scores - Normalized component scores
     * @returns {number} Final accessibility score (0-1)
     */
    calculateCompositeScore(scores) {
        const weights = {
            road: 0.3,
            flood: 0.25,
            transport: 0.25,
            settlement: 0.2
        };

        return Object.entries(weights).reduce((total, [key, weight]) => {
            return total + (scores[key] * weight);
        }, 0);
    }

    /**
     * Full flood risk assessment implementation with caching
     * @param {number} lat - Target latitude
     * @param {number} long - Target longitude
     * @returns {Promise<Object>} Flood risk assessment
     */
    async getFloodRisk(lat = this.lat, long = this.long) {
        const cacheKey = `flood-${lat},${long}`;

        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        try {
            const elevation = await AgriculturalLandAnalyzer.fetchSinglePointElevation(lat, long)
                .catch(err => {
                    logger.warn('Elevation data fetch failed', { error: err.message });
                    return { elevation: 0 };
                });

            const waterBodies = await this._findWaterBodies(lat, long)
                .catch(err => {
                    logger.warn('Water bodies detection failed', { error: err.message });
                    return { distance: Infinity, count: 0 };
                });

            const riskLevel = this.calculateFloodRisk(
                elevation.elevation || 0,
                waterBodies.distance || Infinity
            );

            const result = {
                elevation: elevation.elevation || 0,
                waterDistance: waterBodies.distance || Infinity,
                riskLevel,
                timestamp: new Date().toISOString()
            };

            this.cache.set(cacheKey, result, this.config.cacheTTL.floodData);
            return result;
        } catch (error) {
            logger.error('Flood risk assessment failed', { error: error.message });
            // Return historical data as fallback
            return this.getHistoricalFloodRisk(lat, long);
        }
    }

    /**
     * Finds the nearest water bodies within a 5km radius of the current location.
     *
     * @returns {Promise<{ count: number, distance: number }>} - An object containing the number of water bodies found and the distance to the nearest one.
     */
    async _findWaterBodies(lat = this.lat, long = this.long) {
        try {
            // Create buffer using correct turf.buffer syntax
            const point = turf.point([long, lat]);
            const buffer = turf.buffer(point, 5, { units: 'kilometers' });
            const bbox = turf.bbox(buffer);

            // Optimized Overpass query
            const query = `[out:json][timeout:15];
            (
              way["natural"="water"]["water"!="pond"]["water"!="pool"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
              relation["natural"="water"]["water"!="pond"]["water"!="pool"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});
            );
            out body 50;
            >;
            out skel qt;`;

            const data = await Promise.race([
                this.makeApiRequest(this.config.apis.overpass.endpoint, { data: query }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Overpass timeout')), 20000))
            ]);

            return this._processWaterBodies(data);
        } catch (error) {
            logger.warn('Water body detection failed, using fallback:', error.message);
            return this._fallbackWaterBodyDetection(lat, long);
        }
    }

    async _processWaterBodies(data) {
        if (!data || !data.elements || data.elements.length === 0) {
            return { count: 0, distance: Infinity };
        }

        try {
            const waterFeatures = data.elements
                .filter(element => element.type === 'way' || element.type === 'relation')
                .map(element => {
                    if (!element.geometry || element.geometry.length < 3) {
                        return null; // Ignore invalid geometries
                    }

                    let coordinates = element.geometry.map(node => [node.lon, node.lat]);

                    // Ensure the polygon is closed
                    if (coordinates.length >= 3 && !this.isSamePoint(coordinates[0], coordinates[coordinates.length - 1])) {
                        coordinates.push(coordinates[0]);
                    }

                    // Ensure it has at least 4 points after closing
                    if (coordinates.length < 4) {
                        return null;
                    }

                    return turf.polygon([coordinates]);
                })
                .filter(feature => feature !== null);

            if (waterFeatures.length === 0) {
                return { count: 0, distance: Infinity };
            }

            const currentPoint = turf.point([this.long, this.lat]);
            const distances = waterFeatures.map(feature =>
                turf.distance(currentPoint, turf.nearestPoint(currentPoint, feature))
            );

            return {
                count: waterFeatures.length,
                distance: Math.min(...distances),
            };
        } catch (error) {
            console.error('Error processing water bodies:', error);
            return { count: 0, distance: Infinity };
        }
    }

    // Helper function to check if two coordinates are the same
    isSamePoint(coord1, coord2) {
        return coord1[0] === coord2[0] && coord1[1] === coord2[1];
    }

    async _fallbackWaterBodyDetection() {
        // Implement alternative detection method using OpenStreetMap Nominatim
        try {
            const response = await this.makeApiRequest(
                `${this.config.apis.nominatim.baseURL}/search`,
                {
                    q: 'water',
                    format: 'json',
                    viewbox: [this.long - 0.5, this.lat - 0.5, this.long + 0.5, this.lat + 0.5].join(','),
                    bounded: 1
                }
            );

            return {
                count: response.length,
                distance: response.length > 0
                    ? Math.min(...response.map(f => turf.distance(
                        turf.point([this.long, this.lat]),
                        turf.point([f.lon, f.lat])
                    )))
                    : Infinity
            };
        } catch (fallbackError) {
            return { count: 0, distance: Infinity };
        }
    }

    // Security and configuration
    async getAuthHeaders(service) {
        const headers = {};
        if (service === 'ors' && this.config.apis.openRouteService.key) {
            headers['Authorization'] = this.config.apis.openRouteService.key;
        }
        return headers;
    }

    async getCacheTTL(service) {
        return service === 'flood'
            ? this.config.cacheTTL.floodData
            : 600000; // 10 minutes default
    }

    // Fallback strategies
    async generateFallbackAssessment(error) {
        return {
            score: 0.5,
            components: {
                road: 0.5,
                flood: 0.5,
                transport: 0.5,
                settlement: 0.5
            },
            error: error.message,
            isFallback: true
        };
    }

    async generateRoadFallback() {
        return {
            minor: { distance: Infinity, point: null },
            major: { distance: Infinity, point: null },
            isFallback: true
        };
    }

    async reverseGeocode(lat = this.lat, long = this.long) {
        try {
            return await this.makeApiRequest(`${this.config.apis.nominatim.baseURL}/reverse`, {
                lat: lat,
                lon: long,
                format: 'json',
                'accept-language': 'en'
            });
        } catch (error) {
            logger.error('Reverse geocoding failed', { error: error.message });
            throw error;
        }
    }

    async cleanupCache() {
        const now = Date.now();
        const expiredKeys = [];

        // Find expired cache entries
        this.cacheTimers.forEach((expiryTime, key) => {
            if (now >= expiryTime) {
                expiredKeys.push(key);
            }
        });

        // Remove expired entries
        expiredKeys.forEach(key => {
            this.cache.delete(key);
            this.cacheTimers.delete(key);
        });

        logger.debug(`Cache cleanup: removed ${expiredKeys.length} expired entries`);
    }

    // Update cache.set to use the timer tracking
    cache = {
        set: (key, value, ttl) => {
            this._cacheMap.set(key, value);

            // Set expiration timer
            const expiryTime = Date.now() + ttl;
            this.cacheTimers.set(key, expiryTime);

            return value;
        },
        has: (key) => this._cacheMap.has(key),
        get: (key) => this._cacheMap.get(key),
        delete: (key) => {
            this._cacheMap.delete(key);
            this.cacheTimers.delete(key);
        }
    };

    async cleanup() {
        try {
            // Clear any timers
            if (this.cacheCleanupInterval) {
                clearInterval(this.cacheCleanupInterval);
            }

            // Clean up cache
            this.cache = new Map();
            this.cacheTimers = new Map();

            logger.info('GeospatialAccessibilityAssessment resources cleaned up');
            return true;
        } catch (error) {
            logger.error('Error during cleanup', { error: error.message });
            return false;
        }
    }
}

module.exports = GeospatialAccessibilityAssessment;