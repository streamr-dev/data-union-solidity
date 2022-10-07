const { ErrorMessage } = require('./ErrorMessage')
const { error } = require('./error')
const TOLERANCE_MILLIS = 5 * 60 * 1000 // 5 min
const SignedRequestValidator  = require('./SignedRequestValidatorMiddleware')(TOLERANCE_MILLIS)
const { JoinHandler } = require('./JoinHandler')
const InvalidRequestError = require('./InvalidRequestError')

module.exports = {
	ErrorMessage,
	error,
	SignedRequestValidator,
	InvalidRequestError,
	JoinHandler,
}
