// schemas.js
module.exports = {
    orsSchema: {
        type: 'object',
        properties: {
            features: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['geometry', 'properties']
                }
            }
        }
    },
    overpassSchema: {
        type: 'object',
        properties: {
            elements: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['type', 'id', 'tags']
                }
            }
        }
    }
};
