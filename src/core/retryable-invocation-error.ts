/** A retained inspection expired. Discard its result/effect plan and inspect again. */
export class RetryableInvocationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RetryableInvocationError';
    }
}
