export const YEAR_START     = 2026;
export const YEAR_END       = 2044;
export const FORECAST_YEARS = Array.from({ length: YEAR_END - YEAR_START + 1 }, (_, i) => YEAR_START + i);
export const CURRENT_YEAR   = new Date().getFullYear();
