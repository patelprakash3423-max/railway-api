export type ProviderState = 'SUCCESS' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR';
export type ProviderFailureState = Exclude<ProviderState, 'SUCCESS'>;
