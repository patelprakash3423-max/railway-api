export interface SearchBudgetConfig {
  maxAvailabilityCalls: number;
  maxIntermediateStations: number;
  maxResults: number;
}
export const defaultSearchBudget: Readonly<SearchBudgetConfig> = Object.freeze({
  maxAvailabilityCalls: 20, maxIntermediateStations: 3, maxResults: 5,
});
export class SearchBudget {
  readonly config: Readonly<SearchBudgetConfig>;
  private used = 0;
  constructor(config: Partial<SearchBudgetConfig> = {}) {
    this.config = Object.freeze({ ...defaultSearchBudget, ...config });
    for (const value of Object.values(this.config)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Search limits must be nonnegative safe integers.');
    }
  }
  canCall(): boolean { return this.used < this.config.maxAvailabilityCalls; }
  consumeCall(): void {
    if (!this.canCall()) throw new Error('Availability call budget exhausted.');
    this.used += 1;
  }
  get callsUsed(): number { return this.used; }
}
