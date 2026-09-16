let count = 0;
export function resetApiCallCount(): void { count = 0; }
export function getApiCallCount(): number { return count; }
export function incrementApiCallCount(): void { count += 1; }
