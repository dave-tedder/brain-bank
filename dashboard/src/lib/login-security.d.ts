export declare const LOGIN_MAX_ATTEMPTS: number;
export declare const LOGIN_WINDOW_MS: number;
export declare function _resetLoginRateLimitForTests(): void;
export declare function checkLoginRateLimit(
  key: string,
  now?: number,
): { allowed: boolean; retryAfterMs: number };
export declare function recordFailedLogin(key: string, now?: number): void;
export declare function clearLoginFailures(key: string): void;
export declare function constantTimeEqualStr(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean;
