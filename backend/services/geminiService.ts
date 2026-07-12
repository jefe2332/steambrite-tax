
import { TaxResponse, Suggestion, AddressData } from "../types.ts";

// Simple in-memory cache for the session to prevent redundant API calls
const cache = new Map<string, TaxResponse>();

export const getAddressSuggestions = async (
  input: string, 
  mode: "Ohio Only" | "USA"
): Promise<Suggestion[]> => {
  if (input.trim().length < 2) return [];
  
  try {
    const res = await fetch('/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, mode })
    });
    if (!res.ok) throw new Error('Network response was not ok');
    return await res.json();
  } catch (error) {
    console.error(error);
    return [];
  }
};

export const lookupTaxRates = async (address: AddressData, forceOhio: boolean = false): Promise<TaxResponse> => {
  const cacheKey = `${address.street}-${address.zip}`.toLowerCase();
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const res = await fetch('/api/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, forceOhio })
  });
  
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to fetch tax rates');
  }
  
  const result = await res.json();
  cache.set(cacheKey, result);
  return result;
};
