const Joi = require('joi');

const vegetationIndexSchema = Joi.object({
    polygon: Joi.object({
        type: Joi.string().valid('Feature').required(),
        properties: Joi.object().allow({}),
        geometry: Joi.object({
            type: Joi.string().valid('Polygon').required(),
            coordinates: Joi.array().items(
                Joi.array().items(
                    Joi.array().items(Joi.number()).min(2).max(2)
                ).min(4)
            ).required()
        }).required()
    }).required(),
    startDate: Joi.string().isoDate().required(),
    endDate: Joi.string().isoDate().required(),
    source: Joi.string().valid('sentinel2a', 'planet', 'intercalibrated', 'landsat').required()
});

const boreholeSitesSchema = Joi.object({
    polygon: Joi.object({
        type: Joi.string().valid('Feature').required(),
        properties: Joi.object().allow({}),
        geometry: Joi.object({
            type: Joi.string().valid('Polygon').required(),
            coordinates: Joi.array().items(
                Joi.array().items(
                    Joi.array().items(Joi.number()).min(2).max(2)
                ).min(4)
            ).required()
        }).required()
    }).required(),
    source: Joi.string().valid('unspecified').required()
});

module.exports = { vegetationIndexSchema, boreholeSitesSchema };