const sleep = require("./sleep-promise")

/**
 * @callback UntilCondition
 * @returns {boolean} signifying if it should stop waiting and continue execution
 */
/**
 * Wait until a condition is true
 * @param {UntilCondition|Promise<boolean>} condition wait until this callback function returns true
 * @param {number} [timeOutMs=10000] stop waiting after that many milliseconds, -1 for disable
 * @param {number} [pollingIntervalMs=100] check condition between so many milliseconds
 */
async function until(condition, timeOutMs = 10000, pollingIntervalMs = 100) {
    let timeout = false
    if (timeOutMs > 0) {
        setTimeout(() => { timeout = true }, timeOutMs)
    }

    // Promise wrapped condition function works for normal functions just the same as Promises
    while (!await Promise.resolve().then(condition)) {
        if (timeout) {
            throw new Error(`Timeout after ${timeOutMs} milliseconds`)
        }
        await sleep(pollingIntervalMs)
    }
    return condition()
}

module.exports = until
