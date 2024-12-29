const Joi = require('joi');

const polygonSchema = Joi.object({
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
    endDate: Joi.string().isoDate().required()
});
module.exports = { polygonSchema };