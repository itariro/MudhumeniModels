class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

class ModelError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ModelError';
    }
}

module.exports = {
    ValidationError,
    ModelError
};